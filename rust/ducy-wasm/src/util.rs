//! What every part of the bindings shares: errors and values for JS, a
//! game's rules, and a club table's host. Kept apart from the bot tables
//! (`play`), so the relay's build can leave those out (ducy-web #463).

use ducy_play::{Table, TableRules, TableSeat, Variant};

use ducy_host::TableHost;
use serde::Serialize;
use wasm_bindgen::prelude::*;

pub(crate) fn err(e: impl std::fmt::Debug) -> JsError {
    JsError::new(&format!("{e:?}"))
}

pub(crate) fn to_js(value: &impl Serialize) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(err)
}

/// The casino chips, in the page's hundredths: $1, $5, $25, $100, $500,
/// $1,000, $5,000, $25,000.
const CHIPS: [u64; 8] = [100, 500, 2_500, 10_000, 50_000, 100_000, 500_000, 2_500_000];

/// A game's smallest chip, by default: the largest casino chip not above the
/// small blind. So 1/2 and 2/5 bet in $1, 5/10 and 10/25 in $5, 25/50 in $25.
/// Below a $1 small blind, any amount.
pub(crate) fn default_chip(small_blind: u64) -> u64 {
    CHIPS
        .iter()
        .rev()
        .copied()
        .find(|&c| c <= small_blind)
        .unwrap_or(1)
}

pub(crate) fn rules_for(
    game: Option<&str>,
    small_blind: u64,
    big_blind: u64,
) -> Result<TableRules, JsError> {
    Ok(rules_for_game(game, small_blind, big_blind)?.with_chip(default_chip(small_blind)))
}

fn rules_for_game(
    game: Option<&str>,
    small_blind: u64,
    big_blind: u64,
) -> Result<TableRules, JsError> {
    Ok(match game.unwrap_or("nlhe") {
        "nlhe" => TableRules::no_limit_holdem(small_blind, big_blind),
        g @ ("plo4" | "plo5" | "plo6") => TableRules::pot_limit_omaha(small_blind, big_blind)
            .with_variant(Variant::Omaha {
                hole_cards: g[3..].parse().unwrap_or(4),
            }),
        // A PLO bomb pot on two boards: everyone antes the big blind, and the
        // hand starts on the flop.
        "plo4-bomb" => {
            TableRules::pot_limit_omaha(small_blind, big_blind).bomb_pot(big_blind, true)
        }
        g => return Err(JsError::new(&format!("unknown game {g}"))),
    })
}

/// Bomb pots every `every` hands, or none for 0.
pub(crate) fn bomb_pots(every: u64, ante: u64, double_board: bool) -> Option<ducy_play::BombPots> {
    (every > 0).then_some(ducy_play::BombPots {
        every,
        ante,
        double_board,
    })
}

/// A friends table's host: the host in seat 0 and `seats - 1` empty seats
/// (2 to 10 in all) that people take as they join. Chips are real: the host
/// starts with `host_chips`, everyone else asks the host for chips, and a
/// stack after a request must be `min_buy_in` to `max_buy_in` chips.
#[allow(clippy::too_many_arguments)]
pub(crate) fn friends_host(
    seats: usize,
    host_name: &str,
    host_chips: u64,
    min_buy_in: u64,
    max_buy_in: u64,
    small_blind: u64,
    big_blind: u64,
    seed: u64,
    game: Option<&str>,
    turn_ms: u64,
) -> Result<TableHost, JsError> {
    let rules = rules_for(game, small_blind, big_blind)?;
    if small_blind == 0 || big_blind < small_blind || min_buy_in < big_blind {
        return Err(JsError::new("invalid blinds or buy-in"));
    }
    if !(2..=ducy_play::MAX_PLAYERS).contains(&seats) {
        return Err(JsError::new("a table seats 2 to 10"));
    }
    if host_chips < min_buy_in || host_chips > max_buy_in {
        return Err(JsError::new(
            "the host's chips must be within the buy-in limits",
        ));
    }
    let name: String = host_name.trim().chars().take(ducy_host::MAX_NAME).collect();
    let mut all = vec![TableSeat::human(
        if name.is_empty() { "Host" } else { &name },
        "you",
    )];
    all.extend((1..seats).map(|_| TableSeat::empty()));
    let mut table = Table::new(rules, all, host_chips, seed)
        .map_err(err)?
        .with_secure_deals();
    table.set_run_it_twice(true);
    let open = (0..seats).map(|s| s > 0).collect();
    TableHost::new(table, open, turn_ms)
        .and_then(|h| h.with_bank(min_buy_in, max_buy_in))
        .map_err(err)
}

/// A club table's host: `seats` empty seats and no seat for the host;
/// everyone posts `ante` every hand (0 for none, #655), and the club takes
/// `rake` from each hand (#449).
#[allow(clippy::too_many_arguments)]
pub(crate) fn club_host(
    seats: usize,
    min_buy_in: u64,
    max_buy_in: u64,
    small_blind: u64,
    big_blind: u64,
    ante: u64,
    seed: u64,
    game: Option<String>,
    turn_ms: u64,
    rake: ducy_play::Rake,
) -> Result<TableHost, JsError> {
    let base = rules_for(game.as_deref(), small_blind, big_blind)?;
    // A bomb-pot game keeps its own ante.
    let rules = if ante > 0 { base.with_ante(ante) } else { base }.with_rake(rake);
    if small_blind == 0 || big_blind < small_blind || min_buy_in < big_blind || ante > big_blind {
        return Err(JsError::new("invalid blinds, ante or buy-in"));
    }
    if !(2..=ducy_play::MAX_PLAYERS).contains(&seats) {
        return Err(JsError::new("a table seats 2 to 10"));
    }
    let all = (0..seats).map(|_| TableSeat::empty()).collect();
    let mut table = Table::new(rules, all, min_buy_in, seed)
        .map_err(err)?
        .with_secure_deals();
    table.set_run_it_twice(true);
    TableHost::without_host(table, turn_ms, min_buy_in, max_buy_in).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_club_table_takes_its_ante_and_keeps_no_flop_no_drop() {
        let rake = ducy_play::Rake {
            percent: 500,
            cap: 400,
            no_flop: true,
            time: 0,
        };
        let host = club_host(6, 8_000, 20_000, 100, 200, 50, 1, None, 0, rake)
            .ok()
            .unwrap();
        let rules = host.table().rules();
        assert_eq!(
            (rules.small_blind, rules.big_blind, rules.ante),
            (100, 200, 50)
        );
        assert!(!rules.bomb_pot);
        assert_eq!(rules.rake, rake);
        // No ante: none.
        let host = club_host(
            6,
            8_000,
            20_000,
            100,
            200,
            0,
            1,
            Some("plo5".into()),
            0,
            rake,
        )
        .ok()
        .unwrap();
        assert_eq!(host.table().rules().ante, 0);
    }
}

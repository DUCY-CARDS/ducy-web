//! The equity calculator's sampling (ducy-web #464): a job (the page's
//! seats, boards and dead cards) built into one of ducy's games once, then
//! sampled in batches and added up. The page keeps the clock and the
//! threads: it calls `run` until its time is up, on the main thread or in
//! mc-worker.js, and adds the workers' totals with `mergeEquityTotals`.

use std::rc::Rc;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use ducy::deck::{Card, Deck};
use ducy::games::flop_game::FlopGame;
use ducy::games::holdem::{HoldemGameEvaluation, HoldemGameState, HoldemRange};
use ducy::games::omaha::{OmahaGameEvaluation, OmahaGameState};
use ducy::games::omaha_bomb_pot::{OmahaBombPotGameEvaluation, OmahaBombPotGameState, SeatHand};
use ducy::games::omaha_hilo::{OmahaHiLoGameEvaluation, OmahaHiLoGameState};
use ducy::games::omaha_range::OmahaRange;
use ducy::games::omaha_range_equity::OmahaRangeSampler;

use crate::study::{omaha_ranges, parse_ranges, to_js_err};
use crate::util::{err, to_js};

/// What the page asks for. Cards are like "As". Players come in this
/// order: known hands first, then one per range (Hold'em and Omaha range
/// jobs); a bomb pot's seats are in table order, with `randomIndices` and
/// `rangeSeats` naming the seats that aren't known hands.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Job {
    /// "range" (Hold'em ranges), "orange" (Omaha ranges), "omaha" (known
    /// Omaha hands, the board to come) or "bombpot".
    #[serde(rename = "type")]
    kind: String,
    num_players: usize,
    hands: Vec<Vec<String>>,
    /// The board so far: 0 to 5 cards (1 or 2 is part of a flop).
    board_cards: Vec<String>,
    /// A bomb pot's boards so far.
    all_board_cards: Vec<Vec<String>>,
    dead: Vec<String>,
    /// Range text, one per range player.
    ranges: Vec<String>,
    /// Bomb pot seats dealt from an Omaha range.
    range_seats: Vec<RangeSeat>,
    /// Bomb pot seats dealt random hands.
    random_indices: Vec<usize>,
    num_boards: usize,
    cards_per: u32,
    /// Omaha Hi-Lo.
    hilo: bool,
    /// Hold'em ranges counted exactly, once.
    exact: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct RangeSeat {
    seat: usize,
    text: String,
}

/// Totals over the samples so far: each player's equity summed over
/// `weight` (the samples, or 1 for an exact answer), and for a bomb pot the
/// boards won and the scoops.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityTotals {
    /// Samples taken (1 for an exact answer).
    pub done: f64,
    /// What `totals` divide by.
    pub weight: f64,
    /// Each player's equity, summed.
    pub totals: Vec<f64>,
    /// A bomb pot's `boardWins[board][player]`: won or tied.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub board_wins: Option<Vec<Vec<f64>>>,
    /// Alone won every board.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scoops: Option<Vec<f64>>,
    /// An opponent alone won every board.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scooped: Option<Vec<f64>>,
}

impl EquityTotals {
    fn new(players: usize, boards: Option<usize>) -> Self {
        Self {
            totals: vec![0.0; players],
            board_wins: boards.map(|b| vec![vec![0.0; players]; b]),
            scoops: boards.map(|_| vec![0.0; players]),
            scooped: boards.map(|_| vec![0.0; players]),
            ..Default::default()
        }
    }

    /// Adds `other`'s samples to these.
    pub fn merge(&mut self, other: &Self) {
        fn add(a: &mut [f64], b: &[f64]) {
            for (x, y) in a.iter_mut().zip(b) {
                *x += y;
            }
        }
        self.done += other.done;
        self.weight += other.weight;
        add(&mut self.totals, &other.totals);
        if let (Some(a), Some(b)) = (&mut self.board_wins, &other.board_wins) {
            for (a, b) in a.iter_mut().zip(b) {
                add(a, b);
            }
        }
        if let (Some(a), Some(b)) = (&mut self.scoops, &other.scoops) {
            add(a, b);
        }
        if let (Some(a), Some(b)) = (&mut self.scooped, &other.scooped) {
            add(a, b);
        }
    }
}

/// One deal's bomb pot results from each board's winners (seat numbers):
/// boards won, and the scoop when one seat alone won them all.
pub fn bomb_pot_deal(board_winners: &[Vec<usize>], players: usize) -> EquityTotals {
    let mut t = EquityTotals::new(players, Some(board_winners.len()));
    t.done = 1.0;
    t.weight = 1.0;
    let wins = t.board_wins.as_mut().unwrap();
    for (b, ws) in board_winners.iter().enumerate() {
        for &w in ws.iter().filter(|&&w| w < players) {
            wins[b][w] += 1.0;
        }
    }
    let sole: Vec<Option<usize>> = board_winners
        .iter()
        .map(|ws| match ws[..] {
            [w] => Some(w),
            _ => None,
        })
        .collect();
    let scooper = match sole.first() {
        Some(&Some(p)) if p < players && sole.iter().all(|s| *s == Some(p)) => Some(p),
        _ => None,
    };
    if let Some(p) = scooper {
        t.scoops.as_mut().unwrap()[p] = 1.0;
        for (i, s) in t.scooped.as_mut().unwrap().iter_mut().enumerate() {
            if i != p {
                *s = 1.0;
            }
        }
    }
    t
}

/// `n` more samples whose equities sum to `sums`.
fn add_sums(t: &mut EquityTotals, n: u64, sums: &[f64]) {
    for (x, y) in t.totals.iter_mut().zip(sums) {
        *x += y;
    }
    t.done += n as f64;
    t.weight += n as f64;
}

fn deck(cards: &[String]) -> Result<Deck, JsError> {
    Deck::parse(&cards.join(" ")).map_err(to_js_err)
}

fn card(c: &str) -> Result<Card, JsError> {
    Card::parse(c).map_err(to_js_err)
}

/// Known hands, the board so far (1 to 3 flop cards: the rest is dealt
/// with each runout) and the dead cards, onto a flop game.
fn fill<G: FlopGame>(game: &mut G, job: &Job, board: &[String]) -> Result<(), JsError> {
    for h in &job.hands {
        game.add_player(deck(h)?).map_err(to_js_err)?;
    }
    if !board.is_empty() {
        game.set_flop(deck(&board[..board.len().min(3)])?)
            .map_err(to_js_err)?;
    }
    if let Some(c) = board.get(3) {
        game.set_turn(card(c)?).map_err(to_js_err)?;
    }
    if let Some(c) = board.get(4) {
        game.set_river(card(c)?).map_err(to_js_err)?;
    }
    if !job.dead.is_empty() {
        game.add_dead_cards(deck(&job.dead)?).map_err(to_js_err)?;
    }
    Ok(())
}

fn holdem(job: &Job, board: &[String]) -> Result<HoldemGameState, JsError> {
    let mut g = HoldemGameState::new();
    fill(&mut g, job, board)?;
    Ok(g)
}

enum Game {
    HoldemRanges(HoldemGameState, Vec<HoldemRange>),
    Omaha(OmahaGameState),
    OmahaHiLo(OmahaHiLoGameState),
    OmahaRanges(OmahaGameState, Vec<Rc<OmahaRangeSampler>>),
    OmahaHiLoRanges(OmahaHiLoGameState, Vec<Rc<OmahaRangeSampler>>),
    BombPot(OmahaBombPotGameState, Vec<(usize, OmahaRange)>),
}

/// An equity job, built once and sampled in batches.
#[wasm_bindgen]
pub struct EquityJob {
    job: Job,
    game: Game,
    totals: EquityTotals,
}

#[wasm_bindgen]
impl EquityJob {
    /// Builds `job`'s game. Errors on bad cards, or a range that doesn't
    /// read ("invalid range").
    #[wasm_bindgen(constructor)]
    pub fn new(job: JsValue) -> Result<EquityJob, JsError> {
        let job: Job = serde_wasm_bindgen::from_value(job).map_err(err)?;
        let cards = job.cards_per as usize;
        let game = match job.kind.as_str() {
            "range" => {
                Game::HoldemRanges(holdem(&job, &job.board_cards)?, parse_ranges(&job.ranges)?)
            }
            "omaha" | "orange" => {
                let ranges = (job.kind == "orange")
                    .then(|| omaha_ranges(&job.ranges, cards))
                    .transpose()?;
                if job.hilo {
                    let mut g = OmahaHiLoGameState::new(job.cards_per);
                    fill(&mut g, &job, &job.board_cards)?;
                    match ranges {
                        Some(r) => Game::OmahaHiLoRanges(g, r),
                        None => Game::OmahaHiLo(g),
                    }
                } else {
                    let mut g = OmahaGameState::new(job.cards_per);
                    fill(&mut g, &job, &job.board_cards)?;
                    match ranges {
                        Some(r) => Game::OmahaRanges(g, r),
                        None => Game::Omaha(g),
                    }
                }
            }
            "bombpot" => {
                let mut g = OmahaBombPotGameState::new(job.num_boards, job.cards_per);
                for h in &job.hands {
                    g.add_player(deck(h)?).map_err(to_js_err)?;
                }
                for (b, board) in job.all_board_cards.iter().enumerate() {
                    if !board.is_empty() {
                        g.set_flop(b, deck(&board[..board.len().min(3)])?)
                            .map_err(to_js_err)?;
                    }
                    if let Some(c) = board.get(3) {
                        g.set_turn(b, card(c)?).map_err(to_js_err)?;
                    }
                    if let Some(c) = board.get(4) {
                        g.set_river(b, card(c)?).map_err(to_js_err)?;
                    }
                }
                if !job.dead.is_empty() {
                    g.add_dead_cards(deck(&job.dead)?).map_err(to_js_err)?;
                }
                let ranges = job
                    .range_seats
                    .iter()
                    .map(|r| {
                        Ok((
                            r.seat,
                            OmahaRange::parse(&r.text, cards).map_err(to_js_err)?,
                        ))
                    })
                    .collect::<Result<_, JsError>>()?;
                Game::BombPot(g, ranges)
            }
            other => return Err(JsError::new(&format!("unknown job type {other}"))),
        };
        let boards = (job.kind == "bombpot").then_some(job.num_boards);
        let totals = EquityTotals::new(job.num_players, boards);
        Ok(Self { job, game, totals })
    }

    /// Samples taken so far.
    pub fn done(&self) -> f64 {
        self.totals.done
    }

    /// Takes `samples` more (an exact job answers once, on its first run).
    pub fn run(&mut self, samples: usize) -> Result<(), JsError> {
        let t = &mut self.totals;
        let n = samples as u64;
        // ducy's plain Omaha sampling gives averages; the rest give sums.
        let avg =
            |eq: Vec<f64>| -> Vec<f64> { eq.into_iter().map(|d| d * samples as f64).collect() };
        match &self.game {
            Game::HoldemRanges(g, ranges) if self.job.exact => {
                if t.done > 0.0 {
                    return Ok(());
                }
                let eq = HoldemGameEvaluation {}
                    .range_equity(g, ranges)
                    .map_err(to_js_err)?;
                add_sums(t, 1, &eq);
            }
            Game::HoldemRanges(g, ranges) => {
                let r = HoldemGameEvaluation {}
                    .sample_range_equity_seeded(g, ranges, samples, None)
                    .map_err(to_js_err)?;
                add_sums(t, r.samples, &r.equity_sum);
            }
            Game::Omaha(g) => {
                let eq = avg(OmahaGameEvaluation {}.sample_equity_seeded(g, samples, None));
                add_sums(t, n, &eq);
            }
            Game::OmahaHiLo(g) => {
                let eq = avg(OmahaHiLoGameEvaluation {}.sample_equity_seeded(g, samples, None));
                add_sums(t, n, &eq);
            }
            Game::OmahaRanges(g, rs) => {
                let refs: Vec<&OmahaRangeSampler> = rs.iter().map(|r| r.as_ref()).collect();
                let r = OmahaGameEvaluation {}
                    .sample_range_equity_seeded(g, &refs, samples, None)
                    .map_err(to_js_err)?;
                add_sums(t, r.samples, &r.equity_sum);
            }
            Game::OmahaHiLoRanges(g, rs) => {
                let refs: Vec<&OmahaRangeSampler> = rs.iter().map(|r| r.as_ref()).collect();
                let r = OmahaHiLoGameEvaluation {}
                    .sample_range_equity_seeded(g, &refs, samples, None)
                    .map_err(to_js_err)?;
                add_sums(t, r.samples, &r.equity_sum);
            }
            Game::BombPot(g, ranges) => {
                let seats: Vec<(usize, SeatHand)> = self
                    .job
                    .random_indices
                    .iter()
                    .map(|&s| (s, SeatHand::Random))
                    .chain(ranges.iter().map(|(s, r)| (*s, SeatHand::Range(r))))
                    .collect();
                let r = OmahaBombPotGameEvaluation {}
                    .sample_seats_seeded(g, &seats, samples, None)
                    .map_err(to_js_err)?;
                let f = |v: &[u64]| v.iter().map(|&x| x as f64).collect::<Vec<f64>>();
                let mut more = EquityTotals {
                    done: r.samples as f64,
                    weight: r.samples as f64,
                    totals: r.equity_sum,
                    board_wins: Some(r.board_wins.iter().map(|b| f(b)).collect()),
                    scoops: Some(f(&r.scoops)),
                    scooped: Some(f(&r.scooped)),
                };
                more.totals.resize(t.totals.len(), 0.0);
                t.merge(&more);
            }
        }
        Ok(())
    }

    /// The totals so far, as a plain object for posting between threads.
    pub fn totals(&self) -> Result<JsValue, JsError> {
        to_js(&self.totals)
    }
}

/// `a` plus `b`: two runs' totals (e.g. two workers') of the same job.
#[wasm_bindgen(js_name = mergeEquityTotals)]
pub fn merge_equity_totals(a: JsValue, b: JsValue) -> Result<JsValue, JsError> {
    let mut a: EquityTotals = serde_wasm_bindgen::from_value(a).map_err(err)?;
    let b: EquityTotals = serde_wasm_bindgen::from_value(b).map_err(err)?;
    a.merge(&b);
    to_js(&a)
}

/// Empty totals for a job: nothing sampled yet.
#[wasm_bindgen(js_name = emptyEquityTotals)]
pub fn empty_equity_totals(job: JsValue) -> Result<JsValue, JsError> {
    let job: Job = serde_wasm_bindgen::from_value(job).map_err(err)?;
    let boards = (job.kind == "bombpot").then_some(job.num_boards);
    to_js(&EquityTotals::new(job.num_players, boards))
}

/// An upper bound on the hand evaluations an exact Hold'em range job would
/// take (only a full flop or more counts; a partial flop is sampled), to
/// choose exact or sampled. Errors if a range has no usable combos.
#[wasm_bindgen(js_name = rangeExactCost)]
pub fn range_exact_cost(job: JsValue) -> Result<f64, JsError> {
    let job: Job = serde_wasm_bindgen::from_value(job).map_err(err)?;
    let board: &[String] = if job.board_cards.len() >= 3 {
        &job.board_cards
    } else {
        &[]
    };
    let g = holdem(&job, board)?;
    HoldemGameEvaluation {}
        .exact_range_evaluations(&g, &parse_ranges(&job.ranges)?)
        .map(|n| n as f64)
        .map_err(to_js_err)
}

/// A bomb pot dealt out (every board complete): each board's winners (seat
/// numbers, from `OmahaBombPotGame.evaluate_winners`) as totals of one deal.
#[wasm_bindgen(js_name = bombPotDealTotals)]
pub fn bomb_pot_deal_totals(board_winners: JsValue, players: usize) -> Result<JsValue, JsError> {
    let w: Vec<Vec<usize>> = serde_wasm_bindgen::from_value(board_winners).map_err(err)?;
    to_js(&bomb_pot_deal(&w, players))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deal_scoops_only_alone_on_every_board() {
        let t = bomb_pot_deal(&[vec![1], vec![1]], 3);
        assert_eq!(t.scoops, Some(vec![0.0, 1.0, 0.0]));
        assert_eq!(t.scooped, Some(vec![1.0, 0.0, 1.0]));
        assert_eq!(t.board_wins, Some(vec![vec![0.0, 1.0, 0.0]; 2]));
        let t = bomb_pot_deal(&[vec![1], vec![0, 1]], 3);
        assert_eq!(t.scoops, Some(vec![0.0; 3]));
        assert_eq!(
            t.board_wins,
            Some(vec![vec![0.0, 1.0, 0.0], vec![1.0, 1.0, 0.0]])
        );
    }

    #[test]
    fn totals_add_up() {
        let mut a = EquityTotals::new(2, Some(1));
        a.done = 2.0;
        a.weight = 2.0;
        a.totals = vec![1.5, 0.5];
        let mut b = a.clone();
        b.scoops = Some(vec![1.0, 0.0]);
        a.merge(&b);
        assert_eq!((a.done, a.weight), (4.0, 4.0));
        assert_eq!(a.totals, vec![3.0, 1.0]);
        assert_eq!(a.scoops, Some(vec![1.0, 0.0]));
    }
}

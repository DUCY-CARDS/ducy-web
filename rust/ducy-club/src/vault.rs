//! The owner's float and vault (ducy-web #589), members' vaults (ducy-web
//! #579), and the notices of chip moves (#576). Chips are treated as if
//! they could be real money.
//!
//! **The owner** gives chips from a float: a fixed amount ([`Float::size`])
//! taken from their vault, which has no limit and is the club's supply.
//! Someone at the owner's device can give away at most what's in the float.
//! Topping it up (a refill) and changing its size apply at once (#660): the
//! relay lets them through only with a passkey unlock from the last few
//! minutes, as every chip move. Each is logged, and one bigger than a full
//! buy-in is a notice. Lowering the size sends what's over it back to the
//! vault; raising it leaves the float to be refilled. Chips taken back go
//! to the owner's vault, not the float. A club from before
//! the float replaced its daily chip cap gets a float the size of the cap,
//! holding what the cap had left that day.
//!
//! **A member** keeps chips in their vault: put in at once, from their
//! balance; taken out after their chosen wait ([`WAITS`], 24 hours unless
//! they pick another), and only by them. Shortening the wait applies once
//! the current wait has passed; lengthening it is at once. Vault chips are
//! on the link they play through ([`crate::money::Link::vault`]): the
//! club's, or their agent's. They count in the books but can't be bought in
//! with, or taken back by the owner. An agent's take back can reach them,
//! after the player's balance, with a notice to the owner and the player
//! ([`Book::agent_take`]). The owner, and a player's agent, see each vault;
//! what they've asked to take out and their wait are theirs alone
//! ([`MemberVault`], left out of the owner's view and the agent's).
//!
//! **Notices**: a give, take back, refill or change to the float's size of
//! more than a full buy-in at the club's biggest table
//! ([`Book::notice_from`]), and a removal, are marked in the activity log
//! (`notice`: a key) and show in the owner's notices for [`NOTICE_DAYS`]
//! until cleared.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::book::{Book, MAX_CHIPS, amount, int, money_err};
use crate::money::{CLUB, Entry, EntryKind, MoneyError};
use crate::rules::{RuleError, TableStatus, chip_text, refuse};

/// A day, in milliseconds.
pub const DAY: u64 = 86_400_000;
/// A new club's float: 2,000 chips.
pub const DEFAULT_FLOAT: u64 = 200_000;
/// A full buy-in at the default table (Hold'em 1/2, 100 big blinds), when
/// the club has no table to measure by.
pub const DEFAULT_BUY_IN: u64 = 20_000;
/// The old daily cap's default, in full buy-ins at the club's biggest
/// table: what a club that never set one gets as its float.
pub const CAP_BUY_INS: u64 = 10;
/// Notices of chip moves show this many days.
pub const NOTICE_DAYS: u64 = 7;
/// The waits a member can choose for taking chips out of their vault.
pub const WAITS: [u64; 3] = [DAY, 3 * DAY, 7 * DAY];

/// A raise of the old daily cap that was waiting its day (ducy-web #576).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapRaise {
    /// The cap it raised to.
    pub to: u64,
    /// When it was asked for.
    pub at: u64,
}

impl CapRaise {
    /// When it applies.
    pub fn applies(&self) -> u64 {
        self.at + DAY
    }
}

/// The owner's float.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Float {
    /// What a refill tops it up to.
    pub size: u64,
    /// Whether it has been filled the first time (a new club's is, once
    /// the club starts).
    #[serde(default)]
    pub open: bool,
}

impl Float {
    /// A float of `size`, not filled yet.
    pub fn new(size: u64) -> Self {
        Self { size, open: false }
    }
}

/// A member's request to take chips out of their vault.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultOut {
    /// Its number, the member's own.
    pub id: u64,
    /// The chips.
    pub amount: u64,
    /// When it was asked for.
    pub at: u64,
    /// When the chips are back in their balance.
    pub ready: u64,
}

/// A shorter wait, applying once the current one has passed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitChange {
    /// The new wait.
    pub to: u64,
    /// When it applies.
    pub applies: u64,
}

fn day() -> u64 {
    DAY
}

/// A member's vault settings and what they've asked to take out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberVault {
    /// How long taking chips out waits.
    #[serde(default = "day")]
    pub wait: u64,
    /// A shorter wait, waiting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shorter: Option<WaitChange>,
    /// Chips on their way out, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outs: Vec<VaultOut>,
    /// The last request's number.
    #[serde(default)]
    pub next: u64,
    /// Their agent's last take back that reached the vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<VaultTaken>,
}

/// Chips an agent took back from a player's vault.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultTaken {
    /// The chips.
    pub amount: u64,
    /// When.
    pub at: u64,
}

impl Default for MemberVault {
    fn default() -> Self {
        Self {
            wait: DAY,
            shorter: None,
            outs: Vec::new(),
            next: 0,
            taken: None,
        }
    }
}

/// What settling found due: members whose accounts changed.
pub type Settled = Vec<String>;

impl Book {
    fn owner(&self) -> String {
        self.club
            .owner_id
            .clone()
            .unwrap_or_else(|| self.club.host_id.clone())
    }

    /// A full buy-in at the club's biggest table (its maximum in big blinds
    /// times its big blind), of those a day old by `now`; with none that
    /// old, of all its tables; with none, [`DEFAULT_BUY_IN`].
    pub fn biggest_buy_in(&self, now: u64) -> u64 {
        let full = |t: &crate::rules::Table| t.bb * if t.max_bb > 0 { t.max_bb } else { 100 };
        let tables = || self.club.tables.iter().filter(|t| t.bb > 0);
        tables()
            .filter(|t| t.created_at.saturating_add(DAY) <= now)
            .map(full)
            .max()
            .or_else(|| tables().map(full).max())
            .unwrap_or(DEFAULT_BUY_IN)
    }

    /// The old daily cap in force at `now` (#576), for a club moving to the
    /// float: a raise whose day is up, the owner's own, or the default.
    fn old_cap(&self, now: u64) -> u64 {
        match &self.club.cap_raise {
            Some(r) if now >= r.applies() => r.to,
            _ => self
                .club
                .chip_cap
                .unwrap_or_else(|| CAP_BUY_INS.saturating_mul(self.biggest_buy_in(now))),
        }
    }

    /// Chips the club gave members in the 24 hours up to `now`.
    fn given_today(&self, now: u64) -> u64 {
        self.money
            .ledger()
            .iter()
            .filter(|e| {
                e.kind == EntryKind::Give && e.backer == CLUB && e.member != crate::money::FLOAT
            })
            .filter(|e| e.at.saturating_add(DAY) > now && e.at <= now)
            .map(|e| e.amount.max(0) as u64)
            .sum()
    }

    fn float_mut(&mut self) -> &mut Float {
        self.club
            .float
            .get_or_insert_with(|| Float::new(DEFAULT_FLOAT))
    }

    /// The float, set up if it isn't yet: a club from before it gets one the
    /// size of its daily cap, holding what the cap had left today (a raise
    /// of the cap still waiting is dropped); a new club's is filled to its
    /// size.
    pub fn start_float(&mut self, now: u64) {
        let owner = self.owner();
        if self.club.float.is_none() {
            let cap = self.old_cap(now);
            let left = cap.saturating_sub(self.given_today(now));
            let mut f = Float::new(cap);
            f.open = true;
            self.club.cap_raise = None;
            self.club.chip_cap = None;
            self.club.float = Some(f);
            if left > 0 {
                let _ = self.money.refill(left, "Left of the daily cap", now);
            }
            let text = format!(
                "The daily chip cap is now a float of {}, holding {}",
                chip_text(cap),
                chip_text(left)
            );
            self.log_notice(&owner, &text, now, None);
            return;
        }
        self.club.chip_cap = None;
        self.club.cap_raise = None;
        let f = self.float_mut();
        if f.open {
            return;
        }
        f.open = true;
        let size = f.size;
        let top = size.saturating_sub(self.money.float());
        if top > 0 {
            let _ = self.money.refill(top, "", now);
        }
        let text = format!("Float of {} filled", chip_text(size));
        self.log_action(&owner, &text, now, Some(top as i64));
    }

    /// The float's size now.
    pub fn float_size(&self) -> u64 {
        self.club.float.as_ref().map_or(DEFAULT_FLOAT, |f| f.size)
    }

    /// Whatever is due by `now`: the float set up, members' chips out of
    /// their vaults and shorter waits. The members whose accounts changed.
    pub fn settle_vault(&mut self, now: u64) -> Settled {
        self.start_float(now);
        let mut changed = Vec::new();
        let ids: Vec<String> = self.club.vaults.keys().cloned().collect();
        for id in ids {
            let v = self.club.vaults.get_mut(&id).expect("listed");
            if let Some(s) = v.shorter.clone().filter(|s| now >= s.applies) {
                v.wait = s.to;
                v.shorter = None;
            }
            let (due, keep): (Vec<VaultOut>, Vec<VaultOut>) = std::mem::take(&mut v.outs)
                .into_iter()
                .partition(|o| o.ready <= now);
            v.outs = keep;
            for o in due {
                // A vault emptied some other way since: nothing to move.
                let backer = self.vault_backer(&id);
                if self.money.vault_out(&id, &backer, o.amount, now).is_ok() {
                    changed.push(id.clone());
                }
            }
        }
        if !changed.is_empty() {
            changed.dedup();
            self.sync();
        }
        changed
    }

    /// When something is next due to settle, if anything is.
    pub fn next_vault_due(&self) -> Option<u64> {
        self.club
            .vaults
            .values()
            .flat_map(|v| {
                v.outs
                    .iter()
                    .map(|o| o.ready)
                    .chain(v.shorter.as_ref().map(|s| s.applies))
            })
            .min()
    }

    /// The club gives a member chips from the owner's float.
    pub fn give_float(
        &mut self,
        id: &str,
        amt: Option<i64>,
        why: &str,
        now: u64,
    ) -> Result<Entry, RuleError> {
        self.member(id)?;
        let amt = amount(amt)?;
        self.direct(id)?;
        self.start_float(now);
        let left = self.money.float();
        if amt > left {
            if left == 0 {
                return refuse("The float is empty. Refill it.");
            }
            return refuse(format!(
                "That’s more than the float: {} left. Refill it.",
                chip_text(left)
            ));
        }
        self.ensure_links(now)?;
        let e = self
            .money
            .give_from_float(
                id,
                amt,
                &why.trim().chars().take(80).collect::<String>(),
                now,
            )
            .map_err(money_err)?;
        self.chips.issued += amt as i64;
        self.sync();
        Ok(e)
    }

    /// The owner refills the float from their vault, up to its size, at
    /// once: logged, and a notice when it's more than a full buy-in.
    /// `{added}`.
    pub fn refill(&mut self, now: u64) -> Result<Value, RuleError> {
        self.start_float(now);
        let top = self.float_size().saturating_sub(self.money.float());
        if top == 0 {
            return refuse("The float is full.");
        }
        self.money.refill(top, "", now).map_err(money_err)?;
        let line = format!("Refilled the float: +{}", chip_text(top));
        self.log_move(&line, top, now);
        Ok(json!({"added": top}))
    }

    /// The owner sets the float's size to `to` chips, at once: a smaller
    /// one sends what's over it back to the vault, a bigger one is filled
    /// by a refill. Logged, and a notice when it changes by more than a
    /// full buy-in.
    pub fn set_float_size(&mut self, to: Option<i64>, now: u64) -> Result<(), RuleError> {
        self.start_float(now);
        let Some(to) = to
            .filter(|&t| t > 0 && t as u64 <= MAX_CHIPS)
            .map(|t| t as u64)
        else {
            return refuse("The float is a whole number of chips above 0.");
        };
        let size = self.float_size();
        if to == size {
            return Ok(());
        }
        self.float_mut().size = to;
        let over = self.money.float().saturating_sub(to);
        if over > 0 {
            self.money
                .to_vault(over, "Float made smaller", now)
                .map_err(money_err)?;
        }
        let owner = self.owner();
        let text = format!("Float set to {} (from {})", chip_text(to), chip_text(size));
        if to.abs_diff(size) > self.notice_from(now) {
            self.log_notice(&owner, &text, now, None);
        } else {
            self.log_action(&owner, &text, now, None);
        }
        Ok(())
    }

    /// The float for the owner's page: {size, float}.
    pub fn float_view(&self) -> Value {
        json!({"size": self.float_size(), "float": self.money.float()})
    }

    /// A member's own vault command (#579): `op` "in" (`amount` from their
    /// balance), "out" (`amount`, after their wait), "cancel" (taking out
    /// `out`, a request's number) or "wait" (`wait`, one of [`WAITS`]).
    pub fn member_vault(&mut self, id: &str, args: &Value, now: u64) -> Result<(), RuleError> {
        self.member(id)?;
        let op = args.get("op").and_then(Value::as_str).unwrap_or("");
        let amt = || amount(int(args.get("amount")));
        match op {
            "in" => {
                let amt = amt()?;
                self.ensure_links(now)?;
                // Everyone's vault is on the link they play through: the
                // club's, or their agent's.
                let backer = self.vault_backer(id);
                self.money
                    .vault_in(id, &backer, amt, now)
                    .map_err(|e| match e {
                        MoneyError::Vault { has } => {
                            RuleError(format!("You have {} to put in.", chip_text(has)))
                        }
                        e => money_err(e),
                    })?;
                self.club.vaults.entry(id.into()).or_default();
                self.sync();
            }
            "out" => {
                let amt = amt()?;
                let has = self.vault_chips(id);
                let v = self.club.vaults.entry(id.into()).or_default();
                let going: u64 = v.outs.iter().map(|o| o.amount).sum();
                let free = has.saturating_sub(going);
                if amt > free {
                    return refuse(format!("Your vault has {} to take out.", chip_text(free)));
                }
                v.next += 1;
                let o = VaultOut {
                    id: v.next,
                    amount: amt,
                    at: now,
                    ready: now + v.wait,
                };
                v.outs.push(o);
            }
            "cancel" => {
                let n = int(args.get("out")).unwrap_or(-1);
                let v = self.club.vaults.entry(id.into()).or_default();
                let before = v.outs.len();
                v.outs.retain(|o| o.id as i64 != n);
                if v.outs.len() == before {
                    return refuse("That’s no longer waiting.");
                }
            }
            "wait" => {
                let to = int(args.get("wait")).map_or(0, |w| w.max(0) as u64);
                if !WAITS.contains(&to) {
                    return refuse("Pick 24 hours, 3 days or 7 days.");
                }
                let v = self.club.vaults.entry(id.into()).or_default();
                if to >= v.wait {
                    v.wait = to;
                    v.shorter = None;
                } else {
                    v.shorter = Some(WaitChange {
                        to,
                        applies: now + v.wait,
                    });
                }
            }
            _ => return refuse("Unknown vault command."),
        }
        Ok(())
    }

    /// A member's vault as they see it: {vault, wait, shorter: {to, applies}
    /// or null, outs: [{id, amount, at, ready}]}.
    pub fn vault_of(&self, id: &str) -> Value {
        let has = self.vault_chips(id);
        let v = self.club.vaults.get(id).cloned().unwrap_or_default();
        json!({"vault": has, "wait": v.wait, "shorter": v.shorter, "outs": v.outs, "taken": v.taken})
    }

    /// Whom a member's vault is with: whoever they play through, the club
    /// or their agent.
    pub fn vault_backer(&self, id: &str) -> String {
        self.through(id).unwrap_or_else(|| CLUB.into())
    }

    /// The chips in a member's vault.
    pub fn vault_chips(&self, id: &str) -> u64 {
        self.money
            .link(id, &self.vault_backer(id))
            .map_or(0, |l| l.vault)
    }

    /// An agent (`backer`) takes `amt` back from their player `id`: from
    /// their balance first, then their vault, which doesn't protect a
    /// player's chips from their agent. What came from the vault comes out
    /// of it first (its own entry), and requests to take out more than is
    /// left are cut down. A take back that reaches the vault is a notice to
    /// the owner, and the player sees it too. The take back's entry, and
    /// what came from the vault.
    pub fn agent_take(
        &mut self,
        backer: &str,
        id: &str,
        amt: Option<i64>,
        why: &str,
        now: u64,
    ) -> Result<(Entry, u64), RuleError> {
        self.member(id)?;
        let amt = amount(amt)?;
        let bal = self.balance(id).max(0) as u64;
        let has = self.money.link(id, backer).map_or(0, |l| l.vault);
        if amt > bal + has {
            return refuse(format!(
                "{} has {} chips.",
                self.name(id),
                chip_text(bal + has)
            ));
        }
        let from_vault = amt.saturating_sub(bal);
        if from_vault > 0 {
            self.money
                .vault_out(id, backer, from_vault, now)
                .map_err(money_err)?;
            if let Some(v) = self.club.vaults.get_mut(id) {
                let mut left = has - from_vault;
                for o in &mut v.outs {
                    o.amount = o.amount.min(left);
                    left -= o.amount;
                }
                v.outs.retain(|o| o.amount > 0);
            }
            self.club.vaults.entry(id.into()).or_default().taken = Some(VaultTaken {
                amount: from_vault,
                at: now,
            });
        }
        let note: String = why.trim().chars().take(80).collect();
        let e = self
            .money
            .take_back(backer, id, amt, &note, now)
            .map_err(money_err)?;
        self.sync();
        if from_vault > 0 {
            let text = format!(
                "{}’s agent {} took {} back from their vault",
                self.name(id),
                self.name(backer),
                chip_text(from_vault)
            );
            self.log_notice(backer, &text, now, Some(from_vault as i64));
        }
        Ok((e, from_vault))
    }

    /// The size a give or take back must be over for a notice: a full
    /// buy-in at the club's biggest table, open now or by the day-old
    /// measure, whichever is less.
    pub fn notice_from(&self, now: u64) -> u64 {
        let open = self
            .club
            .tables
            .iter()
            .filter(|t| t.status != TableStatus::Closed && t.bb > 0)
            .map(|t| t.bb * if t.max_bb > 0 { t.max_bb } else { 100 })
            .max();
        let measure = self.biggest_buy_in(now);
        open.map_or(measure, |o| o.min(measure))
    }

    /// Adds an entry to the activity log that's also a notice to the owner;
    /// its key.
    pub fn log_notice(&mut self, by: &str, text: &str, now: u64, amt: Option<i64>) -> String {
        let same = self
            .log
            .iter()
            .filter(|l| l["at"].as_u64() == Some(now))
            .count();
        let key = format!("move:{now}:{same}");
        self.log_action(by, text, now, amt);
        if let Some(e) = self.log.last_mut() {
            e["notice"] = key.clone().into();
        }
        key
    }

    /// Logs a chip move by the owner, with a notice when it's big; the
    /// notice's key, if any.
    pub fn log_move(&mut self, text: &str, amt: u64, now: u64) -> Option<String> {
        let owner = self.owner();
        if amt > self.notice_from(now) {
            Some(self.log_notice(&owner, text, now, Some(amt as i64)))
        } else {
            self.log_action(&owner, text, now, Some(amt as i64));
            None
        }
    }

    /// The owner's notices of big chip moves, removals and big float changes
    /// from the last [`NOTICE_DAYS`].
    pub fn move_notices(&self, now: u64) -> Vec<Value> {
        let since = now.saturating_sub(NOTICE_DAYS * DAY);
        self.log
            .iter()
            .filter(|l| l["at"].as_u64().is_some_and(|a| a >= since))
            .filter_map(|l| {
                let key = l["notice"].as_str()?;
                Some(json!({
                    "key": key, "kind": "move", "text": l["text"], "amount": l.get("amount").cloned().unwrap_or(Value::Null),
                    "by": l["by"], "at": l["at"],
                }))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::ClubState;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use serde_json::Map;

    const NOW: u64 = 1_800_000_000_000;
    const H: u64 = 3_600_000;

    // A club from before the float: one table, a week old, 1/2, 100 big
    // blinds, so a full buy-in is 200 and the old default cap 2,000.
    fn old_club(ids: &[&str]) -> ClubState {
        let mut members = Map::new();
        for id in ids {
            members.insert(
                (*id).into(),
                json!({"id": id, "name": id[..1].to_uppercase() + &id[1..], "status": "member"}),
            );
        }
        let mut c: ClubState = serde_json::from_value(json!({
            "code": "ABCD-EFGH", "hostId": "HOST", "ownerId": "OWN", "members": members,
            "tables": [{"id": "t1", "name": "T1", "game": "nlhe", "sb": 100, "bb": 200, "minBB": 40, "maxBB": 100,
                        "seats": 9, "status": "open", "createdAt": NOW - 7 * DAY}],
        }))
        .unwrap();
        c.book.ensure_links(0).unwrap();
        c.book.sync();
        c
    }

    // A new club: its float is the default, filled when it starts.
    fn new_club(ids: &[&str]) -> ClubState {
        let mut c = old_club(ids);
        c.book.club.float = Some(Float::new(DEFAULT_FLOAT));
        c
    }

    fn run(
        c: &mut ClubState,
        op: &str,
        args: Value,
        now: u64,
    ) -> Result<crate::host::Outcome, RuleError> {
        c.run(op, &args, now, &mut StdRng::seed_from_u64(1))
    }

    fn give(
        c: &mut ClubState,
        id: &str,
        amount: u64,
        now: u64,
    ) -> Result<crate::host::Outcome, RuleError> {
        run(c, "give", json!({"id": id, "amount": amount}), now)
    }

    fn audit(c: &ClubState) {
        assert_eq!(c.book.money.audit(), Vec::<String>::new());
        assert!(c.totals().conserved, "{:?}", c.totals());
    }

    #[test]
    fn a_new_club_has_the_default_float_filled() {
        let mut c = new_club(&["ann"]);
        run(&mut c, "vault_settle", json!({}), NOW).unwrap();
        assert_eq!(c.book.money.float(), DEFAULT_FLOAT);
        assert_eq!(c.book.float_view()["size"], DEFAULT_FLOAT);
        let e = c.book.money.ledger().last().unwrap();
        assert_eq!(
            (e.member.as_str(), e.kind),
            (crate::money::FLOAT, EntryKind::Refill)
        );
        audit(&c);
    }

    #[test]
    fn gives_come_out_of_the_float_and_stop_at_it() {
        let mut c = new_club(&["ann", "bob"]);
        give(&mut c, "ann", 150_000, NOW).unwrap();
        assert_eq!(c.book.money.float(), 50_000);
        let e = give(&mut c, "bob", 60_000, NOW).unwrap_err().0;
        assert_eq!(e, "That’s more than the float: 500 left. Refill it.");
        give(&mut c, "bob", 50_000, NOW).unwrap();
        assert_eq!(
            give(&mut c, "bob", 1, NOW).unwrap_err().0,
            "The float is empty. Refill it."
        );
        // A grant too.
        c.book.request_chips("ann", Some(100), "", "", NOW).unwrap();
        assert!(run(&mut c, "grant", json!({"id": "ann"}), NOW).is_err());
        // Taking back goes to the owner's vault, not the float.
        run(&mut c, "take", json!({"id": "ann", "amount": 100_000}), NOW).unwrap();
        assert_eq!(c.book.money.float(), 0);
        // Each give is the member's entry and the float's, in one transaction.
        let gives: Vec<&Entry> = c
            .book
            .money
            .ledger()
            .iter()
            .filter(|e| e.kind == EntryKind::Give)
            .collect();
        assert_eq!(gives.len(), 4);
        assert_eq!(
            (gives[0].member.as_str(), gives[0].amount),
            ("ann", 150_000)
        );
        assert_eq!(
            (gives[1].member.as_str(), gives[1].amount),
            (crate::money::FLOAT, -150_000)
        );
        assert_eq!(gives[0].tx, gives[1].tx);
        audit(&c);
    }

    #[test]
    fn every_refill_is_at_once() {
        let mut c = new_club(&["ann"]);
        give(&mut c, "ann", 200_000, NOW).unwrap();
        let v = run(&mut c, "refill", json!({}), NOW + H).unwrap().value;
        assert_eq!(v, json!({"added": 200_000}));
        assert_eq!(c.book.money.float(), 200_000);
        assert!(
            run(&mut c, "refill", json!({}), NOW + H)
                .unwrap_err()
                .0
                .contains("full")
        );
        // Again within the hour: at once too, and nothing left to settle.
        give(&mut c, "ann", 100_000, NOW + 2 * H).unwrap();
        let out = run(&mut c, "refill", json!({}), NOW + 2 * H).unwrap();
        assert_eq!(out.value, json!({"added": 100_000}));
        assert_eq!(out.next_vault, None);
        assert_eq!(c.book.money.float(), 200_000);
        assert_eq!(
            c.book.money.ledger().last().unwrap().kind,
            EntryKind::Refill
        );
        // More than a full buy-in (200): a notice; less: logged only.
        let refills = |c: &ClubState| -> Vec<Value> {
            c.book
                .move_notices(NOW + 3 * H)
                .into_iter()
                .filter(|n| n["text"].as_str().unwrap().starts_with("Refilled"))
                .collect()
        };
        let n = refills(&c);
        assert_eq!(n.len(), 2);
        assert!(n.iter().all(|n| n["kind"] == "move"));
        assert_eq!(n[1]["text"], "Refilled the float: +1,000");
        give(&mut c, "ann", 10_000, NOW + 3 * H).unwrap();
        run(&mut c, "refill", json!({}), NOW + 3 * H).unwrap();
        let l = c.book.log.last().unwrap();
        assert_eq!(l["text"], "Refilled the float: +100");
        assert!(l.get("notice").is_none());
        assert_eq!(refills(&c).len(), 2);
        audit(&c);
    }

    #[test]
    fn the_float_size_changes_at_once_either_way() {
        let mut c = new_club(&["ann"]);
        run(&mut c, "float_size", json!({"amount": 50_000}), NOW).unwrap();
        // What's over it goes back to the vault, in the ledger.
        assert_eq!(c.book.money.float(), 50_000);
        assert_eq!(
            c.book.money.ledger().last().unwrap().kind,
            EntryKind::ToVault
        );
        assert_eq!(
            c.book.move_notices(NOW)[0]["text"],
            "Float set to 500 (from 2,000)"
        );
        // Raised at once; not filled: a refill tops it up.
        let out = run(&mut c, "float_size", json!({"amount": 300_000}), NOW + H).unwrap();
        assert_eq!(out.next_vault, None);
        assert_eq!(c.book.float_size(), 300_000);
        assert_eq!(c.book.money.float(), 50_000);
        assert_eq!(
            c.book.float_view(),
            json!({"size": 300_000, "float": 50_000})
        );
        assert_eq!(
            c.book.move_notices(NOW + H).last().unwrap()["text"],
            "Float set to 3,000 (from 500)"
        );
        run(&mut c, "refill", json!({}), NOW + H).unwrap();
        assert_eq!(c.book.money.float(), 300_000);
        // A change of a full buy-in or less: logged, no notice.
        let before = c.book.move_notices(NOW + H).len();
        run(&mut c, "float_size", json!({"amount": 320_000}), NOW + H).unwrap();
        assert_eq!(
            c.book.log.last().unwrap()["text"],
            "Float set to 3,200 (from 3,000)"
        );
        assert_eq!(c.book.move_notices(NOW + H).len(), before);
        // The same size: nothing.
        let logged = c.book.log.len();
        run(&mut c, "float_size", json!({"amount": 320_000}), NOW + H).unwrap();
        assert_eq!(c.book.log.len(), logged);
        assert!(run(&mut c, "float_size", json!({"amount": 0}), NOW + 2 * DAY).is_err());
        // The wait's commands are gone.
        for op in ["approve_refill", "cancel_refill", "cancel_float_raise"] {
            assert!(run(&mut c, op, json!({}), NOW + 2 * DAY).is_err(), "{op}");
        }
        audit(&c);
    }

    #[test]
    fn a_club_from_before_gets_a_float_from_its_cap() {
        // The owner had set a cap of 1,000, given 600 of it today, and asked
        // for a raise to 5,000 an hour ago (dropped: nothing waits now).
        let mut c = old_club(&["ann"]);
        c.book.club.chip_cap = Some(100_000);
        c.book.club.cap_raise = Some(CapRaise {
            to: 500_000,
            at: NOW - H,
        });
        c.book.issue("ann", Some(60_000), "", NOW - 2 * H).unwrap();
        run(&mut c, "vault_settle", json!({}), NOW).unwrap();
        assert_eq!(c.book.float_size(), 100_000);
        assert_eq!(c.book.money.float(), 40_000);
        assert_eq!(c.book.club.chip_cap, None);
        assert_eq!(c.book.club.cap_raise, None);
        assert!(
            c.book
                .move_notices(NOW)
                .iter()
                .any(|n| n["text"] == "The daily chip cap is now a float of 1,000, holding 400")
        );
        // Settling again changes nothing.
        let n = c.book.money.ledger().len();
        run(&mut c, "vault_settle", json!({}), NOW + 1).unwrap();
        assert_eq!(c.book.money.ledger().len(), n);
        // One that never set a cap: ten full buy-ins at its biggest table.
        let mut c = old_club(&["ann"]);
        run(&mut c, "vault_settle", json!({}), NOW).unwrap();
        assert_eq!(
            (c.book.float_size(), c.book.money.float()),
            (200_000, 200_000)
        );
        audit(&c);
    }

    #[test]
    fn a_members_vault_in_at_once_out_after_their_wait() {
        let mut c = new_club(&["ann"]);
        give(&mut c, "ann", 100_000, NOW).unwrap();
        c.book
            .member_vault("ann", &json!({"op": "in", "amount": 70_000}), NOW)
            .unwrap();
        assert_eq!(c.book.balance("ann"), 30_000);
        assert_eq!(c.book.club.members["ann"].other["vault"], 70_000);
        let e = c
            .book
            .member_vault("ann", &json!({"op": "in", "amount": 40_000}), NOW)
            .unwrap_err()
            .0;
        assert_eq!(e, "You have 300 to put in.");
        // Vault chips can't be bought in with, or taken back.
        assert_eq!(c.book.available("ann"), 30_000);
        assert!(run(&mut c, "take", json!({"id": "ann", "amount": 40_000}), NOW).is_err());
        // Out: after the wait (24 hours by default).
        c.book
            .member_vault("ann", &json!({"op": "out", "amount": 50_000}), NOW + H)
            .unwrap();
        let e = c
            .book
            .member_vault("ann", &json!({"op": "out", "amount": 30_000}), NOW + H)
            .unwrap_err()
            .0;
        assert_eq!(e, "Your vault has 200 to take out.");
        assert_eq!(c.book.next_vault_due(), Some(NOW + H + DAY));
        let out = run(&mut c, "vault_settle", json!({}), NOW + H + DAY - 1).unwrap();
        assert!(out.accounts.is_empty());
        assert_eq!(c.book.balance("ann"), 30_000);
        let out = run(&mut c, "vault_settle", json!({}), NOW + H + DAY).unwrap();
        assert_eq!(out.accounts.len(), 1);
        assert_eq!(c.book.balance("ann"), 80_000);
        assert_eq!(c.book.vault_of("ann")["vault"], 20_000);
        // Cancelled: nothing moves.
        c.book
            .member_vault(
                "ann",
                &json!({"op": "out", "amount": 20_000}),
                NOW + 2 * DAY,
            )
            .unwrap();
        c.book
            .member_vault("ann", &json!({"op": "cancel", "out": 2}), NOW + 2 * DAY)
            .unwrap();
        assert!(
            c.book
                .member_vault("ann", &json!({"op": "cancel", "out": 2}), NOW + 2 * DAY)
                .is_err()
        );
        run(&mut c, "vault_settle", json!({}), NOW + 9 * DAY).unwrap();
        assert_eq!(c.book.vault_of("ann")["vault"], 20_000);
        audit(&c);
    }

    #[test]
    fn a_shorter_wait_applies_after_the_current_one_a_longer_at_once() {
        let mut c = new_club(&["ann"]);
        give(&mut c, "ann", 100_000, NOW).unwrap();
        c.book
            .member_vault("ann", &json!({"op": "in", "amount": 100_000}), NOW)
            .unwrap();
        c.book
            .member_vault("ann", &json!({"op": "wait", "wait": 7 * DAY}), NOW)
            .unwrap();
        assert_eq!(c.book.vault_of("ann")["wait"], 7 * DAY);
        c.book
            .member_vault("ann", &json!({"op": "wait", "wait": DAY}), NOW + H)
            .unwrap();
        assert_eq!(c.book.vault_of("ann")["wait"], 7 * DAY);
        assert_eq!(
            c.book.vault_of("ann")["shorter"],
            json!({"to": DAY, "applies": NOW + H + 7 * DAY})
        );
        // Taken out meanwhile: the 7 days.
        c.book
            .member_vault("ann", &json!({"op": "out", "amount": 1}), NOW + 2 * H)
            .unwrap();
        assert_eq!(
            c.book.vault_of("ann")["outs"][0]["ready"],
            NOW + 2 * H + 7 * DAY
        );
        run(&mut c, "vault_settle", json!({}), NOW + H + 7 * DAY).unwrap();
        assert_eq!(c.book.vault_of("ann")["wait"], DAY);
        assert!(
            c.book
                .member_vault("ann", &json!({"op": "wait", "wait": 2 * DAY}), NOW)
                .is_err()
        );
        audit(&c);
    }

    #[test]
    fn an_agents_player_has_a_vault_their_agent_can_take_back_from() {
        let mut c = new_club(&["ann", "bo"]);
        c.book.club.members.get_mut("ann").unwrap().agent = Some("yes".into());
        c.book.assign_to_agent("bo", Some("ann"), NOW).unwrap();
        let agent = |c: &mut ClubState, cmd: Value| c.book.run_agent("ann", &cmd, NOW + H);
        agent(&mut c, json!({"op": "give", "id": "bo", "amount": 80_000})).unwrap();
        // The same vault, on their link with their agent.
        c.book
            .member_vault("bo", &json!({"op": "in", "amount": 50_000}), NOW + H)
            .unwrap();
        assert_eq!(c.book.money.link("bo", "ann").unwrap().vault, 50_000);
        assert_eq!(c.book.club.members["bo"].other["vault"], 50_000);
        c.book
            .member_vault("bo", &json!({"op": "out", "amount": 30_000}), NOW + H)
            .unwrap();
        // The agent sees the vault, not what they asked to take out.
        let body = c.agent_body("ann", 0).unwrap();
        assert_eq!(body["players"][0]["vault"], 50_000);
        assert!(!body.to_string().contains("outs"));
        // A take back: the balance (300) first, then the vault (400).
        let done = agent(&mut c, json!({"op": "take", "id": "bo", "amount": 70_000})).unwrap();
        assert_eq!(c.book.balance("bo"), 0);
        assert_eq!(c.book.vault_chips("bo"), 10_000);
        // What was on its way out is cut to what's left.
        assert_eq!(c.book.vault_of("bo")["outs"][0]["amount"], 10_000);
        assert_eq!(
            c.book.vault_of("bo")["taken"],
            json!({"amount": 40_000, "at": NOW + H})
        );
        assert_eq!(
            done.accounts[0].since,
            Some(c.book.money.ledger().len() as u64 - 2)
        );
        // A notice to the owner.
        assert!(c.book.move_notices(NOW + H).iter().any(|n| n["text"]
            == "Bo’s agent Ann took 400 back from their vault"
            && n["amount"] == 40_000));
        // More than both: refused.
        assert!(agent(&mut c, json!({"op": "take", "id": "bo", "amount": 20_000})).is_err());
        // Moving to another backer waits until the vault is empty.
        assert!(
            c.book
                .assign_to_agent("bo", None, NOW + H)
                .unwrap_err()
                .0
                .contains("100")
        );
        audit(&c);
    }

    #[test]
    fn notices_of_big_moves_removals_and_refills() {
        let mut c = new_club(&["ann", "bob"]);
        // A full buy-in (200) or less: logged, no notice.
        give(&mut c, "ann", 20_000, NOW).unwrap();
        assert_eq!(c.book.log.last().unwrap()["text"], "Gave Ann 200");
        assert!(c.book.move_notices(NOW).is_empty());
        give(&mut c, "ann", 20_100, NOW).unwrap();
        run(
            &mut c,
            "take",
            json!({"id": "ann", "amount": 30_000, "note": "cash"}),
            NOW,
        )
        .unwrap();
        run(&mut c, "remove", json!({"id": "bob"}), NOW).unwrap();
        run(&mut c, "refill", json!({}), NOW).unwrap();
        let texts: Vec<String> = c
            .book
            .move_notices(NOW)
            .iter()
            .map(|n| n["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            texts,
            [
                "Gave Ann 201",
                "Took back 300 from Ann: cash",
                "Removed Bob",
                "Refilled the float: +401"
            ]
        );
        assert!(c.book.move_notices(NOW + 8 * DAY).is_empty());
    }
}

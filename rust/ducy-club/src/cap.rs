//! The club's daily chip cap and its notices of big chip moves (ducy-web
//! #576): so a stolen or unattended owner's device can't give out chips
//! without limit, or move many unseen.
//!
//! The cap is on chips the club gives members (give, granting a request, a
//! service's give) in any 24 hours, counted from the club's own ledger and
//! clock. By default it's [`CAP_BUY_INS`] full buy-ins at the club's
//! biggest table. Lowering it applies at once; a raise waits
//! [`RAISE_WAIT`] (the old cap holds until then), and a new raise replaces
//! one waiting and starts its own wait.
//!
//! A table counts toward the default once it's a day old too, so opening a
//! big one doesn't lift the cap at once; until the club has one that old,
//! its tables count as they are.
//!
//! Notices: a give or take back of more than a full buy-in at the club's
//! biggest table ([`Book::notice_from`]), a removal, and a change to the cap
//! are marked in the activity log (`notice`: a key), and show in the
//! owner's notices for [`NOTICE_DAYS`] until cleared.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::book::{Book, MAX_CHIPS, amount};
use crate::money::{CLUB, Entry, EntryKind};
use crate::rules::{RuleError, TableStatus, chip_text, refuse};

/// A day, in milliseconds: the cap's window.
pub const DAY: u64 = 86_400_000;
/// How long a raise of the cap waits.
pub const RAISE_WAIT: u64 = DAY;
/// A full buy-in at the default table (Hold'em 1/2, 100 big blinds), when
/// the club has no table to measure by.
pub const DEFAULT_BUY_IN: u64 = 20_000;
/// The default cap, in full buy-ins at the club's biggest table.
pub const CAP_BUY_INS: u64 = 10;
/// Notices of chip moves show this many days.
pub const NOTICE_DAYS: u64 = 7;

/// A raise of the cap, waiting its day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapRaise {
    /// The cap it raises to.
    pub to: u64,
    /// When it was asked for.
    pub at: u64,
}

impl CapRaise {
    /// When it applies.
    pub fn applies(&self) -> u64 {
        self.at + RAISE_WAIT
    }
}

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

    /// The cap in force at `now`: a raise whose day is up, the owner's
    /// own, or the default.
    pub fn chip_cap(&self, now: u64) -> u64 {
        match &self.club.cap_raise {
            Some(r) if now >= r.applies() => r.to,
            _ => self
                .club
                .chip_cap
                .unwrap_or_else(|| CAP_BUY_INS.saturating_mul(self.biggest_buy_in(now))),
        }
    }

    /// Chips the club gave members in the 24 hours up to `now`.
    pub fn given_today(&self, now: u64) -> u64 {
        self.money
            .ledger()
            .iter()
            .filter(|e| e.kind == EntryKind::Give && e.backer == CLUB)
            .filter(|e| e.at.saturating_add(DAY) > now && e.at <= now)
            .map(|e| e.amount.max(0) as u64)
            .sum()
    }

    /// Refused if giving `amt` more would go over the cap.
    pub fn check_cap(&self, amt: u64, now: u64) -> Result<(), RuleError> {
        let left = self.chip_cap(now).saturating_sub(self.given_today(now));
        if amt <= left {
            return Ok(());
        }
        if left == 0 {
            return refuse(format!(
                "The daily chip cap ({}) is used up. Try again later.",
                chip_text(self.chip_cap(now))
            ));
        }
        refuse(format!(
            "That’s over the daily chip cap: {} left today.",
            chip_text(left)
        ))
    }

    /// The club gives a member chips, within the cap.
    pub fn issue_capped(
        &mut self,
        id: &str,
        amt: Option<i64>,
        why: &str,
        now: u64,
    ) -> Result<Entry, RuleError> {
        self.check_cap(amount(amt)?, now)?;
        self.issue(id, amt, why, now)
    }

    /// A raise whose day is up becomes the owner's cap, logged.
    pub fn settle_cap(&mut self, now: u64) {
        let Some(r) = self.club.cap_raise.clone() else {
            return;
        };
        if now < r.applies() {
            return;
        }
        self.club.chip_cap = Some(r.to);
        self.club.cap_raise = None;
        let owner = self.owner();
        let text = format!("Daily chip cap raised to {}", chip_text(r.to));
        self.log_action(&owner, &text, r.applies(), None);
    }

    /// The size a give or take back must be over for a notice: a full
    /// buy-in at the club's biggest table, open now or by the cap's measure,
    /// whichever is less.
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

    /// The owner sets the cap to `to` chips: a lower one applies at once
    /// (and drops any raise waiting), a higher one waits its day.
    pub fn set_chip_cap(&mut self, to: Option<i64>, now: u64) -> Result<(), RuleError> {
        self.settle_cap(now);
        let Some(to) = to
            .filter(|&t| t > 0 && t as u64 <= MAX_CHIPS)
            .map(|t| t as u64)
        else {
            return refuse("The daily chip cap is a whole number of chips above 0.");
        };
        let cap = self.chip_cap(now);
        let owner = self.owner();
        if to > cap {
            self.club.cap_raise = Some(CapRaise { to, at: now });
            let text = format!(
                "Asked to raise the daily chip cap to {} (from {})",
                chip_text(to),
                chip_text(cap)
            );
            self.log_action(&owner, &text, now, None);
            return Ok(());
        }
        let dropped = self.club.cap_raise.take();
        if to == cap && dropped.is_none() && self.club.chip_cap.is_some() {
            return Ok(());
        }
        self.club.chip_cap = Some(to);
        let mut text = format!("Daily chip cap set to {}", chip_text(to));
        if let Some(r) = dropped {
            text += &format!("; the raise to {} is cancelled", chip_text(r.to));
        }
        self.log_notice(&owner, &text, now, None);
        Ok(())
    }

    /// The owner cancels a raise of the cap still waiting.
    pub fn cancel_cap_raise(&mut self, now: u64) -> Result<(), RuleError> {
        self.settle_cap(now);
        let Some(r) = self.club.cap_raise.take() else {
            return refuse("No raise of the cap is waiting.");
        };
        let owner = self.owner();
        let text = format!(
            "Cancelled raising the daily chip cap to {}",
            chip_text(r.to)
        );
        self.log_notice(&owner, &text, now, None);
        Ok(())
    }

    /// The cap for the owner's page: {cap, given (in the last 24 hours),
    /// left, set (the owner chose it), raise: {to, at, applies} or null}.
    pub fn cap_view(&self, now: u64) -> Value {
        let cap = self.chip_cap(now);
        let given = self.given_today(now);
        let raise = self
            .club
            .cap_raise
            .as_ref()
            .filter(|r| now < r.applies())
            .map_or(
                Value::Null,
                |r| json!({"to": r.to, "at": r.at, "applies": r.applies()}),
            );
        json!({
            "cap": cap, "given": given, "left": cap.saturating_sub(given),
            "set": self.club.chip_cap.is_some() || !raise.is_null(), "raise": raise,
        })
    }

    /// The owner's notices of chip moves, removals and cap changes from the
    /// last [`NOTICE_DAYS`], and a raise of the cap waiting.
    pub fn move_notices(&self, now: u64) -> Vec<Value> {
        let since = now.saturating_sub(NOTICE_DAYS * DAY);
        let mut out: Vec<Value> = self
            .log
            .iter()
            .filter(|l| l["at"].as_u64().is_some_and(|a| a >= since))
            .filter_map(|l| {
                let key = l["notice"].as_str()?;
                Some(json!({
                    "key": key, "kind": "move", "text": l["text"], "amount": l.get("amount").cloned().unwrap_or(Value::Null),
                    "by": l["by"], "at": l["at"],
                }))
            })
            .collect();
        if let Some(r) = self.club.cap_raise.as_ref().filter(|r| now < r.applies()) {
            out.push(json!({
                "key": format!("cap_raise:{}", r.at), "kind": "cap_raise", "to": r.to,
                "cap": self.chip_cap(now), "applies": r.applies(), "at": r.at,
            }));
        }
        out
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

    fn club(ids: &[&str]) -> ClubState {
        let mut members = Map::new();
        for id in ids {
            members.insert(
                (*id).into(),
                json!({"id": id, "name": id[..1].to_uppercase() + &id[1..], "status": "member"}),
            );
        }
        // One table, a week old: 1/2, 100 big blinds, so a full buy-in is 200.
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

    #[test]
    fn the_default_is_ten_buy_ins_at_the_biggest_table_a_day_old() {
        let mut c = club(&["ann"]);
        assert_eq!(c.book.chip_cap(NOW), 200_000);
        // A bigger table opened today doesn't lift it until it's a day old.
        let mut t = c.book.club.tables[0].clone();
        t.id = "t2".into();
        t.bb = 1000;
        t.created_at = NOW;
        c.book.club.tables.push(t);
        assert_eq!(c.book.chip_cap(NOW + H), 200_000);
        assert_eq!(c.book.chip_cap(NOW + DAY), 1_000_000);
        // A new club's tables count as they are; with none, the default table.
        c.book.club.tables.remove(0);
        assert_eq!(c.book.biggest_buy_in(NOW), 100_000);
        c.book.club.tables.clear();
        assert_eq!(c.book.biggest_buy_in(NOW), DEFAULT_BUY_IN);
    }

    #[test]
    fn gives_and_grants_stop_at_the_cap_over_any_24_hours() {
        let mut c = club(&["ann", "bob"]);
        c.book.club.chip_cap = Some(100_000);
        give(&mut c, "ann", 60_000, NOW).unwrap();
        let e = give(&mut c, "bob", 50_000, NOW + H).unwrap_err().0;
        assert_eq!(e, "That’s over the daily chip cap: 400 left today.");
        give(&mut c, "bob", 40_000, NOW + H).unwrap();
        // A request granted counts too.
        c.book
            .request_chips("ann", Some(100), "", "", NOW + 2 * H)
            .unwrap();
        let e = run(&mut c, "grant", json!({"id": "ann"}), NOW + 2 * H)
            .unwrap_err()
            .0;
        assert_eq!(e, "The daily chip cap (1,000) is used up. Try again later.");
        // Taking back doesn't make room: chips given still count for a day.
        run(
            &mut c,
            "take",
            json!({"id": "ann", "amount": 60_000}),
            NOW + 3 * H,
        )
        .unwrap();
        assert!(give(&mut c, "ann", 100, NOW + 3 * H).is_err());
        // A day after the first give, its chips are out of the window.
        assert_eq!(c.book.cap_view(NOW + DAY)["left"], 60_000);
        run(&mut c, "grant", json!({"id": "ann"}), NOW + DAY).unwrap();
        assert_eq!(c.book.balance("ann"), 100);
    }

    #[test]
    fn a_raise_waits_24_hours_on_the_clubs_clock() {
        let mut c = club(&["ann"]);
        run(&mut c, "chip_cap", json!({"amount": 500_000}), NOW).unwrap();
        // The old cap holds.
        assert_eq!(c.book.chip_cap(NOW), 200_000);
        assert!(give(&mut c, "ann", 300_000, NOW + H).is_err());
        let v = c.book.cap_view(NOW + H);
        assert_eq!(
            v["raise"],
            json!({"to": 500_000, "at": NOW, "applies": NOW + DAY})
        );
        // The owner hears of it at once.
        let n = c.book.move_notices(NOW + H);
        assert_eq!(n.last().unwrap()["kind"], "cap_raise");
        assert_eq!(n.last().unwrap()["applies"], NOW + DAY);
        assert!(give(&mut c, "ann", 300_000, NOW + DAY - 1).is_err());
        // A day on, it applies, and is logged.
        give(&mut c, "ann", 300_000, NOW + DAY).unwrap();
        assert_eq!(c.book.club.chip_cap, Some(500_000));
        assert!(c.book.club.cap_raise.is_none());
        assert!(
            c.book
                .log
                .iter()
                .any(|l| l["text"] == "Daily chip cap raised to 5,000")
        );
        assert!(
            !c.book
                .move_notices(NOW + DAY)
                .iter()
                .any(|n| n["kind"] == "cap_raise")
        );
    }

    #[test]
    fn a_raise_is_cancelled_at_once() {
        let mut c = club(&["ann"]);
        run(&mut c, "chip_cap", json!({"amount": 500_000}), NOW).unwrap();
        run(&mut c, "cancel_cap_raise", json!({}), NOW + H).unwrap();
        assert!(c.book.club.cap_raise.is_none());
        assert_eq!(c.book.chip_cap(NOW + 2 * DAY), 200_000);
        let n = c.book.move_notices(NOW + H);
        assert_eq!(n.len(), 1);
        assert_eq!(
            n[0]["text"],
            "Cancelled raising the daily chip cap to 5,000"
        );
        assert!(run(&mut c, "cancel_cap_raise", json!({}), NOW + H).is_err());
    }

    #[test]
    fn a_lower_cap_applies_at_once() {
        let mut c = club(&["ann"]);
        run(&mut c, "chip_cap", json!({"amount": 50_000}), NOW).unwrap();
        assert_eq!(c.book.chip_cap(NOW), 50_000);
        assert!(give(&mut c, "ann", 60_000, NOW).is_err());
        assert_eq!(
            c.book.move_notices(NOW)[0]["text"],
            "Daily chip cap set to 500"
        );
        assert!(run(&mut c, "chip_cap", json!({"amount": 0}), NOW).is_err());
    }

    #[test]
    fn a_raise_then_a_lower_drops_the_raise() {
        let mut c = club(&["ann"]);
        run(&mut c, "chip_cap", json!({"amount": 500_000}), NOW).unwrap();
        run(&mut c, "chip_cap", json!({"amount": 100_000}), NOW + H).unwrap();
        assert!(c.book.club.cap_raise.is_none());
        assert_eq!(c.book.chip_cap(NOW + 2 * DAY), 100_000);
        assert_eq!(
            c.book.log.last().unwrap()["text"],
            "Daily chip cap set to 1,000; the raise to 5,000 is cancelled"
        );
    }

    #[test]
    fn a_new_raise_replaces_one_waiting_and_waits_its_own_day() {
        let mut c = club(&["ann"]);
        run(&mut c, "chip_cap", json!({"amount": 300_000}), NOW).unwrap();
        run(&mut c, "chip_cap", json!({"amount": 400_000}), NOW + 20 * H).unwrap();
        // The first raise's day is up, but it was replaced.
        assert_eq!(c.book.chip_cap(NOW + DAY), 200_000);
        assert_eq!(c.book.chip_cap(NOW + 20 * H + DAY), 400_000);
    }

    #[test]
    fn big_moves_and_removals_are_notices() {
        let mut c = club(&["ann", "bob"]);
        // A full buy-in (200) or less: logged, no notice.
        let o = give(&mut c, "ann", 20_000, NOW).unwrap();
        assert_eq!(o.value, Value::Null);
        assert_eq!(c.book.log.last().unwrap()["text"], "Gave Ann 200");
        assert!(c.book.move_notices(NOW).is_empty());
        let o = give(&mut c, "ann", 20_100, NOW).unwrap();
        assert!(o.value.is_null());
        assert_eq!(c.book.move_notices(NOW).len(), 1);
        run(
            &mut c,
            "take",
            json!({"id": "ann", "amount": 30_000, "note": "cash"}),
            NOW,
        )
        .unwrap();
        run(&mut c, "remove", json!({"id": "bob"}), NOW).unwrap();
        let n = c.book.move_notices(NOW);
        let texts: Vec<&str> = n.iter().map(|n| n["text"].as_str().unwrap()).collect();
        assert_eq!(
            texts,
            [
                "Gave Ann 201",
                "Took back 300 from Ann: cash",
                "Removed Bob"
            ]
        );
        assert_eq!(n[1]["amount"], 30_000);
        // Unique keys, and gone after a week.
        let keys: std::collections::BTreeSet<&str> =
            n.iter().map(|n| n["key"].as_str().unwrap()).collect();
        assert_eq!(keys.len(), 3);
        assert!(c.book.move_notices(NOW + 8 * DAY).is_empty());
    }
}

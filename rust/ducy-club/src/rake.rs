//! What players pay the club at its cash tables (ducy-web #449): rake (a
//! share of each pot) or time (a fixed charge each hand), as a table's
//! [`Charge`](crate::rules::Charge) says. Ducy's engine takes it from the
//! hand, so the pots and stacks are right; this books it.
//!
//! - **Each hand** ([`Book::rake_hand`]): what each player paid goes on
//!   their seat (`rake`, the session's so far), into the club's chips taken
//!   back, and into the [`RakeBook`], by club day. Once per hand: the seat
//!   keeps the last hand booked (`rakeHand`).
//! - **Standing up**: the session's rake is a [`Rake`](EntryKind::Rake)
//!   entry of [`HOUSE`](crate::money::HOUSE) in the ledger, and each link on
//!   their path gets its share (rakeback); what the club's own links get is
//!   chips it issues.
//! - **Every chip adds up**: the rake book's total is the house's entries
//!   plus what's on the seats of sessions still going.
//!
//! The owner sees each player's contributions, today, over seven days and
//! in all ([`ClubState::contributions`]); an agent sees their players'.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::book::Book;
use crate::host::ClubState;
use crate::money::{CLUB, EntryKind};
use crate::rules::Status;

/// A day, in milliseconds.
const DAY_MS: u64 = 86_400_000;
/// How many days of contributions are kept, day by day.
pub const KEEP_DAYS: usize = 400;
/// The days in a week's contributions.
pub const WEEK_DAYS: u64 = 7;

/// Each player's contributions: by club day (days since 1970 in the club's
/// time), the last [`KEEP_DAYS`] of them, and in all.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RakeBook {
    /// Each day's, by player, keyed by the day's number as text (the club
    /// is read through flattened structs, which can't take number keys).
    pub days: BTreeMap<String, BTreeMap<String, u64>>,
    /// All time, by player.
    pub total: BTreeMap<String, u64>,
}

fn day_of(key: &str) -> u64 {
    key.parse().unwrap_or(0)
}

impl RakeBook {
    /// Nothing booked.
    pub fn is_empty(&self) -> bool {
        self.total.is_empty()
    }

    fn add(&mut self, id: &str, day: u64, amount: u64) {
        *self
            .days
            .entry(day.to_string())
            .or_default()
            .entry(id.into())
            .or_default() += amount;
        *self.total.entry(id.into()).or_default() += amount;
        while self.days.len() > KEEP_DAYS {
            let Some(oldest) = self.days.keys().min_by_key(|k| day_of(k)).cloned() else {
                break;
            };
            self.days.remove(&oldest);
        }
    }

    /// What `id` paid from day `from` on.
    pub fn since(&self, id: &str, from: u64) -> u64 {
        self.days
            .iter()
            .filter(|(k, _)| day_of(k) >= from)
            .filter_map(|(_, d)| d.get(id))
            .sum()
    }

    /// What everyone paid in all.
    pub fn all(&self) -> u64 {
        self.total.values().sum()
    }
}

impl Book {
    /// The club day `now` falls on.
    pub fn club_day(&self, now: u64) -> u64 {
        let off = i64::from(self.money.utc_offset_min) * 60_000;
        ((now as i64 + off).max(0) as u64) / DAY_MS
    }

    /// Hand `hand` at table `table` is over, and each player in `paid` (by
    /// member id) paid the club that much in rake and time. Booked on their
    /// seat there, once per hand. Who was booked.
    pub fn rake_hand(
        &mut self,
        table: &str,
        hand: u64,
        paid: &[(String, u64)],
        now: u64,
    ) -> Vec<String> {
        let day = self.club_day(now);
        let mut out = vec![];
        for (id, amount) in paid {
            if *amount == 0 {
                continue;
            }
            let Some(seat) = self
                .club
                .members
                .get_mut(id)
                .and_then(|m| m.other.get_mut("seat"))
                .and_then(Value::as_object_mut)
                .filter(|s| s.get("table").and_then(Value::as_str) == Some(table))
            else {
                continue;
            };
            if seat.get("rakeHand").and_then(Value::as_u64) == Some(hand) {
                continue;
            }
            let so_far = seat.get("rake").and_then(Value::as_u64).unwrap_or(0);
            seat.insert("rake".into(), (so_far + amount).into());
            seat.insert("rakeHand".into(), hand.into());
            self.chips.reclaimed += *amount as i64;
            self.rake_book.add(id, day, *amount);
            out.push(id.clone());
        }
        out
    }

    /// Chips the club issued with a cash-out's rake shares: what its own
    /// links got.
    pub(crate) fn note_rake_shares(&mut self, entries: &[crate::money::Entry]) {
        let issued: i64 = entries
            .iter()
            .filter(|e| e.kind == EntryKind::RakeShare && e.backer == CLUB)
            .map(|e| e.amount)
            .sum();
        self.chips.issued += issued;
    }

    /// The rake and time on the seats of sessions still going.
    pub fn rake_seated(&self) -> u64 {
        self.club
            .members
            .values()
            .filter_map(|m| m.seat())
            .filter_map(|s| s.get("rake").and_then(Value::as_u64))
            .sum()
    }

    /// Whether the rake adds up: the rake book's total is the house's
    /// ledger entries plus what's on the seats.
    pub fn rake_adds_up(&self) -> bool {
        self.rake_book.all() == self.money.house() + self.rake_seated()
    }
}

impl ClubState {
    /// Each player's contributions (#449), most first: `{id, name, agent,
    /// today, week, all}`, with the totals, and each agent's (their
    /// players') for the owner. With `agent`, only that agent's players.
    pub fn contributions(&self, agent: Option<&str>, now: u64) -> Value {
        let b = &self.book;
        let today = b.club_day(now);
        let week = today.saturating_sub(WEEK_DAYS - 1);
        let members = &b.club.members;
        let agent_of = |id: &str| {
            members
                .get(id)
                .and_then(|m| m.agent_of.clone())
                .filter(|a| b.is_agent(a))
        };
        let mut rows: Vec<Value> = b
            .rake_book
            .total
            .iter()
            .filter(|(id, _)| agent.is_none_or(|a| agent_of(id).as_deref() == Some(a)))
            .map(|(id, all)| {
                let name = members.get(id).map_or(id.clone(), |m| m.name.clone());
                json!({
                    "id": id, "name": name, "agent": agent_of(id),
                    "today": b.rake_book.since(id, today), "week": b.rake_book.since(id, week), "all": all,
                })
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r["all"].as_u64().unwrap_or(0)));
        let sum = |k: &str| rows.iter().filter_map(|r| r[k].as_u64()).sum::<u64>();
        let totals = json!({"today": sum("today"), "week": sum("week"), "all": sum("all")});
        let mut agents: Vec<Value> = vec![];
        if agent.is_none() {
            let mut by: BTreeMap<String, [u64; 3]> = BTreeMap::new();
            for r in &rows {
                let Some(a) = r["agent"].as_str() else {
                    continue;
                };
                let t = by.entry(a.into()).or_default();
                for (i, k) in ["today", "week", "all"].iter().enumerate() {
                    t[i] += r[*k].as_u64().unwrap_or(0);
                }
            }
            agents = by
                .into_iter()
                .filter(|(a, _)| members.get(a).is_some_and(|m| m.status == Status::Member))
                .map(|(a, t)| {
                    json!({"id": a, "name": members[&a].name, "today": t[0], "week": t[1], "all": t[2]})
                })
                .collect();
        }
        json!({"players": rows, "agents": agents, "totals": totals})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::Limits;
    use crate::money::HOUSE;
    use serde_json::Map;

    const NOW: u64 = 1_800_000_000_000;
    const LIMITS: Limits = Limits {
        min: 1000,
        max: 20_000,
    };

    fn club(ids: &[&str]) -> ClubState {
        let mut members = Map::new();
        for id in ids {
            members.insert(
                (*id).into(),
                json!({"id": id, "name": id[..1].to_uppercase() + &id[1..], "status": "member"}),
            );
        }
        let mut c: ClubState = serde_json::from_value(json!({
            "code": "ABCD-EFGH", "hostId": "HOST", "members": members,
            "tables": [{"id": "t1", "name": "Main", "game": "nlhe", "sb": 100, "bb": 200, "minBB": 5, "maxBB": 100,
                        "seats": 6, "status": "open", "charge": {"percent": 500, "capBB": 300}}],
        }))
        .unwrap();
        c.book.ensure_links(0).unwrap();
        c.book.sync();
        c
    }

    fn stack(c: &mut ClubState, id: &str, chips: u64) {
        c.book.club.members.get_mut(id).unwrap().other["seat"]["stack"] = chips.into();
    }

    /// Every chip the club issued and didn't take back is somewhere, the
    /// rake adds up, and the ledger's links and house do.
    fn adds_up(c: &ClubState) {
        assert!(c.totals().conserved, "{:?}", c.totals());
        assert!(c.book.rake_adds_up());
        assert_eq!(c.book.money.audit(), Vec::<String>::new());
    }

    #[test]
    fn rake_is_booked_once_a_hand_and_the_books_add_up() {
        let mut c = club(&["ann", "bob"]);
        for id in ["ann", "bob"] {
            c.book.issue(id, Some(10_000), "", NOW).unwrap();
            c.book
                .chips_for_table(id, "t1", Some(5000), LIMITS, NOW)
                .unwrap();
        }
        adds_up(&c);
        // A hand: Ann wins 950 of Bob's 1,000, the club takes 50 (25 each).
        stack(&mut c, "ann", 5950);
        stack(&mut c, "bob", 4000);
        let paid = vec![("ann".to_string(), 25), ("bob".to_string(), 25)];
        assert_eq!(c.book.rake_hand("t1", 1, &paid, NOW), ["ann", "bob"]);
        adds_up(&c);
        // The same hand again (a result sent twice) isn't booked twice.
        assert!(c.book.rake_hand("t1", 1, &paid, NOW).is_empty());
        assert_eq!(c.book.chips.reclaimed, 50);
        // The club saves and loads with it (its JSON, through the flattened book).
        let back: ClubState = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.book.rake_book, c.book.rake_book);
        // Not at that table: nothing.
        assert!(c.book.rake_hand("t2", 2, &paid, NOW).is_empty());
        stack(&mut c, "ann", 5940);
        c.book
            .rake_hand("t1", 2, &[("ann".into(), 10)], NOW + DAY_MS);
        adds_up(&c);

        // Ann stands up: her 35 is the house's, in the ledger.
        c.book.cash_out("ann", NOW + DAY_MS).unwrap();
        let e = c
            .book
            .money
            .ledger()
            .iter()
            .find(|e| e.kind == EntryKind::Rake)
            .unwrap()
            .clone();
        assert_eq!(
            (
                e.member.as_str(),
                e.amount,
                e.from.as_deref(),
                e.about.as_deref()
            ),
            (HOUSE, 35, Some("ann"), Some("t1"))
        );
        assert_eq!(c.book.balance("ann"), 5000 + 5940);
        adds_up(&c);
        // Her own account doesn't have it.
        assert!(c.entries_of("ann", 0).iter().all(|e| e["kind"] != "rake"));

        // What each paid: today, this week, in all.
        let v = c.contributions(None, NOW + DAY_MS);
        assert_eq!(v["totals"], json!({"today": 10, "week": 60, "all": 60}));
        assert_eq!(v["players"][0]["id"], "ann");
        assert_eq!(v["players"][0]["all"], 35);
        assert_eq!(v["players"][1]["today"], 0);
    }

    #[test]
    fn rakeback_up_an_agent_s_path_is_chips_the_club_issues() {
        let mut c = club(&["al", "bo", "cy"]);
        c.book.offer_agent("al").unwrap();
        c.book.answer_agent("al", true, 1, &mut test_rng()).unwrap();
        c.book.assign_to_agent("bo", Some("al"), 2).unwrap();
        c.book.issue("al", Some(20_000), "", NOW).unwrap();
        c.book
            .run_agent(
                "al",
                &json!({"op": "give", "id": "bo", "amount": 8000}),
                NOW,
            )
            .unwrap();
        // The club gives Al 30% of his players' rake; Al gives Bo 10%.
        c.book.money.set_default_share(CLUB, Some(3000)).unwrap();
        c.book.money.set_share("bo", "al", Some(1000)).unwrap();
        c.book
            .chips_for_table("bo", "t1", Some(5000), LIMITS, NOW)
            .unwrap();
        stack(&mut c, "bo", 4800);
        c.book.rake_hand("t1", 7, &[("bo".into(), 200)], NOW);
        adds_up(&c);
        let al_before = c.book.money.link("al", CLUB).unwrap().balance;
        c.book.cash_out("bo", NOW).unwrap();
        // Al's link with the club gets 60; Bo's with Al, 20.
        assert_eq!(
            c.book.money.link("al", CLUB).unwrap().balance - al_before,
            4800 + 60
        );
        assert_eq!(c.book.chips.issued, 20_000 + 60);
        adds_up(&c);
        // The owner sees Bo's under Al; Al sees only his players'.
        let v = c.contributions(None, NOW);
        assert_eq!(v["agents"][0]["id"], "al");
        assert_eq!(v["agents"][0]["all"], 200);
        let mine = c.contributions(Some("al"), NOW);
        assert_eq!(mine["players"].as_array().unwrap().len(), 1);
        assert!(
            c.contributions(Some("cy"), NOW)["players"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    fn test_rng() -> rand::rngs::StdRng {
        use rand::SeedableRng;
        rand::rngs::StdRng::seed_from_u64(3)
    }

    #[test]
    fn the_club_s_rake_is_new_tables_unless_one_sets_its_own() {
        use crate::rules::Charge;
        let ok = |v: Value| Charge::from_value(&v);
        assert_eq!(
            ok(json!({"percent": 450, "capBB": 250})).unwrap(),
            Charge {
                percent: 450,
                cap_bb: 250,
                time_bb: 0
            }
        );
        assert!(ok(Value::Null).unwrap().is_none());
        for bad in [
            json!({"percent": 1001}),
            json!({"timeBB": 26}),
            json!({"timeBB": 4}),
            json!({"percent": 500, "timeBB": 10}),
            json!({"percent": -1}),
            json!({"percent": 4.5}),
            json!("5%"),
        ] {
            assert!(ok(bad).is_err());
        }
        // At 1/2: a cap of 2.5 BB is 5 chips; no flop, no drop, always.
        let e = ok(json!({"percent": 450, "capBB": 250}))
            .unwrap()
            .engine(200);
        assert_eq!((e.percent, e.cap, e.no_flop, e.time), (450, 500, true, 0));
        assert_eq!(ok(json!({"timeBB": 25})).unwrap().engine(200).time, 50);
        assert_eq!(ok(json!({"timeBB": 5})).unwrap().time_bb, 5);

        // The club's: none, then 5% capped at 3 BB.
        let mut c = club(&[]);
        assert!(c.book.club.charge.is_none());
        c.run(
            "settings",
            &json!({"charge": {"percent": 500, "capBB": 300}}),
            1,
            &mut test_rng(),
        )
        .unwrap();
        let why = c
            .run(
                "settings",
                &json!({"charge": {"percent": 2000}}),
                1,
                &mut test_rng(),
            )
            .unwrap_err()
            .0;
        assert!(why.contains("at most 10%"), "{why}");
        let mut r = test_rng();
        let mut new = |spec: Value| {
            c.book
                .club
                .new_table(&spec, 1, None, &mut r)
                .unwrap()
                .charge
        };
        assert_eq!(new(json!({})).cap_bb, 300);
        assert_eq!(new(json!({"charge": {"timeBB": 25}})).time_bb, 25);
        assert!(new(json!({"charge": null})).is_none());
        // Members are told before they sit.
        let body = c.book.club.tables_body(&Default::default());
        assert_eq!(body["tables"][0]["charge"]["capBB"], 300);
    }

    #[test]
    fn days_are_kept_for_a_while_and_all_time_for_good() {
        let mut r = RakeBook::default();
        for d in 0..(KEEP_DAYS as u64 + 5) {
            r.add("ann", d, 1);
        }
        assert_eq!(r.days.len(), KEEP_DAYS);
        assert_eq!(r.total["ann"], KEEP_DAYS as u64 + 5);
        assert_eq!(r.since("ann", KEEP_DAYS as u64), 5);
    }
}

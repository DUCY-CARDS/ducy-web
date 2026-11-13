//! Each player's play (ducy-web #661), so the owner can see who is good for
//! the games: cash hands dealt in and won or lost, by club day, kept with the
//! rake book ([`RakeBook`](crate::rake::RakeBook), which has what they paid).
//! Totals only: nothing from inside a hand.
//!
//! - **Each hand** ([`Book::play_hand`]): each player dealt in at a cash
//!   table counts a hand and what it won or lost them (after the rake), once
//!   per hand: the seat keeps the last hand counted (`playHand`).
//! - **Tournaments**: what each paid in and won, from the ledger (buy-ins,
//!   refunds, prizes and voids about a tournament).
//! - **The report** ([`ClubState::players_report`]): each player with their
//!   agent, last played, and today, 7 days, 30 days and all time; an agent
//!   sees their own players'.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::book::Book;
use crate::host::ClubState;
use crate::money::EntryKind;
use crate::rake::WEEK_DAYS;
use crate::rules::Status;

/// How many days of play are kept, day by day: the longest period shown.
pub const KEEP_DAYS: usize = 30;

/// A player's cash play over a day, or all time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Play {
    /// Hands dealt in.
    pub hands: u64,
    /// Chips won (above 0) or lost, after the rake.
    pub net: i64,
}

impl Play {
    fn add(&mut self, o: Play) {
        self.hands += o.hands;
        self.net += o.net;
    }
}

/// Each player's cash play: by club day (the last [`KEEP_DAYS`]), in all,
/// and when they last played.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlayBook {
    /// Each day's, by player, keyed by the day's number as text.
    pub days: BTreeMap<String, BTreeMap<String, Play>>,
    /// All time, by player.
    pub total: BTreeMap<String, Play>,
    /// When each last finished a hand, in ms.
    pub last: BTreeMap<String, u64>,
}

fn day_of(key: &str) -> u64 {
    key.parse().unwrap_or(0)
}

impl PlayBook {
    /// Nothing counted.
    pub fn is_empty(&self) -> bool {
        self.total.is_empty()
    }

    fn add(&mut self, id: &str, day: u64, play: Play, now: u64) {
        self.days
            .entry(day.to_string())
            .or_default()
            .entry(id.into())
            .or_default()
            .add(play);
        self.total.entry(id.into()).or_default().add(play);
        let last = self.last.entry(id.into()).or_default();
        *last = (*last).max(now);
        while self.days.len() > KEEP_DAYS {
            let Some(oldest) = self.days.keys().min_by_key(|k| day_of(k)).cloned() else {
                break;
            };
            self.days.remove(&oldest);
        }
    }

    /// What `id` played from day `from` on.
    pub fn since(&self, id: &str, from: u64) -> Play {
        let mut p = Play::default();
        for (_, d) in self.days.iter().filter(|(k, _)| day_of(k) >= from) {
            if let Some(x) = d.get(id) {
                p.add(*x);
            }
        }
        p
    }
}

impl Book {
    /// Hand `hand` at table `table` is over, and each player in `dealt` (by
    /// member id) was dealt in and won (above 0) or lost that much. Counted
    /// for those seated there, once per hand. Who was counted.
    pub fn play_hand(
        &mut self,
        table: &str,
        hand: u64,
        dealt: &[(String, i64)],
        now: u64,
    ) -> Vec<String> {
        let day = self.club_day(now);
        let mut out = vec![];
        for (id, net) in dealt {
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
            if seat.get("playHand").and_then(Value::as_u64) == Some(hand) {
                continue;
            }
            seat.insert("playHand".into(), hand.into());
            self.play_book.add(
                id,
                day,
                Play {
                    hands: 1,
                    net: *net,
                },
                now,
            );
            out.push(id.clone());
        }
        out
    }
}

/// The periods shown: their names and first club day, from `today`.
fn periods(today: u64) -> [(&'static str, u64); 4] {
    [
        ("today", today),
        ("week", today.saturating_sub(WEEK_DAYS - 1)),
        ("month", today.saturating_sub(KEEP_DAYS as u64 - 1)),
        ("all", 0),
    ]
}

/// A player's tournaments: by club day, chips won (above 0) or lost.
#[derive(Default)]
struct Tourneys {
    days: BTreeMap<u64, i64>,
    last: u64,
}

impl ClubState {
    /// Each member's tournament results from the ledger: the first entry of
    /// each move (the player's own link) that's a buy-in, refund, prize or
    /// void about a tournament.
    fn tourney_results(&self) -> BTreeMap<String, Tourneys> {
        let b = &self.book;
        let ledger = b.money.ledger();
        let ids: BTreeSet<&str> = ledger
            .iter()
            .filter(|e| e.kind == EntryKind::TourneyBuyIn)
            .filter_map(|e| e.about.as_deref())
            .collect();
        let mut out: BTreeMap<String, Tourneys> = BTreeMap::new();
        let mut tx = None;
        for e in ledger {
            let first = tx != Some(e.tx);
            tx = Some(e.tx);
            let kind = matches!(
                e.kind,
                EntryKind::TourneyBuyIn | EntryKind::Refund | EntryKind::Prize | EntryKind::Void
            );
            if !first || !kind || !e.about.as_deref().is_some_and(|a| ids.contains(a)) {
                continue;
            }
            let t = out.entry(e.member.clone()).or_default();
            *t.days.entry(b.club_day(e.at)).or_default() += e.amount;
            t.last = t.last.max(e.at);
        }
        out
    }

    /// Each player's play at `now` (#661): `{players: [{id, name, agent,
    /// last, today, week, month, all}], agents: [{id, name}]}`, each period
    /// `{hands, net, rake, tourney}` (cash hands dealt in, won or lost at
    /// cash tables after the rake, rake and time paid, won or lost in
    /// tournaments). Anyone who's played, most hands first. With `agent`,
    /// only that agent's players (and no agents).
    pub fn players_report(&self, agent: Option<&str>, now: u64) -> Value {
        let b = &self.book;
        let members = &b.club.members;
        let agent_of = |id: &str| {
            members
                .get(id)
                .and_then(|m| m.agent_of.clone())
                .filter(|a| b.is_agent(a))
        };
        let tourneys = self.tourney_results();
        let ids: BTreeSet<&String> = b
            .play_book
            .total
            .keys()
            .chain(b.rake_book.total.keys())
            .chain(tourneys.keys())
            .filter(|id| members.contains_key(*id))
            .collect();
        let shown = periods(b.club_day(now));
        let mut rows: Vec<Value> = ids
            .into_iter()
            .filter(|id| agent.is_none_or(|a| agent_of(id).as_deref() == Some(a)))
            .map(|id| {
                let t = tourneys.get(id);
                let mut row = json!({
                    "id": id, "name": members[id].name, "agent": agent_of(id),
                    "last": b.play_book.last.get(id).copied().unwrap_or(0).max(t.map_or(0, |t| t.last)),
                });
                for (name, from) in shown {
                    let p = if from == 0 {
                        b.play_book.total.get(id).copied().unwrap_or_default()
                    } else {
                        b.play_book.since(id, from)
                    };
                    let rake = if from == 0 {
                        b.rake_book.total.get(id).copied().unwrap_or(0)
                    } else {
                        b.rake_book.since(id, from)
                    };
                    let tourney: i64 = t.map_or(0, |t| t.days.range(from..).map(|(_, n)| n).sum());
                    row[name] = json!({"hands": p.hands, "net": p.net, "rake": rake, "tourney": tourney});
                }
                row
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r["all"]["hands"].as_u64().unwrap_or(0)));
        let agents: Vec<Value> = if agent.is_some() {
            vec![]
        } else {
            let mut a: Vec<_> = members
                .values()
                .filter(|m| m.status == Status::Member && b.is_agent(&m.id))
                .map(|m| json!({"id": m.id, "name": m.name}))
                .collect();
            a.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
            a
        };
        json!({"players": rows, "agents": agents})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::Limits;
    use serde_json::Map;

    const NOW: u64 = 1_800_000_000_000;
    const DAY_MS: u64 = 86_400_000;
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
                        "seats": 6, "status": "open"}],
        }))
        .unwrap();
        c.book.ensure_links(0).unwrap();
        c.book.sync();
        c
    }

    fn rng() -> rand::rngs::StdRng {
        use rand::SeedableRng;
        rand::rngs::StdRng::seed_from_u64(5)
    }

    fn seat(c: &mut ClubState, id: &str) {
        c.book.issue(id, Some(10_000), "", NOW).unwrap();
        c.book
            .chips_for_table(id, "t1", Some(5000), LIMITS, NOW)
            .unwrap();
    }

    #[test]
    fn hands_are_counted_once_by_day_and_reported_by_period() {
        let mut c = club(&["ann", "bob", "cy"]);
        seat(&mut c, "ann");
        seat(&mut c, "bob");
        let dealt = vec![("ann".to_string(), 300), ("bob".to_string(), -300)];
        assert_eq!(c.book.play_hand("t1", 1, &dealt, NOW), ["ann", "bob"]);
        // The same hand again isn't counted twice; another table's isn't.
        assert!(c.book.play_hand("t1", 1, &dealt, NOW).is_empty());
        assert!(c.book.play_hand("t2", 2, &dealt, NOW).is_empty());
        // Cy isn't seated: not counted.
        assert!(
            c.book
                .play_hand("t1", 2, &[("cy".into(), 5)], NOW)
                .is_empty()
        );
        // Eight days later, one more for Ann.
        let later = NOW + 8 * DAY_MS;
        c.book.play_hand("t1", 3, &[("ann".into(), -100)], later);
        c.book.rake_hand("t1", 3, &[("ann".into(), 10)], later);
        // Saved and loaded with the club.
        let back: ClubState = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.book.play_book, c.book.play_book);

        let v = c.players_report(None, later);
        let ann = &v["players"][0];
        assert_eq!(ann["id"], "ann");
        assert_eq!(ann["last"], later);
        assert_eq!(
            ann["today"],
            json!({"hands": 1, "net": -100, "rake": 10, "tourney": 0})
        );
        assert_eq!(ann["week"]["hands"], 1);
        assert_eq!(
            ann["month"],
            json!({"hands": 2, "net": 200, "rake": 10, "tourney": 0})
        );
        assert_eq!(ann["all"]["hands"], 2);
        let bob = &v["players"][1];
        assert_eq!(bob["today"]["hands"], 0);
        assert_eq!(
            bob["all"],
            json!({"hands": 1, "net": -300, "rake": 0, "tourney": 0})
        );
        assert_eq!(v["players"].as_array().unwrap().len(), 2);

        // Days past 30 go; all time stays.
        let much_later = NOW + 40 * DAY_MS;
        c.book.play_hand("t1", 4, &[("ann".into(), 1)], much_later);
        let v = c.players_report(None, much_later);
        assert_eq!(v["players"][0]["month"]["hands"], 1);
        assert_eq!(v["players"][0]["all"]["hands"], 3);
    }

    #[test]
    fn days_are_kept_for_thirty_days() {
        let mut p = PlayBook::default();
        for d in 0..(KEEP_DAYS as u64 + 5) {
            p.add("ann", d, Play { hands: 1, net: 1 }, d);
        }
        assert_eq!(p.days.len(), KEEP_DAYS);
        assert_eq!(p.total["ann"].hands, KEEP_DAYS as u64 + 5);
        assert_eq!(p.since("ann", KEEP_DAYS as u64).hands, 5);
    }

    #[test]
    fn tournaments_count_from_the_ledger_and_agents_see_their_own() {
        let mut c = club(&["al", "bo", "cy"]);
        c.book.offer_agent("al").unwrap();
        c.book.answer_agent("al", true, 1, &mut rng()).unwrap();
        c.book.assign_to_agent("bo", Some("al"), 2).unwrap();
        c.book.issue("al", Some(20_000), "", NOW).unwrap();
        c.book
            .run_agent(
                "al",
                &json!({"op": "give", "id": "bo", "amount": 8000}),
                NOW,
            )
            .unwrap();
        c.book.issue("cy", Some(5000), "", NOW).unwrap();
        // Bo buys in for 1,000 and wins 2,500; Cy buys in and loses it.
        c.book.tourney_buy_in("bo", "T", Some(1000), NOW).unwrap();
        c.book.tourney_buy_in("cy", "T", Some(1000), NOW).unwrap();
        c.book
            .money
            .pay("bo", EntryKind::Prize, "T", 2500, NOW)
            .unwrap();
        // A promotion's prize isn't a tournament's.
        c.book
            .money
            .pay("cy", EntryKind::Prize, "promo1", 50, NOW)
            .unwrap();
        let v = c.players_report(None, NOW);
        let row = |id: &str| {
            v["players"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == id)
                .cloned()
                .unwrap()
        };
        assert_eq!(row("bo")["today"]["tourney"], 1500);
        assert_eq!(row("bo")["agent"], "al");
        assert_eq!(row("bo")["last"], NOW);
        assert_eq!(row("cy")["all"]["tourney"], -1000);
        assert!(row("cy")["agent"].is_null());
        // Al's buy-in for Bo (on his own link) isn't Al's play.
        assert!(
            v["players"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["id"] != "al")
        );
        assert_eq!(v["agents"], json!([{"id": "al", "name": "Al"}]));
        // Al sees only Bo.
        let mine = c.players_report(Some("al"), NOW);
        assert_eq!(mine["players"].as_array().unwrap().len(), 1);
        assert_eq!(mine["players"][0]["id"], "bo");
        assert!(mine["agents"].as_array().unwrap().is_empty());
    }
}

//! Scheduled cash games (ducy-web #599): a game on the club's menu set for a
//! time, which players sign up for ahead and check in to before it starts.
//!
//! - **Setting it up:** the owner picks a game the club offers or deals
//!   ([`Club::schedule_game`]), its start (an exact instant, in ms), how many
//!   players (one table's worth or more), the fewest to start with, and when
//!   check-in opens (by default [`CHECK_IN_MS`] before the start). They can
//!   edit or cancel it; everyone signed up hears.
//! - **Signing up:** the first `players` to sign up have seats; the rest are
//!   its waitlist, in order. Someone leaving gives their seat to the first on
//!   the waitlist.
//! - **Check-in:** from when the window opens until the start, anyone signed
//!   up or waitlisted checks in.
//! - **The start:** signed-up players who checked in keep their seats; those
//!   who didn't are no-shows, and their seats go to checked-in waitlist
//!   players, in order; anyone checked in left over joins the game's live
//!   waitlist ([`crate::lists`]). Tables of the game open and each player's
//!   seat is held for them there, to buy in. Too few checked in: the owner
//!   decides, start short or cancel.
//!
//! The caller times it ([`Club::next_scheduled_due`], then
//! [`Club::scheduled_due`]), starts the tables that open and sends the news.

use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::interest::MenuGame;
use crate::rules::{Club, RuleError, Status, random36, refuse};

/// When check-in opens, by default: before the start.
pub const CHECK_IN_MS: u64 = 60 * 60_000;
/// How long a seat given at the start is held for its player to sit down.
pub const SEAT_HOLD_MS: u64 = 10 * 60_000;
/// A start this late (the club was asleep) is left to the owner.
pub const LATE_MS: u64 = 30 * 60_000;
/// How long a started or cancelled game is still shown to those signed up.
pub const SHOWN_MS: u64 = 6 * 60 * 60_000;
/// How long a started or cancelled game is kept, for the owner.
pub const KEPT_MS: u64 = 3 * 24 * 60 * 60_000;
/// The most players a game can be for.
pub const MAX_PLAYERS: u32 = 60;
/// Who seats held at the start are by.
pub const SCHEDULED_BY: &str = "scheduled";

/// Where a scheduled game is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SchedStatus {
    /// Not started: sign-up and check-in.
    #[default]
    Upcoming,
    /// Its start came with too few checked in: the owner decides.
    Short,
    /// Its tables opened.
    Started,
    /// The owner cancelled it.
    Cancelled,
}

/// Someone signed up.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SignUp {
    /// The member.
    pub member: String,
    /// When they signed up.
    pub at: u64,
    /// When they checked in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_in: Option<u64>,
    /// When a waitlist place of theirs became a seat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub promoted: Option<u64>,
    /// At the start: "seated", "noShow", "waitlist" (on the game's live
    /// list) or "out" (waitlisted, not checked in).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub result: String,
    /// The table their seat is at, once it started.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub table: String,
}

/// A scheduled cash game.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scheduled {
    /// Its id.
    pub id: String,
    /// The game, as it was when scheduled.
    pub game: MenuGame,
    /// When it starts (ms since the epoch, UTC).
    pub start_at: u64,
    /// How many players it seats, over all its tables.
    pub players: u32,
    /// The fewest checked in to start without asking the owner.
    pub min_players: u32,
    /// How long before the start check-in opens.
    pub check_in_ms: u64,
    /// Where it is.
    pub status: SchedStatus,
    /// Who signed up, in order: the first `players` have seats.
    pub signups: Vec<SignUp>,
    /// When it was scheduled.
    pub created_at: u64,
    /// When the owner last changed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<u64>,
    /// Whether those signed up were told check-in is open.
    pub check_in_told: bool,
    /// When it started or was cancelled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// The tables it opened.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<String>,
    /// Why it couldn't start, for the owner.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl Scheduled {
    /// When check-in opens.
    pub fn check_in_at(&self) -> u64 {
        self.start_at.saturating_sub(self.check_in_ms)
    }

    /// Whether check-in is open at `now`.
    pub fn check_in_open(&self, now: u64) -> bool {
        self.status == SchedStatus::Upcoming && now >= self.check_in_at() && now < self.start_at
    }

    /// Member `id`'s place: 0 with a seat, else their place on the waitlist
    /// from 1. None if they're not signed up.
    pub fn place(&self, id: &str) -> Option<usize> {
        let i = self.signups.iter().position(|s| s.member == id)?;
        let seats = self.players as usize;
        Some(if i < seats { 0 } else { i - seats + 1 })
    }

    /// Those with seats, then the waitlist.
    pub fn split(&self) -> (&[SignUp], &[SignUp]) {
        let n = (self.players as usize).min(self.signups.len());
        self.signups.split_at(n)
    }

    /// Who plays at the start: (seated, no-shows, checked-in left over, the
    /// waitlist not checked in). Checked-in players keep their seats; no-shows'
    /// seats go to the checked-in waitlist, in order.
    pub fn line_up(&self) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>) {
        let (seats, wait) = self.split();
        let ids = |v: Vec<&SignUp>| v.into_iter().map(|s| s.member.clone()).collect::<Vec<_>>();
        let mut seated = ids(seats.iter().filter(|s| s.checked_in.is_some()).collect());
        let no_shows = ids(seats.iter().filter(|s| s.checked_in.is_none()).collect());
        let free = (self.players as usize).saturating_sub(seated.len());
        let waiting = ids(wait.iter().filter(|s| s.checked_in.is_some()).collect());
        let out = ids(wait.iter().filter(|s| s.checked_in.is_none()).collect());
        let (fill, left) = waiting.split_at(free.min(waiting.len()));
        seated.extend(fill.iter().cloned());
        (seated, no_shows, left.to_vec(), out)
    }
}

/// What the caller sends and does after a scheduled game changes.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedNews {
    /// Messages to sign and send now: `{to, body}`.
    pub sends: Vec<Value>,
    /// Tables that opened: start them, then send `after_open`.
    pub opened: Vec<String>,
    /// Messages to send once they run: `{to, body}`.
    pub after_open: Vec<Value>,
    /// Members whose waitlists changed.
    pub lists_to: Vec<String>,
}

/// The owner's choices for a scheduled game.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SchedSpec {
    key: Option<String>,
    start_at: Option<u64>,
    players: Option<u32>,
    min_players: Option<u32>,
    check_in_mins: Option<u64>,
}

impl Club {
    /// Scheduled game `id`.
    pub fn scheduled_game(&self, id: &str) -> Option<&Scheduled> {
        self.scheduled.iter().find(|g| g.id == id)
    }

    fn scheduled_mut(&mut self, id: &str) -> Result<&mut Scheduled, RuleError> {
        match self.scheduled.iter_mut().find(|g| g.id == id) {
            Some(g) => Ok(g),
            None => refuse("That game isn’t scheduled."),
        }
    }

    /// The game with key `key`, from the menu or a table dealing it.
    fn game_for(&self, key: &str) -> Option<MenuGame> {
        if let Some(g) = self.offered(key) {
            return Some(g.clone());
        }
        let t = self.open_tables().find(|t| t.game_key() == key)?;
        Some(MenuGame {
            key: key.into(),
            name: String::new(),
            game: t.game.clone(),
            sb: t.sb,
            bb: t.bb,
            min_bb: t.min_bb,
            max_bb: t.max_bb,
            seats: t.seats,
            turn_secs: t.turn_secs,
            sit_out_mins: t.sit_out_mins,
            stay_hands: t.stay_hands,
            charge: t.charge,
        })
    }

    /// A scheduled game's name: "NLH - 1/2".
    pub fn scheduled_name(&self, g: &Scheduled) -> String {
        // The game's own name, not a table's ("NLH - 1/2 - #2").
        let name = self.default_table_name(&g.game.game, g.game.sb, g.game.bb);
        match name.rsplit_once(" - #") {
            Some((base, n)) if n.chars().all(|c| c.is_ascii_digit()) => base.to_string(),
            _ => name,
        }
    }

    fn check_spec(g: &mut Scheduled, s: &SchedSpec, now: u64) -> Result<(), RuleError> {
        if let Some(at) = s.start_at {
            g.start_at = at;
        }
        if let Some(p) = s.players {
            g.players = p;
        }
        if let Some(m) = s.min_players {
            g.min_players = m;
        }
        if let Some(c) = s.check_in_mins {
            g.check_in_ms = c * 60_000;
        }
        if g.start_at <= now {
            return refuse("Pick a time ahead.");
        }
        if !(2..=MAX_PLAYERS).contains(&g.players) {
            return refuse(format!("Players: 2 to {MAX_PLAYERS}."));
        }
        if !(2..=g.players).contains(&g.min_players) {
            return refuse(format!("Fewest to start: 2 to {}.", g.players));
        }
        if !(5 * 60_000..=24 * 60 * 60_000).contains(&g.check_in_ms) {
            return refuse("Check-in opens 5 minutes to 24 hours before.");
        }
        Ok(())
    }

    /// Schedules game `spec.key` (`{key, startAt, players, minPlayers,
    /// checkInMins}`): one the club offers or deals.
    pub fn schedule_game(
        &mut self,
        spec: &Value,
        now: u64,
        rng: &mut StdRng,
    ) -> Result<&Scheduled, RuleError> {
        let s: SchedSpec = serde_json::from_value(spec.clone())
            .map_err(|_| RuleError("Pick a game and a time.".into()))?;
        let Some(game) = s.key.as_deref().and_then(|k| self.game_for(k)) else {
            return refuse("Pick a game the club offers.");
        };
        let mut g = Scheduled {
            id: random36(rng, 8),
            players: game.seats,
            min_players: 2,
            check_in_ms: CHECK_IN_MS,
            game,
            created_at: now,
            ..Scheduled::default()
        };
        Self::check_spec(&mut g, &s, now)?;
        self.scheduled.push(g);
        Ok(self.scheduled.last().expect("just added"))
    }

    fn sched_body(&self, g: &Scheduled, kind: &str) -> Value {
        json!({"type": "sched", "club": self.code, "kind": kind, "id": g.id,
               "name": self.scheduled_name(g), "startAt": g.start_at})
    }

    fn tell_all(&self, g: &Scheduled, kind: &str) -> Vec<Value> {
        let body = self.sched_body(g, kind);
        g.signups
            .iter()
            .map(|s| json!({"to": s.member, "body": body}))
            .collect()
    }

    /// Those newly given a seat (waitlisted in `before`, with one now): they
    /// hear it.
    fn seats_given(&mut self, id: &str, before: &[String], now: u64) -> Vec<Value> {
        let Some(i) = self.scheduled.iter().position(|g| g.id == id) else {
            return vec![];
        };
        let seats = self.scheduled[i].players as usize;
        let mut got = vec![];
        for (n, s) in self.scheduled[i].signups.iter_mut().enumerate() {
            if n < seats && !before.contains(&s.member) {
                s.promoted = Some(now);
                got.push(s.member.clone());
            }
        }
        let body = self.sched_body(&self.scheduled[i], "seat");
        got.into_iter()
            .map(|m| json!({"to": m, "body": body}))
            .collect()
    }

    fn with_seats(&self, id: &str) -> Vec<String> {
        self.scheduled_game(id).map_or(vec![], |g| {
            g.split().0.iter().map(|s| s.member.clone()).collect()
        })
    }

    /// The owner changes scheduled game `id` (`{startAt, players,
    /// minPlayers, checkInMins}`, each optional); everyone signed up hears.
    pub fn edit_scheduled(
        &mut self,
        id: &str,
        spec: &Value,
        now: u64,
    ) -> Result<SchedNews, RuleError> {
        let s: SchedSpec =
            serde_json::from_value(spec.clone()).map_err(|_| RuleError("Pick a time.".into()))?;
        let before = self.with_seats(id);
        let g = self.scheduled_mut(id)?;
        if !matches!(g.status, SchedStatus::Upcoming | SchedStatus::Short) {
            return refuse("That game has started or was cancelled.");
        }
        let mut edited = g.clone();
        Self::check_spec(&mut edited, &s, now)?;
        let moved = edited.start_at != g.start_at || edited.check_in_ms != g.check_in_ms;
        edited.edited_at = Some(now);
        edited.status = SchedStatus::Upcoming;
        edited.note.clear();
        if moved && now < edited.check_in_at() {
            edited.check_in_told = false;
        }
        *g = edited;
        let g = self.scheduled_game(id).expect("just changed").clone();
        let mut out = SchedNews {
            sends: self.tell_all(&g, "edited"),
            ..SchedNews::default()
        };
        out.sends.extend(self.seats_given(id, &before, now));
        Ok(out)
    }

    /// The owner cancels scheduled game `id`; everyone signed up hears.
    pub fn cancel_scheduled(&mut self, id: &str, now: u64) -> Result<SchedNews, RuleError> {
        let g = self.scheduled_mut(id)?;
        if !matches!(g.status, SchedStatus::Upcoming | SchedStatus::Short) {
            return refuse("That game has started or was cancelled.");
        }
        g.status = SchedStatus::Cancelled;
        g.ended_at = Some(now);
        let g = g.clone();
        Ok(SchedNews {
            sends: self.tell_all(&g, "cancelled"),
            ..SchedNews::default()
        })
    }

    /// Member `who` signs up for scheduled game `id`: their place (0, a
    /// seat; else on the waitlist from 1).
    pub fn sched_sign_up(&mut self, id: &str, who: &str, now: u64) -> Result<SchedNews, RuleError> {
        if !self
            .members
            .get(who)
            .is_some_and(|m| m.status == Status::Member)
        {
            return refuse("Only club members can sign up.");
        }
        let g = self.scheduled_mut(id)?;
        if g.status != SchedStatus::Upcoming || now >= g.start_at {
            return refuse("Sign-up for that game has closed.");
        }
        if g.signups.iter().any(|s| s.member == who) {
            return refuse("You’re signed up already.");
        }
        g.signups.push(SignUp {
            member: who.into(),
            at: now,
            ..SignUp::default()
        });
        let g = g.clone();
        let mut body = self.sched_body(&g, "confirmed");
        body["place"] = g.place(who).unwrap_or(0).into();
        Ok(SchedNews {
            sends: vec![json!({"to": who, "body": body})],
            ..SchedNews::default()
        })
    }

    /// Member `who` leaves scheduled game `id`: their seat goes to the first
    /// on the waitlist, who hears it.
    pub fn sched_leave(&mut self, id: &str, who: &str, now: u64) -> Result<SchedNews, RuleError> {
        let before = self.with_seats(id);
        let g = self.scheduled_mut(id)?;
        if g.status != SchedStatus::Upcoming {
            return refuse("That game has started or was cancelled.");
        }
        let Some(i) = g.signups.iter().position(|s| s.member == who) else {
            return refuse("You’re not signed up.");
        };
        g.signups.remove(i);
        Ok(SchedNews {
            sends: self.seats_given(id, &before, now),
            ..SchedNews::default()
        })
    }

    /// Member `who`, signed up or waitlisted, checks in to scheduled game
    /// `id` while check-in is open.
    pub fn sched_check_in(
        &mut self,
        id: &str,
        who: &str,
        now: u64,
    ) -> Result<SchedNews, RuleError> {
        let g = self.scheduled_mut(id)?;
        if !g.check_in_open(now) {
            return refuse("Check-in isn’t open.");
        }
        let Some(s) = g.signups.iter_mut().find(|s| s.member == who) else {
            return refuse("You’re not signed up.");
        };
        s.checked_in.get_or_insert(now);
        Ok(SchedNews::default())
    }

    /// When a scheduled game next needs the caller: check-in opening or a
    /// start.
    pub fn next_scheduled_due(&self) -> Option<u64> {
        self.scheduled
            .iter()
            .filter(|g| g.status == SchedStatus::Upcoming)
            .map(|g| {
                if g.check_in_told {
                    g.start_at
                } else {
                    g.check_in_at().min(g.start_at)
                }
            })
            .min()
    }

    /// What's due at `now`: check-in opening (those signed up hear), and
    /// starts. A start with fewer than its fewest checked in, or long late,
    /// waits for the owner. `most`: the plan's tables open at once.
    pub fn scheduled_due(&mut self, now: u64, most: Option<u64>, rng: &mut StdRng) -> SchedNews {
        let mut out = SchedNews::default();
        self.scheduled.retain(|g| {
            g.status == SchedStatus::Upcoming
                || g.status == SchedStatus::Short
                || g.ended_at.unwrap_or(g.start_at) + KEPT_MS > now
        });
        let ids: Vec<String> = self
            .scheduled
            .iter()
            .filter(|g| g.status == SchedStatus::Upcoming)
            .map(|g| g.id.clone())
            .collect();
        for id in ids {
            let g = self.scheduled_game(&id).expect("listed").clone();
            if now >= g.start_at {
                let (seated, ..) = g.line_up();
                if seated.len() < g.min_players as usize || now >= g.start_at + LATE_MS {
                    self.short(&id, &mut out);
                } else if let Err(e) = self.start_scheduled_into(&id, now, most, rng, &mut out) {
                    self.short(&id, &mut out);
                    if let Ok(g) = self.scheduled_mut(&id) {
                        g.note = e.0;
                    }
                }
            } else if !g.check_in_told && now >= g.check_in_at() {
                if let Ok(g) = self.scheduled_mut(&id) {
                    g.check_in_told = true;
                }
                out.sends.extend(self.tell_all(&g, "checkin"));
            }
        }
        out
    }

    fn short(&mut self, id: &str, out: &mut SchedNews) {
        let Ok(g) = self.scheduled_mut(id) else {
            return;
        };
        g.status = SchedStatus::Short;
        let g = g.clone();
        let body = self.sched_body(&g, "short");
        for s in g.signups.iter().filter(|s| s.checked_in.is_some()) {
            out.sends.push(json!({"to": s.member, "body": body}));
        }
    }

    /// The owner starts scheduled game `id` now, short if they choose.
    pub fn start_scheduled(
        &mut self,
        id: &str,
        now: u64,
        most: Option<u64>,
        rng: &mut StdRng,
    ) -> Result<SchedNews, RuleError> {
        let mut out = SchedNews::default();
        self.start_scheduled_into(id, now, most, rng, &mut out)?;
        Ok(out)
    }

    fn start_scheduled_into(
        &mut self,
        id: &str,
        now: u64,
        most: Option<u64>,
        rng: &mut StdRng,
        out: &mut SchedNews,
    ) -> Result<(), RuleError> {
        let g = self.scheduled_game(id).cloned();
        let Some(g) = g.filter(|g| matches!(g.status, SchedStatus::Upcoming | SchedStatus::Short))
        else {
            return refuse("That game has started or was cancelled.");
        };
        let (seated, no_shows, left, not_in) = g.line_up();
        if seated.is_empty() {
            return refuse("No one checked in.");
        }
        // As many tables as it takes, players spread evenly over them, in
        // their order.
        let per = g.game.seats.max(2) as usize;
        let want = seated.len().div_ceil(per);
        let spec = g.game.spec();
        let mut tables: Vec<(String, String)> = vec![];
        let mut why = None;
        for _ in 0..want {
            match self.new_table(&spec, now, most, rng) {
                Ok(t) => tables.push((t.id.clone(), t.name.clone())),
                Err(e) => {
                    why = Some(e);
                    break;
                }
            }
        }
        if tables.is_empty() {
            return Err(why.unwrap_or_else(|| RuleError("No table could open.".into())));
        }
        // Each table gets players in turn, up to its seats; any left over
        // (the plan's tables ran out) wait on the game's list.
        let n = tables.len();
        let fits = n * per;
        let mut results: Vec<(String, &str, String)> = vec![];
        let mut waiting: Vec<String> = vec![];
        for (i, m) in seated.iter().enumerate() {
            if i >= fits {
                waiting.push(m.clone());
                continue;
            }
            let (tid, name) = &tables[i % n];
            let from = self
                .members
                .get(m)
                .and_then(|x| x.seat_table())
                .map(str::to_string);
            let _ = self.reserve_seat(
                m,
                tid,
                0,
                from.as_deref(),
                Some(SCHEDULED_BY),
                now,
                SEAT_HOLD_MS,
            );
            let mut body = self.sched_body(&g, "start");
            body["table"] = tid.clone().into();
            body["tableName"] = name.clone().into();
            out.after_open.push(json!({"to": m, "body": body}));
            results.push((m.clone(), "seated", tid.clone()));
        }
        waiting.extend(left);
        for m in &waiting {
            if self.join_list(m, &g.game.key, now).is_ok() {
                out.lists_to.push(m.clone());
            }
            out.after_open
                .push(json!({"to": m, "body": self.sched_body(&g, "waitlist")}));
            results.push((m.clone(), "waitlist", String::new()));
        }
        for m in &no_shows {
            results.push((m.clone(), "noShow", String::new()));
        }
        for m in &not_in {
            results.push((m.clone(), "out", String::new()));
        }
        let ids: Vec<String> = tables.iter().map(|(t, _)| t.clone()).collect();
        let g = self.scheduled_mut(id).expect("checked");
        for (m, r, t) in results {
            if let Some(s) = g.signups.iter_mut().find(|s| s.member == m) {
                s.result = r.into();
                s.table = t;
            }
        }
        g.status = SchedStatus::Started;
        g.ended_at = Some(now);
        g.tables = ids.clone();
        g.note.clear();
        out.opened.extend(ids);
        Ok(())
    }

    /// What member `id` is told of the scheduled games: those coming up, and
    /// those they signed up for that started or were cancelled lately. Each
    /// `{id, name, game, sb, bb, min, max, seats, players, startAt,
    /// checkInAt, status, checkInOpen, taken, waiting, mine}`; `mine` (signed up):
    /// `{place, checkedIn, promoted, edited, result, table}`.
    pub fn scheduled_for(&self, id: &str, now: u64) -> Value {
        let games: Vec<Value> = self
            .scheduled
            .iter()
            .filter_map(|g| {
                let s = g.signups.iter().find(|s| s.member == id);
                let live = matches!(g.status, SchedStatus::Upcoming | SchedStatus::Short);
                if !live && (s.is_none() || g.ended_at.unwrap_or(0) + SHOWN_MS <= now) {
                    return None;
                }
                let (seats, wait) = g.split();
                let mut v = json!({
                    "id": g.id, "name": self.scheduled_name(g), "key": g.game.key, "game": g.game.game,
                    "sb": g.game.sb, "bb": g.game.bb, "min": g.game.min_bb * g.game.bb,
                    "max": g.game.max_bb * g.game.bb, "seats": g.game.seats, "players": g.players,
                    "startAt": g.start_at, "checkInAt": g.check_in_at(), "status": g.status,
                    "checkInOpen": g.check_in_open(now),
                    "taken": seats.len(), "waiting": wait.len(),
                });
                if let Some(s) = s {
                    v["mine"] = json!({
                        "place": g.place(id).unwrap_or(0), "checkedIn": s.checked_in.is_some(),
                        "promoted": s.promoted.is_some(),
                        "edited": g.edited_at.is_some_and(|e| e > s.at),
                        "result": s.result, "table": s.table,
                    });
                }
                Some(v)
            })
            .collect();
        json!({"type": "scheduled", "club": self.code, "games": games})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::TableStatus;
    use rand::SeedableRng;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(5)
    }

    const K: &str = "nlhe:1/2:6";
    const H: u64 = 60 * 60_000;
    // Thursday's game: 7:00 PM, check-in from 6:00.
    const START: u64 = 100 * H;

    // A club with members `ids`, offering Hold'em 1/2 6-max.
    fn club(ids: &[&str]) -> Club {
        let mut members = serde_json::Map::new();
        for id in ids {
            members.insert(
                (*id).into(),
                json!({"id": id, "name": id.to_uppercase(), "status": "member"}),
            );
        }
        let mut c: Club = serde_json::from_value(
            json!({"code": "ABCD-EFGH", "hostId": "HOST", "members": members}),
        )
        .unwrap();
        c.offer_game(
            &json!({"game": "nlhe", "sb": 1, "bb": 2, "seats": 6}),
            &mut rng(),
        )
        .unwrap();
        c
    }

    fn schedule(c: &mut Club, players: u32, min: u32) -> String {
        c.schedule_game(
            &json!({"key": K, "startAt": START, "players": players, "minPlayers": min}),
            0,
            &mut rng(),
        )
        .unwrap()
        .id
        .clone()
    }

    fn kinds(n: &[Value]) -> Vec<(String, String)> {
        n.iter()
            .map(|s| {
                (
                    s["to"].as_str().unwrap().to_string(),
                    s["body"]["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn setting_it_up() {
        let mut c = club(&["a"]);
        let id = schedule(&mut c, 6, 2);
        let g = c.scheduled_game(&id).unwrap();
        assert_eq!(g.game.key, K);
        assert_eq!(g.check_in_at(), START - H);
        assert_eq!(c.scheduled_name(g), "NLH - 0.01/0.02");
        let bad = |spec: Value| c.clone().schedule_game(&spec, 0, &mut rng()).unwrap_err().0;
        assert!(bad(json!({"key": "plo4:1/2:6", "startAt": START})).contains("offers"));
        assert!(bad(json!({"key": K, "startAt": 0})).contains("ahead"));
        assert!(bad(json!({"key": K, "startAt": START, "players": 1})).contains("Players"));
        assert!(
            bad(json!({"key": K, "startAt": START, "players": 6, "minPlayers": 7}))
                .contains("Fewest")
        );
        // Defaults: a table's worth, 2 to start, check-in an hour before.
        let d = c
            .schedule_game(&json!({"key": K, "startAt": START}), 0, &mut rng())
            .unwrap()
            .clone();
        assert_eq!(
            (d.players, d.min_players, d.check_in_ms),
            (6, 2, CHECK_IN_MS)
        );
        // A game the club deals but doesn't offer.
        c.tables.push(crate::rules::Table {
            id: "t".into(),
            game: "plo4".into(),
            sb: 5,
            bb: 10,
            seats: 9,
            status: TableStatus::Open,
            ..Default::default()
        });
        assert!(
            c.schedule_game(
                &json!({"key": "plo4:5/10:9", "startAt": START}),
                0,
                &mut rng()
            )
            .is_ok()
        );
    }

    #[test]
    fn sign_up_and_the_waitlist() {
        let mut c = club(&["a", "b", "c", "d", "z"]);
        let id = schedule(&mut c, 2, 2);
        let n = c.sched_sign_up(&id, "a", 1).unwrap();
        assert_eq!(n.sends[0]["body"]["kind"], "confirmed");
        assert_eq!(n.sends[0]["body"]["place"], 0);
        c.sched_sign_up(&id, "b", 2).unwrap();
        // Seats full: c and d wait, 1st and 2nd.
        assert_eq!(
            c.sched_sign_up(&id, "c", 3).unwrap().sends[0]["body"]["place"],
            1
        );
        c.sched_sign_up(&id, "d", 4).unwrap();
        assert_eq!(c.scheduled_game(&id).unwrap().place("d"), Some(2));
        assert!(
            c.sched_sign_up(&id, "a", 5)
                .unwrap_err()
                .0
                .contains("already")
        );
        c.members.get_mut("z").unwrap().status = Status::Pending;
        assert!(c.sched_sign_up(&id, "z", 5).is_err());
        // What d sees.
        let v = c.scheduled_for("d", 5);
        assert_eq!(v["games"][0]["taken"], 2);
        assert_eq!(v["games"][0]["waiting"], 2);
        assert_eq!(v["games"][0]["mine"]["place"], 2);
        // Someone not signed up sees it too, with no `mine`.
        assert!(c.scheduled_for("z", 5)["games"][0].get("mine").is_none());
        // a leaves: c gets the seat and hears it; d is 1st on the waitlist.
        let n = c.sched_leave(&id, "a", 6).unwrap();
        assert_eq!(kinds(&n.sends), vec![("c".into(), "seat".into())]);
        assert_eq!(c.scheduled_game(&id).unwrap().place("d"), Some(1));
        assert_eq!(
            c.scheduled_for("c", 6)["games"][0]["mine"]["promoted"],
            true
        );
        assert!(c.sched_leave(&id, "a", 7).is_err());
        // More players: d gets a seat too.
        let n = c.edit_scheduled(&id, &json!({"players": 3}), 8).unwrap();
        assert!(kinds(&n.sends).contains(&("d".into(), "seat".into())));
        assert!(kinds(&n.sends).contains(&("b".into(), "edited".into())));
        assert_eq!(c.scheduled_for("b", 8)["games"][0]["mine"]["edited"], true);
    }

    #[test]
    fn check_in_opens_an_hour_before() {
        let mut c = club(&["a", "b"]);
        let id = schedule(&mut c, 6, 2);
        c.sched_sign_up(&id, "a", 1).unwrap();
        assert_eq!(c.next_scheduled_due(), Some(START - H));
        assert!(
            c.sched_check_in(&id, "a", START - H - 1)
                .unwrap_err()
                .0
                .contains("isn’t open")
        );
        // Not yet.
        assert!(
            c.scheduled_due(START - H - 1, None, &mut rng())
                .sends
                .is_empty()
        );
        let n = c.scheduled_due(START - H, None, &mut rng());
        assert_eq!(kinds(&n.sends), vec![("a".into(), "checkin".into())]);
        // Told once; next, the start.
        assert!(
            c.scheduled_due(START - H + 1, None, &mut rng())
                .sends
                .is_empty()
        );
        assert_eq!(c.next_scheduled_due(), Some(START));
        c.sched_check_in(&id, "a", START - 10).unwrap();
        assert!(
            c.sched_check_in(&id, "b", START - 10)
                .unwrap_err()
                .0
                .contains("not signed up")
        );
        // Signing up in the window, then checking in, is fine.
        c.sched_sign_up(&id, "b", START - 5).unwrap();
        c.sched_check_in(&id, "b", START - 5).unwrap();
        assert_eq!(
            c.scheduled_for("a", START - 1)["games"][0]["mine"]["checkedIn"],
            true
        );
        // Closed at the start.
        assert!(c.sched_check_in(&id, "a", START).is_err());
        // Moved later: check-in is told again when it reopens.
        let mut d = club(&["a"]);
        let id = schedule(&mut d, 6, 2);
        d.sched_sign_up(&id, "a", 1).unwrap();
        d.scheduled_due(START - H, None, &mut rng());
        d.edit_scheduled(&id, &json!({"startAt": START + 5 * H}), START - H + 1)
            .unwrap();
        assert_eq!(d.next_scheduled_due(), Some(START + 4 * H));
    }

    #[test]
    fn no_shows_give_their_seats_to_the_checked_in_waitlist() {
        let ids = ["a", "b", "c", "d", "e", "f"];
        let mut c = club(&ids);
        let id = schedule(&mut c, 3, 2);
        for (i, m) in ids.iter().enumerate() {
            c.sched_sign_up(&id, m, i as u64).unwrap();
        }
        // a, b, c have seats; d, e, f wait. b doesn't come; d doesn't check
        // in; e and f do.
        for m in ["a", "c", "e", "f"] {
            c.sched_check_in(&id, m, START - 100).unwrap();
        }
        let (seated, no_shows, left, out) = c.scheduled_game(&id).unwrap().line_up();
        assert_eq!(seated, ["a", "c", "e"]);
        assert_eq!(no_shows, ["b"]);
        assert_eq!(left, ["f"]);
        assert_eq!(out, ["d"]);
        let n = c.scheduled_due(START, None, &mut rng());
        // One table of the game opens, its seats held for a, c and e.
        assert_eq!(n.opened.len(), 1);
        let tid = &n.opened[0];
        assert_eq!(c.table(tid).unwrap().game_key(), K);
        assert_eq!(c.held_seats(tid, START, ""), 3);
        let told = kinds(&n.after_open);
        assert!(told.contains(&("e".into(), "start".into())));
        assert_eq!(n.after_open[0]["body"]["table"], tid.as_str());
        // f, checked in, left over: on the game's live waitlist.
        assert!(told.contains(&("f".into(), "waitlist".into())));
        assert_eq!(c.place_on_list("f", K), Some(1));
        assert_eq!(n.lists_to, ["f"]);
        let g = c.scheduled_game(&id).unwrap();
        assert_eq!(g.status, SchedStatus::Started);
        let result = |m: &str| {
            g.signups
                .iter()
                .find(|s| s.member == m)
                .unwrap()
                .result
                .clone()
        };
        assert_eq!(result("b"), "noShow");
        assert_eq!(result("d"), "out");
        assert_eq!(result("e"), "seated");
        // Its name is the game's, not "#2" after its own table took the name.
        assert_eq!(c.scheduled_name(g), "NLH - 0.01/0.02");
        assert_eq!(
            c.scheduled_for("e", START)["games"][0]["mine"]["table"],
            tid.as_str()
        );
        // Nothing more due; no sign-up now.
        assert_eq!(c.next_scheduled_due(), None);
        assert!(c.sched_sign_up(&id, "b", START).is_err());
    }

    #[test]
    fn more_than_a_table_spreads_them_out() {
        let ids: Vec<String> = (0..8).map(|i| format!("p{i}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut c = club(&refs);
        let id = schedule(&mut c, 12, 2);
        for m in &refs {
            c.sched_sign_up(&id, m, 1).unwrap();
            c.sched_check_in(&id, m, START - 1).unwrap();
        }
        let n = c.scheduled_due(START, None, &mut rng());
        assert_eq!(n.opened.len(), 2);
        assert_eq!(c.held_seats(&n.opened[0], START, ""), 4);
        assert_eq!(c.held_seats(&n.opened[1], START, ""), 4);
        // The plan allows one table: the second table's players wait on the list.
        let mut c = club(&refs);
        let id = schedule(&mut c, 12, 2);
        for m in &refs {
            c.sched_sign_up(&id, m, 1).unwrap();
            c.sched_check_in(&id, m, START - 1).unwrap();
        }
        let n = c.scheduled_due(START, Some(1), &mut rng());
        assert_eq!(n.opened.len(), 1);
        assert_eq!(c.held_seats(&n.opened[0], START, ""), 6);
        assert_eq!(c.list(K).len(), 2);
    }

    #[test]
    fn too_few_checked_in_asks_the_owner() {
        let mut c = club(&["a", "b", "c"]);
        let id = schedule(&mut c, 6, 3);
        for m in ["a", "b", "c"] {
            c.sched_sign_up(&id, m, 1).unwrap();
        }
        c.sched_check_in(&id, "a", START - 1).unwrap();
        c.sched_check_in(&id, "b", START - 1).unwrap();
        // Two of the three needed: no table; those checked in hear it's short.
        let n = c.scheduled_due(START, None, &mut rng());
        assert!(n.opened.is_empty());
        assert_eq!(
            kinds(&n.sends),
            vec![("a".into(), "short".into()), ("b".into(), "short".into())]
        );
        assert_eq!(c.scheduled_game(&id).unwrap().status, SchedStatus::Short);
        assert_eq!(c.next_scheduled_due(), None);
        assert!(c.tables.is_empty());
        // The owner starts it short: a and b get seats, c is a no-show.
        let n = c
            .start_scheduled(&id, START + 60_000, None, &mut rng())
            .unwrap();
        assert_eq!(n.opened.len(), 1);
        assert_eq!(c.held_seats(&n.opened[0], START + 60_000, ""), 2);
        assert!(c.start_scheduled(&id, START, None, &mut rng()).is_err());
        // Or cancels it: everyone signed up hears.
        let mut d = club(&["a", "b"]);
        let id = schedule(&mut d, 6, 2);
        d.sched_sign_up(&id, "a", 1).unwrap();
        d.sched_sign_up(&id, "b", 1).unwrap();
        d.scheduled_due(START, None, &mut rng());
        let n = d.cancel_scheduled(&id, START + 1).unwrap();
        assert_eq!(kinds(&n.sends).len(), 2);
        assert_eq!(n.sends[0]["body"]["kind"], "cancelled");
        assert_eq!(
            d.scheduled_for("a", START + 1)["games"][0]["status"],
            "cancelled"
        );
        // Shown a while to those signed up, kept a while for the owner.
        assert!(
            d.scheduled_for("a", START + 1 + SHOWN_MS)["games"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        d.scheduled_due(START + 1 + KEPT_MS, None, &mut rng());
        assert!(d.scheduled.is_empty());
    }

    #[test]
    fn a_start_missed_long_ago_waits_for_the_owner() {
        let mut c = club(&["a", "b"]);
        let id = schedule(&mut c, 6, 2);
        for m in ["a", "b"] {
            c.sched_sign_up(&id, m, 1).unwrap();
            c.sched_check_in(&id, m, START - 1).unwrap();
        }
        let n = c.scheduled_due(START + LATE_MS, None, &mut rng());
        assert!(n.opened.is_empty());
        assert_eq!(c.scheduled_game(&id).unwrap().status, SchedStatus::Short);
    }
}

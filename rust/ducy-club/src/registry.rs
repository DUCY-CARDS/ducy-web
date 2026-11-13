//! The relay's registry of always-on clubs (ducy-web #98, #265, #463, #654):
//! who may have a club, each club's plan and limits, whether it may run, its
//! use, and the super admin's changes.
//!
//! The relay keeps the registry's parts in its storage (ducy-web's
//! relay/src/registry.js: a Durable Object on the Worker); each op takes
//! them in and gives back what changed. Times are milliseconds.
//!
//! - **Creating a club** takes the super admin's permission (a grant),
//!   except for each player's one trial club, free for [`TRIAL_DAYS`] with
//!   the free limits.
//! - **Every club is kept** (#654) until its owner or the super admin
//!   deletes it; none is deleted for going unused.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The free limits: a trial club's, and a granted club's unless raised.
pub const FREE_LIMITS: PlanLimits = PlanLimits {
    tables: 2,
    tourneys_per_day: 1,
};
/// How long a trial club is free, in days.
pub const TRIAL_DAYS: u64 = 14;
/// Days of use kept on each club.
pub const DAYS_KEPT: u64 = 30;
/// About what a club costs while its tables run: its object awake at 128 MB.
pub const GBS_PER_CLUB_MINUTE: f64 = 0.128 * 60.0;
/// What Workers Free allows a day.
pub const FREE_GBS_PER_DAY: f64 = 13_000.0;
/// The most of each limit a super admin may set.
const MAX_LIMIT: u64 = 50;
const DAY_MS: u64 = 86_400_000;

/// What a club may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    /// Tables open at once.
    pub tables: u64,
    /// Tournaments a day.
    pub tourneys_per_day: u64,
}

impl Default for PlanLimits {
    fn default() -> Self {
        FREE_LIMITS
    }
}

/// A club's record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Record {
    /// Its owner's player ID.
    pub owner: String,
    /// When it was made.
    pub at: u64,
    /// Its name.
    pub name: String,
    /// "trial" or "club".
    pub plan: String,
    /// When a trial ends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<u64>,
    /// What it may do.
    pub limits: PlanLimits,
    /// Paused by the super admin.
    pub suspended: bool,
    /// When it was last used.
    pub last_active: u64,
    /// Minutes of play, all time.
    pub minutes: f64,
    /// Minutes of play by day (UTC), the last [`DAYS_KEPT`].
    pub days: BTreeMap<String, f64>,
    /// Anything else kept on it.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            owner: String::new(),
            at: 0,
            name: String::new(),
            plan: "club".into(),
            expires: None,
            limits: FREE_LIMITS,
            suspended: false,
            last_active: 0,
            minutes: 0.0,
            days: BTreeMap::new(),
            other: Map::new(),
        }
    }
}

impl Record {
    /// An older record, as it reads now: one with no `lastActive` was last
    /// used when it was made; a temporary club's flags (#395) are gone
    /// (#654).
    fn full(mut self, raw: &Value) -> Self {
        if raw.get("lastActive").is_none() {
            self.last_active = self.at;
        }
        self.other.remove("temporary");
        self.other.remove("provedAt");
        self
    }

    /// Whether it may run now: "" when it may, else why not.
    pub fn blocked(&self, now: u64) -> String {
        if self.suspended {
            return "ducy has paused this club. Its owner can ask ducy why.".into();
        }
        if self.plan == "trial" && self.expires.is_some_and(|e| now >= e) {
            return "This club’s free trial has ended. Its owner can ask ducy to keep it going."
                .into();
        }
        String::new()
    }
}

/// Permission to create clubs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Grant {
    /// When it was given.
    pub at: u64,
    /// The super admin's note.
    pub note: String,
    /// How many clubs; 0 for the relay's per-owner limit.
    pub max_clubs: u64,
    /// Each club's limits; none for the free ones.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<PlanLimits>,
}

/// The relay's own limits.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RelayLimits {
    /// Clubs for each owner.
    pub per_owner: u64,
    /// Clubs in all.
    pub total: u64,
    /// Player IDs allowed to create clubs from the environment.
    pub creators: Vec<String>,
    /// No trial clubs: only a grant lets a player create a club.
    pub no_trials: bool,
}

/// The registry's parts, as the relay stores them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Registry {
    /// Every club's record, by code.
    pub clubs: BTreeMap<String, Value>,
    /// Who may create clubs, by player ID.
    pub grants: BTreeMap<String, Grant>,
    /// Each player's trial club, by player ID.
    pub trials: BTreeMap<String, String>,
}

/// The day (UTC) of time `ms`, as YYYY-MM-DD.
pub fn day_of(ms: u64) -> String {
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = (ms / DAY_MS) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// A club's limits from an admin's input: whole numbers from 0 (0 tables
/// means none may open) up to a sane ceiling; anything missing or wrong keeps
/// `base`.
pub fn clean_limits(input: &Value, base: PlanLimits) -> PlanLimits {
    let pick = |k: &str, d: u64| {
        input
            .get(k)
            .and_then(Value::as_u64)
            .filter(|n| *n <= MAX_LIMIT)
            .unwrap_or(d)
    };
    PlanLimits {
        tables: pick("tables", base.tables),
        tourneys_per_day: pick("tourneysPerDay", base.tourneys_per_day),
    }
}

/// Whether `s` will do as a player ID in a grant.
fn id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl Registry {
    /// Club `code`'s record, as it reads now.
    pub fn record(&self, code: &str) -> Option<Record> {
        let raw = self.clubs.get(code)?;
        let r: Record = serde_json::from_value(raw.clone()).ok()?;
        Some(r.full(raw))
    }

    fn put(&mut self, code: &str, r: &Record) {
        self.clubs.insert(
            code.into(),
            serde_json::to_value(r).expect("a record serializes"),
        );
    }

    fn update(&mut self, code: &str, f: impl FnOnce(&mut Record)) -> Result<Record, String> {
        let mut r = self.record(code).ok_or("No such club.")?;
        f(&mut r);
        self.put(code, &r);
        Ok(r)
    }

    /// `owner` may have a club in room `code`, called `name`: with a grant,
    /// a club; without, their one trial club. Its record, or why not.
    pub fn claim(
        &mut self,
        owner: &str,
        code: &str,
        name: &str,
        limits: &RelayLimits,
        now: u64,
    ) -> Result<Record, String> {
        if self.clubs.contains_key(code) {
            return Err("That club code is in use.".into());
        }
        if self.clubs.len() as u64 >= limits.total {
            return Err("ducy’s server is full of clubs for now. Try again later.".into());
        }
        let grant = if limits.creators.iter().any(|c| c == owner) {
            Some(Grant::default())
        } else {
            self.grants.get(owner).cloned()
        };
        let mut r = Record {
            owner: owner.into(),
            at: now,
            last_active: now,
            name: name.into(),
            ..Record::default()
        };
        match grant {
            Some(g) => {
                let most = if g.max_clubs > 0 {
                    g.max_clubs
                } else {
                    limits.per_owner
                };
                let have = self
                    .clubs
                    .values()
                    .filter(|c| c.get("owner").and_then(Value::as_str) == Some(owner))
                    .count() as u64;
                if have >= most {
                    let what = if most == 1 { "club" } else { "clubs" };
                    return Err(format!(
                        "You already have {most} {what}, the most ducy has allowed you."
                    ));
                }
                r.limits = g.limits.unwrap_or(FREE_LIMITS);
            }
            None => {
                if limits.no_trials {
                    return Err("Starting a club takes permission from ducy.".into());
                }
                if self.trials.contains_key(owner) {
                    return Err("You’ve already had your free trial club. To run a club, ask ducy for permission.".into());
                }
                self.trials.insert(owner.into(), code.into());
                r.plan = "trial".into();
                r.expires = Some(now + TRIAL_DAYS * DAY_MS);
            }
        }
        self.put(code, &r);
        Ok(r)
    }

    /// Club `code`'s record and whether it may run now ("" or why not).
    pub fn status(&self, code: &str, now: u64) -> Value {
        let r = self.record(code);
        let blocked = r
            .as_ref()
            .map_or("This club isn’t on ducy’s server.".to_string(), |r| {
                r.blocked(now)
            });
        json!({"record": r, "blocked": blocked})
    }

    /// Club `code` was used: someone was active, and its tables were in
    /// play for `minutes` (0: active only).
    pub fn used(&mut self, code: &str, minutes: f64, now: u64) {
        let _ = self.update(code, |r| {
            r.last_active = r.last_active.max(now);
            if minutes > 0.0 {
                r.minutes += minutes;
                *r.days.entry(day_of(now)).or_insert(0.0) += minutes;
                let keep = day_of(now.saturating_sub(DAYS_KEPT * DAY_MS));
                r.days.retain(|d, _| *d >= keep);
            }
        });
    }

    /// Every club with its record, who may create clubs, and who had a trial.
    pub fn list(&self, limits: &RelayLimits, now: u64) -> Value {
        let clubs: Vec<Value> = self
            .clubs
            .keys()
            .filter_map(|code| {
                let r = self.record(code)?;
                let mut v = serde_json::to_value(&r).ok()?;
                v["code"] = code.clone().into();
                v["blocked"] = r.blocked(now).into();
                Some(v)
            })
            .collect();
        let mut grants = serde_json::to_value(&self.grants).unwrap_or_else(|_| json!({}));
        for id in &limits.creators {
            if grants.get(id).is_none() {
                grants[id] = json!({"fromEnv": true});
            }
        }
        json!({
            "clubs": clubs, "grants": grants, "trials": self.trials,
            "limits": {"perOwner": limits.per_owner, "total": limits.total, "trialDays": TRIAL_DAYS,
                       "free": FREE_LIMITS},
        })
    }

    /// Lets `id` create clubs: up to `max_clubs` (0: the relay's per-owner
    /// limit), each with `limits` (none: the free ones).
    pub fn grant(
        &mut self,
        id: &str,
        note: &str,
        max_clubs: u64,
        limits: Option<&Value>,
        now: u64,
    ) -> Result<Grant, String> {
        if !id_ok(id) {
            return Err("That isn’t a player ID.".into());
        }
        let g = Grant {
            at: now,
            note: note.chars().take(200).collect(),
            max_clubs,
            limits: limits.map(|l| clean_limits(l, FREE_LIMITS)),
        };
        self.grants.insert(id.into(), g.clone());
        Ok(g)
    }

    /// Takes permission away; their clubs carry on until suspended.
    pub fn revoke(&mut self, id: &str) {
        self.grants.remove(id);
    }

    /// Changes club `code`: {suspended, limits, plan ("trial" or "club"),
    /// expires (a trial's end)}.
    pub fn set_club(&mut self, code: &str, change: &Value, now: u64) -> Result<Record, String> {
        self.update(code, |r| {
            if let Some(s) = change.get("suspended").and_then(Value::as_bool) {
                r.suspended = s;
            }
            if let Some(l) = change.get("limits").filter(|l| l.is_object()) {
                r.limits = clean_limits(l, r.limits);
            }
            match change.get("plan").and_then(Value::as_str) {
                Some("club") => {
                    r.plan = "club".into();
                    r.expires = None;
                }
                Some("trial") => {
                    r.plan = "trial".into();
                    r.expires.get_or_insert(now + TRIAL_DAYS * DAY_MS);
                }
                _ => {}
            }
            if let Some(e) = change.get("expires").and_then(Value::as_u64)
                && r.plan == "trial"
            {
                r.expires = Some(e);
            }
        })
    }
}

/// A day of use against the free plan, for the admin page: its club-hours,
/// GB-s and share of the free day, from its club-minutes.
pub fn usage_day(day: &str, minutes: f64) -> Value {
    let gbs = (minutes * GBS_PER_CLUB_MINUTE).round();
    json!({
        "day": day, "clubHours": (minutes / 6.0).round() / 10.0, "gbs": gbs,
        "share": (gbs / FREE_GBS_PER_DAY * 1000.0).round() / 10.0,
    })
}

/// An admin's request numbered `seq`, seen at `now`, against the ones seen
/// lately (`seen`: seq → when): the seqs to keep (those within twice the
/// window, and this one), or why not when it was seen before.
pub fn admin_seen(
    seen: &BTreeMap<String, u64>,
    seq: &str,
    now: u64,
    window_ms: u64,
) -> Result<BTreeMap<String, u64>, String> {
    let mut keep: BTreeMap<String, u64> = seen
        .iter()
        .filter(|(_, at)| now.saturating_sub(**at) <= 2 * window_ms)
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    if keep.contains_key(seq) {
        return Err("This request was already received.".into());
    }
    keep.insert(seq.into(), now);
    Ok(keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = DAY_MS;

    fn limits() -> RelayLimits {
        RelayLimits {
            per_owner: 2,
            total: 3,
            creators: vec!["boss".into()],
            ..RelayLimits::default()
        }
    }

    #[test]
    fn days_are_utc_dates() {
        assert_eq!(day_of(0), "1970-01-01");
        assert_eq!(day_of(1_761_955_200_000), "2025-11-01");
        assert_eq!(day_of(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn with_no_trials_only_a_grant_makes_a_club() {
        let mut r = Registry::default();
        let l = RelayLimits {
            no_trials: true,
            ..limits()
        };
        assert!(
            r.claim("ann", "AAAA", "", &l, 10)
                .unwrap_err()
                .contains("permission")
        );
        assert!(r.trials.is_empty());
        r.grant("ann", "", 1, None, 11).unwrap();
        assert_eq!(r.claim("ann", "AAAA", "", &l, 12).unwrap().plan, "club");
    }

    #[test]
    fn trials_grants_and_the_relays_limits() {
        let mut r = Registry::default();
        let l = limits();
        let t = r.claim("ann", "AAAA", "Night Owls", &l, 10).unwrap();
        assert_eq!(
            (t.plan.as_str(), t.expires, t.limits),
            ("trial", Some(10 + TRIAL_DAYS * DAY), FREE_LIMITS)
        );
        assert!(
            r.claim("ann", "BBBB", "", &l, 11)
                .unwrap_err()
                .contains("free trial")
        );
        assert!(
            r.claim("bob", "AAAA", "", &l, 11)
                .unwrap_err()
                .contains("in use")
        );
        // A grant: clubs with its limits, up to its most.
        r.grant(
            "bob",
            "friend",
            1,
            Some(&json!({"tables": 5, "tourneysPerDay": 99})),
            12,
        )
        .unwrap();
        let c = r.claim("bob", "CCCC", "", &l, 13).unwrap();
        assert_eq!(
            (c.plan.as_str(), c.limits.tables, c.limits.tourneys_per_day),
            ("club", 5, 1)
        );
        assert!(
            r.claim("bob", "DDDD", "", &l, 14)
                .unwrap_err()
                .contains("already have 1 club,")
        );
        // From the environment: the relay's per-owner limit.
        r.claim("boss", "EEEE", "", &l, 15).unwrap();
        assert!(
            r.claim("boss", "FFFF", "", &l, 15)
                .unwrap_err()
                .contains("full")
        );
        assert!(r.grant("not an id!", "", 0, None, 0).is_err());
        let list = r.list(&l, 20);
        assert_eq!(list["grants"]["boss"], json!({"fromEnv": true}));
        assert_eq!(list["clubs"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn running_use_and_old_records() {
        let mut r = Registry::default();
        r.claim("ann", "AAAA", "", &limits(), 0).unwrap();
        assert_eq!(r.status("AAAA", 1)["blocked"], "");
        assert!(
            r.status("AAAA", TRIAL_DAYS * DAY)["blocked"]
                .as_str()
                .unwrap()
                .contains("trial has ended")
        );
        assert!(
            r.status("ZZZZ", 1)["blocked"]
                .as_str()
                .unwrap()
                .contains("isn’t on")
        );
        r.set_club("AAAA", &json!({"suspended": true}), 1).unwrap();
        assert!(
            r.status("AAAA", 1)["blocked"]
                .as_str()
                .unwrap()
                .contains("paused")
        );
        r.set_club(
            "AAAA",
            &json!({"suspended": false, "plan": "club", "limits": {"tables": 3}}),
            1,
        )
        .unwrap();
        let rec = r.record("AAAA").unwrap();
        assert_eq!(
            (rec.plan.as_str(), rec.expires, rec.limits.tables),
            ("club", None, 3)
        );
        r.used("AAAA", 30.0, DAY);
        assert_eq!(r.record("AAAA").unwrap().days[&day_of(DAY)], 30.0);
        // An older record: no lastActive reads as made; a temporary club's
        // flags (#395) are dropped (#654).
        r.clubs.insert(
            "OLD".into(),
            json!({"owner": "x", "at": 5, "temporary": true, "provedAt": 9}),
        );
        let old = r.record("OLD").unwrap();
        assert_eq!(old.last_active, 5);
        assert!(old.other.is_empty());
        r.used("OLD", 0.0, 6);
        assert!(r.clubs["OLD"].get("temporary").is_none());
        assert!(r.clubs["OLD"].get("provedAt").is_none());
    }

    #[test]
    fn admin_requests_are_seen_once() {
        let seen = admin_seen(&BTreeMap::new(), "1", 100, 50).unwrap();
        assert!(admin_seen(&seen, "1", 120, 50).is_err());
        // Long gone: dropped.
        assert!(!admin_seen(&seen, "2", 300, 50).unwrap().contains_key("1"));
        assert_eq!(usage_day("2026-10-31", 60.0)["clubHours"], 1.0);
    }
}

//! A club table and its runner (ducy-play's `runner`, ducy-web #452), for
//! ducy-web's club-engine.js, with events and steps as plain JS objects.
//! A friends table, whose host plays seat 0, runs the same way (#462).
//! Bytes cross as lowercase hex.

use ducy_host::runner::{
    ASK_MS, Action, Event, FairResult, HostCommand, IDLE_MS, NEXT_HAND_MS, PlayerCommand,
    RunnerConfig, RunnerUpdate, SeedPicker, Step, TableResult, TableRunner,
};
use ducy_host::{Command, HostSnapshot, TableHost};
use ducy_play::fair_deal::{Bytes32, Reveal};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::fair::{bytes32, hex};
use crate::util::{bomb_pots, club_host, err, friends_host, to_js};

/// The table and runner options from club-host.js.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    seats: usize,
    #[serde(default)]
    min_buy_in: u64,
    #[serde(default)]
    max_buy_in: u64,
    #[serde(default)]
    sb: u64,
    #[serde(default)]
    bb: u64,
    #[serde(default)]
    seed: u64,
    #[serde(default)]
    game: Option<String>,
    #[serde(default)]
    turn_ms: u64,
    #[serde(default)]
    sit_out_ms: Option<u64>,
    #[serde(default = "yes")]
    open: bool,
    #[serde(default = "yes")]
    link: bool,
    #[serde(default)]
    active: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    idle_ms: Option<u64>,
    #[serde(default)]
    ask_ms: Option<u64>,
    #[serde(default)]
    next_hand_ms: Option<u64>,
    // A friends table's.
    #[serde(default)]
    host_name: String,
    #[serde(default)]
    host_chips: u64,
    #[serde(default)]
    bomb_every: u64,
    #[serde(default)]
    auto_deal: bool,
}

fn yes() -> bool {
    true
}

impl Config {
    fn runner(&self, id: String, paused: bool) -> RunnerConfig {
        RunnerConfig {
            id,
            game: self.game.clone().unwrap_or_else(|| "nlhe".to_string()),
            open: self.open,
            link: self.link,
            paused,
            active: self
                .active
                .iter()
                .map(|(k, v)| (k.clone(), *v as u64))
                .collect(),
            idle_ms: self.idle_ms.unwrap_or(IDLE_MS),
            ask_ms: self.ask_ms.unwrap_or(ASK_MS),
            next_hand_ms: self.next_hand_ms.unwrap_or(NEXT_HAND_MS),
            auto_deal: true,
        }
    }

    /// A friends table's: dealt by the host until `autoDeal`, and no one
    /// stood up for being idle.
    fn friends_runner(&self, id: String, paused: bool) -> RunnerConfig {
        RunnerConfig {
            idle_ms: self.idle_ms.unwrap_or(0),
            auto_deal: self.auto_deal,
            ..self.runner(id, paused)
        }
    }
}

const SIT_OUT_MS: u64 = 10 * 60_000;

/// A club table run by its runner. Every call takes the time in
/// milliseconds (e.g. `Date.now()`).
#[wasm_bindgen]
pub struct ClubTable {
    runner: TableRunner,
}

#[wasm_bindgen]
impl ClubTable {
    /// A new table `id`: `config` = {seats, minBuyIn, maxBuyIn, sb, bb, seed,
    /// game, turnMs, sitOutMs, open, link, idleMs, askMs, nextHandMs}.
    pub fn create(id: String, config: JsValue) -> Result<ClubTable, JsError> {
        let c: Config = serde_wasm_bindgen::from_value(config).map_err(err)?;
        let mut host = club_host(
            c.seats,
            c.min_buy_in,
            c.max_buy_in,
            c.sb,
            c.bb,
            c.seed,
            c.game.clone(),
            c.turn_ms,
        )?;
        host.set_sit_out_limit(c.sit_out_ms.unwrap_or(SIT_OUT_MS));
        Ok(ClubTable {
            runner: TableRunner::new(host, c.runner(id, false)),
        })
    }

    /// A table saved with `save`, waiting for its people; `config` as for
    /// `create`, plus `active` ({member: last activity}). Null if it was saved
    /// holding a chip request (the club may have paid it). Throws if it can't
    /// be loaded.
    pub fn restore(
        id: String,
        json: &str,
        config: JsValue,
        now: f64,
    ) -> Result<Option<ClubTable>, JsError> {
        let c: Config = serde_wasm_bindgen::from_value(config).map_err(err)?;
        let s: HostSnapshot = serde_json::from_str(json).map_err(err)?;
        let mut host = TableHost::restore(&s, now as u64, |_| None).map_err(err)?;
        if !host.chip_requests().is_empty() {
            return Ok(None);
        }
        host.set_sit_out_limit(c.sit_out_ms.unwrap_or(SIT_OUT_MS));
        Ok(Some(ClubTable {
            runner: TableRunner::new(host, c.runner(id, true)),
        }))
    }

    /// A friends table `id`: the host in seat 0 with `hostChips`, and
    /// `seats - 1` empty seats people take as they join; `config` as for
    /// `create` plus {hostName, hostChips, bombEvery (a bomb pot on two
    /// boards every so many hands, the ante a big blind), autoDeal}. No one
    /// is stood up for being idle or sitting out.
    pub fn friends(id: String, config: JsValue) -> Result<ClubTable, JsError> {
        let c: Config = serde_wasm_bindgen::from_value(config).map_err(err)?;
        let mut host = friends_host(
            c.seats,
            &c.host_name,
            c.host_chips,
            c.min_buy_in,
            c.max_buy_in,
            c.sb,
            c.bb,
            c.seed,
            c.game.as_deref(),
            c.turn_ms,
        )?;
        host.set_bomb_pots(bomb_pots(c.bomb_every, c.bb, true), 0)
            .map_err(err)?;
        Ok(ClubTable {
            runner: TableRunner::new(host, c.friends_runner(id, false)),
        })
    }

    /// A friends table saved with `save`, waiting for its people; `config`
    /// as for `friends` (its table options aren't used). Throws if it can't
    /// be loaded.
    #[wasm_bindgen(js_name = restoreFriends)]
    pub fn restore_friends(
        id: String,
        json: &str,
        config: JsValue,
        now: f64,
    ) -> Result<ClubTable, JsError> {
        let c: Config = serde_wasm_bindgen::from_value(config).map_err(err)?;
        let s: HostSnapshot = serde_json::from_str(json).map_err(err)?;
        let host = TableHost::restore(&s, now as u64, |_| None).map_err(err)?;
        if !host.has_host() {
            return Err(JsError::new("not a friends table"));
        }
        Ok(ClubTable {
            runner: TableRunner::new(host, c.friends_runner(id, true)),
        })
    }

    /// Takes in an event ({type, …}, the runner's `Event`) and returns the step:
    /// {actions, wake, stopped, paused, dealAt}.
    pub fn event(&mut self, ev: JsValue, now: f64) -> Result<JsValue, JsError> {
        let v: Value = serde_wasm_bindgen::from_value(ev).map_err(err)?;
        let step = self.runner.event(event(&v)?, now as u64);
        to_js(&step_json(&step, self.runner.host())?)
    }

    /// The table as JSON, to `restore` after a restart.
    pub fn save(&mut self, now: f64) -> Result<String, JsError> {
        serde_json::to_string(&self.runner.snapshot(now as u64)).map_err(err)
    }

    /// Every seat's hole cards in the hand at the table (the last one, once
    /// it's over), folded ones too: {hand, seats: [{seat, cards}]}, by seat.
    /// Only for an always-on club's own record of the hand (#580), which no
    /// one at the club can read: never send it to anyone.
    #[wasm_bindgen(js_name = holeCards)]
    pub fn hole_cards(&self) -> Result<JsValue, JsError> {
        let t = self.runner.host().table();
        let seats: Vec<Value> = (0..t.num_seats())
            .filter(|&s| t.hand_index(s).is_some())
            .filter_map(|s| {
                let cards = t.view(s).seats.first()?.cards.clone()?;
                Some(json!({"seat": s, "cards": cards}))
            })
            .collect();
        to_js(&json!({"hand": t.hand_number(), "seats": seats}))
    }

    /// Deals each hand from `pick`'s seed when it gives one, in place of the
    /// fair-deal round (ducy-web's demo club): `pick({state, players})`, the
    /// table about to deal, returns a seed in hex or nothing. Null stops it.
    #[wasm_bindgen(js_name = setSeedPicker)]
    pub fn set_seed_picker(&mut self, pick: Option<SeedFn>) {
        self.runner.set_seed_picker(pick.map(|f| -> SeedPicker {
            Box::new(move |host: &TableHost| {
                let table =
                    to_js(&json!({"state": host.host_view(), "players": host.seated()})).ok()?;
                let seed = f.call(&JsValue::NULL, &table).ok()?.as_string()?;
                bytes32(&seed).ok()
            })
        }));
    }
}

#[wasm_bindgen]
extern "C" {
    /// A JS function for `setSeedPicker`.
    #[wasm_bindgen(typescript_type = "(table: any) => string | undefined")]
    pub type SeedFn;

    #[wasm_bindgen(method, catch)]
    fn call(this: &SeedFn, ctx: &JsValue, table: &JsValue) -> Result<JsValue, JsValue>;
}

fn s(v: &Value, k: &str) -> Result<String, JsError> {
    v[k].as_str()
        .map(str::to_string)
        .ok_or_else(|| JsError::new(&format!("event: no {k}")))
}

fn b(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}

fn n(v: &Value, k: &str) -> Result<usize, JsError> {
    u(v, k).map(|x| x as usize)
}

fn u(v: &Value, k: &str) -> Result<u64, JsError> {
    v[k].as_u64()
        .ok_or_else(|| JsError::new(&format!("event: no {k}")))
}

/// 64 lowercase hex digits, as pages send them; anything else is None.
fn bytes(v: &Value) -> Option<Bytes32> {
    let s = v.as_str()?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    crate::fair::bytes32(s).ok()
}

fn event(v: &Value) -> Result<Event, JsError> {
    Ok(match v["type"].as_str().unwrap_or("") {
        "cmd" => Event::Cmd {
            id: s(v, "id")?,
            cmd: player_command(&v["cmd"]),
            online: v["online"].as_bool(),
        },
        "disconnected" => Event::Disconnected { id: s(v, "id")? },
        "presence" => Event::Presence {
            id: s(v, "id")?,
            on: b(v, "on"),
        },
        "link" => Event::Link { ok: b(v, "ok") },
        "chips" => Event::Chips {
            seat: n(v, "seat")?,
            ok: b(v, "ok"),
        },
        "remove" => Event::Remove {
            seat: n(v, "seat")?,
        },
        "leaving" => Event::Leaving {
            id: s(v, "id")?,
            on: b(v, "on"),
        },
        "mustPlay" => Event::MustPlay {
            id: s(v, "id")?,
            on: b(v, "on"),
        },
        "open" => Event::Open { on: b(v, "on") },
        "host" => Event::Host {
            cmd: host_command(&v["cmd"])?,
        },
        "deal" => Event::Deal,
        "autoDeal" => Event::AutoDeal {
            on: b(v, "on"),
            after_ms: u(v, "afterMs")?,
        },
        "state" => Event::State,
        "wake" => Event::Wake,
        other => return Err(JsError::new(&format!("no event {other}"))),
    })
}

/// The host's own move: {type: 'act', kind, amount} | {type: 'run_twice',
/// yes} | {type: 'chips', amount}.
fn host_command(c: &Value) -> Result<HostCommand, JsError> {
    Ok(match c["type"].as_str().unwrap_or("") {
        "act" => HostCommand::Act {
            kind: s(c, "kind")?,
            amount: c["amount"].as_u64().unwrap_or(0),
        },
        "run_twice" => HostCommand::RunTwice { yes: b(c, "yes") },
        "chips" => HostCommand::Chips {
            amount: u(c, "amount")?,
        },
        other => return Err(JsError::new(&format!("no host command {other}"))),
    })
}

fn player_command(c: &Value) -> PlayerCommand {
    let round = || c["round"].as_str().unwrap_or("").to_string();
    match c["type"].as_str() {
        Some("still_here") => PlayerCommand::StillHere,
        Some("fair_commit") => match bytes(&c["c"]) {
            Some(commitment) => PlayerCommand::FairCommit {
                round: round(),
                commitment,
            },
            None => PlayerCommand::Ignored,
        },
        Some("fair_reveal") => match (bytes(&c["value"]), bytes(&c["nonce"])) {
            (Some(value), Some(nonce)) => PlayerCommand::FairReveal {
                round: round(),
                reveal: Reveal { value, nonce },
            },
            _ => PlayerCommand::Ignored,
        },
        _ => match serde_json::from_value::<Command>(c.clone()) {
            Ok(cmd) => PlayerCommand::Table(cmd),
            Err(_) => PlayerCommand::Unreadable,
        },
    }
}

fn step_json(step: &Step, host: &TableHost) -> Result<Value, JsError> {
    let actions = step
        .actions
        .iter()
        .filter_map(|a| {
            Some(Ok(match a {
                Action::Engine(res) => match result_json(res, host) {
                    Ok(r) => json!({"type": "engine", "res": r}),
                    Err(e) => return Some(Err(e)),
                },
                // A hand's deal, for the host's side only (#580).
                Action::Send {
                    to,
                    update: RunnerUpdate::FairResult(f),
                } => dealt_json(to, f),
                Action::Send { to, update } => {
                    json!({"type": "send", "to": to, "update": update_json(update)?})
                }
                Action::Active { id, at } => json!({"type": "active", "id": id, "at": at}),
                Action::Idle { id } => json!({"type": "idle", "id": id}),
                Action::Refused { reason } => json!({"type": "refused", "reason": reason}),
            }))
        })
        .collect::<Result<Vec<_>, JsError>>()?;
    Ok(json!({
        "actions": actions, "wake": step.wake, "stopped": step.stopped, "paused": step.paused,
        "dealAt": step.deal_at,
    }))
}

fn to(x: &impl serde::Serialize) -> Result<Value, JsError> {
    serde_json::to_value(x).map_err(err)
}

/// An engine result, with what a friends table's host shows: open seats,
/// the buy-in limits and the host's own chips waiting for the next hand
/// (as the table is after the step).
fn result_json(r: &TableResult, host: &TableHost) -> Result<Value, JsError> {
    let out: Vec<Value> = r
        .out
        .iter()
        .map(|o| Ok(json!({"to": o.to, "data": to(&o.update)?})))
        .collect::<Result<_, JsError>>()?;
    let mut v = json!({
        "seq": r.seq,
        "state": to(&r.state)?,
        "botToAct": r.bot_to_act,
        "turnMsLeft": r.turn_ms_left,
        "playersIn": r.players_in,
        "chipRequests": to(&r.chip_requests)?,
        "players": to(&r.players)?,
        "departed": to(&r.departed)?,
        "refunds": to(&r.refunds)?,
        "out": out,
        "openSeats": host.open_seats(),
        "buyIn": host.buy_in_limits().map(|(min, max)| json!({"min": min, "max": max})),
        "hostPendingChips": host.host_pending_chips(),
    });
    // Only from a new hand: the seed it was dealt from, or null.
    if let Some(seed) = r.seed {
        v["seed"] = seed.map(|s| Value::from(hex(&s))).unwrap_or(Value::Null);
    }
    Ok(v)
}

fn list_json(list: &[(String, Bytes32)]) -> Value {
    list.iter()
        .map(|(id, c)| json!({"id": id, "c": hex(c)}))
        .collect()
}

/// A fair-dealt hand's deal, as the runner would have told member `to`:
/// {type: 'dealt', to, hand, game, dealt, index (where `to`'s cards are in
/// the deal), seed, list, reveals}. It never goes to a player (see
/// `update_json`): an always-on club keeps it in the hand's full record
/// (#580), so ducy can check the deal.
fn dealt_json(to: &str, f: &FairResult) -> Value {
    json!({
        "type": "dealt", "to": to, "hand": f.hand, "game": f.game, "dealt": f.dealt, "index": f.index,
        "seed": hex(&f.seed), "list": list_json(&f.list),
        "reveals": f.reveals.iter().map(|(id, r)| json!({"id": id, "value": hex(&r.value), "nonce": hex(&r.nonce)})).collect::<Vec<_>>(),
    })
}

/// A runner's message for a member, or None for one that never goes to a
/// player: a fair-deal result carries the hand's seed, and with it anyone
/// could deal out every other seat's hole cards, folded ones too (#580).
fn update_json(u: &RunnerUpdate) -> Option<Value> {
    Some(match u {
        RunnerUpdate::FairCommit { round } => {
            json!({"type": "fair", "step": "commit", "round": round})
        }
        RunnerUpdate::FairReveal { round, list } => {
            json!({"type": "fair", "step": "reveal", "round": round, "list": list_json(list)})
        }
        RunnerUpdate::FairResult(_) => return None,
        RunnerUpdate::IdleAsk { secs } => json!({"type": "idle", "secs": secs}),
        RunnerUpdate::IdleDone => json!({"type": "idle", "done": true}),
    })
}

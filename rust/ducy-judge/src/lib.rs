//! The postflop fair play check's bindings (#615): ducy's heads-up GTO
//! models score club players' decisions from the flop on (ducy-gto's
//! `judge`), in the judge Worker (relay/judge/), apart from the relay.
//!
//! - `loadHoldem(cards, blueprint)`: the heads-up No-limit Hold'em model
//!   (the site's `gto/current.json` files).
//! - `loadPlo(cards, blueprint, bigBlinds)`: a heads-up PLO model, for the
//!   number of hole cards its abstraction was built for (one each).
//! - `judgeHand(record, options)`: one of the club's full hand records
//!   (relay/src/hand-records.js) in; its scored decisions out, by seat
//!   number, with no cards: `[{seat, street, frequency, top, evLoss, stderr,
//!   bbLost}]`. Hands no model covers give `[]`.

use std::cell::RefCell;

use ducy_gto::{
    holdem::{
        abstraction::CardAbstraction,
        blueprint::Blueprint,
        cards::{Card, parse},
        hunl::{BettingTree, Hunl, HunlConfig},
        range::BucketCache,
        review::{ReviewConfig, Reviewer},
    },
    judge::{self, Scored, TableHand},
    omaha::{abstraction::PloAbstraction, bot::load_blueprint},
};
use ducy_play::Event;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

struct Holdem {
    cards: CardAbstraction,
    blueprint: Blueprint,
    tree: BettingTree,
    big_blind: u64,
    /// The depth it was trained for, in big blinds.
    depth: f64,
    cache: BucketCache,
}

struct Plo {
    cards: PloAbstraction,
    blueprint: Blueprint,
    tree: BettingTree,
    depth: f64,
}

thread_local! {
    static HOLDEM: RefCell<Option<Holdem>> = const { RefCell::new(None) };
    static PLO: RefCell<Vec<Plo>> = const { RefCell::new(Vec::new()) };
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Loads the heads-up Hold'em model: the card abstraction (the compact form
/// is enough) and the blueprint trained on it for the default 100 BB game.
#[wasm_bindgen(js_name = loadHoldem)]
pub fn load_holdem(cards: &[u8], blueprint: &[u8]) -> Result<(), JsError> {
    let cards = CardAbstraction::load(cards).ok_or_else(|| err("not a card abstraction"))?;
    let config = HunlConfig::default();
    let game = Hunl::new(config.clone(), Some(&cards));
    let blueprint = Blueprint::load(blueprint, &game, &cards)
        .map_err(|e| err(format!("blueprint doesn't match: {e:?}")))?;
    drop(game);
    let tree = BettingTree::build(&config);
    let root = &tree.nodes[0].betting;
    let depth = (root.stack[0] + root.contributed[0]) as f64 / config.big_blind.max(1) as f64;
    HOLDEM.with(|h| {
        *h.borrow_mut() = Some(Holdem {
            cards,
            blueprint,
            tree,
            big_blind: config.big_blind,
            depth,
            cache: BucketCache::default(),
        })
    });
    Ok(())
}

/// Loads a heads-up PLO model trained `big_blinds` deep, replacing any for
/// the same number of hole cards.
#[wasm_bindgen(js_name = loadPlo)]
pub fn load_plo(cards: &[u8], blueprint: &[u8], big_blinds: u64) -> Result<(), JsError> {
    let cards = PloAbstraction::load(cards).ok_or_else(|| err("not a PLO card abstraction"))?;
    let config = HunlConfig::pot_limit_omaha_lean(big_blinds);
    let (blueprint, tree) = load_blueprint(&config, &cards, blueprint)
        .map_err(|e| err(format!("blueprint doesn't match: {e:?}")))?;
    let k = cards.config.hole_cards;
    PLO.with(|p| {
        let mut p = p.borrow_mut();
        p.retain(|m| m.cards.config.hole_cards != k);
        p.push(Plo {
            cards,
            blueprint,
            tree,
            depth: big_blinds as f64,
        });
    });
    Ok(())
}

/// The models loaded: `{holdem, plo: [hole cards]}`.
#[wasm_bindgen(js_name = judgeModels)]
pub fn judge_models() -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    struct Models {
        holdem: bool,
        plo: Vec<usize>,
    }
    let m = Models {
        holdem: HOLDEM.with(|h| h.borrow().is_some()),
        plo: PLO.with(|p| {
            p.borrow()
                .iter()
                .map(|m| m.cards.config.hole_cards)
                .collect()
        }),
    };
    serde_wasm_bindgen::to_value(&m).map_err(err)
}

/// A full hand record, as much of it as the check reads.
#[derive(Deserialize)]
struct Record {
    #[serde(default)]
    game: Option<String>,
    sb: f64,
    bb: f64,
    button: usize,
    seats: Vec<Seat>,
    actions: Vec<serde_json::Value>,
    #[serde(default)]
    board: Vec<String>,
}

#[derive(Deserialize)]
struct Seat {
    seat: usize,
    #[serde(default)]
    cards: Option<Vec<String>>,
    #[serde(rename = "stackEnd")]
    stack_end: f64,
    net: f64,
}

/// How a hand is judged.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    /// Turn and river cards sampled to value a flop decision (Hold'em).
    #[serde(default = "flop_runouts")]
    flop_runouts: usize,
    /// Hands are judged only with the smaller stack within this factor of
    /// the depth the model was trained for.
    #[serde(default = "depth_factor")]
    depth_factor: f64,
    #[serde(default)]
    seed: u64,
}

fn flop_runouts() -> usize {
    ReviewConfig::default().flop_runouts
}

fn depth_factor() -> f64 {
    1.5
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    seat: usize,
    street: usize,
    frequency: f64,
    top: f64,
    ev_loss: Option<f64>,
    stderr: f64,
    bb_lost: f64,
}

/// The record as ducy-gto's table hand, its seats numbered from 0 in seat
/// order; and the real seat number of each. None when it doesn't read.
fn table_hand(r: &Record) -> Option<(TableHand, Vec<usize>)> {
    let mut seats: Vec<&Seat> = r.seats.iter().collect();
    seats.sort_by_key(|s| s.seat);
    let numbers: Vec<usize> = seats.iter().map(|s| s.seat).collect();
    let index = |seat: usize| numbers.iter().position(|&s| s == seat);
    let mut history = Vec::with_capacity(r.actions.len());
    for a in &r.actions {
        let mut a = a.clone();
        if let Some(seat) = a.get("seat").and_then(|s| s.as_u64()) {
            a["seat"] = index(seat as usize)?.into();
        }
        history.push(serde_json::from_value::<Event>(a).ok()?);
    }
    // A double board, or a hand run more than once after an all-in, isn't
    // one the models play.
    if history
        .iter()
        .any(|e| matches!(e, Event::SecondBoard { .. } | Event::Runs { .. }))
    {
        return None;
    }
    // The button's place among the seats dealt in: its own, or the last seat
    // before it (a dead button).
    let button = numbers
        .iter()
        .rposition(|&s| s <= r.button)
        .unwrap_or(numbers.len().checked_sub(1)?);
    let chips = |x: f64| (x.is_finite() && x >= 0.0).then_some(x.round() as u64);
    let stacks = seats
        .iter()
        .map(|s| chips(s.stack_end - s.net))
        .collect::<Option<Vec<u64>>>()?;
    let holes = seats
        .iter()
        .map(|s| s.cards.as_ref().and_then(|c| parse(&c.join(" "))))
        .collect();
    let board: Vec<Card> = parse(&r.board.join(" "))?;
    Some((
        TableHand {
            history,
            button,
            small_blind: chips(r.sb)?,
            big_blind: chips(r.bb)?.max(1),
            stacks,
            holes,
            board,
        },
        numbers,
    ))
}

fn within(depth: f64, model: f64, factor: f64) -> bool {
    depth >= model / factor && depth <= model * factor
}

/// Scores one full hand record's decisions from the flop on: by seat number,
/// with no cards. `[]` when no loaded model covers it.
#[wasm_bindgen(js_name = judgeHand)]
pub fn judge_hand(record: JsValue, options: JsValue) -> Result<JsValue, JsError> {
    let r: Record = serde_wasm_bindgen::from_value(record).map_err(err)?;
    let o: Options = if options.is_undefined() || options.is_null() {
        serde_json::from_str("{}").map_err(err)?
    } else {
        serde_wasm_bindgen::from_value(options).map_err(err)?
    };
    let scored = judge_record(&r, &o);
    let out: Vec<Out> = scored
        .into_iter()
        .map(|s| Out {
            seat: s.seat,
            street: s.street,
            frequency: s.frequency,
            top: s.top,
            ev_loss: s.ev_loss,
            stderr: s.stderr,
            bb_lost: s.bb_lost,
        })
        .collect();
    out.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(err)
}

fn judge_record(r: &Record, o: &Options) -> Vec<Scored> {
    let Some((hand, numbers)) = table_hand(r) else {
        return Vec::new();
    };
    let Some(hu) = judge::heads_up(&hand) else {
        return Vec::new();
    };
    let depth = hu.depth(hand.big_blind);
    let game = r.game.as_deref().unwrap_or("nlhe");
    let mut scored = match game {
        "nlhe" => HOLDEM.with(|h| {
            let mut h = h.borrow_mut();
            let Some(m) = h
                .as_mut()
                .filter(|m| within(depth, m.depth, o.depth_factor))
            else {
                return Vec::new();
            };
            let reviewer = Reviewer {
                tree: &m.tree,
                blueprint: &m.blueprint,
                cards: &m.cards,
                tree_big_blind: m.big_blind,
                config: ReviewConfig {
                    flop_runouts: o.flop_runouts,
                    seed: o.seed,
                    ..ReviewConfig::default()
                },
            };
            judge::holdem(&reviewer, &hand, &mut m.cache)
        }),
        "plo4" | "plo5" | "plo6" => {
            let k = usize::from(game.as_bytes()[3] - b'0');
            PLO.with(|p| {
                let p = p.borrow();
                let Some(m) = p
                    .iter()
                    .find(|m| m.cards.config.hole_cards == k)
                    .filter(|m| within(depth, m.depth, o.depth_factor))
                else {
                    return Vec::new();
                };
                judge::plo(&m.cards, &m.blueprint, &m.tree, &hand, o.seed)
            })
        }
        _ => Vec::new(),
    };
    for s in &mut scored {
        s.seat = numbers[s.seat];
    }
    scored
}

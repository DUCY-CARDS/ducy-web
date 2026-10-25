// The demo clubs' bot players (#415): Bankroll Quest's people at a demo
// club's tables. Each bot member is one of Quest's players, a Regular
// (ladder.js ORDER) or one of the card rooms' generic players
// (quest-people.js), with their name and face, picked for a table's stakes
// as Quest's line-ups pick them (quest-lineup.js), and deciding as Quest's
// bots do: ducy's SeatBot plays their seat from what they see at the table,
// in a worker (demo-bot-worker.js) so the page never waits on it. Only the
// demo loads this file (demo-relay.js).
//
//   stakesOf(table)            Quest's stakes for a club table: '1/2', …
//   pickPlayer(stakes, r, taken, names)  a Quest bot id for a seat there
//   playerName(id, names)      their name; names: Regulars' ids → names
//   fits(id, stakes)           whether they'd sit in that game
//   thinker(ready)             (key, id, seed, view) → their move, or throws
//   fallbackMove(id, view)     a move by their style, without SeatBot
//   chatLine(id, net, bb)      what they say after a big pot, or null

import { CRUSHERS, LINEUP_SEATS, POOLS, STYLE_MIX, WHALES, WHALE_CHANCE, poolFor } from './quest-lineup.js';
import { ROOMS, STAKES, regionOf } from './quest-rooms.js';
import { personOf, tourist } from './quest-people.js';
import { lineFor, speaks } from './bot-chat.js';

// The generic players come from a Los Angeles room: its mix of people.
const ROOM = ROOMS.find(r => regionOf(r)?.id === 'la')?.id || ROOMS[0].id;
// A big pot, for a word in the lobby after it (bot-chat.js's bigWin and bigLoss).
const BIG_POT_BB = 30;

const num = v => Number(v) || 0;

/** Quest's stakes for a club table: the highest whose big blind it reaches. */
export function stakesOf(t) {
  let out = '1/2';
  for (const [name, [, bb]] of Object.entries(STAKES)) if (num(t?.bb) >= bb) out = name;
  return out;
}

const weighted = (weights, x) => {
  const entries = Object.entries(weights);
  let left = x * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) if ((left -= w) < 0) return k;
  return entries.at(-1)[0];
};

/**
 * A Quest bot id for a seat at `stakes`, not in `taken` (a Set of ids and
 * names): at 1/2 to 10/20 a style from STYLE_MIX (generic players, softer
 * Regulars, now and then a crusher), at 25/50 up the tough Regulars and now
 * and then a whale. `r(key)` gives numbers in [0, 1), the same for the same
 * key when the line-up should come out the same.
 */
export function pickPlayer(stakes, r, taken = new Set(), names = null) {
  const pool = poolFor(stakes);
  const free = id => !taken.has(id) && !taken.has(playerName(id, names));
  const one = (ids, key) => {
    const ok = ids.filter(free);
    return ok.length ? ok[Math.floor(r(key) * ok.length)] : null;
  };
  const generic = family => {
    for (let k = 0; k < 40; k++) {
      const id = tourist(Math.floor(r(`person${k}`) * 2 ** 31), ROOM, 0, 0, 0, family);
      if (free(id)) return id;
    }
    return null;
  };
  if (pool === 'high') {
    // A whale in about one game in three (WHALE_CHANCE), one seat of five.
    if (r('whale') < WHALE_CHANCE / LINEUP_SEATS) { const w = one(WHALES, 'which'); if (w) return w; }
    return one(POOLS.high, 'reg') || generic('grinder');
  }
  const style = weighted(STYLE_MIX[pool], r('style'));
  if (style === 'crusher') return one(CRUSHERS, 'reg') || generic('grinder');
  if (style === 'character') return one(POOLS[pool].filter(id => !CRUSHERS.includes(id)), 'reg') || generic('grinder');
  return generic(style);
}

/** Whether Quest would seat `id` at `stakes`. */
export function fits(id, stakes) {
  const pool = poolFor(stakes);
  if (personOf(id)) return pool !== 'high';
  if (WHALES.includes(id)) return pool === 'high';
  return POOLS[pool].includes(id) || CRUSHERS.includes(id);
}

/** A bot's name: a generic player's, or a Regular's from `names` (id → name). */
export function playerName(id, names = null) {
  const p = personOf(id);
  if (p) return p.name;
  return names?.get(id) || String(id).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---- deciding ----

/**
 * Their move from their seat's table view, with ducy's SeatBot (one per
 * `key`, a member id, made again when their Quest id changes): {kind,
 * amount}, or null when it isn't their turn. Throws with a ducy-wasm older
 * than SeatBot.
 */
export function seatBotAct(w, bots, key, id, seed, view) {
  if (typeof w.SeatBot !== 'function') throw new Error('this ducy-wasm has no SeatBot');
  let b = bots.get(key);
  if (b?.id !== id) {
    b?.bot.free();
    b = {id, bot: new w.SeatBot(id, BigInt(seed))};
    bots.set(key, b);
  }
  return b.bot.act(view);
}

/**
 * Decides for the bots: in a worker in a page (an Omaha decision can take a
 * second), in this thread elsewhere (the tests), with `ready()` the wasm.
 */
export function thinker(ready) {
  if (typeof Worker !== 'function') {
    const bots = new Map();
    return async (key, id, seed, view) => seatBotAct(await ready(), bots, key, id, seed, view);
  }
  let worker = null, n = 0;
  const waiting = new Map();
  const failAll = why => { for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); };
  return (key, id, seed, view) => {
    if (!worker) {
      worker = new Worker(new URL('./demo-bot-worker.js', import.meta.url), {type: 'module'});
      worker.onmessage = e => {
        const w = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (e.data.error) w?.reject(new Error(e.data.error));
        else w?.resolve(e.data.result);
      };
      worker.onerror = e => failAll(e.message || 'the bots’ worker failed');
    }
    return new Promise((resolve, reject) => {
      const at = ++n;
      waiting.set(at, {resolve, reject});
      worker.postMessage({id: at, key, bot: id, seed, view});
    });
  };
}

// Without SeatBot: how often each style bets and folds to a bet.
const STYLES = {
  rock: {bet: 0.06, fold: 0.4},
  station: {bet: 0.05, fold: 0.04},
  maniac: {bet: 0.4, fold: 0.08},
  grinder: {bet: 0.18, fold: 0.2},
};
const styleOf = id => personOf(id)?.family || (WHALES.includes(id) ? 'maniac' : 'grinder');

/**
 * A move by `id`'s style, for a ducy-wasm without SeatBot: {kind, amount},
 * a bet or raise as a share of the pot (the caller keeps it legal).
 */
export function fallbackMove(id, v, rng = Math.random) {
  const L = v.legal;
  const s = STYLES[styleOf(id)];
  const range = L.raise || L.bet;
  const x = rng();
  if (range && x < s.bet) return {kind: L.raise ? 'raise' : 'bet', amount: num(v.current_bet) + num(v.pot) * (0.5 + rng() / 2)};
  if (!L.can_check && x > 1 - s.fold) return {kind: 'fold', amount: 0};
  return {kind: L.can_check ? 'check' : 'call', amount: 0};
}

/** What `id` says in the lobby after winning or losing `net` chips, or null. */
export function chatLine(id, net, bb, rng = Math.random) {
  const big = BIG_POT_BB * Math.max(1, num(bb));
  const moment = net >= big ? 'bigWin' : net <= -big ? 'bigLoss' : null;
  return moment && speaks(id, moment, {rng}) ? lineFor(id, moment, rng) : null;
}

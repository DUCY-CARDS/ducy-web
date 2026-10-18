// Who sits at a Bankroll Challenge table (#302): bot ids by stakes, room
// and time.
//
// - **1/2 and 2/5:** the room's generic players (quest-people.js), regs and
//   tourists, more tourists on a weekend evening; rarely a soft Regular.
// - **5/10 and 10/20:** two of the softer Regulars, and regs who play those
//   stakes, with tourists in the evenings.
// - **25/50 and 50/100:** the tough Regulars (the top of the heads-up
//   challenge's strength order, ladder.js), and sometimes a whale.
//
// Without generic players (an older ducy-wasm), every seat is a Regular, the
// softest at the bottom. Pure, and the same for a table all through a block
// of game hours, so a table you look at in the lobby is the one you sit down
// at; within a room, no one sits at two tables at once. lineupStacks gives
// the running game's stacks.

import { ORDER } from './ladder.js';
import { ROOMS, lobby, roll } from './quest-rooms.js';
import { buyInRange } from './quest.js';
import { personOf, roster, tourist, touristShare } from './quest-people.js';

export const LINEUP_SEATS = 5; // and you: 6-handed
// The wild ones who sometimes sit in big games, and only there.
export const WHALES = ['milk_king', 'nik_airbag'];
// The chance a big game has a whale in it, per block.
export const WHALE_CHANCE = 0.35;
// A table keeps its line-up for this many game hours.
const BLOCK_HOURS = 2;
// At 1/2 and 2/5, the chance a seat goes to one of the softer Regulars.
export const REGULAR_AT_LOW = 0.07;
// The Regulars at a 5/10 or 10/20 table, with generic players.
export const REGULARS_AT_MID = 2;
// The chance a reg is in the building in a block: at home, and visiting
// another room.
const AT_HOME = 0.5;
const VISITING = 0.08;
// Tourists in a room's pool for a game day.
const TOURISTS_A_DAY = 150;
// Spare players a table keeps for seats that come free.
const BENCH = 4;

const notWhale = id => !WHALES.includes(id);
// Regulars by stakes: the bottom of the strength order at 1/2 and 2/5, the
// middle at 5/10 and 10/20, the top at 25/50 and 50/100.
export const POOLS = {
  low: ORDER.slice(0, 11).filter(notWhale),
  mid: ORDER.slice(5, 15).filter(notWhale),
  high: ORDER.slice(10).filter(notWhale),
};
export const poolFor = stakes => (['1/2', '2/5'].includes(stakes) ? 'low' : ['5/10', '10/20'].includes(stakes) ? 'mid' : 'high');
export const bigGame = stakes => poolFor(stakes) === 'high';
const blockOf = minutes => Math.floor(minutes / (60 * BLOCK_HOURS));

/**
 * The five Regulars at table `tableId` (stakes name, e.g. '2/5') at game time
 * `minutes`, from the quest's `seed`. `have` (optional) is the personality ids
 * this engine has: anyone missing is skipped. With `generic`, low and mid
 * stakes tables seat generic players too (roomLineups).
 */
export function lineupFor(seed, tableId, stakes, minutes, have = null, {generic = false} = {}) {
  if (generic && !bigGame(stakes)) {
    const t = roomLineups(seed, roomOfTable(tableId), minutes, have).get(tableId);
    if (t) return t.seats;
  }
  return regularsLineup(seed, tableId, stakes, minutes, have);
}

function regularsLineup(seed, tableId, stakes, minutes, have, taken = new Set()) {
  const block = blockOf(minutes);
  const pool = POOLS[poolFor(stakes)].filter(id => (!have || have.includes(id)) && !taken.has(id));
  const picked = [];
  // A whale takes the first seat of some big games.
  if (bigGame(stakes) && roll(seed, tableId, 'whale', block) < WHALE_CHANCE) {
    const whales = WHALES.filter(id => !have || have.includes(id));
    if (whales.length) picked.push(whales[Math.floor(roll(seed, tableId, 'which', block) * whales.length)]);
  }
  const free = pool.filter(id => !picked.includes(id));
  for (let i = 0; picked.length < LINEUP_SEATS && free.length; i++) {
    picked.push(free.splice(Math.floor(roll(seed, tableId, 'seat', block, i) * free.length), 1)[0]);
  }
  return picked;
}

// A running game's stacks: how long the players have been in their sessions
// at most, in game hours, besides the time into the block.
const SESSION_HOURS = 4;
// A winning or losing rate in big blinds an hour from strength: the
// strongest Regular wins about this much, the weakest loses it.
const EDGE_BB_HOUR = 6;
// How much a stack swings in an hour, in big blinds (a whale swings double).
const SWING_BB_HOUR = 55;

// A standard normal draw from two rolls.
const normal = (u, v) => Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * v);

// How strong player `id` is, 0 (softest) to 1 (toughest): a Regular by the
// heads-up challenge's order, a generic player by family (from their
// measured strength, ducy #256).
const FAMILY_STRENGTH = {station: 0.1, maniac: 0.12, rock: 0.3, grinder: 0.65};
const strengthOf = id => {
  const g = personOf(id);
  if (g) return FAMILY_STRENGTH[g.family] ?? 0.3;
  const at = ORDER.indexOf(id);
  return at < 0 ? 0.5 : at / (ORDER.length - 1);
};

/**
 * What Regular `id` buys in (and tops up) for at table `tableId`, in chips,
 * within the room's buy-in range: the same for them all through a block of
 * game hours. It follows the player: weaker Regulars often buy in short
 * (near the minimum), stronger ones often for the maximum, the rest for 100
 * big blinds; not always. Whales always buy in for the maximum.
 */
export function buyInFor(seed, tableId, id, blinds, room, minutes) {
  const {min, max} = buyInRange(blinds, room);
  const bb = blinds[1];
  const block = Math.floor(minutes / (60 * BLOCK_HOURS));
  const r = key => roll(seed, tableId, 'buyin', id, block, key);
  // Whales always buy in for the most the room allows.
  if (WHALES.includes(id)) return max;
  // A generic player has their own habit (quest-people.js), kept to the room.
  const g = personOf(id);
  if (g) return Math.max(min, Math.min(max, g.buyInBb * bb));
  const strength = strengthOf(id);
  const pShort = 0.05 + 0.4 * (1 - strength);
  const pMax = 0.15 + 0.45 * strength;
  const h = r('habit');
  if (h < pShort) return Math.min(max, min + Math.floor(r('short') * 3) * 10 * bb);
  if (h < pShort + pMax) return max;
  return Math.max(min, Math.min(max, 100 * bb));
}

/**
 * What each of `ids` (as from lineupFor) has in front of them when you walk
 * up to table `tableId`, a game already running, and what they buy in for
 * when they top up: [{stack, buyIn}] in chips, the same through the
 * line-up's block. Each has played up to SESSION_HOURS plus the time into the
 * block, winning or losing at a rate from their strength with a big swing,
 * so stacks spread out: a winner can sit well over the maximum buy-in, and
 * one who lost over half a buy-in has topped up. Whole big blinds.
 */
export function lineupStacks(seed, tableId, ids, blinds, room, minutes) {
  const {max} = buyInRange(blinds, room);
  const bb = blinds[1];
  const blockMinutes = 60 * BLOCK_HOURS;
  const block = Math.floor(minutes / blockMinutes);
  const into = (minutes % blockMinutes) / 60;
  return ids.map(id => {
    const r = key => roll(seed, tableId, 'stack', id, block, key);
    const buyIn = buyInFor(seed, tableId, id, blinds, room, minutes);
    const strength = strengthOf(id);
    const whale = WHALES.includes(id);
    const hours = into + 0.25 + r('hours') * SESSION_HOURS;
    const edge = whale ? -3 * EDGE_BB_HOUR : (2 * strength - 1) * EDGE_BB_HOUR;
    const swing = (whale ? 2 : 1) * SWING_BB_HOUR;
    const net = (edge * hours + swing * Math.sqrt(hours) * normal(r('u'), r('v'))) * bb;
    let stack = buyIn + net;
    // Lost over half of it: they topped up (as regulars.js has them do
    // between hands), and have played some of that too.
    if (stack < buyIn / 2) stack = buyIn * (0.5 + 0.6 * r('reload'));
    stack = Math.min(stack, 6 * max);
    return {stack: Math.max(bb, Math.round(stack / bb) * bb), buyIn};
  });
}

/** Just the stacks of lineupStacks, in chips. */
export function stacksAt(seed, tableId, ids, blinds, room, minutes) {
  return lineupStacks(seed, tableId, ids, blinds, room, minutes).map(s => s.stack);
}


/** The room a table id belongs to: `deuce-1/2-1` is at 'deuce'. */
export const roomOfTable = tableId => String(tableId).split('-')[0];

/**
 * Every low and mid stakes table at room `roomId` at game time `minutes`,
 * seated together so no one is at two tables: Map tableId → {seats, bench},
 * `seats` the five bot ids, `bench` players who can take a seat that comes
 * free.
 */
export function roomLineups(seed, roomId, minutes, have = null) {
  const block = blockOf(minutes);
  const day = Math.floor(minutes / 1440);
  const here = lobby(seed, minutes).find(r => r.room.id === roomId);
  const out = new Map();
  if (!here) return out;
  // The regs in the building this block: most of the home roster, and a few
  // from the other rooms.
  const regs = [];
  for (const room of ROOMS) {
    for (const r of roster(seed, room.id)) {
      const chance = room.id === roomId ? AT_HOME : VISITING;
      if (roll(seed, r.id, roomId, 'here', block) < chance) regs.push(r);
    }
  }
  const taken = new Set();
  const names = new Set();
  const free = id => !taken.has(id) && !names.has(personOf(id)?.name);
  const take = (id, list) => {
    taken.add(id);
    const name = personOf(id)?.name;
    if (name) names.add(name);
    list.push(id);
  };
  const share = touristShare(minutes);
  let slot = 0;
  const nextTourist = () => {
    for (let tries = 0; tries < 20; tries++) {
      const t = tourist(seed, roomId, day, Math.floor(roll(seed, roomId, 'slot', block, slot++) * TOURISTS_A_DAY), minutes);
      if (free(t)) return t;
    }
    return null;
  };
  const nextReg = (level, key) => {
    const options = regs.filter(r => r.level === level && free(r.id));
    return options.length ? options[Math.floor(roll(seed, key, block) * options.length)].id : null;
  };
  const softRegular = (stakes, key) => {
    const pool = POOLS[poolFor(stakes)].filter(id => (!have || have.includes(id)) && !taken.has(id));
    return pool.length ? pool[Math.floor(roll(seed, key, block) * pool.length)] : null;
  };
  const tables = here.games.filter(g => !bigGame(g.stakes)).flatMap(g => g.ids.map(id => ({id, stakes: g.stakes, low: poolFor(g.stakes) === 'low'})));
  const fill = (t, list, n, key) => {
    for (let i = 0; list.length < n && i < n * 8; i++) {
      const r = roll(seed, t.id, key, block, i);
      let who = null;
      if (t.low && r < REGULAR_AT_LOW) who = softRegular(t.stakes, `${t.id}|${key}|reg|${i}`);
      else if (r < (t.low ? share : share / 2)) who = nextTourist();
      else who = nextReg(t.low ? 'low' : 'mid', `${t.id}|${key}|${i}`) || nextTourist();
      if (who && free(who)) take(who, list);
    }
  };
  // Every table's seats first, then the benches, so a bench never leaves a
  // seat empty. Names are only kept apart within a table.
  const tableNames = new Map();
  for (const t of tables) {
    names.clear();
    const seats = [];
    if (!t.low) {
      for (let i = 0; i < REGULARS_AT_MID; i++) {
        const r = softRegular(t.stakes, `${t.id}|mid|${i}`);
        if (r) take(r, seats);
      }
    }
    fill(t, seats, LINEUP_SEATS, 'seat');
    tableNames.set(t.id, new Set(names));
    out.set(t.id, {seats, bench: []});
  }
  for (const t of tables) {
    names.clear();
    for (const n of tableNames.get(t.id)) names.add(n);
    fill(t, out.get(t.id).bench, BENCH, 'bench');
  }
  return out;
}

/**
 * Who replaces a player who leaves mid-session: anyone from the table's pool
 * (the stakes' Regulars), or, at a generic table, its bench.
 */
export function replacementPool(stakes, have = null, {seed, tableId, minutes, generic = false} = {}) {
  if (generic && !bigGame(stakes) && tableId) {
    const t = roomLineups(seed, roomOfTable(tableId), minutes, have).get(tableId);
    if (t?.bench.length) return t.bench;
  }
  return POOLS[poolFor(stakes)].filter(id => !have || have.includes(id));
}

// Who sits at a Bankroll Challenge table (#302): bot ids by stakes, room
// and time.
//
// - **1/2 and 2/5:** the room's generic players (quest-people.js), regs and
//   tourists, more tourists on a weekend evening. Mostly ABC players
//   (grinders), now and then a maniac, a rock or a calling station, now and
//   then one of the softer Regulars, and rarely a crusher (STYLE_MIX).
// - **5/10 and 10/20:** fewer ABC players, more Regulars, and crushers
//   often.
// - **25/50 and 50/100:** the tough Regulars (the top of the heads-up
//   challenge's strength order, ladder.js), and sometimes a whale.
//
// Without generic players (an older ducy-wasm), every seat is a Regular, the
// softest at the bottom. Pure, and the same for a table all through a block
// of game hours, so a table you look at in the lobby is the one you sit down
// at; within a room, no one sits at two tables at once. lineupStacks gives
// the running game's stacks.

import { ORDER } from './ladder.js';
import { ROOMS, lobby, regionOf, roll } from './quest-rooms.js';
import { buyInRange } from './quest.js';
import { personOf, roster, tourist, touristShare, wildness } from './quest-people.js';

export const LINEUP_SEATS = 5; // and you: 6-handed
// The wild ones who sometimes sit in big games, and only there.
export const WHALES = ['milk_king', 'nik_airbag'];
// The chance a big game has a whale in it, per block.
export const WHALE_CHANCE = 0.35;
// A table keeps its line-up for this many game hours.
const BLOCK_HOURS = 2;
// Who sits in a seat at a generic table, by stakes: the share of each
// style. ABC players are the grinders; a crusher is one of the strongest
// Regulars (CRUSHERS); a character one of the stakes' softer Regulars.
// Maniacs come more often as the night gets wild (quest-people.js wildness).
export const STYLE_MIX = {
  low: {grinder: 0.66, rock: 0.09, maniac: 0.09, station: 0.08, character: 0.05, crusher: 0.03},
  mid: {grinder: 0.4, rock: 0.07, maniac: 0.07, station: 0.04, character: 0.17, crusher: 0.25},
};
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
// The crushers: the strongest Regulars (the top of the strength order).
export const CRUSHERS = ORDER.slice(-6).filter(notWhale);
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

// A running game's stacks, fitted to a hand-by-hand simulation of live
// 6-max tables (#301 follow-up): six players of mixed skill (from -6 to +12
// bb/100, 90-115 bb/100 standard deviation), pots from small to stacks-off,
// losers topping up when under half a buy-in, winners keeping everything,
// sessions of a median 4 hours with 1 in 20 running 12 to 36. Sampled every
// half hour, about 43% of seats sat over the max buy-in, 8% over 2x, 2% over
// 3x, 0.2% over 5x and 0.01% over 10x, mostly players who'd been there a
// long time: after 12 hours, 27% over 2x and 1% over 5x.
//
// How long a player you walk up to has been sitting, from the simulation:
// the share in each 2-hour band, and the rest 12 hours or more.
const SEATED_HOURS = [[2, 0.29], [4, 0.20], [6, 0.13], [8, 0.09], [10, 0.064], [12, 0.048]];
// Past 12 hours: an exponential tail (mean 7 hours), to at most 36.
const LONG_TAIL_HOURS = 7;
// Their stack over what they bought in for is log-normal, its log with a
// mean and spread that grow with the hours: fitted to the simulation's share
// over 2x, 3x and 5x the max buy-in at 5, 9 and 18 hours.
const logMean = h => 0.25 * Math.log(1 + h) - 0.37;
const logSpread = h => 0.07 + 0.13 * Math.sqrt(h);
// Stronger players sit deeper (the simulation's sharks were over 2x three
// times as often as its tourists): this much on the log per unit strength.
const STRENGTH_LEAN = 0.31;
// A whale's stack swings wider, and leans toward losing.
const WHALE_SPREAD = 1.4;
const WHALE_LEAN = -0.1;
// No one sits with more than this many max buy-ins.
const STACK_CAP = 12;

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

/** How long a player has been sitting, in hours, from a roll `u` in [0, 1). */
export function seatedHours(u, v) {
  let below = 0;
  for (const [upTo, share] of SEATED_HOURS) {
    if (u < below + share) return upTo - 2 + 2 * (u - below) / share;
    below += share;
  }
  return Math.min(36, 12 + LONG_TAIL_HOURS * -Math.log(1 - v));
}

/**
 * What each of `ids` (as from lineupFor) has in front of them when you walk
 * up to table `tableId`, a game already running, and what they buy in for
 * when they top up: [{stack, buyIn}] in chips, the same line-up through its
 * block. Each has been sitting a while (seatedHours, plus the time into the
 * block), and their stack has grown or shrunk from their buy-in as the
 * simulation above has stacks do: most sit within a buy-in or two of where
 * they started, some winners at 2-3x the max buy-in, and now and then one
 * who's been there all day at 5-10x. One who lost over half a buy-in has
 * topped up. Whole big blinds.
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
    const hours = seatedHours(r('hours'), r('tail')) + into;
    const mean = logMean(hours) + STRENGTH_LEAN * (strength - 0.5) + (whale ? WHALE_LEAN : 0);
    const spread = logSpread(hours) * (whale ? WHALE_SPREAD : 1);
    const ratio = Math.exp(mean + spread * normal(r('u'), r('v')));
    // A winner wins other players' chips, so even a short buyer's winnings
    // grow with the table's stacks: between their buy-in and the max.
    let stack = ratio >= 1 ? buyIn + (ratio - 1) * (buyIn + max) / 2 : buyIn * ratio;
    // Lost over half of it: they topped up (as regulars.js has them do
    // between hands), and have played some of that too.
    if (stack < buyIn / 2) stack = buyIn * (0.5 + 0.6 * r('reload'));
    stack = Math.min(stack, STACK_CAP * max);
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
  // from the region's other rooms.
  const regs = [];
  const region = regionOf(here.room)?.id;
  for (const room of ROOMS.filter(r => regionOf(r)?.id === region)) {
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
  const wild = wildness(minutes);
  let slot = 0;
  // A tourist, of `family` if one is asked for.
  const nextTourist = family => {
    for (let tries = 0; tries < 20; tries++) {
      const t = tourist(seed, roomId, day, Math.floor(roll(seed, roomId, 'slot', block, slot++) * TOURISTS_A_DAY), minutes, family);
      if (free(t)) return t;
    }
    return null;
  };
  // A reg in the building who plays these stakes, of `family` if asked.
  const nextReg = (level, key, family = null) => {
    const options = regs.filter(r => r.level === level && free(r.id) && (!family || personOf(r.id)?.family === family));
    return options.length ? options[Math.floor(roll(seed, key, block) * options.length)].id : null;
  };
  const named = (pool, key) => {
    const options = pool.filter(id => (!have || have.includes(id)) && !taken.has(id));
    return options.length ? options[Math.floor(roll(seed, key, block) * options.length)] : null;
  };
  // The stakes' softer Regulars (not the crushers), and the crushers.
  const character = (stakes, key) => named(POOLS[poolFor(stakes)].filter(id => !CRUSHERS.includes(id)), key);
  const crusher = key => named(CRUSHERS, key);
  const styleFor = (t, r) => {
    const mix = {...STYLE_MIX[t.low ? 'low' : 'mid']};
    mix.maniac *= 1 + wild;
    let x = r * Object.values(mix).reduce((a, w) => a + w, 0);
    for (const [k, w] of Object.entries(mix)) if ((x -= w) < 0) return k;
    return 'grinder';
  };
  const tables = here.games.filter(g => !bigGame(g.stakes)).flatMap(g => g.ids.map(id => ({id, stakes: g.stakes, low: poolFor(g.stakes) === 'low'})));
  const fill = (t, list, n, key) => {
    for (let i = 0; list.length < n && i < n * 8; i++) {
      const k = `${t.id}|${key}|${i}`;
      const style = styleFor(t, roll(seed, t.id, key, 'style', block, i));
      let who = null;
      if (style === 'crusher') who = crusher(`${k}|crusher`);
      else if (style === 'character') who = character(t.stakes, `${k}|reg`);
      else {
        // A tourist or a reg (more tourists on a busy night), of that style.
        const touristFirst = roll(seed, t.id, key, block, i) < (t.low ? share : share / 2);
        const level = t.low ? 'low' : 'mid', other = t.low ? 'mid' : 'low';
        // A reg who usually plays the other stakes will sit in when theirs is short.
        const reg = () => nextReg(level, k, style) || nextReg(other, `${k}|other`, style);
        who = touristFirst ? nextTourist(style) || reg() : reg() || nextTourist(style);
      }
      if (who && free(who)) take(who, list);
    }
  };
  // Every table's seats first, then the benches, so a bench never leaves a
  // seat empty. Names are only kept apart within a table.
  const tableNames = new Map();
  for (const t of tables) {
    names.clear();
    const seats = [];
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

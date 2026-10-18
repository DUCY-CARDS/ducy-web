// Who sits at a Bankroll Quest table (#302, a first version): five Regulars
// picked by stakes, softest at the bottom and toughest at the top (the heads-up
// challenge's strength order, ladder.js), with a whale sometimes in a big
// game. Until the generic low-stakes players arrive (ducy #256), the small
// games are the Regulars' softer half. Pure, and the same for a table all
// through a block of game hours, so a table you look at in the lobby is the
// one you sit down at. lineupStacks gives the running game's stacks.

import { ORDER } from './ladder.js';
import { roll } from './quest-rooms.js';
import { buyInRange } from './quest.js';

export const LINEUP_SEATS = 5; // and you: 6-handed
// The wild ones who sometimes sit in big games, and only there.
export const WHALES = ['milk_king', 'nik_airbag'];
// The chance a big game has a whale in it, per block.
export const WHALE_CHANCE = 0.35;
// A table keeps its line-up for this many game hours.
const BLOCK_HOURS = 2;

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

/**
 * The five Regulars at table `tableId` (stakes name, e.g. '2/5') at game time
 * `minutes`, from the quest's `seed`. `have` (optional) is the personality ids
 * this engine has: anyone missing is skipped.
 */
export function lineupFor(seed, tableId, stakes, minutes, have = null) {
  const block = Math.floor(minutes / (60 * BLOCK_HOURS));
  const pool = POOLS[poolFor(stakes)].filter(id => !have || have.includes(id));
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

// How strong Regular `id` is, 0 (softest) to 1 (toughest), from the heads-up
// challenge's order.
const strengthOf = id => {
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

/** Who replaces a Regular who leaves mid-session: anyone from the table's pool. */
export const replacementPool = (stakes, have = null) => POOLS[poolFor(stakes)].filter(id => !have || have.includes(id));

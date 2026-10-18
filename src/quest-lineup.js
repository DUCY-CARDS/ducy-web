// Who sits at a Bankroll Quest table (#302, a first version): five Regulars
// picked by stakes, softest at the bottom and toughest at the top (the heads-up
// challenge's strength order, ladder.js), with a whale sometimes in a big
// game. Until the generic low-stakes players arrive (ducy #256), the small
// games are the Regulars' softer half. Pure, and the same for a table all
// through a block of game hours, so a table you look at in the lobby is the
// one you sit down at.

import { ORDER } from './ladder.js';
import { roll } from './quest-rooms.js';

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

/** Who replaces a Regular who leaves mid-session: anyone from the table's pool. */
export const replacementPool = (stakes, have = null) => POOLS[poolFor(stakes)].filter(id => !have || have.includes(id));

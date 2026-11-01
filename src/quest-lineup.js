// Who sits at a Bankroll Challenge table (#302): bot ids by stakes, room
// and time.
//
// - **1/2 and 2/5:** the room's generic players (quest-people.js), regs and
//   tourists, more tourists on a weekend evening. Mostly ABC players
//   (grinders), now and then a maniac, a rock or a calling station, now and
//   then one of the softer Regulars, and rarely a crusher (STYLE_MIX).
// - **5/10:** fewer ABC players, more Regulars, and crushers often.
// - **10/20:** four strong Regulars, or three and a rock, and an ABC player
//   or now and then a bad one.
// - **25/50 and 50/100:** the tough Regulars (the top of the heads-up
//   challenge's strength order, ladder.js), and sometimes a whale.
//
// The same for a table all through a block of game hours, so a table you
// look at in the lobby is the one you sit down at; within a room, no one
// sits at two tables at once. lineupStacks gives the running game's stacks.
// The seating lives in ducy-quest (Rust, #466); the pools are kept here for
// the demo's bots.

import { quest as op } from '../wasm/ducy_wasm.js';
import { ORDER } from './ladder.js';

export const LINEUP_SEATS = 5; // and you: 6-handed
// The wild ones who sometimes sit in big games, and only there.
export const WHALES = ['milk_king', 'nik_airbag'];
// The chance a big game has a whale in it, per block.
export const WHALE_CHANCE = 0.35;
// Who sits in a seat at a generic table, by stakes: the share of each
// style. ABC players are the grinders; a crusher is one of the strongest
// Regulars (CRUSHERS); a character one of the stakes' softer Regulars.
export const STYLE_MIX = {
  low: {grinder: 0.66, rock: 0.09, maniac: 0.09, station: 0.08, character: 0.05, crusher: 0.03},
  mid: {grinder: 0.4, rock: 0.07, maniac: 0.07, station: 0.04, character: 0.17, crusher: 0.25},
};

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
// The strong Regulars who make up a 10/20 game.
export const STRONG = ORDER.slice(-10).filter(notWhale);
// 10/20: three strong players and a rock this often, else four; a bad
// player in the last seat this often.
export const ROCK_AT_10_20 = 0.5;
export const BAD_AT_10_20 = 0.2;
export const poolFor = stakes => (['1/2', '2/5'].includes(stakes) ? 'low' : ['5/10', '10/20'].includes(stakes) ? 'mid' : 'high');
export const bigGame = stakes => poolFor(stakes) === 'high';

const haveList = have => (have ? [...have] : null);

/**
 * The five Regulars at table `tableId` (stakes name, e.g. '2/5') at game time
 * `minutes`, from the quest's `seed`. `have` (optional) is the personality ids
 * this engine has: anyone missing is skipped. With `generic`, low and mid
 * stakes tables seat generic players too (roomLineups).
 */
export const lineupFor = (seed, tableId, stakes, minutes, have = null, {generic = false} = {}) =>
  op({op: 'lineupFor', seed, table: String(tableId), stakes, minutes, have: haveList(have), generic});

/** What player `id` buys in (and tops up) for at table `tableId`, in chips, within the room's buy-in range. */
export const buyInFor = (seed, tableId, id, blinds, room, minutes) =>
  op({op: 'buyInFor', seed, table: String(tableId), id: String(id), blinds, room: room || {}, minutes});

/** How long a player has been sitting, in hours, from rolls `u` and `v` in [0, 1). */
export const seatedHours = (u, v) => op({op: 'seatedHours', u, v});

/**
 * What each of `ids` (as from lineupFor) has in front of them when you walk
 * up to table `tableId`, a game already running, and what they buy in for
 * when they top up: [{stack, buyIn}] in chips, the same line-up through its
 * block. Whole big blinds.
 */
export const lineupStacks = (seed, tableId, ids, blinds, room, minutes) =>
  op({op: 'lineupStacks', seed, table: String(tableId), ids: ids.map(String), blinds, room: room || {}, minutes});

/** Just the stacks of lineupStacks, in chips. */
export const stacksAt = (seed, tableId, ids, blinds, room, minutes) => lineupStacks(seed, tableId, ids, blinds, room, minutes).map(s => s.stack);

/** The room a table id belongs to: `deuce-1/2-1` is at 'deuce'. */
export const roomOfTable = tableId => String(tableId).split('-')[0];

/**
 * Every low and mid stakes table at room `roomId` at game time `minutes`,
 * seated together so no one is at two tables: Map tableId → {seats, bench}.
 */
export const roomLineups = (seed, roomId, minutes, have = null) => new Map(op({op: 'roomLineups', seed, room: roomId, minutes, have: haveList(have)}));

/** Who replaces a player who leaves mid-session: anyone from the table's pool, or, at a generic table, its bench. */
export const replacementPool = (stakes, have = null, {seed = 0, tableId = null, minutes = 0, generic = false} = {}) =>
  op({op: 'replacementPool', stakes, have: haveList(have), seed, table: tableId == null ? null : String(tableId), minutes, generic});

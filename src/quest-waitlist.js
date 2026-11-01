// The Bankroll Challenge's waitlists: every game in every room has players
// waiting for a seat, more when it's busy and at the small games, fewer at
// the big ones. The same for a world's seed: a list changes every 10 game
// minutes, as people are seated and others put their names down. Joining
// one is quest.js (joinList); this is who's on it and how fast it moves.
// From ducy-quest (Rust, #466).

import { quest as op } from '../wasm/ducy_wasm.js';
import { roomById } from './quest-rooms.js';

/** A game's list key in a room: `nlhe 1/2`, `plo4 2/5`. */
export const listKey = g => `${g.game || 'nlhe'} ${g.stakes}`;

/**
 * Game minutes between seats opening in a game at `stakes` spreading
 * `tables` tables (at your home club, `home`, almost none), faster with
 * more tables.
 */
export const seatGap = (tables, home = false, stakes = '1/2') => op({op: 'seatGap', tables, home: !!home, stakes});

/** Who's waiting for a game ({stakes, game}) in a room at game time `minutes`: their names. */
export const waitingAt = (seed, roomId, game, minutes) => op({op: 'waitingAt', seed, room: roomId, game: game.game || 'nlhe', stakes: game.stakes, minutes});

/**
 * Every game in every room right now with its list: [{room, games: [{...game,
 * key, waiting, gap}]}], as quest-rooms.js `lobby`. `homeRoomId`, your home
 * club, where seats come quickest.
 */
export const listsNow = (seed, minutes, homeRoomId = null) =>
  op({op: 'listsNow', seed, minutes, home: homeRoomId}).map(r => ({room: roomById(r.room), games: r.games}));

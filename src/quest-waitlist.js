// The Bankroll Challenge's waitlists: every game in every room has players
// waiting for a seat, more when it's busy and at the small games, fewer at
// the big ones. Pure, and the same for a world's seed: a list changes every
// LIST_MINUTES of game time, as people are seated and others put their names
// down. Joining one is quest.js (joinList); this is who's on it and how fast
// it moves.

import { activity, lobby, roll } from './quest-rooms.js';
import { botIdOf, familyFor, personOf } from './quest-people.js';

// A list's names change this often, in game minutes.
const LIST_MINUTES = 10;
// The longest a list gets.
const MAX_WAITING = 5;

/** A game's list key in a room: `nlhe 1/2`, `plo4 2/5`. */
export const listKey = g => `${g.game || 'nlhe'} ${g.stakes}`;

/**
 * Game minutes between seats opening in a game spreading `tables` tables:
 * a seat comes free about every 4 game minutes at one table (a minute of
 * real time), faster with more tables.
 */
export function seatGap(tables) {
  return Math.min(4, Math.max(1, 4 / Math.max(1, tables)));
}

/**
 * Who's waiting for a game in a room at game time `minutes`: their names
 * (made like the rooms' generic players), most at busy small games.
 */
export function waitingAt(seed, roomId, game, minutes) {
  const m = Math.floor(minutes);
  const day = Math.floor(m / 1440) % 7;
  const hour = Math.floor((m % 1440) / 60);
  const bucket = Math.floor(m / LIST_MINUTES);
  const small = ['1/2', '2/5'].includes(game.stakes);
  const most = (small ? MAX_WAITING : 3) * activity(day, hour);
  const n = Math.min(MAX_WAITING, Math.floor(roll(seed, roomId, listKey(game), 'waiting', bucket) * (most + 1)));
  const names = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor(roll(seed, roomId, listKey(game), 'name', bucket, i) * 2 ** 31) + 1;
    const name = personOf(botIdOf(familyFor('tourist', 0, roll(s, 'family')), s)).name;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Every game in every room right now with its list: [{room, games: [{...game,
 * key, waiting, gap}]}], from quest-rooms.js `lobby`.
 */
export function listsNow(seed, minutes) {
  return lobby(seed, minutes).map(r => ({
    room: r.room,
    games: r.games.map(g => ({...g, key: listKey(g), waiting: waitingAt(seed, r.room.id, g, minutes), gap: seatGap(g.tables)})),
  }));
}

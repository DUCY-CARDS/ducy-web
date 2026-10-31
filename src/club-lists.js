// Each game's waitlist (#518): ducy-play's club_lists, through
// club-rules.js. A game is its tables' type, stakes and seats (a table's
// key, "nlhe:1/2:9"); club.lists = {key: [{member, at, offer?: {table,
// until}, missed?}]}.
//
// Players join and leave lists themselves. When a seat is free, the next
// waiting is offered it for OFFER_MS, the seat held for them; a missed offer
// passes them over, and back within AWAY_MS they take their place again
// (club-server.js sends and times it).

import { rules } from './club-rules.js';

export const OFFER_MS = 60_000;
export const AWAY_MS = 10 * 60_000;

// A table's game, as the lists have it.
export const gameKey = t => `${t.game}:${t.sb}/${t.bb}:${t.seats}`;

// Game `key`'s list, oldest first.
export const listOf = (club, key) => club.lists?.[key] || [];

// Member `id` joins game `key`'s list (back in line if passed over); their
// place. Throws why not. For an offered game that isn't running (its
// interest list), `min`: the fewest players they'd start a table with (null:
// a full one).
export const joinList = (club, id, key, now = Date.now(), min = null) => rules(club, {op: 'joinList', id, key, min}, now);

// ---- interest lists: offered games that aren't running ----
//
// club.menu = [{key, name, game, sb, bb, minBB, maxBB, seats, …}]: the games
// the club offers (club-commands.js offer_game, remove_offer). Once enough
// are on an offered game's list, the first of them are asked "We're starting
// a new table. Join?", then further down each ASK_MS; a no takes them off;
// enough yes opens a table of it and seats them (club-server.js). The
// question goes by group `interest:<key>` in messages to members.

// Whether offered game `key` should ask about a table now.
export const wantsInterest = (club, key) => rules(club, {op: 'wantsInterest', key});
// Asks the first on its list. Throws why not. GroupNews (club-groups.js).
export const askInterest = (club, key, now = Date.now()) => rules(club, {op: 'askInterest', key}, now);
// A round ended: further down the list, or finish.
export const extendInterest = (club, key, now = Date.now()) => rules(club, {op: 'extendInterest', key}, now);
// Member `who` answers.
export const interestAnswer = (club, key, who, yes, now = Date.now()) => rules(club, {op: 'interestAnswer', key, who, yes}, now);
// Closes the question; `most`: the plan's tables open at once.
export const finishInterest = (club, key, most = null, now = Date.now()) => rules(club, {op: 'finishInterest', key, most}, now);
// Leaves it (or a manager takes them off); whether they were on it.
export const leaveList = (club, id, key) => rules(club, {op: 'leaveList', id, key});
// Back after a missed offer, within AWAY_MS; their place. Throws why not.
export const backOnList = (club, id, key, now = Date.now()) => rules(club, {op: 'backOnList', id, key}, now);
// Member `id` sat down at table `table`: off its game's list.
export const satDown = (club, id, table) => rules(club, {op: 'satDown', id, table});

// Offers the free seats (`taken`: {table: seats taken} at running tables)
// to the next on each list: [{to, body}] to send.
export const offerSeats = (club, taken, now = Date.now()) => rules(club, {op: 'offerSeats', taken}, now);
// Offers not taken in time, and places kept too long: [{to, body}] to send.
export const lapseLists = (club, now = Date.now()) => rules(club, {op: 'lapseLists'}, now);
// When that's next due, or null.
export const nextListDue = club => rules(club, {op: 'nextListDue'});
// What member `id` is told of their lists: {type: 'lists', club, lists}.
export const listsFor = (club, id) => rules(club, {op: 'listsFor', id});

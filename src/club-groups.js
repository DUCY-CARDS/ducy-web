// Grouped tables with must-move (#501): ducy-play's club_groups, through
// club-rules.js. A group is tables of one type in order, the main table
// first, then must-move 1, 2, 3; club.groups = [{id, tables, min, joined,
// ask?}].
//
// - Moving up: at each table with a seat free, the player longest in the
//   group at the table below moves up after their hand (club-host.js does
//   it as a manager's move, by GROUP_BY).
// - A new table: when the group's tables are full, everyone online but
//   those at them is asked "We're starting a new table. Join?" for ASK_MS
//   (club-server.js); it opens once the group's minimum say yes.

import { rules } from './club-rules.js';

export const MAX_GROUP_TABLES = 4;
export const DEFAULT_GROUP_MIN = 4;
export const ASK_MS = 60_000;
// Who a move up is by: no one, so it isn't logged, and the hit-and-run rule
// doesn't hold it.
export const GROUP_BY = 'group';

export const groupById = (club, id) => (club.groups || []).find(g => g.id === id) || null;

// The group table `tid` is in, and its place (0: the main table), or null.
export function groupOf(club, tid) {
  for (const g of club.groups || []) {
    const place = g.tables.indexOf(tid);
    if (place >= 0) return {group: g, place};
  }
  return null;
}

// "Main" or "Must-move 2", for a table's place in its group.
export const placeName = place => (place ? `Must-move ${place}` : 'Main');

export const makeGroup = (club, table, min = null, now = Date.now()) => rules(club, {op: 'makeGroup', table, min}, now);
export const setGroupMin = (club, id, min) => rules(club, {op: 'setGroupMin', id, min});
export const endGroup = (club, id) => rules(club, {op: 'endGroup', id});
export const satInGroup = (club, id, table, now = Date.now()) => rules(club, {op: 'satInGroup', id, table}, now);
export const leftGroup = (club, id, table, to = null) => rules(club, {op: 'leftGroup', id, table, to});

// Drops closed tables from their groups (and groups whose main table
// closed). Returns whether anything changed.
export function pruneGroups(club) {
  if (!club.groups?.length) return false;
  const before = JSON.stringify(club.groups);
  rules(club, {op: 'pruneGroups'});
  return JSON.stringify(club.groups || []) !== before;
}

// Who moves up in group `id`: [{id, from, to}]. `seated`: {table: [member
// ids]}; `held`: {table: seats held there for people on their way}.
export const movesUp = (club, id, seated, held) => rules(club, {op: 'movesUp', id, seated, held});

// Asks members `online` (all but those at the group's tables); returns who
// was asked, [] if too few to ask. Throws why not.
export const askGroup = (club, id, online, now = Date.now()) => rules(club, {op: 'askGroup', id, online}, now);

// Member `who` answers; returns whether enough have said yes.
export const answerGroup = (club, id, who, yes, now = Date.now()) => rules(club, {op: 'answerGroup', id, who, yes}, now);

// Closes the question: {opened (the new table's id, or null), yes, moves}.
export const endAsk = (club, id, most = null, now = Date.now()) => rules(club, {op: 'endAsk', id, most}, now);

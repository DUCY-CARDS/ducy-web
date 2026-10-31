// Must move (#501, #518): ducy-play's club_groups, through club-rules.js.
// The tables of one game (type, stakes and seats), set up by the manager as
// main tables and must-move tables feeding them; club.groups = [{id,
// tables, mains, min, autoOpen, autoMain, ask?}], the main tables first.
//
// - Moving up: when a seat opens at a table, the player who sat earliest at
//   the table feeding it moves up after their hand (club-host.js does it as
//   a manager's move, by GROUP_BY).
// - A new must-move table (autoOpen): once every table of the game is full
//   and enough wait on its list, the first of them are asked "We're
//   starting a new table. Join?", then the next each ASK_MS (club-server.js);
//   it opens once enough say yes.

import { rules } from './club-rules.js';

export const MAX_GROUP_TABLES = 4;
export const ASK_MS = 60_000;
// Who a move up is by: no one, so it isn't logged, and the hit-and-run rule
// doesn't hold it.
export const GROUP_BY = 'group';

export const groupById = (club, id) => (club.groups || []).find(g => g.id === id) || null;

// The group table `tid` is in, and its place (main tables first), or null.
export function groupOf(club, tid) {
  for (const g of club.groups || []) {
    const place = g.tables.indexOf(tid);
    if (place >= 0) return {group: g, place};
  }
  return null;
}

// Whether a group's table at `place` is a main table.
export const isMain = (g, place) => place < (g.mains ?? 1);

// The tables a group's table at `place` feeds: none for a main table, every
// main table for the first must-move table, else the one before it.
export function feeds(g, place) {
  const m = Math.min(g.mains ?? 1, g.tables.length);
  if (place < m) return [];
  return place === m ? g.tables.slice(0, m) : [g.tables[place - 1]];
}

// Drops closed tables from their groups (and groups with no main table
// left). Returns whether anything changed.
export function pruneGroups(club) {
  if (!club.groups?.length) return false;
  const before = JSON.stringify(club.groups);
  rules(club, {op: 'pruneGroups'});
  return JSON.stringify(club.groups || []) !== before;
}

// Who moves up in group `id`: [{id, from, to}]. `seated`: {table: [member
// ids]}; `held`: {table: seats held there for people on their way}.
export const movesUp = (club, id, seated, held) => rules(club, {op: 'movesUp', id, seated, held});

// "Make them main tables automatically": whether a must-move table became
// one (`taken`: {table: seats taken}).
export const promote = (club, id, taken) => rules(club, {op: 'promote', id, taken});

// Whether group `id` should ask about a new must-move table now.
export const wantsTable = (club, id, taken) => rules(club, {op: 'wantsTable', id, taken});

// The question, its answers and how it ends say what to tell members:
// {sends: [{to, kind, …}] to send now (kind 'ask', 'closed' or 'open'),
// opened (the new table to start), afterOpen (messages once it runs),
// moves ([{id, from, to}], by GROUP_BY), until (when this round ends: time
// it), finish (close it now), listsTo (members whose lists changed)}.

// Asks the first on the game's list. Throws why not.
export const askAbout = (club, id, now = Date.now()) => rules(club, {op: 'askAbout', id}, now);

// A round ended: further down the list, or finish.
export const extendAbout = (club, id, now = Date.now()) => rules(club, {op: 'extendAbout', id}, now);

// Member `who` answers.
export const groupAnswer = (club, id, who, yes, now = Date.now()) => rules(club, {op: 'groupAnswer', id, who, yes}, now);

// Closes the question; `most`: the plan's tables open at once.
export const finishAsk = (club, id, most = null, now = Date.now()) => rules(club, {op: 'finishAsk', id, most}, now);

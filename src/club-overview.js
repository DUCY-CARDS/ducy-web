// The club manager's Overview (#398): summary numbers (never a list of
// members), each table's dealing time, today's tournaments, and the member
// filters the numbers open. Pure functions over the club object (club.js).
//
// Dealing time: a table's clock runs only while hands are being dealt, and
// stops when fewer than two players are in hands (everyone else sitting
// out, say). club-host.js keeps it on the table as `dealing`:
//   {ms, since, stoppedAt}   ms dealt before `since` (when the clock last
//                            started, null while stopped); stoppedAt, when
//                            it last stopped
// The same measure can bill by table-hours later (#268).

import { owedBy, totals } from './club-chips.js';
import { openTables } from './club-tables.js';

export const DAY = 864e5;
export const NEW_DAYS = 7, INACTIVE_DAYS = 30;

// ---- dealing time ----

// The clock after the table is (on) or isn't dealing at `now`.
export function dealClock(clock, on, now = Date.now()) {
  const c = {ms: clock?.ms || 0, since: clock?.since ?? null, ...(clock?.stoppedAt ? {stoppedAt: clock.stoppedAt} : {})};
  if (on && c.since == null) return {...c, since: now};
  if (!on && c.since != null) return {ms: c.ms + Math.max(0, now - c.since), since: null, stoppedAt: now};
  return c;
}

// How long the table has dealt in all, up to `now`.
export const dealingMs = (clock, now = Date.now()) => (clock?.ms || 0) + (clock?.since != null ? Math.max(0, now - clock.since) : 0);
export const isDealing = clock => clock?.since != null;

// "2 h 05 m", "47 m", "0 m".
export function durationText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}

// ---- members ----

// When each member last played (a table or tournament entry in the
// ledger), by id.
const PLAYED = new Set(['buy_in', 'top_up', 'cash_out', 'tourney_buyin']);
export function lastPlayed(club) {
  const out = {};
  for (const e of club.chips?.ledger || []) if (PLAYED.has(e.kind) && e.at > (out[e.member] || 0)) out[e.member] = e.at;
  return out;
}

// The member filters (Overview's numbers open Members with one of them):
//   all       every member
//   new       joined in the last 7 days
//   inactive  no hand played in 30 days (one who joined since isn't yet)
//   owes      a negative balance: owes the club (#404)
//   agents    the club's agents (#74, #426)
//   noagent   members who aren't under an agent
//   agent     agent `agent`'s players (Members' By agent)
export const FILTERS = ['all', 'new', 'inactive', 'owes', 'agents', 'noagent'];
export function memberFilter(club, filter, now = Date.now(), played = lastPlayed(club), agent = '') {
  const members = Object.values(club.members || {}).filter(m => m.status === 'member');
  if (filter === 'new') return members.filter(m => now - (m.joinedAt || 0) < NEW_DAYS * DAY);
  if (filter === 'inactive') return members.filter(m => !m.seat && now - Math.max(played[m.id] || 0, m.joinedAt || 0) >= INACTIVE_DAYS * DAY);
  if (filter === 'owes') return members.filter(m => owedBy(m) > 0);
  if (filter === 'agents') return members.filter(m => m.agent === 'yes');
  if (filter === 'noagent') return members.filter(m => !m.agentOf || club.members[m.agentOf]?.agent !== 'yes');
  if (filter === 'agent') return members.filter(m => m.agentOf && m.agentOf === agent);
  return members;
}

// When each member was last active, by id: last heard from (`seen`, kept
// by an always-on club's room, #401), last played, or joined, whichever is
// latest; 0 when none of them is known.
export function lastActive(club, seen = {}, played = lastPlayed(club)) {
  const out = {};
  for (const m of Object.values(club.members || {})) out[m.id] = Math.max(Number(seen[m.id]) || 0, played[m.id] || 0, m.joinedAt || 0);
  return out;
}

// The Members list's orders (#426): by name, balance (highest first, or
// lowest: who owes the most), or last active (most recent first). Ties go
// by name. `active` is lastActive's map.
export const SORTS = ['name', 'balance', 'balance-low', 'active'];
export function sortMembers(list, sort = 'name', active = {}) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const by = {
    balance: (a, b) => (b.balance || 0) - (a.balance || 0),
    'balance-low': (a, b) => (a.balance || 0) - (b.balance || 0),
    active: (a, b) => (active[b.id] || 0) - (active[a.id] || 0),
  }[sort];
  return [...list].sort((a, b) => (by && by(a, b)) || byName(a, b));
}

// Page `page` (from 1) of `list`, `size` a page: {items, page, pages, from,
// to, total}, from and to counted from 1 ("51–100 of 230"). A page past the
// end shows the last one.
export const PAGE_SIZE = 50;
export function pageOf(list, page = 1, size = PAGE_SIZE) {
  const total = list.length, pages = Math.max(1, Math.ceil(total / size));
  const n = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  const items = list.slice((n - 1) * size, n * size);
  return {items, page: n, pages, from: total ? (n - 1) * size + 1 : 0, to: (n - 1) * size + items.length, total};
}

// ---- the overview ----

// The numbers on top: tables active (dealing) of those open, chips out in
// the club (given out less taken back), members, joined in the last 7
// days, inactive 30+ days, and what's owed each way (#404).
export function overviewNumbers(club, now = Date.now()) {
  const tables = openTables(club);
  const t = totals(club);
  const played = lastPlayed(club);
  return {
    tablesActive: tables.filter(x => isDealing(x.dealing)).length,
    tables: tables.length,
    chipsOut: t.issued - t.reclaimed,
    members: memberFilter(club, 'all', now, played).length,
    joined: memberFilter(club, 'new', now, played).length,
    inactive: memberFilter(club, 'inactive', now, played).length,
    owedToClub: t.owedToClub,
    owedToPlayers: t.owedToPlayers,
  };
}

// Each open table for the overview: its game, status, dealing time and seats.
export function tableSummaries(club, seated = {}, now = Date.now()) {
  return openTables(club).map(t => ({
    id: t.id, name: t.name, game: t.game, sb: t.sb, bb: t.bb, seats: t.seats, taken: seated[t.id] || 0, status: t.status,
    dealing: isDealing(t.dealing), ms: dealingMs(t.dealing, now), stoppedAt: isDealing(t.dealing) ? 0 : t.dealing?.stoppedAt || 0,
  }));
}

// Today's tournaments (on the viewer's calendar): running ones, then those
// still to start today, by start.
export function todaysTourneys(club, now = Date.now()) {
  const day = new Date(now);
  const today = t => { const d = new Date(t); return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate(); };
  const list = club.tourneys || [];
  return [
    ...list.filter(t => t.status === 'running'),
    ...list.filter(t => t.status === 'scheduled' && today(t.startsAt)).sort((a, b) => a.startsAt - b.startsAt),
  ];
}

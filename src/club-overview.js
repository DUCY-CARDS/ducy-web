// The club manager's Overview (#398): summary numbers (never a list of
// members), each table's dealing time, today's tournaments, and the member
// filters the numbers open. ducy-play's club_overview (clubOverview, from
// ducy-wasm, #456) works out the numbers, filters, activity, table
// summaries, notices (club-notices.js) and the club's totals
// (club-chips.js); what's only for showing them (orders, pages, durations,
// today on the viewer's calendar) is here.
//
// Dealing time: a table's clock runs only while hands are being dealt, and
// stops when fewer than two players are in hands (everyone else sitting
// out, say). club-host.js keeps it on the table as `dealing`:
//   {ms, since, stoppedAt}   ms dealt before `since` (when the clock last
//                            started, null while stopped); stoppedAt, when
//                            it last stopped
// The same measure can bill by table-hours later (#268).
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { startMoney } from './club-money.js';

export const DAY = 864e5;
export const NEW_DAYS = 7, INACTIVE_DAYS = 30;

// Runs Overview op `op` ('totals', 'numbers', 'filter', 'lastPlayed',
// 'lastActive', 'tables', 'creditNotices', 'notices') over the club.
export function overview(club, op, args = {}, now = Date.now()) {
  if (!club.money) startMoney(club, now);
  const r = ducy.clubOverview(JSON.stringify(club), op, JSON.stringify(args), now);
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

// ---- dealing time ----

// The clock after the table is (on) or isn't dealing at `now`.
export const dealClock = (clock, on, now = Date.now()) => ducy.dealClock(JSON.stringify(clock ?? null), on, now);

// Whether the clock is running, and how long it has dealt in all up to
// `now`, for a page counting it up.
export const isDealing = clock => clock?.since != null;
export const dealingMs = (clock, now = Date.now()) => (clock?.ms || 0) + (clock?.since != null ? Math.max(0, now - clock.since) : 0);

// "2 h 05 m", "47 m", "0 m".
export function durationText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}

// ---- members ----

// When each member last played (a table or tournament entry in the
// ledger), by id.
export const lastPlayed = club => overview(club, 'lastPlayed');

// The member filters (Overview's numbers open Members with one of them):
//   all       every member
//   new       joined in the last 7 days
//   inactive  no hand played in 30 days (one who joined since isn't yet)
//   owes      a negative balance: owes the club (#404)
//   agents    the club's agents (#74, #426)
//   noagent   members who aren't under an agent
//   agent     agent `agent`'s players (Members' By agent)
export const FILTERS = ['all', 'new', 'inactive', 'owes', 'agents', 'noagent'];
export function memberFilter(club, filter, now = Date.now(), agent = '') {
  return overview(club, 'filter', {filter, agent}, now).map(id => club.members[id]);
}

// When each member was last active, by id: last heard from (`seen`, kept
// by an always-on club's room, #401), last played, or joined, whichever is
// latest; 0 when none of them is known.
export const lastActive = (club, seen = {}) => overview(club, 'lastActive', {seen});

// The Members list's orders (#426): by name, balance (highest first, or
// lowest: who owes the most), last active (most recent first), or agent
// (#445: each agent then their players, by the agent's name; those under
// none last). Ties go by name. `active` is lastActive's map; `members` the
// club's, for agents' names.
export const SORTS = ['name', 'balance', 'balance-low', 'active', 'agent'];
export function sortMembers(list, sort = 'name', active = {}, members = {}) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const agentOf = m => (m.agent === 'yes' ? m : members[m.agentOf]?.agent === 'yes' ? members[m.agentOf] : null);
  const by = {
    balance: (a, b) => (b.balance || 0) - (a.balance || 0),
    'balance-low': (a, b) => (a.balance || 0) - (b.balance || 0),
    active: (a, b) => (active[b.id] || 0) - (active[a.id] || 0),
    agent: (a, b) => {
      const x = agentOf(a), y = agentOf(b);
      if (!x || !y) return !x - !y;
      return byName(x, y) || x.id.localeCompare(y.id) || (b === y) - (a === x);
    },
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
export const overviewNumbers = (club, now = Date.now()) => overview(club, 'numbers', {}, now);

// Each open table for the overview: its game, status, dealing time and seats.
export const tableSummaries = (club, seated = {}, now = Date.now()) => overview(club, 'tables', {seated}, now);

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

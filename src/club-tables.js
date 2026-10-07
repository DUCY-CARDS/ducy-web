// Club tables (#68): the host's tables and how chips move between a member's
// club balance and a table. Pure functions over the club object; the host's
// page (clubs.js) runs each table with ducy's MultiTable.club in a worker.
//
// A table: {id, name, game, sb, bb, minBB, maxBB, seats, turnSecs, status,
// createdAt}. Status is 'open', 'closing' (no new players; everyone is
// cashed out at the end of the hand) or 'closed' (kept for history).
//
// Chips: a member asks the table for chips (the engine checks the table's
// buy-in limits). The host approves when the club ledger allows it: a first
// request is a buy-in (balance, limits, the rathole rule, one table at a
// time), a later one a top-up from the balance. Whatever a member leaves
// with goes back to their balance (cash-out). Between hands the ledger
// follows each seated member's stack, so the club's totals add up.

import { buyIn, cashOut, ensureChips, setStack, topUp } from './club-chips.js';

export const GAMES = [
  {id: 'nlhe', label: 'No-limit Hold’em'},
  {id: 'plo4', label: 'Pot-limit Omaha'},
  {id: 'plo5', label: 'PLO 5-card'},
  {id: 'plo6', label: 'PLO 6-card'},
];
export const MAX_TABLE_NAME = 30;
export const MAX_SEATS = 10;
// How long someone may sit out before their seat is given up (#70): set per
// table, defaulting to the club's setting, which starts at 10 minutes. 0: no limit.
export const DEFAULT_SIT_OUT_MINS = 10;

const whole = n => Number.isSafeInteger(n) && n > 0;

function tableId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => (b % 36).toString(36)).join('');
}

// Adds a table to the club from the host's choices; throws on bad input.
export function newTable(club, {name = '', game = 'nlhe', sb = 1, bb = 2, minBB = 40, maxBB = 100, seats = MAX_SEATS, turnSecs = 30, sitOutMins = club.sitOutMins ?? DEFAULT_SIT_OUT_MINS} = {}, now = Date.now()) {
  ensureTables(club);
  if (!GAMES.some(g => g.id === game)) throw new Error('Pick a game.');
  if (!whole(sb) || !whole(bb) || bb < sb) throw new Error('The big blind must be at least the small blind, both above 0.');
  if (!whole(minBB) || !whole(maxBB) || maxBB < minBB) throw new Error('The maximum buy-in must be at least the minimum.');
  if (!Number.isSafeInteger(seats) || seats < 2 || seats > MAX_SEATS) throw new Error(`A table seats 2 to ${MAX_SEATS}.`);
  if (!Number.isSafeInteger(turnSecs) || turnSecs < 0) throw new Error('Pick a turn time.');
  if (!Number.isSafeInteger(sitOutMins) || sitOutMins < 0) throw new Error('Pick a sit-out limit.');
  const n = club.tables.length + 1;
  const t = {
    id: tableId(), name: String(name).trim().slice(0, MAX_TABLE_NAME) || `Table ${n}`,
    game, sb, bb, minBB, maxBB, seats, turnSecs, sitOutMins, status: 'open', createdAt: now,
  };
  club.tables.push(t);
  return t;
}

export function ensureTables(club) {
  club.tables ??= [];
  club.sitOutMins ??= DEFAULT_SIT_OUT_MINS;
  return ensureChips(club);
}

export const tableById = (club, id) => (club.tables || []).find(t => t.id === id) || null;
export const openTables = club => (club.tables || []).filter(t => t.status !== 'closed');
export const limits = t => ({min: t.minBB * t.bb, max: t.maxBB * t.bb});
export const gameLabel = id => GAMES.find(g => g.id === id)?.label || id;

// What members are told about the tables (no one's chips).
export function tablesBody(club, seatedCounts = {}) {
  return {
    type: 'tables', club: club.code,
    tables: openTables(club).filter(t => t.status === 'open').map(t => ({
      id: t.id, name: t.name, game: t.game, sb: t.sb, bb: t.bb, min: limits(t).min, max: limits(t).max,
      seats: t.seats, taken: seatedCounts[t.id] || 0,
    })),
  };
}

// May member `id` join table `t`? '' if so, else why not. `atTable` is the
// table they're at now (in the host's running session), if any.
export function canJoin(club, id, t, atTable) {
  const m = club.members[id];
  if (!m || m.status !== 'member') return 'Only club members can sit down.';
  if (!t || t.status !== 'open') return 'That table isn’t open.';
  if (atTable && atTable !== t.id) return 'You’re already at another table. Leave it first.';
  if (m.seat && m.seat.table !== t.id) return 'You’re already at another table. Leave it first.';
  return '';
}

// A member at table `t` asks for `amount` chips (the engine already checked
// the table's limits for their stack). Moves the chips in the ledger and
// returns the entry, or throws why not.
export function chipsForTable(club, id, t, amount, now = Date.now()) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Not a member of this club.');
  if (m.seat && m.seat.table !== t.id) throw new Error('Already seated at another table.');
  if (!m.seat) return buyIn(club, id, t.id, amount, limits(t), now);
  // The engine capped the stack at the table maximum.
  return topUp(club, id, amount, Number.MAX_SAFE_INTEGER, now);
}

// Someone left table `t` with `chips` (the engine's count): back to their balance.
export function leftTable(club, id, chips, now = Date.now()) {
  const m = club.members[id];
  if (!m?.seat) return null;
  setStack(club, id, chips);
  return cashOut(club, id, now);
}

// Between hands: the ledger takes each seated member's stack from the
// engine's count (`players`: [{client_id, chips}]).
export function syncStacks(club, players) {
  for (const p of players) {
    const m = club.members[p.client_id];
    if (m?.seat) setStack(club, p.client_id, Number(p.chips));
  }
}

// The host's page opened after closing with people at tables: those tables
// stopped, and any hand in progress didn't count. Everyone seated gets back
// the stack the ledger last had for them (from before that hand), except at
// tables in `keep`, which may resume where they were (#107): those are
// settled by cashOutTable if they can't.
export function cashOutEveryone(club, now = Date.now(), keep = new Set()) {
  ensureTables(club);
  const entries = [];
  for (const m of Object.values(club.members)) {
    if (m.seat && !keep.has(m.seat.table)) entries.push(cashOut(club, m.id, now));
  }
  for (const t of club.tables) if (t.status === 'closing') t.status = 'closed';
  return entries;
}

// Like cashOutEveryone, for the members seated at table `tid` only.
export function cashOutTable(club, tid, now = Date.now()) {
  return Object.values(club.members).filter(m => m.seat?.table === tid).map(m => cashOut(club, m.id, now));
}

// The newest ledger entry that moved chips to or from table `tid` (a buy-in,
// top-up or cash-out), or 0. A saved table whose snapshot was taken before
// that entry is out of step with the ledger and isn't resumed.
export function tableLedgerN(club, tid) {
  let n = 0;
  for (const e of club.chips?.ledger || []) if (e.table === tid && e.n > n) n = e.n;
  return n;
}

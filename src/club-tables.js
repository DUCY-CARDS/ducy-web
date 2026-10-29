// Club tables (#68): the host's tables and how chips move between a member's
// club balance and a table. Pure functions over the club object; the host's
// page (clubs.js) runs each table with ducy's MultiTable.club in a worker.
//
// A table: {id, name, game, sb, bb, minBB, maxBB, seats, turnSecs,
// sitOutMins, stayHands, status, createdAt}. Status is 'open', 'closing' (no new players; everyone is
// cashed out at the end of the hand) or 'closed' (kept for history).
//
// Chips: a member asks the table for chips (the engine checks the table's
// buy-in limits). The host approves when the club ledger allows it: a first
// request is a buy-in (balance, limits, the rathole rule, one table at a
// time), a later one a top-up from the balance. Whatever a member leaves
// with goes back to their balance (cash-out). Between hands the ledger
// follows each seated member's stack, so the club's totals add up.

import { buyIn, cashOut, ensureChips, setStack, topUp } from './club-chips.js';
import { ledgerOf } from './club-money.js';
import { chipInput } from './chip-format.js';

// `short` names tables by default ("NLH - 1/2"); `seats` is the most a game
// seats: 9 at most anywhere, and fewer where the deck runs out. Everyone's
// hole cards and two boards (running it twice) come from 52 cards, leaving
// 42 for hole cards, so PLO5 seats 8 (42 / 5) and PLO6 6 (42 / 6 would allow
// 7; 6 is the limit we keep). `defaultSeats` is a new table's size unless the
// host picks another.
export const MAX_SEATS = 9;
export const GAMES = [
  {id: 'nlhe', label: 'Hold’em', short: 'NLH', seats: MAX_SEATS, defaultSeats: 9},
  {id: 'plo4', label: 'Omaha 4', short: 'PLO', seats: MAX_SEATS, defaultSeats: 8},
  {id: 'plo5', label: 'Omaha 5', short: 'PLO5', seats: 8, defaultSeats: 6},
  {id: 'plo6', label: 'Omaha 6', short: 'PLO6', seats: 6, defaultSeats: 6},
];
export const MAX_TABLE_NAME = 30;
export const maxSeats = game => GAMES.find(g => g.id === game)?.seats ?? MAX_SEATS;
export const defaultSeats = game => GAMES.find(g => g.id === game)?.defaultSeats ?? 9;

// A new table's name when the host doesn't give one: the game and blinds,
// "NLH - 1/2", with " - #2", " - #3"… when an open table already has it.
// Plain numbers (chipInput), so it reads the same whatever the locale.
export function defaultTableName(club, game, sb, bb) {
  const short = GAMES.find(g => g.id === game)?.short || game;
  const base = `${short} - ${chipInput(sb)}/${chipInput(bb)}`;
  const taken = new Set(openTables(club).map(t => t.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} - #${i}`)) return `${base} - #${i}`;
}
// How long someone may sit out before their seat is given up (#70): set per
// table, defaulting to the club's setting, which starts at 10 minutes. 0: no limit.
export const DEFAULT_SIT_OUT_MINS = 10;
// The hit-and-run rule: once a player is up at a table (their stack more than
// they brought to it), they play this many more hands before they may leave.
// Set per table; 0 is off, the default. Back to even or down, they may leave
// any time, and the count starts again if they get ahead again.
export const MAX_STAY_HANDS = 500;

const whole = n => Number.isSafeInteger(n) && n > 0;

function tableId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => (b % 36).toString(36)).join('');
}

// The club's plan allows `limits.tables` tables open at once (#265); throws
// if one more would be too many. No limits: no cap.
export function checkTableLimit(club, limits) {
  const most = limits?.tables;
  if (!Number.isSafeInteger(most)) return;
  if (openTables(club).length >= most) {
    throw new Error(most === 0 ? 'This club can’t open tables. Ask ducy about it.' : `This club can have ${most} ${most === 1 ? 'table' : 'tables'} open at once. Close one first, or ask ducy for more.`);
  }
}

// Adds a table to the club from the host's choices; throws on bad input,
// or when the club's `limits` (#265) allow no more.
export function newTable(club, {name = '', game = 'nlhe', sb = 1, bb = 2, minBB = 40, maxBB = 100, seats = defaultSeats(game), turnSecs = 30, sitOutMins = club.sitOutMins ?? DEFAULT_SIT_OUT_MINS, stayHands = club.stayHands ?? 0} = {}, now = Date.now(), limits = null) {
  ensureTables(club);
  checkTableLimit(club, limits);
  if (!GAMES.some(g => g.id === game)) throw new Error('Pick a game.');
  if (!whole(sb) || !whole(bb) || bb < sb) throw new Error('The big blind must be at least the small blind, both above 0.');
  if (!whole(minBB) || !whole(maxBB) || maxBB < minBB) throw new Error('The maximum buy-in must be at least the minimum.');
  const most = maxSeats(game);
  if (!Number.isSafeInteger(seats) || seats < 2 || seats > most) {
    throw new Error(`${aGame(game)} table seats 2 to ${most}.`);
  }
  if (!Number.isSafeInteger(turnSecs) || turnSecs < 0) throw new Error('Pick a turn time.');
  if (!Number.isSafeInteger(sitOutMins) || sitOutMins < 0) throw new Error('Pick a sit-out limit.');
  if (!Number.isSafeInteger(stayHands) || stayHands < 0 || stayHands > MAX_STAY_HANDS) {
    throw new Error(`Call time: 0 (off) to ${MAX_STAY_HANDS} hands.`);
  }
  const t = {
    id: tableId(), name: String(name).trim().slice(0, MAX_TABLE_NAME) || defaultTableName(club, game, sb, bb),
    game, sb, bb, minBB, maxBB, seats, turnSecs, sitOutMins, stayHands, status: 'open', createdAt: now,
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
// "A Hold’em", "An Omaha 6": the game with its article, to start a sentence.
export const aGame = id => `${/^[AEIOU]/i.test(gameLabel(id)) ? 'An' : 'A'} ${gameLabel(id)}`;

// What members are told about the tables (no one's chips).
export function tablesBody(club, seatedCounts = {}) {
  return {
    type: 'tables', club: club.code,
    tables: openTables(club).filter(t => t.status === 'open').map(t => ({
      id: t.id, name: t.name, game: t.game, sb: t.sb, bb: t.bb, min: limits(t).min, max: limits(t).max,
      seats: t.seats, taken: seatedCounts[t.id] || 0,
      // The hit-and-run rule, so members know before they sit.
      ...(t.stayHands ? {stayHands: t.stayHands} : {}),
    })),
    // The rathole rule's window, so members see it before they sit (#187).
    rathole: club.ratholeHours ?? 0,
  };
}

// What a member may buy in for at table `t` (from tablesBody), by their own
// ledger copy `entries` (#187): {min, max, rathole}, where `rathole` is the
// stack they left the table with less than `ratholeHours` ago (the rule's
// floor, club-chips.js ratholeMin), or 0.
export function buyInRange(t, entries = [], ratholeHours = 0, now = Date.now()) {
  const left = [...entries].reverse().find(e => e.kind === 'cash_out' && !e.player && e.about === t.id);
  const rathole = left && ratholeHours && now - left.at < ratholeHours * 3600e3 ? left.amount : 0;
  return {min: Math.min(t.max, Math.max(t.min, rathole)), max: t.max, rathole};
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
// engine's count (`players`: [{client_id, chips}]). `handNumber`, the hand
// just finished, marks when someone first got ahead at the table (`upAt`,
// for the hit-and-run rule); back to even or down clears it.
export function syncStacks(club, players, handNumber = 0) {
  for (const p of players) {
    const m = club.members[p.client_id];
    if (!m?.seat) continue;
    setStack(club, p.client_id, Number(p.chips));
    const s = m.seat;
    if (s.put == null) continue; // seated before the ledger kept what they brought
    if (s.stack > s.put) s.upAt ??= handNumber;
    else delete s.upAt;
  }
}

// The hit-and-run rule: how many more hands member `id` plays at table `t`
// before they may leave, with `completed` hands finished there so far. 0 when
// they may go: the table has no rule, they aren't up, or they've played them.
export function handsToStay(club, id, t, completed) {
  const need = t?.stayHands || 0;
  const s = club.members[id]?.seat;
  if (!need || !s || s.table !== t.id || s.upAt == null || s.put == null || !(s.stack > s.put)) return 0;
  return Math.max(0, need - (completed - s.upAt));
}

// What a player is told when they try to leave too soon.
export const stayText = n => `You’re up at this table, so you play ${n} more ${n === 1 ? 'hand' : 'hands'} before you can leave. Sitting out doesn’t stop the count: you’re dealt in and fold, posting your blinds, until it’s done.`;

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
  for (const t of club.tables) if (t.status === 'closing' && !keep.has(t.id)) t.status = 'closed';
  return entries;
}

// Like cashOutEveryone, for the members seated at table `tid` only.
export function cashOutTable(club, tid, now = Date.now()) {
  return Object.values(club.members).filter(m => m.seat?.table === tid).map(m => cashOut(club, m.id, now));
}

// ---- reserved seats (#425) ----
//
// The first piece of a waiting list: per table, the members a seat is held
// for, in club.waitlist[table id] = [{member, at, until, from?, by?}], oldest
// first. A member seated at one table reserves a seat at another (or a
// manager does it for them): no one else can take it, and they leave their
// table after the hand and sit down there as usual. `from`: the table
// they're leaving; the hold doesn't lapse while they're still at it,
// finishing their hand, and they have HOLD_MS from leaving it (club-host.js
// sets `until` then). `by`: the manager who moved them.
export const HOLD_MS = 60_000;

// Reservations at table `tid` still held at `now`.
export function reservations(club, tid, now = Date.now()) {
  return (club.waitlist?.[tid] || []).filter(e => e.until > now || stillAt(club, e));
}
const stillAt = (club, e) => !!e.from && club.members[e.member]?.seat?.table === e.from;

// Seats held at table `tid` for anyone but `except`.
export const heldSeats = (club, tid, now = Date.now(), except = '') => reservations(club, tid, now).filter(e => e.member !== except).length;

// Member `id`'s reservation at table `tid`, if it's held.
export const reservationOf = (club, tid, id, now = Date.now()) => reservations(club, tid, now).find(e => e.member === id) || null;

// Holds a seat at table `t` for member `id`, who is at table `from` (or at
// none). `seated`: how many are at `t` now. Throws why not.
export function reserveSeat(club, id, t, seated, {from = '', by = null, now = Date.now(), holdMs = HOLD_MS} = {}) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Only club members can sit down.');
  if (!t || t.status !== 'open') throw new Error('That table isn’t open.');
  if (from === t.id) throw new Error('You’re at that table already.');
  if (seated + heldSeats(club, t.id, now, id) >= t.seats) throw new Error('That table is full.');
  pruneReservations(club, now);
  // One reservation at a time.
  for (const tid of Object.keys(club.waitlist || {})) dropReservation(club, tid, id);
  club.waitlist ??= {};
  const e = {member: id, at: now, until: now + holdMs, ...(from ? {from} : {}), ...(by ? {by} : {})};
  (club.waitlist[t.id] ??= []).push(e);
  return e;
}

// Gives up member `id`'s reservation at table `tid` (they sat down, or it
// was called off). Returns whether there was one.
export function dropReservation(club, tid, id) {
  const list = club.waitlist?.[tid];
  if (!list?.some(e => e.member === id)) return false;
  club.waitlist[tid] = list.filter(e => e.member !== id);
  if (!club.waitlist[tid].length) delete club.waitlist[tid];
  return true;
}

// Drops the reservations that have lapsed; returns them.
export function pruneReservations(club, now = Date.now()) {
  const gone = [];
  for (const [tid, list] of Object.entries(club.waitlist || {})) {
    const keep = list.filter(e => e.until > now || stillAt(club, e));
    gone.push(...list.filter(e => !keep.includes(e)).map(e => ({...e, table: tid})));
    if (keep.length) club.waitlist[tid] = keep; else delete club.waitlist[tid];
  }
  return gone;
}

// When the next reservation lapses, or Infinity.
export function nextLapse(club) {
  let due = Infinity;
  for (const list of Object.values(club.waitlist || {})) for (const e of list) if (!stillAt(club, e)) due = Math.min(due, e.until);
  return due;
}

// The newest ledger entry that moved chips to or from table `tid` (a buy-in,
// top-up or cash-out), or 0. A saved table whose snapshot was taken before
// that entry is out of step with the ledger and isn't resumed.
export function tableLedgerN(club, tid) {
  let n = 0;
  for (const e of ledgerOf(club)) if (e.about === tid && e.n > n) n = e.n;
  return n;
}

// Club tables (#68): the host's tables and how chips move between a member's
// club balance and a table. The tables' rules (making one, who may sit, the
// hit-and-run rule, reserved seats) are ducy-play's (club-rules.js, #455);
// the chips go through the money model (club-chips.js). The host's page
// (clubs.js) runs each table with ducy's MultiTable.club in a worker.
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
import { rules } from './club-rules.js';

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
// Plain numbers, so it reads the same whatever the locale.
export const defaultTableName = (club, game, sb, bb) => rules(club, {op: 'defaultTableName', game: String(game), sb: Number(sb) || 0, bb: Number(bb) || 0});
// How long someone may sit out before their seat is given up (#70): set per
// table, defaulting to the club's setting, which starts at 10 minutes. 0: no limit.
export const DEFAULT_SIT_OUT_MINS = 10;
// The hit-and-run rule: once a player is up at a table (their stack more than
// they brought to it), they play this many more hands before they may leave.
// Set per table; 0 is off, the default. Back to even or down, they may leave
// any time, and the count starts again if they get ahead again.
export const MAX_STAY_HANDS = 500;

// Adds a table to the club from the host's choices ({name, game, sb, bb,
// minBB, maxBB, seats, turnSecs, sitOutMins, stayHands}, each optional:
// Hold'em 1/2, 40 to 100 big blinds, the game's usual seats, 30 seconds,
// the club's sit-out limit and call time); throws on bad input, or when
// the club's `limits` (#265) allow no more tables open at once. Returns
// the table, as kept in club.tables.
export function newTable(club, spec = {}, now = Date.now(), limits = null) {
  ensureTables(club);
  const most = Number.isSafeInteger(limits?.tables) && limits.tables >= 0 ? limits.tables : null;
  const t = rules(club, {op: 'newTable', spec: spec || {}, most}, now);
  return tableById(club, t.id);
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

// What members are told about the tables (no one's chips), with the
// hit-and-run rule's hands and the rathole rule's window (#187), so they
// know before they sit.
export const tablesBody = (club, seatedCounts = {}) => rules(club, {op: 'tablesBody', seated: seatedCounts});

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
export const canJoin = (club, id, t, atTable) => rules(club, {op: 'canJoin', id, table: t?.id || '', at: atTable || null});

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
  const seated = players.filter(p => club.members[p.client_id]?.seat);
  for (const p of seated) setStack(club, p.client_id, Number(p.chips));
  if (seated.length) rules(club, {op: 'noteStacks', players: seated.map(p => p.client_id), hand: handNumber});
}

// The hit-and-run rule: how many more hands member `id` plays at table `t`
// before they may leave, with `completed` hands finished there so far. 0 when
// they may go: the table has no rule, they aren't up, or they've played them.
export const handsToStay = (club, id, t, completed) => (t ? rules(club, {op: 'handsToStay', id, table: t.id, completed: Math.max(0, completed || 0)}) : 0);

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
  rules(club, {op: 'closeClosing', keep: [...keep]});
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

// Reservations at table `tid` still held at `now`. A reservation made from
// another table doesn't lapse while its member is still at that table.
export const reservations = (club, tid, now = Date.now()) => rules(club, {op: 'reservations', table: tid}, now);

// Seats held at table `tid` for anyone but `except`.
export const heldSeats = (club, tid, now = Date.now(), except = '') => rules(club, {op: 'heldSeats', table: tid, except}, now);

// Member `id`'s reservation at table `tid`, if it's held.
export const reservationOf = (club, tid, id, now = Date.now()) => reservations(club, tid, now).find(e => e.member === id) || null;

// Holds a seat at table `t` for member `id`, who is at table `from` (or at
// none). `seated`: how many are at `t` now. One reservation at a time.
// Returns it; throws why not.
export const reserveSeat = (club, id, t, seated, {from = '', by = null, now = Date.now(), holdMs = HOLD_MS} = {}) => rules(club, {op: 'reserveSeat', id, table: t?.id || '', seated, from: from || null, by: by || null, holdMs}, now);

// Gives up member `id`'s reservation at table `tid` (they sat down, or it
// was called off). Returns whether there was one.
export const dropReservation = (club, tid, id) => rules(club, {op: 'dropReservation', table: tid, id});

// Member `id` left the table they reserved from: their seat at `tid` is
// held `holdMs` from now. Returns whether they had one.
export const holdFrom = (club, tid, id, now = Date.now(), holdMs = HOLD_MS) => rules(club, {op: 'holdFrom', table: tid, id, holdMs}, now);

// Drops the reservations that have lapsed; returns them, each with its `table`.
export const pruneReservations = (club, now = Date.now()) => rules(club, {op: 'pruneReservations'}, now);

// When the next reservation lapses, or Infinity.
export const nextLapse = club => rules(club, {op: 'nextLapse'}) ?? Infinity;

// The newest ledger entry that moved chips to or from table `tid` (a buy-in,
// top-up or cash-out), or 0. A saved table whose snapshot was taken before
// that entry is out of step with the ledger and isn't resumed.
export function tableLedgerN(club, tid) {
  let n = 0;
  for (const e of ledgerOf(club)) if (e.about === tid && e.n > n) n = e.n;
  return n;
}

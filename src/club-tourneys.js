// Club tournaments (#64): creating one and registering (#77), prize payouts
// (#79), late registration and re-entries (#80), and the results of running
// one (#81, club-tourney-host.js runs the tables). ducy-play's club_tourneys
// (clubTourneys, from ducy-wasm, #457) runs the rules; here the chips move.
//
// A tournament: {id, name, game, buyIn, added, stack, structure, opensAt,
// startsAt, minPlayers, maxPlayers, tableSize, lateLevel, reentry,
// maxReentries, payout, status, entries, held, createdAt}.
// - buyIn and added are club chips (hundredths, chip-format.js). The pool is
//   every entry's buy-in plus the added chips. No fee for now.
// - stack and the structure (#78: [{sb, bb, ante, minutes} | {break: true,
//   minutes}]) are tournament chips: whole numbers, nothing to do with club chips.
// - lateLevel: registration and re-entry stay open until the end of that
//   level (0: none after the start). reentry: a busted player may buy in
//   again then, as a new entry; maxReentries: per player (0: no limit).
// - payout: null for the defaults (by the number of entries), or the
//   tournament's own payout table {rows} (#424; a one-off tournament's).
//   An older {places: [basis points]} is a table of one row from 1 entry.
// - payoutTable: the id of the club payout table it pays by (#424), if any:
//   club.payoutTables, [{id, name, rows}]. Neither: the defaults.
// - paidShares: once it's finished, the shares it paid by.
// A payout table's rows: [{from, places}], `from` the number of entries
// the row starts at (ascending), `places` basis points by place adding up
// to exactly 10 000. A row is in force until the next one starts.
// - status: 'scheduled' → 'running' → 'finished', or 'cancelled'.
// - entries: [{n, member, at, place}] in order; a member's last entry is
//   their current one, and place is set once it's knocked out (1: the winner).
//
// Club chips stay conserved: buy-ins move down a member's path into the
// tournament (`held`), taken before the entry is made; a refund moves them
// back up it; prizes pay out what's held plus the added chips, which are
// issued then (club-chips.js, #454).
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { payTo, tourneyBuyIn } from './club-chips.js';
import { startMoney } from './club-money.js';

export const MAX_TOURNEY_NAME = 40;
export const MAX_ENTRIES = 1000;
export const MAX_PAYOUT_TABLES = 20;
export const MAX_PAYOUT_ROWS = 50;
export const MAX_PAYOUT_NAME = 30;

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Each of `list` made like the same id's in `from`, keeping the objects.
const byId = (list, from) => {
  const had = new Map((list || []).map(x => [x.id, x]));
  return from.map(x => (had.has(x.id) ? merge(had.get(x.id), x) : x));
};

// Runs `op` on the club's tournaments; returns its value. A tournament or
// payout table someone holds stays the one in the club. Throws why, if refused.
function rules(club, op, now = Date.now()) {
  const part = {code: club.code, members: club.members || {}, tourneys: club.tourneys || [], payoutTables: club.payoutTables || []};
  const r = ducy.clubTourneys(JSON.stringify(part), op, now);
  if (!r.ok) throw new Error(r.message);
  if (r.club) {
    club.tourneys = byId(club.tourneys, r.club.tourneys);
    club.payoutTables = byId(club.payoutTables, r.club.payoutTables);
  }
  return r.value;
}

export function ensureTourneys(club) {
  club.tourneys ??= [];
  return club.tourneys;
}

export const tourneyById = (club, id) => (club.tourneys || []).find(t => t.id === id) || null;

// A member's current entry, if any.
export const entryOf = (t, id) => t.entries.findLast(e => e.member === id) || null;
// Registered and not knocked out.
export const isIn = (t, id) => { const e = entryOf(t, id); return !!e && e.place == null; };
// Entries so far (re-entries count), and the prize pool.
export const entryCount = t => t.entries.length;
export const pool = t => t.entries.length * t.buyIn + t.added;
// Different players registered.
export const playerCount = t => new Set(t.entries.map(e => e.member)).size;

// A new tournament. Throws why the settings won't do, or when the club's
// `limits` (#265: tourneysPerDay) allow no more that day.
export function newTourney(club, s = {}, now = Date.now(), limits = null) {
  const most = Number.isSafeInteger(limits?.tourneysPerDay) ? limits.tourneysPerDay : null;
  return tourneyById(club, rules(club, {op: 'new', s, most}, now).id);
}

// A member registers before the start (#77): registration must be open and
// the tournament not full. The buy-in goes down their path first.
export function register(club, tid, id, now = Date.now()) {
  const buyIn = rules(club, {op: 'checkRegister', tid, id}, now);
  if (buyIn > 0) tourneyBuyIn(club, id, tid, buyIn, now);
  return rules(club, {op: 'register', tid, id}, now);
}

// A member unregisters before the start, and gets the buy-in back.
export function unregister(club, tid, id, now = Date.now()) {
  const back = rules(club, {op: 'unregister', tid, id}, now);
  if (back.amount > 0) payTo(club, id, 'refund', back.amount, tid, now);
}

// Late registration or a re-entry (#80), while the tournament is running and
// `level` (from 0, the level being played) is no later than the last
// registration level. Returns the new entry.
export function lateEntry(club, tid, id, level, now = Date.now()) {
  const buyIn = rules(club, {op: 'checkLateEntry', tid, id, level}, now);
  if (buyIn > 0) tourneyBuyIn(club, id, tid, buyIn, now);
  return rules(club, {op: 'lateEntry', tid, id, level}, now);
}

// What to do at the start time: 'start', or 'cancel' when fewer than the
// minimum registered; null before then.
export function atStart(t, now = Date.now()) {
  return rules({tourneys: [t]}, {op: 'atStart', tid: t.id}, now);
}

// Cancels a tournament that hasn't finished: every buy-in goes back (the
// added chips were never paid). Also used when a running tournament can't go
// on (its host restarted).
export function cancelTourney(club, tid, now = Date.now(), why = '') {
  for (const back of rules(club, {op: 'cancel', tid, why}, now)) payTo(club, back.member, 'refund', back.amount, tid, now);
  return tourneyById(club, tid);
}

export function startTourney(club, tid, now = Date.now()) {
  rules(club, {op: 'start', tid}, now);
  return tourneyById(club, tid);
}

// ---- payouts (#79, #424) ----

// The default shares for `entries` entries, in basis points adding up to
// exactly 10 000: about the top 15% paid, on a falling curve.
export const defaultPayout = entries => Array.from(ducy.defaultPayout(Math.max(0, entries)));

// Checks a payout table's rows: at least one, each starting at more entries
// than the one before (from 1), each row's shares whole basis points above
// 0, none more than the place above, adding up to exactly 10 000. Returns a
// clean copy; throws why not.
export function checkPayoutRows(rows) {
  const r = ducy.checkPayoutRows(JSON.stringify(rows ?? null));
  if (!r.ok) throw new Error(r.message);
  return r.rows;
}

// The row in force for `entries` entries: the last that starts at or below
// them (below the first row's start, the first row).
export function payoutRow(rows, entries) {
  return rows.findLast(r => r.from <= entries) || rows[0];
}

export const payoutTableById = (club, id) => (club?.payoutTables || []).find(p => p.id === id) || null;

// The rows a tournament pays by: its club table's, its own (an older
// single list of shares as one row from 1 entry), or null for the defaults.
export function payoutRows(t, club = null) {
  if (t.payoutTable) return payoutTableById(club, t.payoutTable)?.rows || null;
  if (t.payout?.rows) return t.payout.rows;
  if (t.payout?.places) return [{from: 1, places: t.payout.places}];
  return null;
}

const payouts = (t, club) => ducy.tourneyPayouts(JSON.stringify(t), JSON.stringify(club?.payoutTables || []));

// The shares in force: what it paid by once finished; else the row in force
// for the entries so far, or the defaults for them. `club`: for club tables.
export const payoutShares = (t, club = null) => payouts(t, club).shares;

// The prizes for the current pool, by place (index 0: first), adding up to
// exactly the pool; rounding remainders go to first place. No more places
// than entries: what places beyond them would get goes to first too.
export const prizes = (t, club = null) => payouts(t, club).prizes;

// The tournament's own payouts: a table {rows}, a single list of shares (a
// table of one row from 1 entry), or null to go back to the defaults. It
// then pays by no club table.
export function setPayout(club, tid, payout) {
  rules(club, {op: 'setPayout', tid, payout: payout ?? null});
  return tourneyById(club, tid);
}

// The tournament pays by club table `id`, or (null) the defaults.
export function setPayoutTable(club, tid, id) {
  rules(club, {op: 'setPayoutTable', tid, table: id ?? null});
  return tourneyById(club, tid);
}

// A new club payout table {name, rows}. Returns it; throws why not.
export function addPayoutTable(club, s = {}) {
  return payoutTableById(club, rules(club, {op: 'addPayoutTable', s}).id);
}

// Renames a club payout table and/or changes its rows. The tournaments
// still to finish that pay by it follow; finished ones keep what they paid.
export function editPayoutTable(club, id, s = {}) {
  rules(club, {op: 'editPayoutTable', id, s});
  return payoutTableById(club, id);
}

// Deletes a club payout table, unless a tournament still to finish pays by
// it (switch those first). Returns the table.
export const deletePayoutTable = (club, id) => rules(club, {op: 'deletePayoutTable', id});

// ---- results (#81) ----

// Entry `id` (a member) was knocked out, in `place` as things stand. Knockouts
// are numbered in the order they happen: entries registered late change the
// count, so final places are set at the finish (finishTourney).
export function knockedOut(club, tid, id, place) {
  rules(club, {op: 'knockedOut', tid, id, place});
  return entryOf(tourneyById(club, tid), id);
}

// The tournament has a winner: places are final, and the prizes go into
// winners' club balances. Returns [{member, place, amount}].
export function finishTourney(club, tid, winner, now = Date.now()) {
  const {paid, issued} = rules(club, {op: 'finish', tid, winner}, now);
  for (const p of paid) payTo(club, p.member, 'prize', p.amount, tid, now);
  // What was paid beyond what was held: the added chips, issued now.
  club.chips.issued += issued;
  return paid;
}

// What members see of the club's tournaments (the lobby), with how running
// ones are going (`live`: {[tid]: {level, playersLeft, ...}} from the host).
export const tourneysBody = (club, live = {}, now = Date.now()) => rules(club, {op: 'body', live}, now);

// ---- running them (#456) ----

// ducy-play's club_tourney_host (clubTourneyHost) says what tournament
// `tid`'s start time and each result from its runner mean for the club:
// starting or cancelling it, resuming it, who's knocked out, the prizes.
// Ops: 'atStart' {seed}, 'abandon' {why, log}, 'resume' {saved, online},
// 'result' {res, clock}, 'check' {id, running}, 'enter' {id, level},
// 'playing' {id, running}. Returns the step for club-tourney-host.js to
// carry out: {sends: [{to, update}], events (for the runner), chipsChanged,
// changed, liveChanged, live, onPlay, over, counts, value}. Throws why
// not, and nothing changes.
export function tourneyHost(club, tid, op, args = {}, now = Date.now()) {
  if (!club.money) startMoney(club, now);
  const r = ducy.clubTourneyHost(JSON.stringify(club), tid, op, JSON.stringify(args), now);
  if (!r.ok) throw new Error(r.message);
  merge(club.members, r.club.members);
  club.money = r.club.money;
  Object.assign(club.chips ??= {}, r.club.chips);
  club.log = r.club.log;
  club.tourneys = byId(club.tourneys, r.club.tourneys);
  return r.value;
}

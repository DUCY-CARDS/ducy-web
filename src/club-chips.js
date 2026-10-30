// Club chips (#67): each member's balance and the club's ledger. Functions
// over the club object from club.js; no DOM or network.
//
// Chips are play money (#61). Every move is made by the club money model
// (club-money.js, #454): each member plays through a backer, the club or
// their agent, and their balance is that link's. The club gives chips to
// its own members (issue) and takes them back (reclaim); an agent gives and
// takes back their players' (backerGive, backerTake). A member brings chips
// to a table (buy_in, top_up) down every link on their path, and takes them
// back up it when they leave (cash_out); the tables (#68) call those. Every
// movement is in the model's ledger (club-money.js), and each function here
// returns the member's own entry. The host sends each member the entries on
// their own links, signed, so the member keeps a copy that proves their
// balance.
//
// Conservation: issued − reclaimed = the club's links + all table stacks +
// the buy-ins tournaments hold (club-tourneys.js). Promotion prizes
// (club-promos.js) are issued, and voided ones reclaimed.
//
// Amounts are whole hundredths, shown divided by 100 (chip-format.js).
//
// Credit players (#404): a member's `credit` is how far below zero their
// link may go to sit at a table (0, the default: not at all). A negative
// balance is what they owe their backer. They buy in and top up from what's
// available (`room`: balance + credit, and no more than every link above
// them has), their own chips first. Standing up adds the stack to the
// balance, so what they owe is paid back first and anything still owed
// stays negative.

import * as ducy from '../wasm/ducy_wasm.js';
import { chipInput } from './chip-format.js';
import { CLUB, entriesOf, entryView } from './club-money.js';
import { book } from './club-book.js';

export const MAX_CHIPS = 1e12;
export const DEFAULT_RATHOLE_HOURS = 2;
export const MAX_NOTE = 80;

// Adds the chip fields to a club (new, or saved before #67).
export function ensureChips(club) {
  club.chips ??= {issued: 0, reclaimed: 0};
  // The older ledger copy, before the model's ledger (#454).
  delete club.chips.ledger;
  delete club.chips.next;
  club.ratholeHours ??= DEFAULT_RATHOLE_HOURS;
  for (const m of Object.values(club.members)) {
    m.balance ??= 0;
    m.request ??= null;
    m.left ??= {};
    m.seat ??= null;
    // An agent's credit limit was its own field; it's the member's credit
    // now (#445).
    if (m.creditLimit != null) {
      if (m.creditLimit > (m.credit || 0)) m.credit = m.creditLimit;
      delete m.creditLimit;
    }
  }
  return club;
}

// A number for the book: whole chips, or null (refused as an amount).
const num = a => (Number.isFinite(a) ? a : null);

// An entry the book made, as pages see it.
const made = (club, e) => entryView(club, e);

// The club gives chips: only to its own members (an agent's players get
// theirs from their agent).
export function issue(club, id, amt, now = Date.now(), why = '') {
  ensureChips(club);
  return made(club, book(club, {op: 'issue', id, amount: num(amt), note: String(why ?? '')}, now));
}

// The club takes chips back from a member's balance (not from a table).
export function reclaim(club, id, amt, now = Date.now(), why = '') {
  ensureChips(club);
  return made(club, book(club, {op: 'reclaim', id, amount: num(amt), note: String(why ?? '')}, now));
}

// A backer (an agent) gives one of their players chips (#76): it costs
// them nothing until the chips go on a table.
export function backerGive(club, backer, id, amt, now = Date.now(), why = '') {
  ensureChips(club);
  return made(club, book(club, {op: 'backerGive', backer, id, amount: num(amt), note: String(why ?? '')}, now));
}

// A backer takes back chips from one of their players, up to what they have.
export function backerTake(club, backer, id, amt, now = Date.now(), why = '') {
  ensureChips(club);
  return made(club, book(club, {op: 'backerTake', backer, id, amount: num(amt), note: String(why ?? '')}, now));
}

// A credit player's limit and what they may bring to a table now (#404):
// their room (balance plus their limit, never more than their backers'
// links allow), never below 0 (a limit lowered under what they owe leaves
// nothing).
export const creditOf = m => m?.credit || 0;
export const owedBy = m => Math.max(0, -(m?.balance || 0));
export const available = m => m?.room ?? Math.max(0, (m?.balance || 0) + creditOf(m));

// A member asks for chips; a new request replaces an older one. `table`:
// asked from that table (#404). A credit player asking for more than is
// available is at their limit (`atLimit`): the host may only raise the
// limit or say no.
export function requestChips(club, id, amt, why = '', now = Date.now(), {table = ''} = {}) {
  ensureChips(club);
  book(club, {op: 'requestChips', id, amount: num(amt), note: String(why ?? ''), table: typeof table === 'string' ? table : ''}, now);
  return club.members[id].request;
}

// Throws if a request may not be granted with chips: a credit player at
// their limit is never given chips past it (#404).
export const checkGrant = (club, id) => { book(club, {op: 'checkGrant', id}); };

export const cancelRequest = (club, id) => book(club, {op: 'cancelRequest', id});

// How many answered requests the club keeps (#188).
export const REQUEST_LOG = 100;

// A request is answered (#188): it's cleared, the member is told how
// (m.answer: {asked, given, outcome, note, at}), and the club keeps it in
// club.requestLog (newest last, REQUEST_LOG at most). `outcome` is
// 'granted' or 'declined'; `note` is the reason for a decline; `by` who
// answered when it wasn't the host (an agent). `limit`: the credit limit
// was raised to it instead of chips given (#404; `given` is the extra
// credit, so older pages read it as granted).
export function answerRequest(club, id, outcome, {given = 0, why = '', by = '', limit = null, now = Date.now()} = {}) {
  ensureChips(club);
  return book(club, {op: 'answerRequest', id, outcome, given, note: String(why ?? ''), by, limit}, now);
}

// The host grants a request, for the amount asked or a different one.
export function grantRequest(club, id, amt, now = Date.now()) {
  ensureChips(club);
  return made(club, book(club, {op: 'grantRequest', id, amount: amt == null ? null : num(amt)}, now));
}

// The host (or an agent, `by`) declines a request, saying why if they
// like. False if there's none.
export function declineRequest(club, id, why = '', now = Date.now(), by = '') {
  ensureChips(club);
  return book(club, {op: 'declineRequest', id, note: String(why ?? ''), by}, now);
}

// The smallest buy-in allowed at `table` because of the rathole rule (#67):
// someone who left with S chips must come back with at least S until the
// club's rathole window has passed. 0 when the rule doesn't apply.
export function ratholeMin(club, id, table, now = Date.now()) {
  const left = club.members[id]?.left?.[table];
  if (!left) return 0;
  return now - left.at < club.ratholeHours * 3600e3 ? left.stack : 0;
}

// A table move by the club's book, its entry as pages see it (or null).
function moved(club, op, now) {
  ensureChips(club);
  const e = book(club, op, now);
  return e ? made(club, e) : null;
}

// Sits a member at `table` with `amt` chips down their path, within the
// table's limits ({min, max}) and the rathole rule. Their seat keeps `put`:
// what they've brought to the table in all (buy-in and top-ups), to tell
// when they're up there (club-tables.js handsToStay). Too little available
// throws an Error with `short` set: the table offers to ask the manager.
export function buyIn(club, id, table, amt, {min, max}, now = Date.now()) {
  return moved(club, {op: 'buyIn', id, table, amount: num(amt), limits: {min, max}}, now);
}

// Adds chips to a seated member's stack between hands, capped so the stack
// doesn't go over `max`. Returns null if nothing was moved. More than is
// available is refused, not cut down: the table adds what it asked for
// (#404).
export function topUp(club, id, amt, max, now = Date.now()) {
  return moved(club, {op: 'topUp', id, amount: num(amt), max: Number.isFinite(max) && max < Number.MAX_SAFE_INTEGER ? max : null}, now);
}

// The table handed back part of a top-up: added at the deal, it would have
// taken the stack over the table's maximum (allenpiscitello/ducy#118). Those
// chips leave the seat and go back up the path.
export function refundTopUp(club, id, amt, now = Date.now()) {
  return moved(club, {op: 'refundTopUp', id, amount: num(amt)}, now);
}

// The table reports a seated member's stack after a hand.
export function setStack(club, id, stack) {
  const m = club.members[id];
  if (!m?.seat || !Number.isSafeInteger(stack) || stack < 0) throw new Error('Bad stack.');
  m.seat.stack = stack;
}

// Stands a member up: their stack goes back up their path, and the rathole
// rule starts for that table. What they owed is paid back from it first
// (#404). With nothing left, the cash-out is still an entry, at 0, so their
// page knows they left.
export const cashOut = (club, id, now = Date.now()) => moved(club, {op: 'cashOut', id}, now);

// A tournament buy-in (club-tourneys.js): `amt` down the member's path.
export const tourneyBuyIn = (club, id, tourney, amt, now = Date.now()) => moved(club, {op: 'tourneyBuyIn', id, tourney, amount: num(amt)}, now);

// Something the club pays a member, up their path: `what` is 'prize' (a
// tournament's or a promotion's) or 'refund' (a tournament buy-in back);
// `about` the tournament or promotion. A member removed since they entered
// is paid all the same.
export const payTo = (club, id, what, amt, about, now = Date.now()) => moved(club, {op: 'pay', id, what, amount: num(amt), about: String(about ?? '')}, now);

// A promotion prize taken back, up the path it came down (club-promos.js).
export const voidPrize = (club, id, amt, promo, now = Date.now()) => moved(club, {op: 'voidPrize', id, amount: num(amt), promo: String(promo ?? '')}, now);

// The club's books. `owedToClub` adds up what its direct members owe it,
// `owedToPlayers` what it owes them (#404). An agent's link is their
// players' too.
export function totals(club) {
  ensureChips(club);
  const ms = Object.values(club.members);
  const links = club.money ? club.money.links.filter(l => l.backer === CLUB).map(l => l.balance) : ms.map(m => m.balance);
  const balances = links.reduce((s, b) => s + b, 0);
  const onTables = ms.reduce((s, m) => s + (m.seat?.stack || 0), 0);
  // Buy-ins held by tournaments until they pay out or refund (club-tourneys.js).
  const inTourneys = (club.tourneys || []).reduce((s, t) => s + (t.held || 0), 0);
  const owedToClub = links.reduce((s, b) => s + Math.max(0, -b), 0);
  const owedToPlayers = links.reduce((s, b) => s + Math.max(0, b), 0);
  return {issued: club.chips.issued, reclaimed: club.chips.reclaimed, balances, onTables, inTourneys, owedToClub, owedToPlayers,
    conserved: club.chips.issued - club.chips.reclaimed === balances + onTables + inTourneys};
}

// What a member is told about their account: balance, open request, and
// the entries on their own links after `since`, with their credit limit and
// what's available to sit with (#404). `ledger: 'links'`: the entries are
// the money model's (#454), numbered as its ledger; a copy kept from before
// starts again.
export function accountBody(club, id, since = 0) {
  ensureChips(club);
  const m = club.members[id];
  return {
    type: 'account', club: club.code, balance: m?.balance || 0, request: m?.request || null, answer: m?.answer || null,
    credit: creditOf(m), available: available(m),
    ledger: 'links', entries: entriesOf(club, id, since),
  };
}

// The ledger as CSV (#188): one row per entry, oldest first, with the
// member's and backer's names, what happened (`kindText`), what it was
// about (a table's, tournament's or promotion's name), the change to the
// link and its balance after, in plain amounts (1.5, not 150 hundredths).
export function ledgerCsv(entries, names = {}, aboutNames = {}, kindText = {}) {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['when', 'member', 'with', 'what', 'about', 'change', 'balance', 'note']];
  for (const e of [...entries].sort((a, b) => a.n - b.n)) {
    rows.push([
      new Date(e.at).toISOString(), names[e.member] || e.member, names[e.backer] || e.backer, kindText[e.kind] || e.kind,
      e.about ? aboutNames[e.about] || e.about : '', chipInput(e.amount), chipInput(e.balance), e.note || '',
    ]);
  }
  return rows.map(r => r.map(cell).join(',')).join('\n') + '\n';
}

// A player's check of their own copy: on each of their links, each entry's
// balance follows from the one before, and the links add up to the balance
// the host reports (ducy-play's club_member).
export const checkOwnLedger = (entries, balance) => Number.isFinite(balance) && ducy.checkOwnLedger(JSON.stringify(entries || []), balance);

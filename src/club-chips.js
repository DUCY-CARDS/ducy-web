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

import { chipInput, chipText } from './chip-format.js';
import { CLUB, entriesOf, entryView, move } from './club-money.js';
import { book } from './club-book.js';

export const MAX_CHIPS = 1e12;
export const DEFAULT_RATHOLE_HOURS = 2;
export const MAX_NOTE = 80;

const ok = a => Number.isSafeInteger(a) && a > 0 && a <= MAX_CHIPS;

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

function member(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Not a member of this club.');
  ensureChips(club);
  return m;
}

function amount(a) {
  if (!ok(a)) throw new Error('Enter a whole number of chips above 0.');
  return a;
}

// The member's own entry among a move's.
const own = (entries, id) => entries.find(e => e.member === id && !e.player);

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

// An Error saying a player has too little available; the table offers to
// ask the manager for more (#404).
function short(msg) {
  const e = new Error(msg);
  e.short = true;
  return e;
}

function tooMuch(m, amt) {
  if (amt <= available(m)) return;
  const own = Math.max(0, (m.balance || 0) + creditOf(m));
  if (available(m) < own) throw short(`You have ${chipText(available(m))} available: your agent can’t back more right now.`);
  if (!creditOf(m)) throw short(`You have ${chipText(Math.max(0, m.balance))} chips in the club.`);
  throw short(`You have ${chipText(available(m))} available (your chips and credit).`);
}

// A refusal from the money model, in the player's words.
function refusal(m, e) {
  if (e.money?.code === 'room') return short(`You have ${chipText(available(m))} available: your agent can’t back more right now.`);
  if (e.money?.code === 'overdue') return new Error('What you owe is overdue: pay it back to play.');
  return e;
}

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

// Sits a member at `table` with `amt` chips down their path, within the
// table's limits ({min, max}) and the rathole rule.
export function buyIn(club, id, table, amt, {min, max}, now = Date.now()) {
  const m = member(club, id);
  amount(amt);
  if (m.seat) throw new Error('Already seated at a table.');
  const floor = Math.max(min, ratholeMin(club, id, table, now));
  if (amt < floor) throw new Error(floor > min ? `You left this table with ${chipText(floor)} chips less than ${club.ratholeHours} hours ago, so buy in for at least that.` : `The minimum buy-in is ${min}.`);
  if (amt > max) throw new Error(`The maximum buy-in is ${chipText(max)}.`);
  tooMuch(m, amt);
  let entries;
  try {
    entries = move(club, {op: 'buyIn', member: id, table, amount: amt}, now);
  } catch (e) { throw refusal(m, e); }
  // `put`: what they've brought to the table in all (buy-in and top-ups), to
  // tell when they're up there (club-tables.js handsToStay).
  m.seat = {table, stack: amt, put: amt};
  return own(entries, id);
}

// Adds chips to a seated member's stack between hands, capped so the stack
// doesn't go over `max`. Returns null if nothing was moved. More than is
// available is refused, not cut down: the table adds what it asked for
// (#404).
export function topUp(club, id, amt, max, now = Date.now()) {
  const m = member(club, id);
  amount(amt);
  if (!m.seat) throw new Error('Not seated.');
  const moved = Math.min(amt, max - m.seat.stack);
  if (moved <= 0) return null;
  tooMuch(m, moved);
  let entries;
  try {
    entries = move(club, {op: 'topUp', member: id, amount: moved}, now);
  } catch (e) { throw refusal(m, e); }
  m.seat.stack += moved;
  if (m.seat.put != null) m.seat.put += moved;
  return own(entries, id);
}

// The table handed back part of a top-up: added at the deal, it would have
// taken the stack over the table's maximum (allenpiscitello/ducy#118). Those
// chips leave the seat and go back up the path.
export function refundTopUp(club, id, amt, now = Date.now()) {
  const m = member(club, id);
  amount(amt);
  if (!m.seat) return null;
  m.seat.stack = Math.max(0, m.seat.stack - amt);
  if (m.seat.put != null) m.seat.put = Math.max(0, m.seat.put - amt);
  return own(move(club, {op: 'refundTopUp', member: id, amount: amt}, now), id);
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
export function cashOut(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.seat) throw new Error('Not seated.');
  const {table, stack} = m.seat;
  move(club, {op: 'setStack', member: id, stack}, now);
  const entries = move(club, {op: 'cashOut', member: id}, now);
  m.seat = null;
  m.left = {...m.left, [table]: {stack, at: now}};
  return own(entries, id);
}

// A tournament buy-in (club-tourneys.js): `amt` down the member's path.
export function tourneyBuyIn(club, id, tourney, amt, now = Date.now()) {
  const m = member(club, id);
  if (amt > available(m)) throw new Error(`The buy-in is ${chipText(amt)} chips; you have ${chipText(available(m))}.`);
  try {
    return own(move(club, {op: 'tourneyBuyIn', member: id, tourney, amount: amt}, now), id);
  } catch (e) { throw refusal(m, e); }
}

// Something the club pays a member, up their path: `what` is 'prize' (a
// tournament's or a promotion's) or 'refund' (a tournament buy-in back);
// `about` the tournament or promotion.
export function payTo(club, id, what, amt, about, now = Date.now()) {
  // Removed since they entered, they're paid all the same.
  if (!club.members[id]) throw new Error('No such member.');
  ensureChips(club);
  return own(move(club, {op: 'pay', member: id, kind: what, about, amount: amt}, now), id);
}

// A promotion prize taken back, up the path it came down (club-promos.js).
export function voidPrize(club, id, amt, promo, now = Date.now()) {
  const m = member(club, id);
  if (m.balance < amt) throw new Error(`${m.name} has only ${chipText(Math.max(0, m.balance))} chips in the club now; take what’s left from their balance first, or leave the award.`);
  const e = own(move(club, {op: 'void', member: id, about: promo, amount: amt}, now), id);
  club.chips.reclaimed += amt;
  return e;
}

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
// the host reports.
export function checkOwnLedger(entries, balance) {
  const links = new Map();
  for (const e of [...entries].sort((x, y) => x.n - y.n)) {
    if (!Number.isSafeInteger(e.amount)) return false;
    const b = (links.get(e.backer) || 0) + e.amount;
    if (b !== e.balance) return false;
    links.set(e.backer, b);
  }
  return [...links.values()].reduce((s, b) => s + b, 0) === balance;
}

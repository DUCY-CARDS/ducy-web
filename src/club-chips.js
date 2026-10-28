// Club chips (#67): each member's balance and the club's ledger. Functions
// over the club object from club.js; no DOM or network.
//
// Chips are play money (#61). Every move is made by the club money model
// (club-money.js, #454): each member plays through a backer, the club or
// their agent, and their balance is that link's. The club gives chips to
// its own members (issue / grant) and takes them back (reclaim); an agent
// gives and takes back their players' (backerGive, backerTake). A member
// brings chips to a table (buy_in, top_up) down every link on their path,
// and takes them back up it when they leave (cash_out); the tables (#68)
// call those. Every movement is an entry in an append-only ledger: {n, at,
// kind, member, amount, balance, note?, table?}, where `balance` is the
// member's balance after it (an agent's entries for their players' moves
// carry `player`). The host sends each member their own entries, signed, so
// the member keeps a copy that proves their balance.
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
// them has), their own chips first; entries that drew on credit say how much
// (`credit`). Standing up adds the stack to the balance, so what they owe is
// paid back first (`repaid` on the cash-out) and anything still owed stays
// negative (`owes`).

import { chipInput, chipText } from './chip-format.js';
import { backerOf, CLUB, move } from './club-money.js';

export const MAX_CHIPS = 1e12;
export const DEFAULT_RATHOLE_HOURS = 2;
export const MAX_NOTE = 80;

const ok = a => Number.isSafeInteger(a) && a > 0 && a <= MAX_CHIPS;
const note = s => String(s ?? '').trim().slice(0, MAX_NOTE);

// Adds the chip fields to a club (new, or saved before #67).
export function ensureChips(club) {
  club.chips ??= {issued: 0, reclaimed: 0, next: 1, ledger: []};
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

const nameOf = (club, id) => club.members[id]?.name || id;

// Chips from the club go only to its own members: an agent's players get
// theirs from their agent.
function direct(club, m) {
  const b = backerOf(club, m);
  if (b !== CLUB) throw new Error(`${m.name} plays under ${nameOf(club, b)}: their chips come from them.`);
}

// The member's own entry among a move's.
const own = (entries, id) => entries.find(e => e.member === id && !e.player);

// The club gives chips. `kind` is 'grant' when it answers a request.
export function issue(club, id, amt, now = Date.now(), why = '', kind = 'issue') {
  const m = member(club, id);
  amount(amt);
  direct(club, m);
  const [e] = move(club, {op: 'give', backer: CLUB, member: id, amount: amt, note: note(why)}, now, {kind});
  club.chips.issued += amt;
  return e;
}

// The club takes chips back from a member's balance (not from a table).
export function reclaim(club, id, amt, now = Date.now(), why = '') {
  const m = club.members[id];
  ensureChips(club);
  if (!m) throw new Error('No such member.');
  amount(amt);
  if (amt > m.balance) throw new Error(`${m.name} only has ${chipText(m.balance)} chips in the club.`);
  direct(club, m);
  const [e] = move(club, {op: 'takeBack', backer: CLUB, member: id, amount: amt, note: note(why)}, now, {kind: 'reclaim'});
  club.chips.reclaimed += amt;
  return e;
}

// A backer (an agent) gives one of their players chips (#76): it costs
// them nothing until the chips go on a table.
export function backerGive(club, backer, id, amt, now = Date.now(), why = '', kind = 'transfer_in') {
  member(club, id);
  amount(amt);
  const [e] = move(club, {op: 'give', backer, member: id, amount: amt, note: note(why)}, now, {kind, extra: {from: backer}});
  return e;
}

// A backer takes back chips from one of their players, up to what they have.
export function backerTake(club, backer, id, amt, now = Date.now(), why = '', kind = 'transfer_out') {
  const m = member(club, id);
  amount(amt);
  if (amt > m.balance) throw new Error(`${m.name} has ${chipText(Math.max(0, m.balance))} chips.`);
  const [e] = move(club, {op: 'takeBack', backer, member: id, amount: amt, note: note(why)}, now, {kind, extra: {to: backer}});
  return e;
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

// What part of `amt`, taken from the balance, is drawn on credit.
const drawn = (m, amt) => Math.max(0, amt - Math.max(0, m.balance));

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
  const m = member(club, id);
  m.request = {amount: amount(amt), note: note(why), at: now};
  if (typeof table === 'string' && table) m.request.table = table.slice(0, 40);
  if (creditOf(m) && amt > available(m)) m.request.atLimit = true;
  return m.request;
}

// Throws if a request may not be granted with chips: a credit player at
// their limit is never given chips past it (#404).
export function checkGrant(club, id) {
  const m = club.members[id];
  if (m?.request?.atLimit) throw new Error(`${m.name} is at their credit limit: raise it, or say no.`);
}

export function cancelRequest(club, id) {
  const m = club.members[id];
  if (!m?.request) return false;
  m.request = null;
  return true;
}

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
  const m = member(club, id);
  if (!m.request) return null;
  const a = {asked: m.request.amount, given, outcome, note: note(why), at: now, ...(limit != null ? {limit} : {})};
  m.answer = a;
  m.request = null;
  club.requestLog ??= [];
  club.requestLog.push({member: id, ...a, ...(by ? {by} : {})});
  if (club.requestLog.length > REQUEST_LOG) club.requestLog.splice(0, club.requestLog.length - REQUEST_LOG);
  return a;
}

// The host grants a request, for the amount asked or a different one.
export function grantRequest(club, id, amt, now = Date.now()) {
  const m = member(club, id);
  if (!m.request) throw new Error('There’s no request to grant.');
  checkGrant(club, id);
  const given = amt ?? m.request.amount;
  const e = issue(club, id, given, now, m.request.note, 'grant');
  answerRequest(club, id, 'granted', {given, now});
  return e;
}

// The host (or an agent, `by`) declines a request, saying why if they
// like. False if there's none.
export function declineRequest(club, id, why = '', now = Date.now(), by = '') {
  return !!answerRequest(club, id, 'declined', {why, by, now});
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
  const credit = drawn(m, amt);
  let entries;
  try {
    entries = move(club, {op: 'buyIn', member: id, table, amount: amt}, now, {kind: 'buy_in', extra: {table}});
  } catch (e) { throw refusal(m, e); }
  // `put`: what they've brought to the table in all (buy-in and top-ups), to
  // tell when they're up there (club-tables.js handsToStay).
  m.seat = {table, stack: amt, put: amt};
  const e = own(entries, id);
  if (credit) e.credit = credit;
  return e;
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
  const credit = drawn(m, moved);
  let entries;
  try {
    entries = move(club, {op: 'topUp', member: id, amount: moved}, now, {kind: 'top_up', extra: {table: m.seat.table}});
  } catch (e) { throw refusal(m, e); }
  m.seat.stack += moved;
  if (m.seat.put != null) m.seat.put += moved;
  const e = own(entries, id);
  if (credit) e.credit = credit;
  return e;
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
  return own(move(club, {op: 'refundTopUp', member: id, amount: amt}, now, {kind: 'top_up_refund', extra: {table: m.seat.table}}), id);
}

// The table reports a seated member's stack after a hand.
export function setStack(club, id, stack) {
  const m = club.members[id];
  if (!m?.seat || !Number.isSafeInteger(stack) || stack < 0) throw new Error('Bad stack.');
  m.seat.stack = stack;
}

// Stands a member up: their stack goes back up their path, and the rathole
// rule starts for that table. What they owed is paid back from it first
// (`repaid`); what they still owe after is `owes` (#404).
export function cashOut(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.seat) throw new Error('Not seated.');
  const {table, stack} = m.seat;
  const repaid = Math.min(stack, owedBy(m));
  move(club, {op: 'setStack', member: id, stack}, now);
  const entries = move(club, {op: 'cashOut', member: id}, now, {kind: 'cash_out', extra: {table}});
  m.seat = null;
  m.left = {...m.left, [table]: {stack, at: now}};
  const owes = owedBy(m);
  let e = own(entries, id);
  if (!e) {
    // Nothing to bring back: an entry all the same, so their page knows they left.
    e = {n: club.chips.next++, at: now, kind: 'cash_out', member: id, amount: 0, balance: m.balance, table};
    club.chips.ledger.push(e);
  }
  if (repaid) e.repaid = repaid;
  if (owes) e.owes = owes;
  return e;
}

// A tournament buy-in (club-tourneys.js): `amt` down the member's path.
export function tourneyBuyIn(club, id, tourney, amt, now = Date.now()) {
  const m = member(club, id);
  if (amt > available(m)) throw new Error(`The buy-in is ${chipText(amt)} chips; you have ${chipText(available(m))}.`);
  try {
    return own(move(club, {op: 'tourneyBuyIn', member: id, tourney, amount: amt}, now, {kind: 'tourney_buyin', extra: {tourney}}), id);
  } catch (e) { throw refusal(m, e); }
}

// Something the club pays a member, up their path: a tournament's refund
// ('refund') or prize, or a promotion's ('prize'). `kind` and `extra` are
// for their ledger entry.
export function payTo(club, id, what, amt, now = Date.now(), kind = 'tourney_prize', extra = {}) {
  // Removed since they entered, they're paid all the same.
  if (!club.members[id]) throw new Error('No such member.');
  ensureChips(club);
  return own(move(club, {op: 'pay', member: id, kind: what, about: extra.tourney || extra.promo || '', amount: amt}, now, {kind, extra}), id);
}

// A promotion prize taken back, up the path it came down (club-promos.js).
export function voidPrize(club, id, amt, now = Date.now(), extra = {}) {
  const m = member(club, id);
  if (m.balance < amt) throw new Error(`${m.name} has only ${chipText(Math.max(0, m.balance))} chips in the club now; take what’s left from their balance first, or leave the award.`);
  const e = own(move(club, {op: 'void', member: id, about: extra.promo || '', amount: amt}, now, {kind: 'promo_void', extra}), id);
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
// their ledger entries after `since`, with their credit limit and what's
// available to sit with (#404; older pages ignore them).
export function accountBody(club, id, since = 0) {
  ensureChips(club);
  const m = club.members[id];
  return {
    type: 'account', club: club.code, balance: m?.balance || 0, request: m?.request || null, answer: m?.answer || null,
    credit: creditOf(m), available: available(m),
    entries: club.chips.ledger.filter(e => e.member === id && e.n > since),
  };
}

// The change an entry makes to a member's balance.
export function balanceChange(e) {
  // Moving to links (#454): an agent's players' shares, as one line.
  if (e.kind === 'links') return e.change || 0;
  return {
    issue: e.amount, grant: e.amount, settle: e.amount, cash_out: e.amount, transfer_in: e.amount,
    // A top-up the table handed back (over its maximum) returns to the balance.
    top_up_refund: e.amount,
    reclaim: -e.amount, buy_in: -e.amount, top_up: -e.amount, transfer_out: -e.amount,
    // Tournaments (club-tourneys.js).
    tourney_buyin: -e.amount, tourney_refund: e.amount, tourney_prize: e.amount,
    // High Hand promotions (club-promos.js): a prize, and a voided one.
    promo: e.amount, promo_void: -e.amount,
  }[e.kind] || 0;
}

// The ledger as CSV (#188): one row per entry, oldest first, with the
// member's name, what happened (`kindText`), the table's name, the signed
// change to their balance and the balance after, in plain amounts (1.5,
// not 150 hundredths).
export function ledgerCsv(entries, names = {}, tableNames = {}, kindText = {}) {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['when', 'member', 'what', 'table', 'change', 'balance', 'note']];
  for (const e of [...entries].sort((a, b) => a.n - b.n)) {
    rows.push([
      new Date(e.at).toISOString(), names[e.member] || e.member, kindText[e.kind] || e.kind,
      e.table ? tableNames[e.table] || e.table : '', chipInput(balanceChange(e)), chipInput(e.balance), e.note || '',
    ]);
  }
  return rows.map(r => r.map(cell).join(',')).join('\n') + '\n';
}

// A player's check of their own copy: the entries add up to the balance the
// host reports, and each entry's balance follows from the one before.
export function checkOwnLedger(entries, balance) {
  let b = 0;
  for (const e of [...entries].sort((x, y) => x.n - y.n)) {
    b += balanceChange(e);
    if (b !== e.balance) return false;
  }
  return b === balance;
}

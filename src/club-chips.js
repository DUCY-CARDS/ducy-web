// Club chips (#67): each member's club balance and the club's ledger. Pure
// functions over the club object from club.js; no DOM or network.
//
// Chips are play money (#61). Only the host creates them (issue / grant) and
// takes them back (reclaim). A member brings chips from their balance to a
// table (buy_in, top_up) and takes them back when they leave (cash_out); the
// tables (#68) call those. Every movement is an entry in an append-only
// ledger: {n, at, kind, member, amount, balance, note?, table?}, where
// `balance` is the member's club balance after it. The host sends each member
// their own entries, signed, so the member keeps a copy that proves their
// balance.
//
// Conservation: issued − reclaimed = all club balances + all table stacks.

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

function record(club, m, kind, amt, now, extra = {}) {
  const e = {n: club.chips.next++, at: now, kind, member: m.id, amount: amt, balance: m.balance, ...extra};
  if (!e.note) delete e.note;
  club.chips.ledger.push(e);
  return e;
}

// The host gives chips. `kind` is 'grant' when it answers a request.
export function issue(club, id, amt, now = Date.now(), why = '', kind = 'issue') {
  const m = member(club, id);
  amount(amt);
  m.balance += amt;
  club.chips.issued += amt;
  return record(club, m, kind, amt, now, {note: note(why)});
}

// The host takes chips back from a member's club balance (not from a table).
export function reclaim(club, id, amt, now = Date.now(), why = '') {
  const m = club.members[id];
  ensureChips(club);
  if (!m) throw new Error('No such member.');
  amount(amt);
  if (amt > m.balance) throw new Error(`${m.name} only has ${m.balance} chips in the club.`);
  m.balance -= amt;
  club.chips.reclaimed += amt;
  return record(club, m, 'reclaim', amt, now, {note: note(why)});
}

// A member asks the host for chips; a new request replaces an older one.
export function requestChips(club, id, amt, why = '', now = Date.now()) {
  const m = member(club, id);
  m.request = {amount: amount(amt), note: note(why), at: now};
  return m.request;
}

export function cancelRequest(club, id) {
  const m = club.members[id];
  if (!m?.request) return false;
  m.request = null;
  return true;
}

// The host grants a request, for the amount asked or a different one.
export function grantRequest(club, id, amt, now = Date.now()) {
  const m = member(club, id);
  if (!m.request) throw new Error('There’s no request to grant.');
  const e = issue(club, id, amt ?? m.request.amount, now, m.request.note, 'grant');
  m.request = null;
  return e;
}

export const declineRequest = (club, id) => cancelRequest(club, id);

// One member gives chips to another from their own club balance (a game
// assistant, #62): two entries, so each sees their side. Total chips don't
// change. Returns [out, in].
export function transfer(club, from, to, amt, now = Date.now(), why = '') {
  const a = member(club, from), b = member(club, to);
  amount(amt);
  if (from === to) throw new Error('Pick someone else.');
  if (amt > a.balance) throw new Error(`You have ${a.balance} chips in the club.`);
  a.balance -= amt;
  b.balance += amt;
  return [
    record(club, a, 'transfer_out', amt, now, {note: note(why), to}),
    record(club, b, 'transfer_in', amt, now, {note: note(why), from}),
  ];
}

// The smallest buy-in allowed at `table` because of the rathole rule (#67):
// someone who left with S chips must come back with at least S until the
// club's rathole window has passed. 0 when the rule doesn't apply.
export function ratholeMin(club, id, table, now = Date.now()) {
  const left = club.members[id]?.left?.[table];
  if (!left) return 0;
  return now - left.at < club.ratholeHours * 3600e3 ? left.stack : 0;
}

// Sits a member at `table` with `amt` chips from their club balance, within
// the table's limits ({min, max}) and the rathole rule.
export function buyIn(club, id, table, amt, {min, max}, now = Date.now()) {
  const m = member(club, id);
  amount(amt);
  if (m.seat) throw new Error('Already seated at a table.');
  const floor = Math.max(min, ratholeMin(club, id, table, now));
  if (amt < floor) throw new Error(floor > min ? `You left this table with ${floor} chips less than ${club.ratholeHours} hours ago, so buy in for at least that.` : `The minimum buy-in is ${min}.`);
  if (amt > max) throw new Error(`The maximum buy-in is ${max}.`);
  if (amt > m.balance) throw new Error(`You have ${m.balance} chips in the club.`);
  m.balance -= amt;
  m.seat = {table, stack: amt};
  return record(club, m, 'buy_in', amt, now, {table});
}

// Adds chips to a seated member's stack between hands, capped so the stack
// doesn't go over `max`. Returns null if nothing was moved.
export function topUp(club, id, amt, max, now = Date.now()) {
  const m = member(club, id);
  amount(amt);
  if (!m.seat) throw new Error('Not seated.');
  const moved = Math.min(amt, max - m.seat.stack, m.balance);
  if (moved <= 0) return null;
  m.balance -= moved;
  m.seat.stack += moved;
  return record(club, m, 'top_up', moved, now, {table: m.seat.table});
}

// The table reports a seated member's stack after a hand.
export function setStack(club, id, stack) {
  const m = club.members[id];
  if (!m?.seat || !Number.isSafeInteger(stack) || stack < 0) throw new Error('Bad stack.');
  m.seat.stack = stack;
}

// Stands a member up: their stack goes back to their club balance, and the
// rathole rule starts for that table.
export function cashOut(club, id, now = Date.now()) {
  const m = club.members[id];
  if (!m?.seat) throw new Error('Not seated.');
  const {table, stack} = m.seat;
  m.balance += stack;
  m.seat = null;
  m.left = {...m.left, [table]: {stack, at: now}};
  return record(club, m, 'cash_out', stack, now, {table});
}

export function totals(club) {
  ensureChips(club);
  const ms = Object.values(club.members);
  const balances = ms.reduce((s, m) => s + m.balance, 0);
  const onTables = ms.reduce((s, m) => s + (m.seat?.stack || 0), 0);
  return {issued: club.chips.issued, reclaimed: club.chips.reclaimed, balances, onTables,
    conserved: club.chips.issued - club.chips.reclaimed === balances + onTables};
}

// What a member is told about their account: balance, open request, and
// their ledger entries after `since`.
export function accountBody(club, id, since = 0) {
  ensureChips(club);
  const m = club.members[id];
  return {
    type: 'account', club: club.code, balance: m?.balance || 0, request: m?.request || null,
    entries: club.chips.ledger.filter(e => e.member === id && e.n > since),
  };
}

// The change an entry makes to a member's club balance.
export function balanceChange(e) {
  return {
    issue: e.amount, grant: e.amount, cash_out: e.amount, transfer_in: e.amount,
    reclaim: -e.amount, buy_in: -e.amount, top_up: -e.amount, transfer_out: -e.amount,
  }[e.kind] || 0;
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

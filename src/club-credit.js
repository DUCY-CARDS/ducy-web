// Credit players (#404): members who may sit down with chips borrowed from
// the club, up to a credit limit. Pure functions over the club object; the
// ledger side (buying in on credit, repaying on standing up) is in
// club-chips.js, and club-server.js runs the host's commands.
//
// Member field: credit, the limit on their link (absent or 0: none,
// club-money.js). The balance is the member's own chips off the table,
// negative for what they owe. For now only the host sets limits; later a
// player's agent will too.

import { chipText } from './chip-format.js';
import { answerRequest, available, creditOf, ensureChips, issue, owedBy } from './club-chips.js';
import { logAction } from './club-log.js';
import { backerOf, move } from './club-money.js';

const whole = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e12;

function member(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Not a member of this club.');
  ensureChips(club);
  return m;
}

// The limit on the link member `m` plays through (#454): club-money.js
// keeps m.credit in step.
function setLimit(club, m, limit, now) {
  move(club, {op: 'setCredit', member: m.id, backer: backerOf(club, m), credit: limit}, now);
}

// The host sets member `id`'s credit limit (0: none). Lowering it below what
// they owe is allowed: they just have nothing available until they pay.
export function setCredit(club, id, limit, now = Date.now()) {
  const m = member(club, id);
  if (!whole(limit)) throw new Error('The credit limit is a whole number of chips (0 for none).');
  if (limit === creditOf(m)) return m;
  setLimit(club, m, limit, now);
  logAction(club, club.hostId, `${m.name}’s credit limit is now ${chipText(limit)}`, now);
  return m;
}

// The host answers a credit player's request at their limit by raising the
// limit to `limit` (the only other answer is no: credit is never given past
// the limit). The request counts as granted, the extra credit as given.
export function raiseCredit(club, id, limit, now = Date.now()) {
  const m = member(club, id);
  if (!m.request) throw new Error('There’s no request to answer.');
  const was = creditOf(m);
  if (!whole(limit) || limit <= was) throw new Error(`Raise the limit above ${chipText(was)}.`);
  setLimit(club, m, limit, now);
  answerRequest(club, id, 'granted', {given: limit - was, limit, now});
  logAction(club, club.hostId, `${m.name}’s credit limit raised to ${chipText(limit)}`, now, limit - was);
  return m;
}

// The host records `amt` received from a member who owes the club (cash, a
// transfer: `why`). Their balance goes up by it, up to what they owe; the
// ledger shows it as 'settle'.
export function settleDebt(club, id, amt, now = Date.now(), why = '') {
  const m = member(club, id);
  const owed = owedBy(m);
  if (!owed) throw new Error(`${m.name} doesn’t owe the club anything.`);
  if (Number.isSafeInteger(amt) && amt > owed) throw new Error(`${m.name} owes ${chipText(owed)}.`);
  const e = issue(club, id, amt, now, why || 'Settled', 'settle');
  logAction(club, club.hostId, `Recorded ${chipText(amt)} settled by ${m.name}`, now, amt);
  return e;
}

// A member's credit at a glance, for the host's Members list: balance
// (negative: owes), limit, what they owe, what's available, chips on a table.
export function creditRow(m) {
  return {balance: m.balance || 0, credit: creditOf(m), owes: owedBy(m), available: available(m), onTable: m.seat?.stack || 0};
}

// What the host should hear about (#404), newest first: a credit player at
// their limit asking for chips ('at_limit', while the request is open), and
// a player who stood up owing ('left_owing', the last `keep` such cash-outs;
// `owesNow` is what they still owe, 0 once settled).
export function creditNotices(club, keep = 50) {
  ensureChips(club);
  const out = [];
  for (const m of Object.values(club.members)) {
    const q = m.request;
    if (q?.atLimit) out.push({kind: 'at_limit', member: m.id, name: m.name, asked: q.amount, credit: creditOf(m), available: available(m), table: q.table || '', at: q.at});
  }
  const left = club.chips.ledger.filter(e => e.kind === 'cash_out' && e.owes).slice(-keep);
  for (const e of left) {
    const m = club.members[e.member];
    out.push({kind: 'left_owing', member: e.member, name: m?.name || e.member, owes: e.owes, owesNow: owedBy(m), table: e.table, at: e.at, n: e.n});
  }
  return out.sort((a, b) => b.at - a.at);
}

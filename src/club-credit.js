// Credit players (#404): members who may sit down with chips borrowed from
// the club, up to a credit limit. ducy-play's club book (club-book.js, #456)
// sets and raises limits; the ledger side (buying in on credit, repaying on
// standing up) is in club-chips.js, and club-server.js runs the host's
// commands. Paying the club back is the host giving chips, with a note (#454).
//
// Member field: credit, the limit on their link (absent or 0: none,
// club-money.js). The balance is the member's own chips off the table,
// negative for what they owe. For now only the host sets limits; later a
// player's agent will too.

import { available, creditOf, ensureChips, owedBy } from './club-chips.js';
import { book } from './club-book.js';
import { ownEntries } from './club-money.js';

const num = a => (Number.isFinite(a) ? a : null);

// The host sets member `id`'s credit limit (0: none). Lowering it below what
// they owe is allowed: they just have nothing available until they pay.
export function setCredit(club, id, limit, now = Date.now()) {
  ensureChips(club);
  book(club, {op: 'setCredit', id, amount: num(limit)}, now);
  return club.members[id];
}

// The host answers a credit player's request at their limit by raising the
// limit to `limit` (the only other answer is no: credit is never given past
// the limit). The request counts as granted, the extra credit as given.
export function raiseCredit(club, id, limit, now = Date.now()) {
  ensureChips(club);
  book(club, {op: 'raiseCredit', id, amount: num(limit)}, now);
  return club.members[id];
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
  // Cash-outs that left the player's own link below zero.
  const left = ownEntries(club).filter(e => e.kind === 'cash_out' && e.balance < 0).slice(-keep);
  for (const e of left) {
    const m = club.members[e.member];
    out.push({kind: 'left_owing', member: e.member, name: m?.name || e.member, owes: -e.balance, owesNow: owedBy(m), table: e.about, at: e.at, n: e.n});
  }
  return out.sort((a, b) => b.at - a.at);
}

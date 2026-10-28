// What a member sees of their chips at a club (#398, #404), from their own
// copy of the ledger (club.js keeps it; the money model's entries,
// club-money.js). Pure, for clubs.js to draw.

import { tableSessions } from './hand-replay.js';

const SESSION = new Set(['buy_in', 'top_up', 'refund', 'cash_out']);

// Part of a table session: their own buy-in, top-up, cash-out, or a top-up
// handed back (a refund about the table they're at).
const ofSession = (e, last) => SESSION.has(e.kind) && !e.player && (e.kind !== 'refund' || (last && last.table === e.about));

// The member's chip history, newest first, a table session as one line:
// 'left' (the result when they stood up, and the balance after), or 'at'
// (still at the table: what they've brought, and the balance now). Any
// other entry is a line of its own: {kind, amount (signed), balance, note,
// at, entry}.
export function chipLines(entries) {
  const sorted = [...(entries || [])].sort((a, b) => a.n - b.n);
  const sessions = tableSessions(sorted).reverse(); // oldest first, as the entries
  const out = [];
  let i = 0, last = null;
  for (const e of sorted) {
    if (!ofSession(e, last)) { out.push({kind: e.kind, amount: e.amount, balance: e.balance, note: e.note || '', at: e.at, entry: e}); continue; }
    // Entries of one session follow its buy-in (tableSessions' order).
    if (e.kind === 'buy_in' || !last) last = sessions[i++];
    if (!last) continue;
    if (e.kind === 'cash_out') { out.push({kind: 'left', table: e.about, amount: last.net, balance: e.balance, at: e.at, owes: Math.max(0, -e.balance), entry: e}); last = null; }
    else if (last.open) {
      const prev = out.findIndex(l => l.kind === 'at' && l.session === last);
      const line = {kind: 'at', table: last.table, amount: -last.put, balance: e.balance, at: e.at, session: last, entry: e};
      if (prev >= 0) out[prev] = line; else out.push(line);
    }
  }
  return out.reverse().map(({session: _, ...l}) => l);
}

// After standing up (entry `n`, a cash-out): the table, the result there,
// the balance after it and what's still owed, or null.
export function leftSummary(entries, n) {
  const line = chipLines(entries).find(l => l.kind === 'left' && l.entry.n === n);
  return line ? {table: line.table, net: line.amount, balance: line.balance, owes: line.owes} : null;
}

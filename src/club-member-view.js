// What a member sees of their chips at a club (#398, #404), from their own
// copy of the ledger (club.js keeps it). Pure, for clubs.js to draw.

import { balanceChange } from './club-chips.js';
import { tableSessions } from './hand-replay.js';

const SESSION = new Set(['buy_in', 'top_up', 'top_up_refund', 'cash_out']);

// The member's chip history, newest first, a table session as one line:
// 'left' (the result when they stood up, and the balance after), or 'at'
// (still at the table: what they've brought, and the balance now). Any
// other entry is a line of its own: {kind, amount (signed), balance, note,
// at, table?, entry}.
export function chipLines(entries) {
  const sorted = [...(entries || [])].sort((a, b) => a.n - b.n);
  const sessions = tableSessions(sorted).reverse(); // oldest first, as the entries
  const out = [];
  let i = 0, last = null;
  for (const e of sorted) {
    if (!SESSION.has(e.kind)) { out.push({kind: e.kind, amount: balanceChange(e), balance: e.balance, note: e.note || '', at: e.at, entry: e}); continue; }
    // Entries of one session follow its buy-in (tableSessions' order).
    if (e.kind === 'top_up_refund' && !last) continue;
    if (e.kind === 'buy_in' || !last) last = sessions[i++];
    if (!last) continue;
    if (e.kind === 'cash_out') { out.push({kind: 'left', table: e.table, amount: last.net, balance: e.balance, at: e.at, owes: e.owes || 0, entry: e}); last = null; }
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

// What a member sees of their chips at a club (#398, #404), from their own
// copy of the ledger (club.js keeps it; the money model's entries,
// club-money.js). ducy-play's club_views works it out (#459), for clubs.js
// to draw.

import * as ducy from '../wasm/ducy_wasm.js';

// The member's chip history, newest first, a table session as one line:
// 'left' (the result when they stood up, and the balance after), or 'at'
// (still at the table: what they've brought, and the balance now). Any
// other entry is a line of its own: {kind, amount (signed), balance, note,
// at, entry}.
export const chipLines = entries => ducy.chipLines(JSON.stringify(entries || []));

// After standing up (entry `n`, a cash-out): the table, the result there,
// the balance after it and what's still owed, or null.
export const leftSummary = (entries, n) => ducy.leftSummary(JSON.stringify(entries || []), Number(n) || 0);

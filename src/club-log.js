// The club's activity log: what the host, the owner, agents and services
// did, for the owner's Activity page. ducy-play keeps it (the club's book)
// and says which moves are big (club_overview, #456).
//
// Managers (#62, #417) were removed with the move to the club money model
// (#454): only the owner runs a club, for now. dropManagers clears the role
// from clubs saved before.

import { book } from './club-book.js';
import { overview } from './club-overview.js';

export const MAX_LOG = 500;

// `amount`: the chips an action moved, so the host can spot big ones (#190).
// The log keeps the last MAX_LOG lines.
export function logAction(club, by, text, now = Date.now(), amount = null) {
  book(club, {op: 'logAction', by, text, amount}, now);
}

// The size from which a chip move counts as big (#190): a full buy-in at
// the club's biggest open table (its maximum, in big blinds, times its big
// blind), or null when no table is open to measure by.
export const bigMove = club => overview(club, 'bigMove');

// Whether a log entry moved at least `threshold` chips.
export const isBigMove = (entry, threshold) => threshold != null && entry.amount != null && entry.amount >= threshold;

// A club saved with managers, or a manager offer open: they're plain members
// now. True if anything changed.
export function dropManagers(club) {
  let changed = false;
  for (const m of Object.values(club.members || {})) {
    if (m.role == null) continue;
    delete m.role;
    changed = true;
  }
  return changed;
}

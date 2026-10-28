// The club's activity log: what the host, the owner, agents and services
// did, for the owner's Activity page. Pure functions over the club object.
//
// Managers (#62, #417) were removed with the move to the club money model
// (#454): only the owner runs a club, for now. dropManagers clears the role
// from clubs saved before.

export const MAX_LOG = 500;

// `amount`: the chips an action moved, so the host can spot big ones (#190).
export function logAction(club, by, text, now = Date.now(), amount = null) {
  club.log ??= [];
  club.log.push(amount == null ? {at: now, by, text} : {at: now, by, text, amount});
  if (club.log.length > MAX_LOG) club.log.splice(0, club.log.length - MAX_LOG);
}

// The size from which a chip move counts as big (#190): a full buy-in at
// the club's biggest open table (its maximum, in big blinds, times its big
// blind), or null when no table is open to measure by.
export function bigMove(club) {
  const buyIns = (club.tables || [])
    .filter(t => t.status !== 'closed' && t.bb > 0)
    .map(t => t.bb * (t.maxBB || 100));
  return buyIns.length ? Math.max(...buyIns) : null;
}

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

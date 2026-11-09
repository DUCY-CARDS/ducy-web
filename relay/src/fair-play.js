// ducy's fair play checks over a club's kept hands, in one run (club-room.js
// schedules it): the collusion check about pairs (collusion.js, #582) and
// the check for real-time assistance about one player each (assist.js,
// #591), both over the same records, read once. One report, the owner's
// Fair play page.

import { fullHands } from './hand-records.js';
import { addFlagged, collusionReport, LIMITS } from './collusion.js';
import { assistReport } from './assist.js';

// The report over the club's kept hands (storage: the club room's), at
// `now`: collusion.js checkClub's (the last WINDOW_DAYS, or `days`, the
// club's Keep hands, if fewer; the partner's-cards check up to
// PARTNER_WINDOW_DAYS), with assistReport's players (over the same
// WINDOW_DAYS) merged into `flagged` and its counts as `assist`
// {decisions, players}. Keep in step with checkClub.
export async function fairPlayReport(storage, {now = Date.now(), days = LIMITS.WINDOW_DAYS} = {}) {
  const keep = Math.max(1, Number(days) || 1);
  const since = now - Math.min(LIMITS.WINDOW_DAYS, keep) * 864e5;
  const partnerSince = now - Math.min(LIMITS.PARTNER_WINDOW_DAYS, keep) * 864e5;
  const all = await fullHands(storage, {since: Math.min(since, partnerSince)});
  const recs = all.filter(r => r.at >= since);
  const report = collusionReport(recs, {now, since, partnerRecs: all.filter(r => r.at >= partnerSince), partnerSince});
  const assist = assistReport(recs);
  return {...addFlagged(report, assist.flagged), assist: {decisions: assist.decisions, players: assist.players}};
}

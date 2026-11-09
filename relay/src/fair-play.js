// ducy's fair play checks over a club's kept hands, in one run (club-room.js
// schedules it): the collusion check about pairs (collusion.js, #582) and
// the check for real-time assistance about one player each (assist.js,
// #591), both over the same records, read once. One report, the owner's
// Fair play page; and, from the same run, a summary for ducy's admin
// (fair-play-admin.js, #612).

import { fullHands } from './hand-records.js';
import { addFlagged, collusionReport, LIMITS } from './collusion.js';
import { assistReport } from './assist.js';
import { adminSummary } from './fair-play-admin.js';

// The run over the club's kept hands (storage: the club room's), at `now`:
// {report, summary}. `report`: collusion.js checkClub's (the last
// WINDOW_DAYS, or `days`, the club's Keep hands, if fewer; the partner's-
// cards check up to PARTNER_WINDOW_DAYS), with assistReport's players (over
// the same WINDOW_DAYS) merged into `flagged` and its counts as `assist`
// {decisions, players}. `summary`: fair-play-admin.js adminSummary, every
// player's and pair's numbers. Keep in step with checkClub.
export async function fairPlayRun(storage, {now = Date.now(), days = LIMITS.WINDOW_DAYS} = {}) {
  const keep = Math.max(1, Number(days) || 1);
  const since = now - Math.min(LIMITS.WINDOW_DAYS, keep) * 864e5;
  const partnerSince = now - Math.min(LIMITS.PARTNER_WINDOW_DAYS, keep) * 864e5;
  const all = await fullHands(storage, {since: Math.min(since, partnerSince)});
  const recs = all.filter(r => r.at >= since);
  const {pairStats, ...collusion} = collusionReport(recs, {now, since, partnerRecs: all.filter(r => r.at >= partnerSince), partnerSince, stats: true});
  const {stats, ...assist} = assistReport(recs, {stats: true});
  const report = {...addFlagged(collusion, assist.flagged), assist: {decisions: assist.decisions, players: assist.players}};
  return {report, summary: adminSummary({report, pairStats, assistStats: stats, recs, now})};
}

// The owner's report alone (fairPlayRun's `report`).
export async function fairPlayReport(storage, opts = {}) {
  return (await fairPlayRun(storage, opts)).report;
}

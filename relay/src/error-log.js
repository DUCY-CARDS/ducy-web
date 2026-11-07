// The errors pages report (#552, src/error-report.js), kept by the registry for
// the admin page: one row per different error, with how often and when. Only
// what's needed is kept, cut to size, whatever a page sends.

export const MAX_REPORT_BYTES = 4 * 1024;
// Different errors kept; the one seen longest ago goes first.
export const MAX_ERRORS = 200;
// Reports taken a minute across every page, so a bug everywhere (or someone
// sending these on purpose) can't keep the registry busy.
export const MAX_PER_MINUTE = 60;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A report from a page's JSON, cut to size, or null if it isn't one. */
export function cleanReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const message = text(raw.message, 300);
  if (!message) return null;
  return {message, stack: text(raw.stack, 1600), where: text(raw.where, 40), page: text(raw.page, 40), build: text(raw.build, 40), ua: text(raw.ua, 60)};
}

/** Adds `report` to `all` ({key: row}): a new row, or one more of a row's kind. Returns `all`. */
export function addReport(all, report, now) {
  const key = `${report.message}|${report.stack.split('\n')[0] || ''}`;
  const row = all[key];
  if (row) Object.assign(row, {count: row.count + 1, last: now, build: report.build, page: report.page, ua: report.ua});
  else all[key] = {...report, count: 1, first: now, last: now};
  const keys = Object.keys(all);
  if (keys.length > MAX_ERRORS) {
    const oldest = keys.reduce((a, b) => (all[b].last < all[a].last ? b : a));
    delete all[oldest];
  }
  return all;
}

/** A limiter: `take(now)` says if one more report may be kept this minute. */
export function reportLimiter(most = MAX_PER_MINUTE) {
  let minute = -1, used = 0;
  return now => {
    const m = Math.floor(now / 60_000);
    if (m !== minute) { minute = m; used = 0; }
    return ++used <= most;
  };
}

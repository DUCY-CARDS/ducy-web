// Uncaught errors, told to the relay so we hear about them (#552). What's sent:
// the error's text and stack with player IDs and addresses taken out, the
// page's name, the site's version and the browser's name. Only from the live
// site, at most MAX_PER_PAGE a page load, each different error once. Reporting
// never gets in the way: anything going wrong here is ignored.

const REPORT_URL = 'https://ducy-relay.ducy.workers.dev/report';
const LIVE = ['https://ducy.cards', 'https://www.ducy.cards'];
const MAX_PER_PAGE = 5;
const MAX_MESSAGE = 300;
const STACK_LINES = 8;
// Browsers' own noise, and other sites' scripts they won't tell us about.
const NOISE = /^(Script error\.?|ResizeObserver loop)/;

/** `text` with addresses cut to their file, and anything like a player ID or key taken out. */
export function cleanText(text, max = MAX_MESSAGE) {
  return String(text ?? '')
    .replace(/\b(?:https?|wss?|blob|file):\/\/[^\s)]*/g, url => url.replace(/[?#][^:]*/, '').split('/').pop() || 'address')
    .replace(/[A-Za-z0-9_+/-]{20,}={0,2}/g, '[id]')
    .slice(0, max);
}

/** The top of a stack, cleaned. */
export const cleanStack = stack => String(stack ?? '').split('\n').slice(0, STACK_LINES).map(l => cleanText(l.trim(), 200)).filter(Boolean).join('\n');

/** The site's version, from a script's address (v/<version>/src/…). */
export const buildOf = url => /\/v\/([\w.-]+)\/src\//.exec(String(url))?.[1] || 'dev';

/** The page's name: the first part of the address's hash, which holds nothing about anyone. */
export const pageOf = hash => (/^#([a-z0-9-]+)/.exec(String(hash)) || [])[1] || 'home';

/** What's sent for `error` (an Error, a string or a worker's error event), or null for noise. */
export function reportOf(error, {where = '', hash = '', build = 'dev', ua = ''} = {}) {
  const message = cleanText(error?.message ?? error);
  if (!message || NOISE.test(message)) return null;
  const at = error?.filename ? `at ${error.filename}:${error.lineno || 0}:${error.colno || 0}` : '';
  return {message, stack: cleanStack(error?.stack || at), where: String(where).slice(0, 40), page: pageOf(hash), build, ua: browserOf(ua)};
}

/** The browser and its major version, and the kind of device: no more than that. */
export function browserOf(ua) {
  const s = String(ua);
  const name = /(Edg|OPR|Firefox|FxiOS|CriOS|Chrome|Version)\/(\d+)/.exec(s);
  const browser = !name ? 'Other' : name[1] === 'Version' ? `Safari ${name[2]}` : `${{Edg: 'Edge', OPR: 'Opera', FxiOS: 'Firefox', CriOS: 'Chrome'}[name[1]] || name[1]} ${name[2]}`;
  const device = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'other';
  return `${browser}, ${device}`;
}

const sent = new Set();

/** Tells the relay about `error`. `where` says what was running (a worker's name, say). */
export function reportError(error, where = '') {
  try {
    if (!LIVE.includes(globalThis.location?.origin) || sent.size >= MAX_PER_PAGE) return;
    const report = reportOf(error, {where, hash: location.hash, build: buildOf(import.meta.url), ua: navigator.userAgent});
    if (!report || sent.has(report.message)) return;
    sent.add(report.message);
    // Plain text, so the browser doesn't ask the relay first; keepalive, so a page closing still sends it.
    fetch(REPORT_URL, {method: 'POST', mode: 'cors', credentials: 'omit', keepalive: true, headers: {'content-type': 'text/plain'}, body: JSON.stringify(report)}).catch(() => {});
  } catch {}
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', e => reportError(e.error || e));
  window.addEventListener('unhandledrejection', e => reportError(e.reason));
}

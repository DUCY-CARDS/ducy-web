// Multiplayer plumbing for the clubs: a WebSocket to the relay (relay/), where
// each always-on club runs in its room. Members connect as guests.
//   guest → relay: data                  relay → guest: data
//   guest → relay: {type: 'ping', t}     relay → guest: {type: 'pong', t}

const RELAY_KEY = 'ducyRelay';
// The deployed relay (relay/ on Cloudflare Workers). Empty hides
// multiplayer. ?relay=<url> uses another one in this browser (for testing;
// the https:// URL wrangler prints works too), and ?relay=default goes back
// to this one.
export const DEFAULT_RELAY = 'wss://ducy-relay.ducy.workers.dev';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

// A relay address as a WebSocket URL: https:// becomes wss://, http://
// becomes ws://, and a trailing slash goes.
export function wsUrl(u) {
  return String(u).trim().replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '');
}

export function relayUrl() {
  let q = new URLSearchParams(location.search).get('relay');
  try {
    if (q === 'default') { localStorage.removeItem(RELAY_KEY); q = null; }
    if (q) localStorage.setItem(RELAY_KEY, q);
    return wsUrl(q || localStorage.getItem(RELAY_KEY) || DEFAULT_RELAY);
  } catch {
    return wsUrl(q && q !== 'default' ? q : DEFAULT_RELAY);
  }
}

export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(r, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return c.slice(0, 4) + '-' + c.slice(4);
}

// A club code as typed, in any case and with or without the dash or spaces,
// as "ABCD-EFGH"; '' if it isn't one (codes never have I, L, O, 0 or 1).
export function normCode(s) {
  const c = String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every(ch => CODE_CHARS.includes(ch)) ? c.slice(0, 4) + '-' + c.slice(4) : '';
}

// A relay inside the page (a demo club, #406): connect() and lookupCode()
// use it instead of the network. {connect, lookup}, as those take them.
let localRelay = null;
export function useLocalRelay(r) {
  localRelay = r;
}

// What code `code` is, asked of the relay (#393): {kind: 'club', ask, name,
// hostId} for a club (name and hostId only when it lets people ask to join
// with its code), {kind: 'none'} for anything else, or null when the relay
// can't be asked. With the `invite` token of an invite link, a club's About
// the club comes too (`about`, #398).
export async function lookupCode(code, get = globalThis.fetch, invite = '') {
  if (localRelay) return localRelay.lookup(code, invite);
  const base = relayUrl().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    const r = await get(`${base}/code/${encodeURIComponent(code)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`);
    if (!r.ok) return null;
    const v = await r.json();
    return ['club', 'none'].includes(v?.kind) ? v : null;
  } catch {
    return null;
  }
}

// Opens the room and keeps it open, reconnecting with backoff when the
// connection drops. Handlers: onOpen(), onMessage(obj), onStatus(text) with
// '' once connected, onFail(reason) when it gives up, and onHealth(healthy)
// when the link's health changes: unhealthy while the socket is down, or
// (once the relay has shown it answers pings) when nothing has been heard
// for a while.
// With `queue` (clubs), a guest can connect while the club's host is away
// (see relay/README.md). With `persistent`, it never gives up reconnecting.
export const SILENT_MS = 12_000;

// With `prove(challenge)` (a club connection, #577), the relay first asks
// the page to prove it holds the player's key: prove signs the challenge
// (identity.js signMessage of {type: 'prove', room, challenge}), and
// onOpen comes once the relay says it's proven. Until then the connection
// is no one, so it can't knock off the player's other one.
// Coming back to the page (a phone waking the tab) checks the connection at
// once: a dead one reconnects straight away, a silent one is replaced.
export function connect(code, role, id, {onOpen, onMessage, onStatus, onFail, onHealth = () => {}}, {queue = false, persistent = false, prove = null} = {}) {
  if (localRelay) return localRelay.connect(code, role, id, {onOpen, onMessage, onStatus, onFail, onHealth});
  let ws = null, closed = false, tries = 0, retry = null, joined = false;
  let heard = 0, pongs = false, healthy = false;
  const url = `${relayUrl()}/room/${encodeURIComponent(code)}?role=${role}` + (id ? `&id=${encodeURIComponent(id)}` : '') + (queue ? '&queue=1' : '');
  const setHealth = h => { if (h !== healthy) { healthy = h; onHealth(h); } };
  // Healthy: the socket is open and, if the relay answers pings, we've heard
  // from it recently. (A relay without pongs: the socket's state alone.)
  const check = () => setHealth(!!ws && ws.readyState === 1 && (!pongs || Date.now() - heard < SILENT_MS));
  const opened = () => { tries = 0; onStatus(''); onOpen(); check(); };
  const open = () => {
    const sock = ws = new WebSocket(url);
    // onOpen first: it may reset what was known before the health change.
    ws.onopen = () => { heard = Date.now(); if (!prove) opened(); };
    ws.onmessage = e => {
      if (sock !== ws) return;
      heard = Date.now();
      // Joined once something comes through: the relay opens a socket for a
      // code with no table behind it before closing it with 4004, which then
      // fails at once instead of reconnecting for ever.
      joined = true;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { console.warn(err); return; }
      if (m?.type === 'pong') { pongs = true; check(); return; }
      // Proving this page holds the player's key (#577).
      if (prove && m?.type === 'prove') {
        Promise.resolve(prove(String(m.challenge || ''))).then(env => { if (sock === ws && sock.readyState === 1) sock.send(JSON.stringify({type: 'prove', env})); }, err => console.warn('relay: not proven:', err));
        return;
      }
      if (prove && m?.type === 'proven') { opened(); return; }
      check();
      try { onMessage(m); } catch (err) { console.warn(err); }
    };
    ws.onclose = e => {
      // An old socket, replaced after the page woke: nothing to do.
      if (sock !== ws) return;
      check();
      if (closed) return;
      // 4009: a newer connection with the same id took over, from another tab
      // or window. Reconnecting would knock that one off in turn, and the two
      // would trade places every second; the newer one keeps it.
      if (e.code === 4009) {
        closed = true;
        onFail('This is open in another tab or window, which took it over. Use that one, or reload this page to take it back.');
        return;
      }
      // 4003: ducy paused the club, or its free trial ended (#265): say why,
      // and look again now and then, in case it's back.
      if (e.code === 4003) {
        onStatus(e.reason || 'ducy has paused this club.');
        retry = setTimeout(open, 5 * 60_000);
        return;
      }
      // 4004: no such club. 4008: this page sent faster than the relay
      // allows (#103).
      if (persistent && e.code !== 4008 && !(e.code === 4004 && !joined)) {
        onStatus('Reconnecting…');
        retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** tries++));
        return;
      }
      if (e.code === 4008 || (e.code === 4004 && !joined) || tries >= 6) {
        closed = true;
        onFail(e.code === 4004 ? 'No club with that code.'
          : e.code === 4008 ? 'The relay closed the connection: too many messages. Reload to reconnect.' : 'Lost the connection.');
        return;
      }
      onStatus('Reconnecting…');
      retry = setTimeout(open, 1000 * 2 ** tries++);
    };
  };
  // The page is back in front (a phone woke the tab): a socket that's gone
  // reconnects now, not at the end of its backoff; one that's open but
  // silent (a phone can keep a dead one open) is checked with a ping and
  // replaced if nothing answers.
  const wake = () => {
    if (closed || document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      if (!retry) return;
      clearTimeout(retry);
      retry = null;
      tries = 0;
      open();
      return;
    }
    if (ws.readyState !== 1) return;
    const sock = ws, before = heard;
    sock.send(JSON.stringify({type: 'ping', t: Date.now()}));
    setTimeout(() => {
      if (closed || sock !== ws || heard !== before || sock.readyState !== 1) return;
      ws = null;
      sock.close();
      onStatus('Reconnecting…');
      open();
    }, 4000);
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
  open();
  return {
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(retry); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake); if (ws) ws.close(1000); },
    healthy: () => healthy,
  };
}

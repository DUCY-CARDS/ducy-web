// Multiplayer plumbing for #play: a WebSocket to the relay (relay/), which
// forwards messages between the host's tab and each player's tab in a room.
// The relay knows nothing about poker; the host's tab runs the table.
//   host  → relay: {to, data}           relay → host:  {from, data} | {from, event: 'open' | 'close'}
//   guest → relay: data                  relay → guest: data | {type: 'host_gone'}

const RELAY_KEY = 'ducyRelay';
const CLIENT_KEY = 'ducyPlayClient';
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

// The table code in the page's link (?table=ABCD-EFGH), if any.
export function linkedCode() {
  return normCode(new URLSearchParams(location.search).get('table') || '');
}

// The host's player ID in the page's link (?host=…), if any: a guest checks
// the host's signed encryption key against it.
export function linkedHost() {
  const h = new URLSearchParams(location.search).get('host') || '';
  return /^[1-9A-HJ-NP-Za-km-z]{8}$/.test(h) ? h : '';
}

// A link that opens #play ready to join `code`. It names the relay too when
// it isn't the default, so friends reach the same one, and the host's player
// ID, so guests can check the host's encryption key (play.js).
export function joinLink(code, hostId = '') {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('table', code);
  if (hostId) u.searchParams.set('host', hostId);
  const relay = relayUrl();
  if (relay !== wsUrl(DEFAULT_RELAY)) u.searchParams.set('relay', relay);
  u.hash = 'play';
  return u.toString();
}

export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(r, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return c.slice(0, 4) + '-' + c.slice(4);
}

// A table code as typed, in any case and with or without the dash or spaces,
// as "ABCD-EFGH"; '' if it isn't one (codes never have I, L, O, 0 or 1).
export function normCode(s) {
  const c = String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every(ch => CODE_CHARS.includes(ch)) ? c.slice(0, 4) + '-' + c.slice(4) : '';
}

// Identifies this tab to the host, so a reload gets the same seat back.
export function clientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_KEY);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(CLIENT_KEY, id); }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Opens the room as host or guest and keeps it open, reconnecting with
// backoff when the connection drops. Handlers: onOpen(), onMessage(obj),
// onStatus(text) with '' once connected, onFail(reason) when it gives up.
// With `queue` (clubs), a guest can connect while the host is away, and the
// relay keeps its messages until the host comes back (see relay/README.md).
// With `retryInUse`, a host refused because the room already has one keeps
// trying for a few seconds (after a reload the relay may not have noticed
// the old connection close yet) before giving up with `inUse` as the reason.
export function connect(code, role, id, {onOpen, onMessage, onStatus, onFail}, {queue = false, retryInUse = false, inUse = 'That table code is in use.'} = {}) {
  let ws = null, closed = false, tries = 0, retry = null, joined = false;
  const url = `${relayUrl()}/room/${encodeURIComponent(code)}?role=${role}` + (id ? `&id=${encodeURIComponent(id)}` : '') + (queue ? '&queue=1' : '');
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { tries = 0; joined = true; onStatus(''); onOpen(); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
    ws.onclose = e => {
      if (closed) return;
      // 4001: the room already has a host; 4004: no such table. After a drop
      // a guest keeps trying while the host comes back.
      // 4008: this page sent faster than the relay allows (#103).
      if ((e.code === 4001 && !(retryInUse && tries < 4)) || e.code === 4008 || (e.code === 4004 && !joined) || tries >= 6) {
        closed = true;
        onFail(e.code === 4001 ? inUse : e.code === 4004 ? 'No table with that code.'
          : e.code === 4008 ? 'The relay closed the connection: too many messages. Reload to reconnect.' : 'Lost the connection.');
        return;
      }
      onStatus('Reconnecting…');
      retry = setTimeout(open, 1000 * 2 ** tries++);
    };
  };
  open();
  return {
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(retry); if (ws) ws.close(1000); },
  };
}

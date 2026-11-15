// Player slots on staging (#671): one browser runs several players at once,
// one per window, so an owner can test a club game alone (the owner in one
// window, an agent in another, players in the rest).
//
// A window's slot comes from its address (?player=3) or, after that, from
// the window's sessionStorage (it lasts across reloads in that window, and
// the address wins over a copy a new window inherited). Slot 1 is this
// browser's normal storage, untouched. Slot N (2 and up) keeps its own:
// localStorage and sessionStorage keys under slotPrefix(N), IndexedDB
// databases named with slotDbSuffix(N) (player-slot-ui.js puts that in
// place, with profile.js's separateStorage). So each slot is its own player
// ID, name, clubs, hands and settings, and two slots never take each other's
// club connections over (#618); the same slot in two windows still does.
//
// Only on staging's sites and local pages: anywhere else (ducy.cards, its
// club site, the sandbox) every window is slot 1 and nothing here runs.
// Pure, so the tests run it in Node.

export const SLOT_PARAM = 'player';
// The window's slot, in its own (real) sessionStorage.
export const SLOT_KEY = 'ducyPlayerSlot';
// The slots this browser has used, in its (real) localStorage, for the switcher.
export const SLOTS_KEY = 'ducyPlayerSlots';
export const MAX_SLOT = 20;

const STAGING = ['staging.ducy.cards', 'club-staging.ducy.cards'];
const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];

// Whether page host `h` may have slots: staging's player app and club site,
// and local pages (for tests and development).
export const slotsAllowed = h => STAGING.includes(h) || LOCAL.includes(h);
// Whether the switcher shows without being asked for (staging); a local page
// shows it once a slot is chosen.
export const isStaging = h => STAGING.includes(h);

// A slot number from text: a whole number from 1 to MAX_SLOT, else null.
export function parseSlot(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_SLOT ? n : null;
}

// This window's slot: {slot, chosen}. `chosen` is true when the address or
// the window asked for one (a local page shows the switcher only then).
// `search` is the page's query string, `saved` the window's SLOT_KEY.
export function pickSlot({host, search = '', saved = null}) {
  if (!slotsAllowed(host)) return {slot: 1, chosen: false};
  const fromUrl = parseSlot(new URLSearchParams(search).get(SLOT_PARAM));
  if (fromUrl) return {slot: fromUrl, chosen: true};
  const fromWindow = parseSlot(saved);
  if (fromWindow) return {slot: fromWindow, chosen: true};
  return {slot: 1, chosen: false};
}

// Slot `n`'s storage: key prefix and IndexedDB name suffix ('' for slot 1).
// '#' keeps them apart from test profiles' (profile.js) and demos' names.
export const slotPrefix = n => (n > 1 ? `slot#${n}:` : '');
export const slotDbSuffix = n => (n > 1 ? `#slot${n}` : '');

// The slots in use, from SLOTS_KEY's text: 1 always, then the rest in order.
export function slotList(text) {
  let list = [];
  try { list = JSON.parse(text || '[]'); } catch {}
  const ns = Array.isArray(list) ? list.map(parseSlot).filter(Boolean) : [];
  return [...new Set([1, ...ns])].sort((a, b) => a - b);
}

// The next slot for a new player, or null when all are used.
export function nextSlot(list) {
  for (let n = 2; n <= MAX_SLOT; n++) if (!list.includes(n)) return n;
  return null;
}

// Address `href` opened as slot `n`: ?player=n (slot 1 too, so a window
// that was another slot goes back), any hash kept.
export function slotUrl(href, n) {
  const u = new URL(href);
  u.search = '';
  u.searchParams.set(SLOT_PARAM, String(n));
  return u.toString();
}

// This window's slot, once player-slot-ui.js has chosen it (1 until then,
// and always in Node).
let current = 1;
export const currentSlot = () => current;
export const setCurrentSlot = n => { current = parseSlot(n) || 1; };

// A link to the other staging site carries this window's slot (?player=N),
// so the club site opens as the same player. Slot 1 adds nothing.
export function withSlot(href, n = current) {
  if (n <= 1) return href;
  const m = String(href).match(/^(https:\/\/[^/?#]+\/)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) return href;
  const q = new URLSearchParams(m[3] || '');
  q.set(SLOT_PARAM, String(n));
  return `${m[1]}${m[2]}?${q}${m[4] || ''}`;
}

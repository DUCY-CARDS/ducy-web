// Muting a player's chat (#616). Muting someone hides their table chat for
// you only, on this device: they aren't told, and nothing else changes (their
// moves, the hand log and fair play are untouched). Mutes follow the player
// ID on each chat line (play.js), not the seat or name, so they last across
// tables, sessions and name changes. Kept as {playerId: name} in
// localStorage; the name is only for the list under You.

const MUTE_KEY = 'ducyChatMuted';
const MUTE_MAX = 200; // players kept; the oldest go first

// A chat line's sender ID, or '' if it isn't one: a player ID, or a bot's
// ('bot:…').
export const chatPid = v => (typeof v === 'string' && /^[\w:.-]{1,64}$/.test(v) ? v : '');

const store0 = () => { try { return globalThis.localStorage || null; } catch { return null; } };

// Who's muted on this device: {playerId: name}.
export function readMuted(store = store0()) {
  try {
    const v = JSON.parse(store?.getItem(MUTE_KEY) || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, n]) => chatPid(k) && typeof n === 'string').map(([k, n]) => [k, n.slice(0, 20)]));
  } catch {
    return {};
  }
}

const listeners = new Set();
// Calls `fn` whenever a mute changes here (the table redraws its chat).
export function onMuteChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Mutes (on) or unmutes player `pid`, shown as `name`.
export function setMuted(pid, name, on, store = store0()) {
  const id = chatPid(pid);
  if (!id) return;
  const m = readMuted(store);
  delete m[id];
  if (on) m[id] = String(name ?? '').slice(0, 20) || 'A player';
  const keep = Object.entries(m).slice(-MUTE_MAX);
  try { store?.setItem(MUTE_KEY, JSON.stringify(Object.fromEntries(keep))); } catch {}
  for (const fn of listeners) { try { fn(); } catch {} }
}

export const isMuted = (pid, muted = readMuted()) => !!pid && Object.prototype.hasOwnProperty.call(muted, pid);

// The muted players, by name: [{pid, name}].
export const mutedList = (store = store0()) => Object.entries(readMuted(store)).map(([pid, name]) => ({pid, name})).sort((a, b) => a.name.localeCompare(b.name));

// The chat lines to show: everyone's but the muted players'.
export const shownChat = (log, muted) => log.filter(m => !isMuted(m.pid, muted));

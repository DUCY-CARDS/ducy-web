// The name this browser's player goes by in clubs (Player settings, #144),
// kept in this browser's storage. A passkey keeps a copy of it on the relay
// (passkey.js), so restoring on a new device or another of ducy's sites
// brings it back with the player ID (#619).

export const NAME_KEY = 'ducyClubName';
export const MAX_NAME = 20;

export const cleanName = n => String(n || '').trim().slice(0, MAX_NAME);

export function storedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
export function keepName(n) {
  try { localStorage.setItem(NAME_KEY, cleanName(n)); } catch {}
}

// After a passkey restore: the name the relay kept, unless this browser has
// one of its own. Returns the name this browser now goes by.
export function restoreName(kept) {
  const n = cleanName(kept);
  if (n && !storedName()) keepName(n);
  return storedName();
}

// What the beta doesn't offer yet (#560). Off means no way to start it in the
// club manager; the code and the room's commands stay, and what a club already
// has still shows. Delete a name to turn it back on. Credit, Balances (Settle)
// and tournament rake came back on in #623; rake and time at cash tables
// (#449, club-rake.js) are `cashRake`, still off. `demoClub` (#636): the club
// manager's Try a demo club (demo.js).

export const OFF = new Set(['cashRake', 'promos', 'services', 'demoClub']);

/**
 * Whether feature `f` is off on this page. `?on=f` in the address turns it
 * back on there, for the end-to-end tests of what's off; nothing links to it.
 */
export function isOff(f, search = globalThis.location?.search || '') {
  if (!OFF.has(f)) return false;
  return !new URLSearchParams(search).getAll('on').includes(f);
}

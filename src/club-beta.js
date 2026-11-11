// What the beta doesn't offer yet (#560). Off means no way to start it in the
// club manager; the code and the room's commands stay, and what a club already
// has still shows. Delete a name to turn it back on. Credit, Balances (Settle)
// and tournament rake came back on in #623; rake and time at cash tables
// (#449, club-rake.js) are `cashRake`, still off.

export const OFF = new Set(['cashRake', 'promos', 'services']);

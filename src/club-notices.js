// The club manager's notifications (#398): what needs the manager, newest
// first, each with what's needed for its quick actions (clubs.js draws
// them and their buttons). ducy-play's club_overview builds them from the
// club (#456).
//
//   join        asks to join                    Let in · Decline
//   chips       asks for chips                  Give (the amount) · Other · Decline
//   at_limit    a credit player at their limit  Raise limit (new amount) · Decline (#404)
//   help        a help request                  Reply · Watch · Done
//   prize       a promotion prize held          Pay · Replay
//   stopped     a table stopped dealing         Close table
//   left_owing  left a table owing the club     (a notice) (#404)
//   move        a big give or take back, a removal or a cap change (#576), for 7 days
//   cap_raise   a raise of the daily chip cap, waiting its day     Cancel (#576)
// Each has a `key`, unique and stable while it stands, so the notices that
// need no answer (stopped, left_owing, move) can be cleared.

import { overview } from './club-overview.js';

// Notices only shown (no answer needed), which Clear puts away.
// fair_play (#582) comes from the relay's check, not the club (clubs.js
// adds it: club-fair-play.js).
export const CLEARABLE = new Set(['stopped', 'left_owing', 'move', 'fair_play']);

export const managerNotices = (club, {cleared = new Set(), seated = {}} = {}, now = Date.now()) => overview(club, 'notices', {cleared: [...cleared], seated}, now);

// The daily chip cap (#576): {cap, given (in the last 24 hours), left, set
// (the owner chose it), raise: {to, at, applies} or null}.
export const chipCap = (club, now = Date.now()) => overview(club, 'chipCap', {}, now);

// The keys of the clearable notices in `list`, to put away with Clear.
export const clearableKeys = list => list.filter(n => CLEARABLE.has(n.kind)).map(n => n.key);

// A new credit limit to offer a player at their limit: enough for what
// they asked, on top of what they have available.
export const raiseTo = n => n.credit + Math.max(0, n.asked - n.available);

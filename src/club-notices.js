// The club manager's notifications (#398): what needs the manager, newest
// first, each with what's needed for its quick actions (clubs.js draws
// them and their buttons). ducy-play's club_overview builds them from the
// club (#456).
//
//   join        asks to join                    Let in · No
//   chips       asks for chips                  Give (the amount) · Other · No
//   at_limit    a credit player at their limit  Raise limit (new amount) · No (#404)
//   help        a help request                  Reply · Watch
//   prize       a promotion prize held          Pay · Replay hand
//   stopped     a table stopped dealing         Close table
//   left_owing  left a table owing the club     (a notice) (#404)
// Each has a `key`, unique and stable while it stands, so the notices that
// need no answer (stopped, left_owing) can be cleared.

import { overview } from './club-overview.js';

// Notices only shown (no answer needed), which Clear puts away.
export const CLEARABLE = new Set(['stopped', 'left_owing']);

export const managerNotices = (club, {cleared = new Set(), seated = {}} = {}) => overview(club, 'notices', {cleared: [...cleared], seated});

// The keys of the clearable notices in `list`, to put away with Clear.
export const clearableKeys = list => list.filter(n => CLEARABLE.has(n.kind)).map(n => n.key);

// A new credit limit to offer a player at their limit: enough for what
// they asked, on top of what they have available.
export const raiseTo = n => n.credit + Math.max(0, n.asked - n.available);

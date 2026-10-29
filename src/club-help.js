// Help requests (#192): a member asks whoever runs the club for help ("Can
// someone top me up?", "Table 2 is stuck"); the host or owner sees the open
// ones, replies, and marks them handled. Members see whether they're around
// to answer. ducy-play's club rules keep them (club-rules.js);
// club-server.js carries the messages.
//
// club.help: [{id, from, name, text, table, at, reply, handled: null | {by, at}}],
// the last MAX_HELP, oldest first.

import { rules } from './club-rules.js';

export const MAX_HELP = 50;
export const MAX_HELP_TEXT = 200;
export const MAX_HELP_REPLY = 200;

// Member `from` asks for help; one open request each, so a new one replaces
// it. Returns the request, or throws why not.
export const askHelp = (club, from, text, table = '', now = Date.now()) => rules(club, {op: 'askHelp', from, text: String(text ?? ''), table: String(table ?? '')}, now);

// The host (`by` = the club's hostId) or owner answers request `id`: a
// reply, and/or marking it handled. Returns the request, or throws.
export const answerHelp = (club, by, id, {reply = '', handled = true} = {}, now = Date.now()) => rules(club, {op: 'answerHelp', by, id, reply: String(reply ?? ''), handled}, now);

export const openHelp = club => (club.help || []).filter(h => !h.handled);

// Who's around to help, given who's connected (`online`, a Set) and whether
// the host's own page is running the club (a club run in the host's tab):
// [{name, role: 'host'}], or none.
export const staffOnline = (club, online, hostHere = false) => rules(club, {op: 'staffOnline', online: [...online], hostHere});

// What member `id` sees: who's around, and their own latest requests.
export const helpBody = (club, id, staff) => rules(club, {op: 'helpBody', id, staff});

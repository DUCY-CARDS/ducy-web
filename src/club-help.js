// Help requests (#192): a member asks whoever runs the club for help ("Can
// someone top me up?", "Table 2 is stuck"); the host or owner sees the open
// ones, replies, and marks them handled. Members see whether they're around
// to answer. Pure functions over the club object; club-server.js carries the
// messages.
//
// club.help: [{id, from, name, text, table, at, reply, handled: null | {by, at}}],
// the last MAX_HELP, oldest first.

export const MAX_HELP = 50;
export const MAX_HELP_TEXT = 200;
export const MAX_HELP_REPLY = 200;
// How many of their own requests a member sees.
const MINE = 3;

const clean = (s, max) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// Member `from` asks for help. Returns the request, or throws why not.
export function askHelp(club, from, text, table = '', now = Date.now()) {
  const m = club.members[from];
  if (m?.status !== 'member') throw new Error('Only members can ask for help.');
  const t = clean(text, MAX_HELP_TEXT);
  if (!t) throw new Error('Say what you need help with.');
  club.help ??= [];
  // One open request each: a new one replaces it.
  club.help = club.help.filter(h => h.from !== from || h.handled);
  const h = {id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, from, name: m.name, text: t, table: clean(table, 50), at: now, reply: '', handled: null};
  club.help.push(h);
  if (club.help.length > MAX_HELP) club.help.splice(0, club.help.length - MAX_HELP);
  return h;
}

// The host (`by` = the club's hostId) or owner answers request `id`: a
// reply, and/or marking it handled. Returns the request, or throws.
export function answerHelp(club, by, id, {reply = '', handled = true} = {}, now = Date.now()) {
  if (by !== club.hostId && by !== club.ownerId) throw new Error('Only the club’s manager answers help requests.');
  const h = (club.help || []).find(x => x.id === id);
  if (!h) throw new Error('No such help request.');
  const r = clean(reply, MAX_HELP_REPLY);
  if (r) h.reply = r;
  if (handled) h.handled = {by: club.members[by]?.name || 'Manager', at: now};
  return h;
}

export const openHelp = club => (club.help || []).filter(h => !h.handled);

// Who's around to help, given who's connected (`online`, a Set) and whether
// the host's own page is running the club (a club run in the host's tab):
// [{name, role: 'host'}], or none.
export function staffOnline(club, online, hostHere = false) {
  if (!hostHere && !(club.ownerId && online.has(club.ownerId))) return [];
  return [{name: club.members[club.ownerId]?.name || 'Manager', role: 'host'}];
}

// What member `id` sees: who's around, and their own latest requests.
export function helpBody(club, id, staff) {
  const mine = (club.help || []).filter(h => h.from === id).slice(-MINE).map(h => ({id: h.id, text: h.text, at: h.at, reply: h.reply, handled: !!h.handled, by: h.handled?.by || ''}));
  return {type: 'help', club: club.code, staff, mine};
}

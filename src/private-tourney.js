// One-off private tournaments (#394): started from Start a game, not a
// club's. Any size: with more players than a table seats it runs on several
// tables, moving players and breaking tables as club tournaments do, since
// it is one. The club tournament code (club-tourneys.js for the rules,
// club-tourney-host.js for the tables) runs it over a stand-in club that
// lives only in the host's tab: everyone who registers is a member of it
// for as long as the tournament lasts. Chips are tournament chips only:
// no buy-ins, no club balances, and the payouts are shares of first,
// second and so on. Pure functions; private-tourney-room.js runs it.
//
// Registration is open from when the host opens the lobby until the host
// starts it (late registration and re-entries are for later).
//
// Points (#403): a buy-in in points, and prizes in points that the host sets
// any way they like (t.points = {buyIn, prizes}). Until the host changes
// them, the prizes are the buy-ins added up and split by the payout shares,
// following the entries; once changed, they're the host's list, which may
// pay more than the entries (an overlay) or less. They can change until the
// end. Points are only for settling up afterwards: the tables play with
// tournament chips, and club chips never move.
//
// ducy-play's club_oneoff (oneOff, #457; privateTourney, #456) has the
// names, points, making, joining and leaving the tournament, what players
// see, the results and standings; here the stand-in club is kept.

import { privateTourney } from '../wasm/ducy_wasm.js';
import { newClub } from './club.js';
import { ask, settleUp } from './oneoff-standings.js';

export const MAX_POINTS = 1e9;

// The host's own seat, in the stand-in club (relay ids are UUIDs, so it can't clash).
export const HOST_ID = 'host';

// The payout choices: the club defaults (about the top 15%, by the number of
// entries), a fixed split, or the host's own payout table by entries (#424,
// the setup's `rows`). Shares are basis points (1/100 of a percent).
export const PAYOUTS = [
  {id: 'default', label: 'Top 15%', places: null},
  {id: 'wta', label: 'Winner takes all', places: [10000]},
  {id: 'top2', label: 'Top 2', places: [6500, 3500]},
  {id: 'top3', label: 'Top 3', places: [5000, 3000, 2000]},
  {id: 'table', label: 'By entries', places: null},
];

// The stand-in club for tournament code `code`, with the host as its
// first member.
export function privateClub(code, hostName, now = Date.now()) {
  const club = newClub('Private game', code, HOST_ID, now);
  club.tourneys = [];
  club.members[HOST_ID] = {id: HOST_ID, name: cleanName(hostName) || 'Host', status: 'member', balance: 0};
  return club;
}

export const cleanName = s => ask({op: 'cleanName', name: String(s ?? '')});

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Runs one of ducy-play's one-off tournament ops ('new', 'join', 'leave',
// 'prizes') on the stand-in club; the members and the tournament keep
// their objects. Throws why not, and nothing changes.
function run(club, op, args, now = Date.now()) {
  const r = privateTourney(JSON.stringify(club), op, JSON.stringify(args), now);
  if (!r.ok) throw new Error(r.message);
  merge(club.members, r.club.members);
  const was = club.tourneys?.[0];
  const t = r.club.tourneys[0];
  club.tourneys = t ? [was?.id === t.id ? merge(was, t) : t] : [];
  return r.value;
}

// The tournament, from the setup form: {name, game, stack, tableSize,
// structure, payout, rows, buyIn} (payout: one of PAYOUTS' ids; rows, for
// 'table', the payout table's rows, #424; buyIn in points, #403). The host
// runs it (their tab runs every table) and plays only if they register in
// the lobby, as anyone does: until then they have no seat and no place.
// Throws why the settings won't do.
export function newPrivateTourney(club, s, now = Date.now()) {
  const p = PAYOUTS.find(x => x.id === s.payout);
  const payout = p?.places || (p?.id === 'table' ? {rows: s.rows} : null);
  run(club, 'new', {setup: s, payout}, now);
  return theTourney(club);
}

export const theTourney = club => club.tourneys?.[0] || null;

// Player `id` (their relay id) registers as `name`, before the start, the
// name made unique. Asking again (a reconnect) keeps their entry and takes
// the new name. Returns the member; throws why not.
export function joinPrivate(club, id, name, now = Date.now()) {
  run(club, 'join', {id, name: String(name ?? '')}, now);
  return club.members[id];
}

// Player `id` unregisters (or the host takes them off), before the start.
// The host may too: they go on running it, and keep their name. Returns
// whether they were registered.
export const leavePrivate = (club, id, now = Date.now()) => run(club, 'leave', {id}, now);

// The paid places now: [{place, share}] (share in basis points); no more
// places than entries.
export const paidPlaces = t => ask({op: 'paidPlaces', tourney: t});

// ---- points (#403) ----

// The prizes the buy-ins make, split by the payout shares (index 0: first);
// rounding remainders go to first, so they add up to the entries exactly.
export const autoPrizes = t => ask({op: 'autoPrizes', tourney: t});

// The prizes in force: the host's, or the split of the buy-ins.
export const prizeList = t => ask({op: 'prizeList', tourney: t});

// The prizes' total against the entries': {prizes, entries, added} (added
// below 0 when the prizes pay out less than came in).
export const prizeTotals = t => ask({op: 'prizeTotals', tourney: t});

// The host sets the prizes: whole points, by place from first (any amounts,
// in any order). null goes back to the split of the buy-ins. Until the end.
// Throws why not.
export function setPrizes(club, list) {
  run(club, 'prizes', {list: list ?? null});
  return theTourney(club);
}

// What every player sees of the tournament (the lobby, how it's going, the
// results), with `live` from club-tourney-host.js while it runs.
export function lobbyBody(club, live = null) {
  const t = theTourney(club);
  if (!t) return null;
  return ask({op: 'lobbyBody', code: club.code, members: club.members, tourney: t, live: live ?? null});
}

// The finishing places so far, best first: [{place, id, name, share,
// amount}] (share and amount 0 out of the money; amount in points).
export const results = body => ask({op: 'results', body});

// The standings at the end (#403), the biggest winner first: [{id, name,
// buyIn, won, added, net}]. What the prizes pay beyond the entries comes
// from the host (`added`, below 0 when they pay less), in their row,
// whether or not they played. [] before the end.
export const tourneyStandings = body => (body ? ask({op: 'standings', body}) : []);

// Who owes whom at the end, in points.
export const tourneySettle = body => settleUp(tourneyStandings(body));

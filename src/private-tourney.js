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

import { newClub } from './club.js';
import { MAX_ENTRIES, entryCount, newTourney, payoutShares, playerCount, register, setPayout, unregister } from './club-tourneys.js';
import { settleUp } from './oneoff-standings.js';

export const MAX_POINTS = 1e9;
const points = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_POINTS;

// The host's own seat, in the stand-in club (relay ids are UUIDs, so it can't clash).
export const HOST_ID = 'host';
const MAX_NAME = 20;

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

export const cleanName = s => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);

// The tournament, from the setup form: {name, game, stack, tableSize,
// structure, payout, rows, buyIn} (payout: one of PAYOUTS' ids; rows, for
// 'table', the payout table's rows, #424; buyIn in points, #403). The host
// runs it (their
// tab runs every table) and plays only if they register in the lobby, as
// anyone does: until then they have no seat and no place.
// Throws why the settings won't do.
export function newPrivateTourney(club, s, now = Date.now()) {
  if (club.tourneys?.length) throw new Error('This game has a tournament already.');
  const buyIn = s.buyIn ?? 0;
  if (!points(buyIn)) throw new Error('The buy-in is a whole number of points, 0 or more.');
  const host = club.members[HOST_ID];
  const t = newTourney(club, {
    name: String(s.name ?? '').trim() || `${host.name}’s tournament`, game: s.game, buyIn: 0, added: 0,
    stack: s.stack, structure: s.structure, tableSize: s.tableSize,
    opensAt: now, startsAt: now, minPlayers: 2, maxPlayers: MAX_ENTRIES,
  }, now);
  const p = PAYOUTS.find(x => x.id === s.payout);
  try {
    if (p?.places) setPayout(club, t.id, p.places);
    else if (p?.id === 'table') setPayout(club, t.id, {rows: s.rows});
  } catch (e) {
    club.tourneys = [];
    throw e;
  }
  t.points = {buyIn, prizes: null};
  return t;
}

export const theTourney = club => club.tourneys?.[0] || null;

// `name` as nobody else in the club has it: "Ann", then "Ann 2", and so on.
function uniqueName(club, id, name) {
  const taken = new Set(Object.values(club.members).filter(m => m.id !== id).map(m => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const s = `${name.slice(0, MAX_NAME - String(n).length - 1)} ${n}`;
    if (!taken.has(s.toLowerCase())) return s;
  }
}

// Player `id` (their relay id) registers as `name`, before the start. Asking
// again (a reconnect) keeps their entry and takes the new name. Returns the
// member; throws why not.
export function joinPrivate(club, id, name, now = Date.now()) {
  const t = theTourney(club);
  if (!t) throw new Error('No tournament here.');
  const clean = cleanName(name);
  if (!clean) throw new Error('Enter your name: it’s what the others see.');
  const m = club.members[id];
  if (m && t.entries.some(e => e.member === id)) {
    if (t.status === 'scheduled') m.name = uniqueName(club, id, clean);
    return m;
  }
  if (t.status !== 'scheduled') throw new Error('This tournament has started: registration is closed.');
  club.members[id] = {id, name: uniqueName(club, id, clean), status: 'member', balance: 0};
  try {
    register(club, t.id, id, now);
  } catch (e) {
    delete club.members[id];
    throw e;
  }
  return club.members[id];
}

// Player `id` unregisters (or the host takes them off), before the start.
// The host may too: they go on running it, and keep their name.
export function leavePrivate(club, id, now = Date.now()) {
  const t = theTourney(club);
  if (!t || t.status !== 'scheduled' || !t.entries.some(e => e.member === id)) return false;
  unregister(club, t.id, id, now);
  if (id !== HOST_ID) delete club.members[id];
  return true;
}

// The paid places now: [{place, share}] (share in basis points); no more
// places than entries.
export function paidPlaces(t) {
  return payoutShares(t).slice(0, Math.max(1, entryCount(t))).map((share, i) => ({place: i + 1, share}));
}

// ---- points (#403) ----

const buyInOf = t => t.points?.buyIn ?? 0;

// The prizes the buy-ins make, split by the payout shares (index 0: first);
// rounding remainders go to first, so they add up to the entries exactly.
export function autoPrizes(t) {
  const total = entryCount(t) * buyInOf(t);
  const out = paidPlaces(t).map(p => Math.floor((total * p.share) / 10000));
  out[0] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

// The prizes in force: the host's, or the split of the buy-ins.
export const prizeList = t => (t.points?.prizes ? t.points.prizes.slice() : autoPrizes(t));

// The prizes' total against the entries': {prizes, entries, added} (added
// below 0 when the prizes pay out less than came in).
export function prizeTotals(t) {
  const prizes = prizeList(t).reduce((a, b) => a + b, 0), entries = entryCount(t) * buyInOf(t);
  return {prizes, entries, added: prizes - entries};
}

// The host sets the prizes: whole points, by place from first (any amounts,
// in any order). null goes back to the split of the buy-ins. Until the end.
// Throws why not.
export function setPrizes(club, list) {
  const t = theTourney(club);
  if (!t) throw new Error('No tournament here.');
  if (t.status === 'finished' || t.status === 'cancelled') throw new Error('It’s over already.');
  t.points ??= {buyIn: 0, prizes: null};
  if (list == null) { t.points.prizes = null; return t; }
  if (!Array.isArray(list) || !list.length || list.length > MAX_ENTRIES || !list.every(points)) throw new Error('Prizes are whole numbers of points, 0 or more.');
  t.points.prizes = list.slice();
  return t;
}

// What every player sees of the tournament (the lobby, how it's going, the
// results), with `live` from club-tourney-host.js while it runs.
export function lobbyBody(club, live = null) {
  const t = theTourney(club);
  if (!t) return null;
  const name = id => club.members[id]?.name || '?';
  return {
    type: 't_lobby', code: club.code, host: name(HOST_ID),
    id: t.id, name: t.name, game: t.game, stack: t.stack, tableSize: t.tableSize, structure: t.structure,
    status: t.status, why: t.why || '', startedAt: t.startedAt || null, endedAt: t.endedAt || null,
    players: t.entries.map(e => ({id: e.member, name: name(e.member), place: e.place ?? null})),
    count: playerCount(t), paid: paidPlaces(t),
    // Points (#403): everyone sees the prizes as they are now.
    buyIn: buyInOf(t), prizes: prizeList(t), custom: !!t.points?.prizes, totals: prizeTotals(t),
    ...(live ? {live} : {}),
  };
}

// The finishing places so far, best first: [{place, id, name, share,
// amount}] (share and amount 0 out of the money; amount in points).
export function results(body) {
  const shares = new Map(body.paid.map(p => [p.place, p.share]));
  return body.players.filter(p => p.place != null).sort((a, b) => a.place - b.place)
    .map(p => ({place: p.place, id: p.id, name: p.name, share: shares.get(p.place) || 0, amount: body.prizes?.[p.place - 1] || 0}));
}

// The standings at the end (#403), the biggest winner first: [{id, name,
// buyIn, won, added, net}]. What the prizes pay beyond the entries comes
// from the host (`added`, below 0 when they pay less), in their row,
// whether or not they played. [] before the end.
export function tourneyStandings(body) {
  if (body?.status !== 'finished') return [];
  const won = new Map(results(body).map(r => [r.id, r.amount]));
  const rows = body.players.map(p => ({id: p.id, name: p.name, buyIn: body.buyIn || 0, won: won.get(p.id) || 0, added: 0}));
  const added = rows.reduce((s, r) => s + r.won - r.buyIn, 0);
  if (added) {
    let host = rows.find(r => r.id === HOST_ID);
    if (!host) rows.push((host = {id: HOST_ID, name: body.host, buyIn: 0, won: 0, added: 0}));
    host.added = added;
  }
  return rows.map(r => ({...r, net: r.won - r.buyIn - r.added})).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
}

// Who owes whom at the end, in points.
export const tourneySettle = body => settleUp(tourneyStandings(body));

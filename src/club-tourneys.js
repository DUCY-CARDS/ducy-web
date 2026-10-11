// Club tournaments (#64): creating one and registering (#77), prize payouts
// (#79), late registration and re-entries (#80), and the results of running
// one (#81, club-tourney-host.js runs the tables). Pure functions over the
// club object from club.js; no DOM or network.
//
// A tournament: {id, name, game, buyIn, added, stack, structure, opensAt,
// startsAt, minPlayers, maxPlayers, tableSize, lateLevel, reentry,
// maxReentries, payout, status, entries, held, createdAt}.
// - buyIn and added are club chips (hundredths, chip-format.js). The pool is
//   every entry's buy-in plus the added chips. No fee for now.
// - stack and the structure (#78: [{sb, bb, ante, minutes} | {break: true,
//   minutes}]) are tournament chips: whole numbers, nothing to do with club chips.
// - lateLevel: registration and re-entry stay open until the end of that
//   level (0: none after the start). reentry: a busted player may buy in
//   again then, as a new entry; maxReentries: per player (0: no limit).
// - payout: null for the defaults (by the number of entries), or the
//   host's {places: [basis points]} adding up to exactly 10 000.
// - status: 'scheduled' → 'running' → 'finished', or 'cancelled'.
// - entries: [{n, member, at, place}] in order; a member's last entry is
//   their current one, and place is set once it's knocked out (1: the winner).
//
// Club chips stay conserved: buy-ins move from a member's balance into the
// tournament (`held`); a refund moves them back; prizes pay out what's held
// plus the added chips, which are issued then.

import { GAMES, maxSeats } from './club-tables.js';
import { chipText } from './chip-format.js';

export const MAX_TOURNEY_NAME = 40;
export const MAX_ENTRIES = 1000;
const MAX_CHIPS = 1e12;

const whole = n => Number.isSafeInteger(n);
const chips = n => whole(n) && n >= 0 && n <= MAX_CHIPS;

export function ensureTourneys(club) {
  club.tourneys ??= [];
  return club.tourneys;
}

export const tourneyById = (club, id) => (club.tourneys || []).find(t => t.id === id) || null;

// The tournaments members can see: not cancelled or finished long ago.
export function visibleTourneys(club, now = Date.now()) {
  return ensureTourneys(club).filter(t => !['finished', 'cancelled'].includes(t.status) || now - (t.endedAt || 0) < 7 * 864e5);
}

// Checks a blind structure's shape (ducy checks it fully; see tourney-structure.js).
function structure(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 200) throw new Error('Add at least one blind level.');
  const out = steps.map(s => {
    if (!whole(s.minutes) || s.minutes < 1) throw new Error('Every level needs its minutes.');
    if (s.break) return {break: true, minutes: s.minutes};
    if (!whole(s.sb) || !whole(s.bb) || !whole(s.ante ?? 0) || s.sb < 1 || s.bb < s.sb || (s.ante ?? 0) < 0) throw new Error('Blinds are whole chips, the big blind at least the small.');
    return {sb: s.sb, bb: s.bb, ante: s.ante ?? 0, minutes: s.minutes};
  });
  if (!out.some(s => !s.break)) throw new Error('Add at least one blind level.');
  return out;
}

// A new tournament. Throws why the settings won't do.
export function newTourney(club, s = {}, now = Date.now()) {
  ensureTourneys(club);
  const name = String(s.name ?? '').trim().slice(0, MAX_TOURNEY_NAME) || `Tournament ${club.tourneys.length + 1}`;
  const game = s.game || 'nlhe';
  if (!GAMES.some(g => g.id === game)) throw new Error('Pick a game.');
  const buyIn = s.buyIn ?? 0, added = s.added ?? 0, stack = s.stack;
  if (!chips(buyIn) || !chips(added)) throw new Error('The buy-in and added prize pool are 0 or more chips.');
  if (!whole(stack) || stack < 20 || stack > 1e9) throw new Error('The starting stack must be at least 20 chips.');
  const opensAt = s.opensAt ?? now, startsAt = s.startsAt;
  if (!whole(opensAt) || !whole(startsAt)) throw new Error('Pick when registration opens and when it starts.');
  if (startsAt < opensAt) throw new Error('It must start after registration opens.');
  const minPlayers = s.minPlayers ?? 2, maxPlayers = s.maxPlayers ?? 100;
  if (!whole(minPlayers) || minPlayers < 2 || !whole(maxPlayers) || maxPlayers < minPlayers || maxPlayers > MAX_ENTRIES) throw new Error('At least 2 players, and a maximum no smaller than the minimum.');
  const most = maxSeats(game);
  const tableSize = s.tableSize ?? Math.min(9, most);
  if (!whole(tableSize) || tableSize < 2 || tableSize > most) throw new Error(`A ${GAMES.find(g => g.id === game).label} table seats 2 to ${most}.`);
  const lateLevel = s.lateLevel ?? 0, maxReentries = s.maxReentries ?? 0;
  if (!whole(lateLevel) || lateLevel < 0 || !whole(maxReentries) || maxReentries < 0) throw new Error('Late registration is up to a level, from 0.');
  const t = {
    id: Math.random().toString(36).slice(2, 8), name, game, buyIn, added, stack, structure: structure(s.structure),
    opensAt, startsAt, minPlayers, maxPlayers, tableSize, lateLevel, reentry: !!s.reentry, maxReentries,
    payout: null, status: 'scheduled', entries: [], held: 0, createdAt: now,
  };
  club.tourneys.push(t);
  return t;
}

function member(club, id) {
  const m = club.members[id];
  if (!m || m.status !== 'member') throw new Error('Not a member of this club.');
  return m;
}

function get(club, tid) {
  const t = tourneyById(club, tid);
  if (!t) throw new Error('No such tournament.');
  return t;
}

// A ledger entry, as club-chips.js keeps them.
function record(club, m, kind, amount, now, tourney) {
  const e = {n: club.chips.next++, at: now, kind, member: m.id, amount, balance: m.balance, tourney};
  club.chips.ledger.push(e);
  return e;
}

// A member's current entry, if any.
export const entryOf = (t, id) => t.entries.findLast(e => e.member === id) || null;
// Registered and not knocked out.
export const isIn = (t, id) => { const e = entryOf(t, id); return !!e && e.place == null; };
// Entries so far (re-entries count), and the prize pool.
export const entryCount = t => t.entries.length;
export const pool = t => t.entries.length * t.buyIn + t.added;
// Different players registered.
export const playerCount = t => new Set(t.entries.map(e => e.member)).size;

// Takes the buy-in and adds an entry.
function enter(club, t, m, now) {
  if (m.balance < t.buyIn) throw new Error(`The buy-in is ${chipText(t.buyIn)} chips; you have ${chipText(m.balance)}.`);
  m.balance -= t.buyIn;
  t.held += t.buyIn;
  const e = {n: t.entries.length + 1, member: m.id, at: now, place: null};
  t.entries.push(e);
  if (t.buyIn > 0) record(club, m, 'tourney_buyin', t.buyIn, now, t.id);
  return e;
}

// A member registers before the start (#77): registration must be open and
// the tournament not full.
export function register(club, tid, id, now = Date.now()) {
  const t = get(club, tid), m = member(club, id);
  if (t.status !== 'scheduled') throw new Error('Registration is closed.');
  if (now < t.opensAt) throw new Error('Registration isn’t open yet.');
  if (isIn(t, id)) throw new Error('You’re registered already.');
  if (playerCount(t) >= t.maxPlayers) throw new Error('The tournament is full.');
  return enter(club, t, m, now);
}

// A member unregisters before the start, and gets the buy-in back.
export function unregister(club, tid, id, now = Date.now()) {
  const t = get(club, tid), m = member(club, id);
  if (t.status !== 'scheduled') throw new Error('It has started: you can’t unregister now.');
  const i = t.entries.findIndex(e => e.member === id);
  if (i < 0) throw new Error('You aren’t registered.');
  t.entries.splice(i, 1);
  t.entries.forEach((e, k) => { e.n = k + 1; });
  refund(club, t, m, now);
}

function refund(club, t, m, now) {
  t.held -= t.buyIn;
  m.balance += t.buyIn;
  if (t.buyIn > 0) record(club, m, 'tourney_refund', t.buyIn, now, t.id);
}

// Late registration or a re-entry (#80), while the tournament is running and
// `level` (from 0, the level being played) is no later than the last
// registration level. Returns the new entry.
export function lateEntry(club, tid, id, level, now = Date.now()) {
  const t = get(club, tid), m = member(club, id);
  if (t.status !== 'running' || level >= t.lateLevel) throw new Error('Late registration is closed.');
  const mine = t.entries.filter(e => e.member === id);
  if (mine.length) {
    if (isIn(t, id)) throw new Error('You’re still in.');
    if (!t.reentry) throw new Error('This tournament has no re-entries.');
    if (t.maxReentries && mine.length - 1 >= t.maxReentries) throw new Error(`You can re-enter ${t.maxReentries} time${t.maxReentries === 1 ? '' : 's'} at most.`);
  } else if (playerCount(t) >= t.maxPlayers) throw new Error('The tournament is full.');
  return enter(club, t, m, now);
}

// What to do at the start time: 'start', or 'cancel' when fewer than the
// minimum registered; null before then.
export function atStart(t, now = Date.now()) {
  if (t.status !== 'scheduled' || now < t.startsAt) return null;
  return playerCount(t) >= t.minPlayers ? 'start' : 'cancel';
}

// Cancels a tournament that hasn't finished: every buy-in goes back (the
// added chips were never paid). Also used when a running tournament can't go
// on (its host restarted).
export function cancelTourney(club, tid, now = Date.now(), why = '') {
  const t = get(club, tid);
  if (t.status === 'finished' || t.status === 'cancelled') throw new Error('It’s over already.');
  for (const e of t.entries) {
    const m = club.members[e.member];
    if (m) refund(club, t, m, now);
  }
  t.status = 'cancelled';
  t.why = why;
  t.endedAt = now;
  return t;
}

export function startTourney(club, tid, now = Date.now()) {
  const t = get(club, tid);
  if (t.status !== 'scheduled') throw new Error('It isn’t waiting to start.');
  t.status = 'running';
  t.startedAt = now;
  return t;
}

// ---- payouts (#79) ----

// How many places the defaults pay for `entries` entries: about the top 15%.
export function paidPlaces(entries) {
  if (entries <= 3) return 1;
  if (entries <= 6) return 2;
  if (entries <= 10) return 3;
  return Math.ceil(entries * 0.15);
}

// The default shares for `entries` entries, in basis points (1/100 of a
// percent) adding up to exactly 10 000: a standard falling curve, the
// rounding remainder to first place.
export function defaultPayout(entries) {
  const n = paidPlaces(Math.max(1, entries));
  const w = Array.from({length: n}, (_, i) => 1 / (i + 1) ** 1.2);
  const sum = w.reduce((a, b) => a + b, 0);
  const bp = w.map(x => Math.floor((x / sum) * 10000));
  bp[0] += 10000 - bp.reduce((a, b) => a + b, 0);
  return bp;
}

// The shares in force: the host's, or the defaults for the entries so far.
export const payoutShares = t => (t.payout?.places || defaultPayout(entryCount(t)));

// The prizes for the current pool, by place (index 0: first), adding up to
// exactly the pool; rounding remainders go to first place. No more places
// than entries: what places beyond them would get goes to first too.
export function prizes(t) {
  const total = pool(t);
  const shares = payoutShares(t).slice(0, Math.max(1, entryCount(t)));
  const out = shares.map(bp => Math.floor((total * bp) / 10000));
  out[0] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

// The host's own payouts: whole basis points per place that add up to
// exactly 10 000 (100%), or null to go back to the defaults.
export function setPayout(club, tid, places) {
  const t = get(club, tid);
  if (t.status === 'finished' || t.status === 'cancelled') throw new Error('It’s over already.');
  if (places == null) { t.payout = null; return t; }
  if (!Array.isArray(places) || !places.length || places.length > MAX_ENTRIES || !places.every(p => whole(p) && p > 0)) throw new Error('Each paid place needs a share above 0.');
  if (places.some((p, i) => i && p > places[i - 1])) throw new Error('A place can’t pay more than the one above it.');
  const sum = places.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new Error(`The payouts add up to ${(sum / 100).toFixed(2)}%, not 100%.`);
  t.payout = {places: places.slice()};
  return t;
}

// ---- results (#81) ----

// Entry `id` (a member) was knocked out, in `place` as things stand. Knockouts
// are numbered in the order they happen: entries registered late change the
// count, so final places are set at the finish (finishTourney).
export function knockedOut(club, tid, id, place) {
  const t = get(club, tid);
  const e = entryOf(t, id);
  if (e && e.place == null) {
    e.place = place;
    e.out = (t.outs = (t.outs || 0) + 1);
  }
  return e;
}

// The tournament has a winner: places are final, and the prizes go into
// winners' club balances. Returns [{member, place, amount}].
export function finishTourney(club, tid, winner, now = Date.now()) {
  const t = get(club, tid);
  if (t.status !== 'running') throw new Error('It isn’t running.');
  // Final places: the winner first, then everyone else in the reverse of
  // the order they went out, over all the entries (late ones too).
  const w = entryOf(t, winner);
  const gone = t.entries.filter(e => e !== w && e.out != null).sort((a, b) => a.out - b.out);
  gone.forEach((e, i) => { e.place = t.entries.length - i; });
  if (w) w.place = 1;
  const amounts = prizes(t);
  const paid = [];
  amounts.forEach((amount, i) => {
    const e = t.entries.find(x => x.place === i + 1);
    const m = e && club.members[e.member];
    if (!m || amount <= 0) return;
    m.balance += amount;
    record(club, m, 'tourney_prize', amount, now, t.id);
    paid.push({member: m.id, place: i + 1, amount});
  });
  // What was paid: what was held, and the added chips, issued now.
  const out = paid.reduce((s, p) => s + p.amount, 0);
  club.chips.issued += out - t.held;
  t.held = 0;
  t.status = 'finished';
  t.endedAt = now;
  t.paid = paid;
  return paid;
}

// What members see of the club's tournaments (the lobby), with how running
// ones are going (`live`: {[tid]: {level, playersLeft, ...}} from the host).
export function tourneysBody(club, live = {}, now = Date.now()) {
  return {
    type: 'tourneys', club: club.code,
    tourneys: visibleTourneys(club, now).map(t => {
      const names = id => club.members[id]?.name || '?';
      return {
        id: t.id, name: t.name, game: t.game, buyIn: t.buyIn, added: t.added, stack: t.stack,
        opensAt: t.opensAt, startsAt: t.startsAt, minPlayers: t.minPlayers, maxPlayers: t.maxPlayers, tableSize: t.tableSize,
        lateLevel: t.lateLevel, reentry: t.reentry, maxReentries: t.maxReentries, status: t.status, why: t.why || '',
        entries: entryCount(t), players: [...new Set(t.entries.map(e => e.member))].map(id => ({id, name: names(id)})),
        in: t.entries.filter(e => e.place == null).map(e => e.member),
        places: t.entries.filter(e => e.place != null).map(e => ({id: e.member, name: names(e.member), place: e.place})),
        pool: pool(t), prizes: prizes(t), structure: t.structure,
        ...(live[t.id] ? {live: live[t.id]} : {}),
      };
    }),
  };
}

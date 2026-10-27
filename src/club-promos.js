// High Hand promotions (#267): club chips paid for big hands, set up by the
// club's owner. Pure functions over the club object (club.js), like
// club-tourneys.js; the club server (club-server.js) calls them after every
// hand and when a period ends, so an always-on club pays out with no browser
// open.
//
// Two kinds of promotion:
// - 'high_hand': the best hand shown down in each game during a period (an
//   hour, a day, a week, or a session window) wins its prizes when the
//   period ends (#276).
// - 'bonus': a fixed prize for each qualifying hand, by tier (quads 10, a
//   straight flush 25…), each tier capped per period on its own (#277).
//
// Qualifying hands (#269): only hands shown down (a record never holds a
// mucked hand's cards), made with two of the player's own cards (both, in
// Hold'em; Omaha needs exactly two anyway) and three from the board; each
// board counts on its own when there are two. A hand also has to meet the
// promotion's conditions (players dealt in, pot, tables).
//
// Prizes are club chips the owner issues (ledger kind 'promo'), never taken
// from pots. A void reclaims them ('promo_void'). Chips have no cash value.
//
// club.promos = {
//   list:    [promo]                        the promotions, newest last
//   boards:  {key: [entry]}                 leaderboards of running periods
//   counts:  {key: n}                       bonus counts per tier / player
//   paid:    {key: chips}                   paid per promotion and period
//   awards:  [award]                        every prize, held or paid
//   history: [{promo, period, game, winners, top}]  finished periods
//   hands:   [record]                       recent qualifying hands (#269)
// }

import { issue, MAX_CHIPS } from './club-chips.js';
import { GAMES } from './club-tables.js';
import { chipText } from './chip-format.js';

// ---- hands ----

export const CATEGORIES = ['high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush', 'royal_flush'];
export const CATEGORY_NAMES = {
  high_card: 'High card', pair: 'Pair', two_pair: 'Two pair', trips: 'Three of a kind', straight: 'A straight', flush: 'A flush',
  full_house: 'A full house', quads: 'Four of a kind', straight_flush: 'A straight flush', royal_flush: 'A royal flush',
};
const RANKS = '23456789TJQKA';
const RANK_WORDS = ['twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
const RANK_ONE = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];

const parse = c => {
  const s = String(c);
  const r = RANKS.indexOf(s.length === 3 && s.startsWith('10') ? 'T' : s[0].toUpperCase());
  return r < 0 ? null : {r, s: s.at(-1).toLowerCase(), text: s};
};

// A five-card hand's score (higher is better; comparable across any five
// cards) and category index (CATEGORIES).
export function score5(cards) {
  const cs = cards.map(parse);
  const counts = new Map();
  for (const c of cs) counts.set(c.r, (counts.get(c.r) || 0) + 1);
  // Ranks by how many of each, then by rank: [[count, rank], …].
  const groups = [...counts].map(([r, n]) => [n, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const flush = cs.every(c => c.s === cs[0].s);
  const uniq = [...counts.keys()].sort((a, b) => b - a);
  let high = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) high = uniq[0];
    else if (uniq.join() === '12,3,2,1,0') high = 3; // the wheel, five-high
  }
  let cat;
  if (high >= 0 && flush) cat = high === 12 ? 9 : 8;
  else if (groups[0][0] === 4) cat = 7;
  else if (groups[0][0] === 3 && groups[1][0] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (high >= 0) cat = 4;
  else if (groups[0][0] === 3) cat = 3;
  else if (groups[0][0] === 2 && groups[1][0] === 2) cat = 2;
  else if (groups[0][0] === 2) cat = 1;
  else cat = 0;
  // A royal flush scores as the ace-high straight flush it is.
  const base = cat === 9 ? 8 : cat;
  const kick = high >= 0 ? [high] : groups.map(g => g[1]);
  let score = base;
  for (let i = 0; i < 5; i++) score = score * 13 + (kick[i] ?? 0);
  return {score, cat, groups, high};
}

function combos(arr, k) {
  const out = [];
  const go = (start, pick) => {
    if (pick.length === k) { out.push(pick); return; }
    for (let i = start; i < arr.length; i++) go(i + 1, [...pick, arr[i]]);
  };
  go(0, []);
  return out;
}

// The best five cards using exactly two of `hole` and three of `board`
// (both hole cards in Hold'em), or null when the board is short.
export function bestWithTwo(hole, board) {
  if (!hole || hole.length < 2 || !board || board.length < 3) return null;
  let best = null;
  for (const h of combos(hole, 2)) {
    for (const b of combos(board, 3)) {
      const five = [...h, ...b];
      const s = score5(five);
      if (!best || s.score > best.score) best = {...s, cards: five};
    }
  }
  return best;
}

// The hand in words: "Quad kings", "A royal flush", "A full house, aces full of tens".
export function handName({cat, groups, high}) {
  const name = CATEGORIES[cat];
  const g = i => groups?.[i]?.[1];
  if (name === 'royal_flush') return 'A royal flush';
  if (name === 'straight_flush') return `A straight flush, ${RANK_ONE[high]} high`;
  if (name === 'quads') return `Quad ${RANK_WORDS[g(0)]}`;
  if (name === 'full_house') return `A full house, ${RANK_WORDS[g(0)]} full of ${RANK_WORDS[g(1)]}`;
  if (name === 'flush') return `A flush, ${RANK_ONE[g(0)]} high`;
  if (name === 'straight') return `A straight, ${RANK_ONE[high]} high`;
  if (name === 'trips') return `Three ${RANK_WORDS[g(0)]}`;
  if (name === 'two_pair') return `Two pair, ${RANK_WORDS[g(0)]} and ${RANK_WORDS[g(1)]}`;
  if (name === 'pair') return `A pair of ${RANK_WORDS[g(0)]}`;
  return `${RANK_ONE[g(0)][0].toUpperCase()}${RANK_ONE[g(0)].slice(1)} high`;
}

// Every shown-down hand in a finished hand's record (hand-replay.js), with
// its best five using two hole cards, per board (#269). `players`: the
// table's [{seat, client_id}], to know who held each seat.
// Returns [{member, name, seat, board (1 or 2), score, cat, category,
// hand (its name), cards, hole}].
export function shownHands(rec, players = []) {
  if (!rec?.showdown) return [];
  const boards = [rec.board, ...(rec.board2?.length ? [rec.board2] : [])];
  const out = [];
  for (const s of rec.seats || []) {
    if (!s.inHand || s.folded || !Array.isArray(s.cards) || s.cards.length < 2 || s.cards.some(c => !parse(c))) continue;
    const member = players.find(p => Number(p.seat) === s.i)?.client_id;
    if (!member) continue;
    boards.forEach((board, b) => {
      const best = bestWithTwo(s.cards, board);
      if (best) out.push({member, name: s.name, seat: s.i, board: b + 1, score: best.score, cat: best.cat, category: CATEGORIES[best.cat], hand: handName(best), cards: best.cards, hole: s.cards});
    });
  }
  return out;
}

// ---- settings (#274) ----

export const MAX_PROMOS = 10;
export const MAX_PROMO_NAME = 40;
export const PERIODS = ['hour', 'day', 'week', 'session'];
export const VOID_MS = 24 * 3600e3;
const HISTORY_KEEP = 100, HANDS_KEEP = 200, AWARDS_KEEP = 500, BOARD_KEEP = 10;

const chips = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_CHIPS;
const whole = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

export function ensurePromos(club) {
  club.promos ??= {};
  const p = club.promos;
  p.list ??= [];
  p.boards ??= {};
  p.counts ??= {};
  p.paid ??= {};
  p.awards ??= [];
  p.history ??= [];
  p.hands ??= [];
  return p;
}

// Checks a promotion's settings; returns them clean, or throws what's wrong.
export function promoSettings(s = {}) {
  const kind = s.kind === 'bonus' ? 'bonus' : s.kind === 'high_hand' ? 'high_hand' : null;
  if (!kind) throw new Error('Pick a kind of promotion.');
  const name = String(s.name ?? '').trim().slice(0, MAX_PROMO_NAME) || (kind === 'bonus' ? 'Hand bonuses' : 'High hand');
  const games = [...new Set(Array.isArray(s.games) ? s.games : [])].filter(g => GAMES.some(x => x.id === g));
  if (!games.length) throw new Error('Pick at least one game.');
  const every = PERIODS.includes(s.every) ? s.every : null;
  if (!every) throw new Error('Pick a period.');
  // The manager's time zone, as minutes to add to UTC (e.g. -300 in New York in winter).
  const tz = whole(s.tz ?? 0, -14 * 60, 14 * 60) ? s.tz ?? 0 : 0;
  const out = {kind, name, games, every, tz};
  if (every === 'session') {
    const days = [...new Set(Array.isArray(s.days) ? s.days : [])].filter(d => whole(d, 0, 6)).sort();
    if (!days.length) throw new Error('Pick the days the session runs.');
    if (!whole(s.from, 0, 1439) || !whole(s.to, 1, 1440) || s.to <= s.from) throw new Error('The session must end after it starts, the same day.');
    Object.assign(out, {days, from: s.from, to: s.to});
  }
  if (kind === 'high_hand') {
    const prizes = (Array.isArray(s.prizes) ? s.prizes : []).filter(x => x !== null && x !== undefined && x !== '').slice(0, 3);
    if (!prizes.length || !prizes.every(x => chips(x)) || !prizes[0]) throw new Error('Give a prize for first place, in chips.');
    out.prizes = prizes;
    out.minCategory = CATEGORIES.includes(s.minCategory) ? s.minCategory : 'full_house';
    out.ties = s.ties === 'first' ? 'first' : 'split';
  } else {
    const tiers = (Array.isArray(s.tiers) ? s.tiers : []).filter(t => t && CATEGORIES.includes(t.category) && t.amount);
    if (!tiers.length) throw new Error('Add at least one bonus: a hand and its prize.');
    if (!tiers.every(t => chips(t.amount) && t.amount > 0)) throw new Error('Each bonus is a number of chips above 0.');
    if (new Set(tiers.map(t => t.category)).size !== tiers.length) throw new Error('Each hand can only have one bonus.');
    // Each tier's cap per period (0: none); `capPerTier`, one for them all,
    // fills in for a tier without its own.
    const cap = c => (whole(c ?? 0, 0, 1000) ? c ?? 0 : 0);
    out.tiers = tiers.map(t => ({category: t.category, amount: t.amount, cap: cap(t.cap ?? s.capPerTier)})).sort((a, b) => CATEGORIES.indexOf(b.category) - CATEGORIES.indexOf(a.category));
    out.capPerPlayer = whole(s.capPerPlayer ?? 0, 0, 1000) ? s.capPerPlayer ?? 0 : 0;
  }
  out.minPlayers = whole(s.minPlayers ?? 4, 2, 9) ? s.minPlayers ?? 4 : 4;
  out.minPot = chips(s.minPot ?? 0) ? s.minPot ?? 0 : 0;
  out.tables = (Array.isArray(s.tables) ? s.tables : []).map(String).slice(0, 50);
  // Whether tournament hands count too (#274); off unless the manager says so.
  out.tourneys = s.tourneys === true;
  out.budget = chips(s.budget ?? 0) ? s.budget ?? 0 : 0;
  out.startsAt = whole(s.startsAt ?? 0, 0, 1e14) ? s.startsAt ?? 0 : 0;
  out.endsAt = whole(s.endsAt ?? 0, 0, 1e14) ? s.endsAt ?? 0 : 0;
  if (out.endsAt && out.endsAt <= out.startsAt) throw new Error('It must end after it starts.');
  return out;
}

// A new promotion; throws why the settings won't do.
export function newPromo(club, s, now = Date.now()) {
  const p = ensurePromos(club);
  if (p.list.filter(x => x.status !== 'ended').length >= MAX_PROMOS) throw new Error(`A club can run ${MAX_PROMOS} promotions at once.`);
  const promo = {id: Math.random().toString(36).slice(2, 8), ...promoSettings(s), status: 'running', createdAt: now, next: null};
  p.list.push(promo);
  return promo;
}

export const promoById = (club, id) => ensurePromos(club).list.find(x => x.id === id) || null;

// Changes take effect from the next period: a running period keeps its rules.
export function editPromo(club, id, s, now = Date.now()) {
  const promo = promoById(club, id);
  if (!promo || promo.status === 'ended') throw new Error('No such promotion.');
  const clean = promoSettings({...s, kind: promo.kind});
  const cur = periodOf(promo, now);
  const started = cur && Object.keys(ensurePromos(club).boards).some(k => k.startsWith(`${id}|${cur.key}|`))
    || cur && Object.keys(club.promos.counts).some(k => k.startsWith(`${id}|${cur.key}|`));
  if (started) promo.next = clean;
  else Object.assign(promo, clean, {next: null});
  return promo;
}

export function setPromoStatus(club, id, status) {
  const promo = promoById(club, id);
  if (!promo) throw new Error('No such promotion.');
  if (!['running', 'paused', 'ended'].includes(status)) throw new Error('Not a promotion state.');
  if (promo.status === 'ended') throw new Error('That promotion has ended.');
  promo.status = status;
  return promo;
}

// ---- periods ----

const H = 3600e3, D = 24 * H;

// The period `promo` is in at `t`: {key, start, end}, or null when it isn't
// running then (a session's off hours, before it starts or after it ends).
export function periodOf(promo, t) {
  if (promo.startsAt && t < promo.startsAt) return null;
  if (promo.endsAt && t >= promo.endsAt) return null;
  const off = (promo.tz || 0) * 60e3;
  const local = t + off;
  const dayStart = Math.floor(local / D) * D;
  let start, end;
  if (promo.every === 'hour') { start = Math.floor(local / H) * H; end = start + H; }
  else if (promo.every === 'day') { start = dayStart; end = start + D; }
  else if (promo.every === 'week') {
    // Weeks start on Monday (1970-01-01 was a Thursday).
    const dow = (Math.floor(local / D) + 3) % 7;
    start = dayStart - dow * D; end = start + 7 * D;
  } else {
    const weekday = (Math.floor(local / D) + 4) % 7; // 0 Sunday
    const mins = (local - dayStart) / 60e3;
    if (!promo.days.includes(weekday) || mins < promo.from || mins >= promo.to) return null;
    start = dayStart + promo.from * 60e3; end = dayStart + promo.to * 60e3;
  }
  start -= off; end -= off;
  if (promo.endsAt) end = Math.min(end, promo.endsAt);
  return {key: String(start), start, end};
}

// ---- after each hand ----

const tierFor = (promo, cat) => promo.tiers.find(t => CATEGORIES.indexOf(t.category) <= cat) || null;
// A tier's cap per period, 0 for none; a promotion from before tiers had
// their own keeps its one for all.
export const tierCap = (promo, t) => t.cap ?? promo.capPerTier ?? 0;

// Why a hand can't count for `promo` ('' when it can): its conditions.
function ineligible(promo, rec, game, players) {
  if (rec.tourney && !promo.tourneys) return 'tournament hand';
  if (!promo.games.includes(game)) return 'game';
  if (promo.tables.length && !promo.tables.includes(rec.table)) return 'table';
  if (players < promo.minPlayers) return `fewer than ${promo.minPlayers} players`;
  if (rec.pot < promo.minPot) return 'pot too small';
  return '';
}

// Pays `amount` to `member` for `promo`, inside its budget for the period;
// returns the award, or null when the budget is spent. `held`: over the
// budget, keep it for the manager to approve instead; `offer`: always keep
// it for the manager.
function award(club, promo, period, {member, amount, rec, hand, kind, place = 0, game}, now, {held = false, offer = false} = {}) {
  const p = club.promos;
  const pk = `${promo.id}|${period.key}`;
  const over = offer || (promo.budget && (p.paid[pk] || 0) + amount > promo.budget);
  if (over && !held && !offer) return null;
  const a = {
    id: Math.random().toString(36).slice(2, 10), promo: promo.id, promoName: promo.name, kind, period: period.key,
    member, name: club.members[member]?.name || member, amount, hand: rec?.id || hand?.handId || null, table: rec?.table || hand?.table || null,
    game, category: hand.category, handName: hand.hand, cards: hand.cards, place, at: now, status: over ? 'held' : 'paid', entry: null,
  };
  if (!over) payAward(club, a, now);
  p.awards.push(a);
  if (p.awards.length > AWARDS_KEEP) p.awards.splice(0, p.awards.length - AWARDS_KEEP);
  return a;
}

function payAward(club, a, now) {
  const p = club.promos;
  const e = issue(club, a.member, a.amount, now, `${a.promoName}: ${a.handName}`, 'promo');
  e.promo = a.promo;
  if (a.hand) e.hand = a.hand;
  a.entry = e.n;
  a.status = 'paid';
  a.paidAt = now;
  const pk = `${a.promo}|${a.period}`;
  p.paid[pk] = (p.paid[pk] || 0) + a.amount;
}

// A finished hand (#269): records its qualifying hands, pays bonuses (#277)
// and updates the high-hand leaderboards (#276). `players`: the table's
// [{seat, client_id}]. Returns {paid: [award], leads: [{promo, game, hand}],
// budget: [promo names whose budget stopped a payout]}.
export function processHand(club, rec, players, now = rec?.at ?? Date.now()) {
  const p = ensurePromos(club);
  const out = {paid: [], leads: [], budget: []};
  // A hand counts once, even if its table reports it again (a host that
  // restarted). `sub`: a tournament's own table, whose hand numbers are its own.
  const key = `${rec?.table}|${rec?.sub ?? ''}|${rec?.hand}`;
  p.seen ??= [];
  if (rec?.hand && p.seen.includes(key)) return out;
  const shown = shownHands(rec, players);
  if (!shown.length) return out;
  p.seen.push(key);
  if (p.seen.length > 400) p.seen.splice(0, p.seen.length - 400);
  const game = rec.game || 'nlhe';
  const dealt = (rec.seats || []).filter(s => s.inHand).length;
  for (const promo of p.list) {
    if (promo.status !== 'running') continue;
    const period = periodOf(promo, rec.at);
    if (!period) continue;
    const why = ineligible(promo, rec, game, dealt);
    if (promo.kind === 'bonus') {
      // Each member's best across the boards, paid once at its highest tier.
      const best = new Map();
      for (const h of shown) if (!best.has(h.member) || h.score > best.get(h.member).score) best.set(h.member, h);
      for (const h of best.values()) {
        const tier = tierFor(promo, h.cat);
        if (!tier) continue;
        record(p, rec, h, game, promo, why);
        if (why) continue;
        const tk = `${promo.id}|${period.key}|tier:${tier.category}`, mk = `${promo.id}|${period.key}|p:${h.member}`;
        if (tierCap(promo, tier) && (p.counts[tk] || 0) >= tierCap(promo, tier)) continue;
        if (promo.capPerPlayer && (p.counts[mk] || 0) >= promo.capPerPlayer) continue;
        const a = award(club, promo, period, {member: h.member, amount: tier.amount, rec, hand: h, kind: 'bonus', game}, now);
        if (!a) { out.budget.push(promo.name); continue; }
        p.counts[tk] = (p.counts[tk] || 0) + 1;
        p.counts[mk] = (p.counts[mk] || 0) + 1;
        out.paid.push(a);
      }
    } else {
      const min = CATEGORIES.indexOf(promo.minCategory);
      for (const h of shown) {
        if (h.cat < min) continue;
        record(p, rec, h, game, promo, why);
        if (why) continue;
        const key = `${promo.id}|${period.key}|${game}`;
        const board = (p.boards[key] ||= []);
        const leader = board[0];
        board.push({member: h.member, name: club.members[h.member]?.name || h.name, score: h.score, category: h.category, hand: h.hand, cards: h.cards, handId: rec.id, table: rec.table, at: rec.at});
        board.sort((a, b) => b.score - a.score || a.at - b.at);
        board.splice(BOARD_KEEP);
        if (board[0].handId === rec.id && board[0].member === h.member && (!leader || leader.score < h.score)) out.leads.push({promo: promo.name, game, hand: board[0]});
      }
    }
  }
  return out;
}

function record(p, rec, h, game, promo, why) {
  p.hands.push({hand: rec.id, table: rec.table, game, member: h.member, name: h.name, category: h.category, handName: h.hand, cards: h.cards, board: h.board, at: rec.at, players: (rec.seats || []).filter(s => s.inHand).length, pot: rec.pot, promo: promo.id, ineligible: why});
  if (p.hands.length > HANDS_KEEP) p.hands.splice(0, p.hands.length - HANDS_KEEP);
}

// ---- when periods end (#276, #277) ----

// Pays the high hands of every period that has ended by `now`, starts the
// promotions' pending changes, and drops counters of past periods. Returns
// [award] paid or held.
export function settlePeriods(club, now = Date.now()) {
  const p = ensurePromos(club);
  const out = [];
  for (const key of Object.keys(p.boards)) {
    const [id, start, game] = key.split('|');
    const promo = promoById(club, id);
    const period = promo ? {key: start, ...periodBounds(promo, Number(start))} : null;
    if (period && period.end > now) continue;
    const board = p.boards[key];
    delete p.boards[key];
    if (!promo || !board.length) continue;
    const winners = placeWinners(promo, board);
    const paid = winners.map(w => award(club, promo, period, {member: w.member, amount: w.amount, hand: w, kind: 'high_hand', place: w.place, game}, now, {held: true}));
    out.push(...paid);
    p.history.push({promo: id, promoName: promo.name, period: start, start: period.start, end: period.end, game, winners: paid.map(a => a.id), top: board});
    if (p.history.length > HISTORY_KEEP) p.history.splice(0, p.history.length - HISTORY_KEEP);
  }
  for (const promo of p.list) {
    const cur = periodOf(promo, now);
    if (promo.next && !hasActivity(p, promo, cur)) { Object.assign(promo, promo.next); promo.next = null; }
    if (promo.status !== 'ended' && promo.endsAt && now >= promo.endsAt && !Object.keys(p.boards).some(k => k.startsWith(`${promo.id}|`))) promo.status = 'ended';
  }
  // Counters and budgets of periods that are over.
  for (const bag of [p.counts, p.paid]) {
    for (const k of Object.keys(bag)) {
      const [id, start] = k.split('|');
      const promo = promoById(club, id);
      if (!promo || periodBounds(promo, Number(start)).end <= now) delete bag[k];
    }
  }
  return out;
}

const hasActivity = (p, promo, cur) => !!cur && [...Object.keys(p.boards), ...Object.keys(p.counts)].some(k => k.startsWith(`${promo.id}|${cur.key}|`));

// The period starting at `start` for `promo`: {start, end}.
function periodBounds(promo, start) {
  const len = promo.every === 'hour' ? H : promo.every === 'day' ? D : promo.every === 'week' ? 7 * D : (promo.to - promo.from) * 60e3;
  const end = start + len;
  return {start, end: promo.endsAt ? Math.min(end, promo.endsAt) : end};
}

// The prizes by place, ties split equally or to the first to make it.
function placeWinners(promo, board) {
  const out = [];
  let place = 0;
  for (let i = 0; i < board.length && place < promo.prizes.length;) {
    const tied = board.filter(b => b.score === board[i].score);
    const span = promo.prizes.slice(place, place + tied.length);
    if (promo.ties === 'first' || tied.length === 1) {
      tied.slice(0, span.length).forEach((t, j) => { if (span[j]) out.push({...t, amount: span[j], place: place + j + 1}); });
    } else {
      const pot = span.reduce((s, x) => s + x, 0);
      tied.forEach((t, j) => {
        // Hundredths left over go to the first to make it.
        const amount = Math.floor(pot / tied.length) + (j < pot % tied.length ? 1 : 0);
        if (amount) out.push({...t, amount, place: place + 1});
      });
    }
    place += tied.length;
    i += tied.length;
  }
  return out;
}

// The soonest time a period with something to settle ends, or null.
export function nextSettle(club) {
  const p = ensurePromos(club);
  let next = null;
  for (const key of Object.keys(p.boards)) {
    const [id, start] = key.split('|');
    const promo = promoById(club, id);
    if (!promo) continue;
    const end = periodBounds(promo, Number(start)).end;
    if (next === null || end < next) next = end;
  }
  return next;
}

// ---- the manager's (#276, #277) ----

// Approves an award held for being over the budget: it's paid now.
export function approveAward(club, id, now = Date.now()) {
  const a = ensurePromos(club).awards.find(x => x.id === id);
  if (!a || a.status !== 'held') throw new Error('No such award waiting.');
  if (!club.members[a.member] || club.members[a.member].status !== 'member') throw new Error(`${a.name} isn’t a member any more.`);
  payAward(club, a, now);
  return a;
}

// Voids an award (paid within VOID_MS, or held): its chips are taken back.
// For a high hand, the next best hand of that period is offered instead,
// held for the manager to approve. Returns {award, offered}.
export function voidAward(club, id, now = Date.now(), why = '') {
  const p = ensurePromos(club);
  const a = p.awards.find(x => x.id === id);
  if (!a || a.status === 'void') throw new Error('No such award.');
  if (a.status === 'paid' && now - (a.paidAt || a.at) > VOID_MS) throw new Error('Awards can only be voided within 24 hours.');
  if (a.status === 'paid') {
    const m = club.members[a.member];
    if (!m || m.balance < a.amount) throw new Error(`${a.name} has only ${chipText(m?.balance || 0)} chips in the club now; take what’s left from their balance first, or leave the award.`);
    m.balance -= a.amount;
    club.chips.reclaimed += a.amount;
    const e = {n: club.chips.next++, at: now, kind: 'promo_void', member: m.id, amount: a.amount, balance: m.balance, promo: a.promo, note: `Voided: ${a.promoName}${why ? `, ${String(why).slice(0, 60)}` : ''}`};
    if (a.hand) e.hand = a.hand;
    club.chips.ledger.push(e);
    const pk = `${a.promo}|${a.period}`;
    if (p.paid[pk]) p.paid[pk] = Math.max(0, p.paid[pk] - a.amount);
  }
  a.status = 'void';
  a.voidedAt = now;
  let offered = null;
  if (a.kind === 'high_hand') {
    const h = p.history.find(x => x.promo === a.promo && x.period === a.period && x.winners.includes(a.id));
    const promo = promoById(club, a.promo);
    const taken = new Set(p.awards.filter(x => x.promo === a.promo && x.period === a.period && x.status !== 'void').map(x => x.hand + x.member));
    const next = h?.top.find(t => t.member !== a.member && !taken.has(t.handId + t.member));
    if (next && promo) {
      const period = {key: a.period, ...periodBounds(promo, Number(a.period))};
      // Offered, not paid: the manager approves it.
      offered = award(club, promo, period, {member: next.member, amount: a.amount, hand: next, kind: 'high_hand', place: a.place, game: h.game}, now, {offer: true});
      h.winners.push(offered.id);
    }
  }
  return {award: a, offered};
}

// ---- what members see (#278) ----

const gameName = id => GAMES.find(g => g.id === id)?.label || id;
const EVERY = {hour: 'each hour', day: 'each day', week: 'each week'};

// A promotion's rules in a sentence.
export function promoRules(promo) {
  return rulesCore(promo) + (promo.tourneys ? ' Tournament hands count too.' : '');
}

function rulesCore(promo) {
  const when = promo.every === 'session' ? 'each session' : EVERY[promo.every];
  const games = promo.games.map(gameName).join(', ');
  if (promo.kind === 'high_hand') {
    const prizes = promo.prizes.map(chipText);
    const places = prizes.length === 1 ? `wins ${prizes[0]}` : `pays ${prizes.join(' / ')} for 1st${prizes.length > 2 ? ', 2nd and 3rd' : ' and 2nd'}`;
    return `Best ${games} hand ${when} ${places} (${CATEGORY_NAMES[promo.minCategory].replace(/^An? /, '').toLowerCase()} or better).`;
  }
  const per = {hour: 'an hour', day: 'a day', week: 'a week', session: 'a session'}[promo.every];
  const tiers = promo.tiers.map(t => `${CATEGORY_NAMES[t.category].replace(/^An? /, '').toLowerCase()} ${chipText(t.amount)}${tierCap(promo, t) ? ` (up to ${tierCap(promo, t)} ${per})` : ''}`).join(', ');
  return `${games}: ${tiers}${promo.capPerPlayer ? `, ${promo.capPerPlayer} per player` : ''}.`;
}

// Everything members are told about the promotions: running ones with
// their leaderboards and caps used, and recent awards.
export function promosBody(club, now = Date.now()) {
  const p = ensurePromos(club);
  const promos = p.list.filter(x => x.status !== 'ended').map(promo => {
    const period = periodOf(promo, now);
    const view = {id: promo.id, name: promo.name, kind: promo.kind, status: promo.status, rules: promoRules(promo), games: promo.games,
      period: period ? {start: period.start, end: period.end} : null, minPlayers: promo.minPlayers, tables: promo.tables, tourneys: promo.tourneys};
    if (promo.kind === 'high_hand') {
      view.leaders = Object.fromEntries(promo.games.map(g => [g, (period && p.boards[`${promo.id}|${period.key}|${g}`] || []).slice(0, 3)
        .map(b => ({name: b.name, hand: b.hand, cards: b.cards, at: b.at}))]));
    } else {
      view.caps = promo.tiers.map(t => ({category: t.category, amount: t.amount, used: period ? p.counts[`${promo.id}|${period.key}|tier:${t.category}`] || 0 : 0, cap: tierCap(promo, t)}));
    }
    return view;
  });
  const recent = p.awards.filter(a => a.status === 'paid').slice(-10).reverse()
    .map(a => ({id: a.id, promo: a.promoName, name: a.name, hand: a.handName, cards: a.cards, amount: a.amount, at: a.paidAt || a.at, member: a.member}));
  return {type: 'promos', club: club.code, promos, recent};
}

// The manager's view: everything, with awards and budgets.
export function promosAdmin(club, now = Date.now()) {
  const p = ensurePromos(club);
  return {
    list: p.list.map(promo => {
      const period = periodOf(promo, now);
      return {...promo, rules: promoRules(promo), period, paid: period ? p.paid[`${promo.id}|${period.key}`] || 0 : 0,
        leaders: promo.kind === 'high_hand' && period ? Object.fromEntries(promo.games.map(g => [g, (p.boards[`${promo.id}|${period.key}|${g}`] || []).slice(0, 3)])) : null,
        caps: promo.kind === 'bonus' && period ? promo.tiers.map(t => ({...t, cap: tierCap(promo, t), used: p.counts[`${promo.id}|${period.key}|tier:${t.category}`] || 0})) : null};
    }),
    awards: p.awards.slice(-50).reverse(),
    hands: p.hands.slice(-30).reverse(),
  };
}

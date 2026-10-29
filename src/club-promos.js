// High Hand promotions (#267): club chips paid for big hands, set up by the
// club's owner. ducy-play's club_promos (clubPromos, from ducy-wasm, #457)
// runs the rules; the club server (club-server.js) calls them after every
// hand and when a period ends, so an always-on club pays out with no browser
// open. Here the chips move.
//
// Two kinds of promotion:
// - 'high_hand': the best hand shown down in each game during a period (an
//   hour, a day, a week, or a session window) wins its prize when the
//   period ends (#276). With rollover, a period played without a
//   qualifying hand adds its prize to the next.
// Any promotion can be on only at set hours on set days.
// - 'bonus': a fixed prize for each qualifying hand, by tier (quads 10, a
//   straight flush 25…), each tier capped per period on its own (#277).
//
// Qualifying hands (#269): only hands shown down (a record never holds a
// mucked hand's cards), made with two of the player's own cards and three
// from the board; each board counts on its own when there are two. A hand
// also has to meet the promotion's conditions (players dealt in, pot, tables).
//
// Prizes are club chips the owner issues (ledger kind 'prize', about the
// promotion; the award keeps its entry's number), never taken from pots. A
// void takes them back ('void', the award's voidEntry). Chips have no cash
// value.
//
// club.promos = {list, boards, counts, paid, awards, played, carry,
// history, hands, seen} (ducy_play::club_promos::PromoState).
//
// Needs ducy's wasm loaded (the relay, the host's page, tests: ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';
import { payTo, voidPrize } from './club-chips.js';

export const CATEGORIES = ['high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush', 'royal_flush'];
export const CATEGORY_NAMES = {
  high_card: 'High card', pair: 'Pair', two_pair: 'Two pair', trips: 'Three of a kind', straight: 'A straight', flush: 'A flush',
  full_house: 'A full house', quads: 'Four of a kind', straight_flush: 'A straight flush', royal_flush: 'A royal flush',
};
export const MAX_PROMOS = 10;
export const MAX_PROMO_NAME = 40;
export const PERIODS = ['hour', 'day', 'week', 'session'];
export const VOID_MS = 24 * 3600e3;

const plain = v => v && typeof v === 'object' && !Array.isArray(v);

// `to` made like `from`, keeping `to`'s objects where both have one.
function merge(to, from) {
  for (const k of Object.keys(to)) if (!(k in from)) delete to[k];
  for (const [k, v] of Object.entries(from)) to[k] = plain(to[k]) && plain(v) ? merge(to[k], v) : v;
  return to;
}

// Each of `from` made like the same id's in `list`, keeping the objects.
const byId = (list, from) => {
  const had = new Map((list || []).map(x => [x.id, x]));
  return from.map(x => (had.has(x.id) ? merge(had.get(x.id), x) : x));
};

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

// Runs `op` on the club's promotions; returns its value. A promotion or
// award someone holds stays the one in the club. Throws why, if refused.
function rules(club, op, now = Date.now()) {
  const part = {code: club.code, members: club.members || {}, promos: club.promos || {}};
  const r = ducy.clubPromos(JSON.stringify(part), op, now);
  if (!r.ok) throw new Error(r.message);
  if (r.club) {
    const p = ensurePromos(club);
    const {list, awards, ...rest} = r.club.promos;
    const keep = {list: byId(p.list, list), awards: byId(p.awards, awards)};
    merge(p, {...rest, list: [], awards: []});
    Object.assign(p, keep);
  }
  return r.value;
}

// A rule that reads only what it's given.
const ask = (op, now = Date.now()) => rules({}, op, now);

export const promoById = (club, id) => ensurePromos(club).list.find(x => x.id === id) || null;
const awardById = (club, id) => ensurePromos(club).awards.find(x => x.id === id) || null;

// Pays the awards the rules marked paid, down each winner's path, as the
// club's prize (#454); returns the club's own award objects.
function payAwards(club, list, now) {
  return list.map(x => {
    const a = awardById(club, x.id) || x;
    if (a.status === 'paid' && a.entry == null) {
      a.entry = payTo(club, a.member, 'prize', a.amount, a.promo, now).n;
      club.chips.issued += a.amount;
    }
    return a;
  });
}

// ---- hands ----

// A five-card hand's score (higher is better; comparable across any five
// cards) and category index (CATEGORIES): {score, cat, groups, high}.
export const score5 = cards => ask({op: 'score5', cards});

// The best five cards using exactly two of `hole` and three of `board`
// (both hole cards in Hold'em), or null when the board is short.
export const bestWithTwo = (hole, board) => (hole && board ? ask({op: 'bestWithTwo', hole, board}) : null);

// The hand in words: "Quad kings", "A royal flush", "A full house, aces full of tens".
export const handName = ({cat, groups, high}) => ask({op: 'handName', cat, groups: groups || [], high: high ?? -1});

// Every shown-down hand in a finished hand's record (hand-replay.js), with
// its best five using two hole cards, per board (#269). `players`: the
// table's [{seat, client_id}]. Returns [{member, name, seat, board (1 or 2),
// score, cat, category, hand (its name), cards, hole}].
export const shownHands = (rec, players = []) => (rec ? ask({op: 'shownHands', rec, players}) : []);

// ---- settings (#274) ----

// A tier's cap per period, 0 for none; a promotion from before tiers had
// their own keeps its one for all.
export const tierCap = (promo, t) => t.cap ?? promo.capPerTier ?? 0;

// A new promotion; throws why the settings won't do.
export function newPromo(club, s, now = Date.now()) {
  return promoById(club, rules(club, {op: 'new', s: s ?? {}}, now).id);
}

// Changes take effect from the next period: a running period keeps its rules.
export function editPromo(club, id, s, now = Date.now()) {
  rules(club, {op: 'edit', id, s: s ?? {}}, now);
  return promoById(club, id);
}

export function setPromoStatus(club, id, status) {
  rules(club, {op: 'setStatus', id, status: String(status)});
  return promoById(club, id);
}

// ---- periods ----

// The period `promo` is in at `t`: {key, start, end}, or null when it isn't
// running then (a session's off hours, before it starts or after it ends).
export const periodOf = (promo, t) => ask({op: 'periodOf', promo, t});

// ---- after each hand, and when periods end ----

// A finished hand (#269): records its qualifying hands, pays bonuses (#277)
// and updates the high-hand leaderboards (#276). `players`: the table's
// [{seat, client_id}]. Returns {paid: [award], leads: [{promo, game, hand}],
// budget: [promo names whose budget stopped a payout]}.
export function processHand(club, rec, players, now = rec?.at ?? Date.now()) {
  ensurePromos(club);
  if (!rec) return {paid: [], leads: [], budget: []};
  const out = rules(club, {op: 'processHand', rec, players: players || []}, now);
  out.paid = payAwards(club, out.paid, now);
  return out;
}

// Pays the high hands of every period that has ended by `now`, starts the
// promotions' pending changes, and drops counters of past periods. Returns
// [award] paid or held.
export function settlePeriods(club, now = Date.now()) {
  ensurePromos(club);
  return payAwards(club, rules(club, {op: 'settle'}, now), now);
}

// The soonest time a period with something to settle ends, or null.
export const nextSettle = club => rules(club, {op: 'nextSettle'});

// ---- the manager's (#276, #277) ----

// Approves an award held for being over the budget: it's paid now.
export function approveAward(club, id, now = Date.now()) {
  return payAwards(club, [rules(club, {op: 'approve', id}, now)], now)[0];
}

// Voids an award (paid within VOID_MS, or held): its chips are taken back.
// For a high hand, the next best hand of that period is offered instead,
// held for the manager to approve. Returns {award, offered}.
export function voidAward(club, id, now = Date.now(), why = '') {
  const v = rules(club, {op: 'void', id, why: String(why ?? '')}, now);
  const a = awardById(club, v.award.id) || v.award;
  // Back up the path it came down (#454).
  if (v.take) a.voidEntry = voidPrize(club, a.member, v.take, a.promo, now).n;
  return {award: a, offered: v.offered ? awardById(club, v.offered.id) || v.offered : null};
}

// ---- what members see (#278) ----

// A promotion's rules in a sentence.
export const promoRules = promo => ask({op: 'rules', promo});

// Everything members are told about the promotions: running ones with
// their leaderboards and caps used, and recent awards.
export const promosBody = (club, now = Date.now()) => rules(club, {op: 'body'}, now);

// The manager's view: everything, with awards and budgets.
export const promosAdmin = (club, now = Date.now()) => rules(club, {op: 'admin'}, now);

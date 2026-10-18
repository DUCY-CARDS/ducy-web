// Bankroll Challenge scenarios (#365): things that happen around the poker.
// This file is the shared machinery (#355): an inbox of offers and news, a
// ledger of the money that changes hands, and what you know about the people
// involved; and the first scenario, staking players.
//
// Staking players: a generic player you've sat with (never a Regular) asks
// you to back them for a game week. They have two hidden traits, leaning their
// outcome but never deciding it:
// - **skill**, from their style (grinders best, rocks steady, calling
//   stations and maniacs worst) and their own noise, as bb/100;
// - **honesty**, regs leaning honest and tourists less so, with their own noise.
// About a game week later the stake comes back: busted, some of it, a small
// or a big win, or nothing at all (they won and stiffed you). Someone who
// stiffed you may turn up at your table again, and you can confront them.
//
// Pure, and repeatable: chances come from the world's seed (roll). Amounts
// are in hundredths, like the rest of the quest (100 is $1).

import { roll } from './quest-rooms.js';
import { personOf } from './quest-people.js';

const DAY = 1440;

// ---- Tuning: every amount, chance and time in one place ----
export const SCENARIOS = {
  stake: {
    // Chance that someone you played with asks, when you leave a table
    // (with someone eligible), and more often at low stakes or late at night.
    ask: 0.3,
    askLow: 1.5,
    askLate: 1.3,
    // Hands with you before they'd ask: you've seen them play.
    minHands: 12,
    // What they ask for, in their buy-ins (100 BB each) at the stakes you played.
    buyIns: [3, 5, 8, 10],
    // At most this share of your bankroll.
    maxShare: 0.3,
    // Your share of their profit.
    shares: [0.4, 0.5, 0.5, 0.6],
    // A game week, give or take two days.
    days: 7,
    spread: 2,
    // Hands they play in a game day, and how much results swing (bb/100 per 100 hands).
    handsPerDay: 220,
    sd: 95,
    // An offer you don't answer goes away after this many game hours.
    offerHours: 12,
    // A counter (more of the profit, or half the money): how often it's taken.
    counterTaken: 0.5,
  },
  confront: {
    // Paying up when confronted: at least this, more the more honest they are.
    payBase: 0.25,
    payHonest: 0.5,
  },
};

// Win rate in bb/100 by style, before each player's own noise.
const SKILL = {grinder: 6, rock: 1, station: -9, maniac: -12};
const SKILL_NOISE = 6;
// Honesty by kind (0 to 1), before each player's own noise.
const HONESTY = {reg: 0.75, tourist: 0.5};
const HONESTY_NOISE = 0.25;

/** A generic player's hidden win rate, bb/100 (same for the same id). */
export function skillOf(id) {
  const p = personOf(id);
  if (!p) return 0;
  return SKILL[p.family] + (roll(p.seed, 'skill') * 2 - 1) * SKILL_NOISE;
}

/** A generic player's hidden honesty, 0 to 1 (same for the same id and kind). */
export function honestyOf(id, reg) {
  const p = personOf(id);
  if (!p) return 0.5;
  return Math.max(0, Math.min(1, HONESTY[reg ? 'reg' : 'tourist'] + (roll(p.seed, 'honesty') * 2 - 1) * HONESTY_NOISE));
}

// ---- Inbox and ledger ----

/** Adds a message to the inbox: {kind, text, at, offer?}. */
export function post(q, msg) {
  const n = (q.inboxN || 0) + 1;
  const inbox = [{id: `m${n}`, read: false, ...msg}, ...(q.inbox || [])].slice(0, 60);
  return {...q, inbox, inboxN: n};
}

/** Marks every message read. */
export const markRead = q => ((q.inbox || []).some(m => !m.read) ? {...q, inbox: q.inbox.map(m => ({...m, read: true}))} : q);

/** Unread messages, and open offers waiting for an answer. */
export const unread = q => (q.inbox || []).filter(m => !m.read).length;
export const openOffers = (q, minutes) => (q.inbox || []).filter(m => m.offer && !m.offer.answered && m.offer.expires > minutes);

/** A ledger entry: money from (negative) or to (positive) the bankroll, by kind. */
export function book(q, entry) {
  return {...q, ledger: [...(q.ledger || []), entry].slice(-500)};
}

/** Staking's totals: {count, staked, returned, net, roi, outstanding}. */
export function stakingTotals(q) {
  const done = (q.stakes || []).filter(s => s.result);
  const staked = done.reduce((a, s) => a + s.amount, 0);
  const returned = done.reduce((a, s) => a + (s.returned || 0), 0);
  const out = (q.stakes || []).filter(s => !s.result).reduce((a, s) => a + s.amount, 0);
  return {count: done.length, staked, returned, net: returned - staked, roi: staked ? (returned - staked) / staked : null, outstanding: out};
}

// ---- Staking players ----

const buyInAt = stakes => 100 * stakes[1];
const late = minutes => { const h = Math.floor((minutes % DAY) / 60); return h >= 22 || h < 4; };

/**
 * Maybe someone you played with asks you to stake them, as you leave a
 * table. `people` [{id, hands}] the generic players this session, `stakes`
 * [sb, bb] where you played, `minutes` the game time, `isRegular(id)` whether
 * they're a room's reg, `n` a counter that makes each chance its own.
 * Returns the quest with the offer in the inbox, or unchanged.
 */
export function maybeAskStake(q, people, stakes, minutes, isRegular, n = 0) {
  const t = SCENARIOS.stake;
  const owed = new Set((q.stakes || []).filter(s => s.result === 'stiffed').map(s => s.id));
  const busy = new Set((q.stakes || []).filter(s => !s.result).map(s => s.id));
  const asked = new Set(openOffers(q, minutes).map(m => m.offer.id));
  const eligible = people.filter(p => p.hands >= t.minHands && personOf(p.id) && !owed.has(p.id) && !busy.has(p.id) && !asked.has(p.id));
  if (!eligible.length) return q;
  const low = stakes[1] <= 500;
  const chance = t.ask * (low ? t.askLow : 1) * (late(minutes) ? t.askLate : 1);
  if (roll(q.seed, 'stake-ask', minutes, n) >= chance) return q;
  const who = eligible[Math.floor(roll(q.seed, 'stake-who', minutes, n) * eligible.length)];
  // Someone who paid you well before asks for more.
  const paid = (q.stakes || []).filter(s => s.id === who.id && s.result && s.returned > s.amount).length;
  const buyIns = t.buyIns[Math.floor(roll(q.seed, 'stake-size', minutes, n) * t.buyIns.length)] + 2 * paid;
  const cap = Math.floor(q.bankroll * t.maxShare);
  const amount = Math.min(buyIns * buyInAt(stakes), cap);
  if (amount < buyInAt(stakes)) return q;
  const share = t.shares[Math.floor(roll(q.seed, 'stake-share', minutes, n) * t.shares.length)];
  const p = personOf(who.id);
  // A round sum: whole $50s.
  const offer = {kind: 'stake', id: who.id, stakes, amount: Math.max(5000, Math.round(amount / 5000) * 5000), share, reg: !!isRegular(who.id), expires: minutes + t.offerHours * 60, again: paid > 0};
  const text = `${p.name} catches you on your way out: “Could you stake me $${dollars(offer.amount)} for a week at ${stakes[0] / 100}/${stakes[1] / 100}? I’ll give you ${Math.round(share * 100)}% of what I win.”`;
  return post(q, {kind: 'stake-ask', at: minutes, text, offer});
}

const dollars = n => (n / 100).toLocaleString('en-US', {maximumFractionDigits: 0});

/** Half a stake, for a counter offer: whole $50s. */
export const halfOf = amount => Math.max(5000, Math.round(amount / 10000) * 5000);

/**
 * Answers a stake offer (message `msgId`): 'accept', 'decline', or a counter,
 * 'more' (a bigger share of the profit) or 'less' (half the money). Accepting
 * moves the money from the bankroll into the stake. Returns the new quest.
 */
export function answerStake(q, msgId, answer, minutes) {
  const msg = (q.inbox || []).find(m => m.id === msgId);
  const o = msg?.offer;
  if (!o || o.answered || o.expires <= minutes) return q;
  const t = SCENARIOS.stake;
  const name = personOf(o.id)?.name || 'They';
  let deal = {...o};
  let note;
  if (answer === 'decline') {
    note = `You passed on staking ${name}.`;
  } else {
    if (answer === 'more' || answer === 'less') {
      // A counter: they take it or walk.
      if (roll(q.seed, 'stake-counter', o.id, Math.floor(minutes)) >= t.counterTaken) {
        q = answered(q, msgId, 'walked');
        return post(q, {kind: 'stake-news', at: minutes, text: `${name} wouldn’t take that and found someone else.`});
      }
      deal = answer === 'more' ? {...deal, share: Math.min(0.8, deal.share + 0.15)} : {...deal, amount: halfOf(deal.amount)};
    }
    if (q.bankroll < deal.amount) return q;
    const end = minutes + (t.days + (roll(q.seed, 'stake-days', o.id, Math.floor(minutes)) * 2 - 1) * t.spread) * DAY;
    const stake = {id: o.id, stakes: o.stakes, amount: deal.amount, share: deal.share, reg: o.reg, start: minutes, end: Math.round(end), n: (q.stakes || []).length};
    q = {...q, bankroll: q.bankroll - deal.amount, stakes: [...(q.stakes || []), stake]};
    q = book(q, {at: minutes, kind: 'stake', amount: -deal.amount, id: o.id});
    note = `You staked ${name} $${dollars(deal.amount)} for ${Math.round(deal.share * 100)}% of the profit. You’ll hear back in about a week.`;
  }
  q = answered(q, msgId, answer);
  return post(q, {kind: 'stake-news', at: minutes, text: note});
}

const answered = (q, msgId, how) => ({...q, inbox: q.inbox.map(m => (m.id === msgId ? {...m, read: true, offer: {...m.offer, answered: how}} : m))});

/**
 * How a stake went, once its week is over: {result, returned, profit}.
 * result 'busted' (all lost), 'down' (some back), 'small' or 'big' (a win,
 * your share paid), 'stiffed' (they won and kept it all). Leans on the
 * player's skill and honesty; the swings are real.
 */
export function stakeOutcome(seed, stake) {
  const t = SCENARIOS.stake;
  const hands = Math.max(200, ((stake.end - stake.start) / DAY) * t.handsPerDay);
  const bb = stake.stakes[1];
  const mean = (skillOf(stake.id) * hands) / 100;
  const sd = (t.sd * Math.sqrt(hands / 100));
  // A normal draw from two seeded rolls (Box-Muller).
  const u1 = Math.max(1e-9, roll(seed, 'stake-run', stake.id, stake.n)), u2 = roll(seed, 'stake-run2', stake.id, stake.n);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const net = Math.round((mean + z * sd) * bb);
  const final = stake.amount + net;
  const honest = roll(seed, 'stake-honest', stake.id, stake.n) < honestyOf(stake.id, stake.reg);
  if (final <= stake.amount * 0.05) return {result: 'busted', returned: 0, profit: -stake.amount};
  if (final < stake.amount) return honest ? {result: 'down', returned: Math.round(final), profit: final - stake.amount} : {result: 'stiffed', returned: 0, profit: final - stake.amount};
  const profit = final - stake.amount;
  if (!honest) return {result: 'stiffed', returned: 0, profit};
  const returned = stake.amount + Math.round(profit * stake.share);
  return {result: profit >= stake.amount ? 'big' : 'small', returned, profit};
}

/** Settles every stake whose week is over by game time `minutes`. Returns the new quest. */
export function resolveStakes(q, minutes) {
  let changed = false;
  const stakes = (q.stakes || []).map(s => {
    if (s.result || s.end > minutes) return s;
    changed = true;
    return {...s, ...stakeOutcome(q.seed, s), settled: s.end};
  });
  if (!changed) return q;
  let out = {...q, stakes};
  for (const s of stakes) {
    if (!s.settled || (q.stakes || []).find(x => x.n === s.n)?.result) continue;
    const name = personOf(s.id)?.name || 'Someone you staked';
    const text = {
      busted: `${name} lost the whole $${dollars(s.amount)} you put up. That’s poker.`,
      down: `${name} had a losing week and handed back $${dollars(s.returned)} of your $${dollars(s.amount)}.`,
      small: `${name} won a little: you got your $${dollars(s.amount)} back plus $${dollars(s.returned - s.amount)}.`,
      big: `${name} had a great week and paid you $${dollars(s.returned)} on your $${dollars(s.amount)} stake.`,
      stiffed: `You haven’t heard from ${name} since you staked them $${dollars(s.amount)}. Word is they had a decent week.`,
    }[s.result];
    if (s.returned) out = {...out, bankroll: out.bankroll + s.returned};
    out = book(out, {at: s.settled, kind: 'stake-back', amount: s.returned || 0, id: s.id, result: s.result});
    out = post(out, {kind: 'stake-result', at: s.settled, text, result: s.result});
  }
  return out;
}

/** Stakes you were stiffed on by `id`, not yet settled: what they owe you. */
export function owedBy(q, id) {
  return (q.stakes || []).filter(s => s.id === id && s.result === 'stiffed' && !s.confronted)
    .reduce((a, s) => a + (s.profit > 0 ? s.amount + Math.round(s.profit * s.share) : Math.max(0, s.amount + s.profit)), 0);
}

/**
 * Confronts `id` (at your table, or just seen) about what they owe: they pay
 * it, or some of it, or nothing, leaning on their honesty. Returns the quest.
 */
export function confront(q, id, minutes) {
  const owed = owedBy(q, id);
  if (!owed) return q;
  const c = SCENARIOS.confront;
  const stake = q.stakes.find(s => s.id === id && s.result === 'stiffed' && !s.confronted);
  const chance = c.payBase + c.payHonest * honestyOf(id, stake.reg);
  const r = roll(q.seed, 'confront', id, Math.floor(minutes));
  const name = personOf(id)?.name || 'They';
  const paid = r < chance * 0.6 ? owed : r < chance ? Math.round(owed / 2 / 100) * 100 : 0;
  // What they pay is counted on the first stake they owe on; every one of them is settled.
  let out = {...q, bankroll: q.bankroll + paid, stakes: q.stakes.map(s => {
    if (s.id !== id || s.result !== 'stiffed' || s.confronted) return s;
    return {...s, confronted: true, returned: (s.returned || 0) + (s === stake ? paid : 0)};
  })};
  out = book(out, {at: minutes, kind: 'stake-back', amount: paid, id, result: 'confronted'});
  const text = paid === owed ? `You asked ${name} about the stake. Embarrassed, they paid the $${dollars(paid)} they owed.`
    : paid ? `You asked ${name} about the stake. They paid $${dollars(paid)} and promised the rest “soon”.`
    : `You asked ${name} about the stake. They shrugged and said they’d had a bad week. You won’t see that money.`;
  return post(out, {kind: 'stake-news', at: minutes, text});
}

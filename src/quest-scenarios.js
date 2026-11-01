// Bankroll Challenge scenarios (#365): things that happen around the poker.
// The shared machinery (#355): an inbox of offers and news, a ledger of the
// money that changes hands, and what you know about the people involved;
// and the first scenario, staking players.
//
// Staking players: a generic player you've sat with (never a Regular) asks
// you to back them for a game week. Their hidden skill and honesty lean the
// outcome but never decide it. About a game week later the stake comes back:
// busted, some of it, a small or a big win, or nothing at all (they won and
// stiffed you). Someone who stiffed you may turn up at your table again, and
// you can confront them.
//
// The rules live in ducy-quest (Rust, #466); these call its wasm build.
// Repeatable: chances come from the world's seed. Amounts are in hundredths.

import { quest as op } from '../wasm/ducy_wasm.js';

// ---- Tuning (ducy-quest's; a test checks the page's copy) ----
export const SCENARIOS = {
  stake: {
    ask: 0.3, askLow: 1.5, askLate: 1.3, minHands: 12, buyIns: [3, 5, 8, 10], maxShare: 0.3,
    shares: [0.4, 0.5, 0.5, 0.6], days: 7, spread: 2, handsPerDay: 220, sd: 95, offerHours: 12, counterTaken: 0.5,
  },
  confront: {payBase: 0.25, payHonest: 0.5},
};

/** A generic player's hidden win rate, bb/100 (same for the same id). */
export const skillOf = id => op({op: 'skillOf', id: String(id)});
/** A generic player's hidden honesty, 0 to 1 (same for the same id and kind). */
export const honestyOf = (id, reg) => op({op: 'honestyOf', id: String(id), reg: !!reg});

// ---- Inbox and ledger ----

/** Adds a message to the inbox: {kind, text, at, offer?}. */
export const post = (q, msg) => op({op: 'post', q, msg});
/** Marks every message read. */
export const markRead = q => (op({op: 'markRead', q}) ?? q);
/** Unread messages. */
export const unread = q => (q.inbox || []).filter(m => !m.read).length;
/** Open offers waiting for an answer. */
export const openOffers = (q, minutes) => op({op: 'openOffers', q, minutes});
/** A ledger entry: money from (negative) or to (positive) the bankroll, by kind. */
export const book = (q, entry) => ({...q, ledger: [...(q.ledger || []), entry].slice(-500)});
/** Staking's totals: {count, staked, returned, net, roi, outstanding}. */
export const stakingTotals = q => op({op: 'stakingTotals', q});

// ---- Staking players ----

/**
 * Maybe someone you played with asks you to stake them, as you leave a
 * table. `people` [{id, hands}] the generic players this session, `stakes`
 * [sb, bb] where you played, `minutes` the game time, `isRegular(id)` whether
 * they're a room's reg, `n` a counter that makes each chance its own.
 */
export function maybeAskStake(q, people, stakes, minutes, isRegular, n = 0) {
  const list = people.map(p => ({id: String(p.id), hands: p.hands || 0}));
  return (op({op: 'maybeAskStake', q, people: list, stakes, minutes, regulars: list.filter(p => isRegular(p.id)).map(p => p.id), n}) ?? q);
}

/** Half a stake, for a counter offer: whole $50s. */
export const halfOf = amount => Math.max(5000, Math.round(amount / 10000) * 5000);

/** Answers a stake offer (message `msgId`): 'accept', 'decline', 'more' (a bigger share) or 'less' (half the money). */
export const answerStake = (q, msgId, answer, minutes) => (op({op: 'answerStake', q, msgId, answer, minutes}) ?? q);
/** How a stake went, once its week is over: {result, returned, profit}. */
export const stakeOutcome = (seed, stake) => op({op: 'stakeOutcome', seed, stake});
/** Settles every stake whose week is over by game time `minutes`. */
export const resolveStakes = (q, minutes) => (op({op: 'resolveStakes', q, minutes}) ?? q);
/** What `id` owes you on stakes they stiffed you on, not yet confronted. */
export const owedBy = (q, id) => op({op: 'owedBy', q, id: String(id)});
/** Confronts `id` about what they owe: they pay it, some of it, or nothing. */
export const confront = (q, id, minutes) => (op({op: 'confront', q, id: String(id), minutes}) ?? q);

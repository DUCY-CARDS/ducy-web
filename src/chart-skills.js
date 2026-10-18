// Practising Ducybot's pre-flop ranges (#249, the training part of #248): a
// spot from his charts (charts/ducybot-*.json, the same files as #charts) is
// a skill, practised two ways:
//   fixed  - pick the action. A hand he plays one way has one right answer;
//            a hand he mixes accepts any action he takes often enough.
//   mixed  - set how often he takes each action, scored by how close the mix is.
// Pure functions, so they can be tested; trainer.js draws the screens.

import { cellHand, VERBS, sizedVerbs } from './charts.js';

// The Hold'em track: a table (heads-up or 6-max), then lessons in order, from
// opening ranges to the more advanced spots. A lesson with `soon` is shown
// but not practised yet: the six-handed solve facing a raise 3-bets only
// 2-6% and shoves 100 BB stacks with aces far too often, which isn't worth
// learning. Fill in its spots once the solve is right.
export const CHART_TRACKS = [
  {table: 'hu', label: 'Heads-up', lessons: [
    {label: 'Opens', ids: ['hu-open-BTN']},
    {label: 'Facing an open', ids: ['hu-vs-open-BB-BTN', 'hu-vs-limp-BB-BTN']},
    {label: 'Facing a 3-bet', ids: ['hu-vs-3bet-BTN-BB', 'hu-vs-iso-BTN-BB']},
    {label: 'Facing a 4-bet', ids: ['hu-vs-4bet-BB-BTN']},
  ]},
  {table: '6max', label: '6-max', lessons: [
    {label: 'Opens', ids: ['open-UTG', 'open-HJ', 'open-CO', 'open-BTN', 'open-SB']},
    {label: 'Facing an open', ids: [], soon: true},
    {label: 'Facing a 3-bet', ids: [], soon: true},
  ]},
];

/** A table's spots in lesson order. */
export const trackIds = table => CHART_TRACKS.find(t => t.table === table).lessons.flatMap(l => l.ids);
export const CHART_MODES = [
  {mode: 'fixed', label: 'Fixed hands', text: 'Pick the action.'},
  {mode: 'mixed', label: 'Mixed strategies', text: 'Set how often to take each action.'},
];
export const DEFAULT_BB = 100;

// An action used less than this often in a spot overall (in %) isn't asked
// about: the solve's noise (a 13% all-in with aces first in, a 4% limp from
// UTG) folds into the spot's main aggressive action, or else its call.
export const MIN_ACTION = 4;
// In fixed mode, besides a hand's most frequent action, any action it takes at
// least this often (in %) is also right.
export const FIXED_OK = 30;
// Mixed mode: a guess within this distance of the true mix (total variation,
// in points of 100) is right; within CLOSE_MIX, close (no points either way).
export const RIGHT_MIX = 12;
export const CLOSE_MIX = 25;

/** The progress key of a chart skill. */
export const chartSkillKey = (table, bb, id, mode) => `chart:${table}:${bb}:${id}:${mode}`;

/** {table, bb, id, mode} for a chart skill's key, or null. */
export function parseChartKey(key) {
  const m = /^chart:(hu|6max):(\d+):([\w-]+):(fixed|mixed)$/.exec(key);
  return m ? {table: m[1], bb: +m[2], id: m[3], mode: m[4]} : null;
}

/** The chart file a table and depth live in. */
export const chartFile = (table, bb) => (table === 'hu' ? `ducybot-hu-${bb}.json` : `ducybot-${bb}.json`);

/** A short name for a spot: "BTN open", "BB vs BTN open", "BTN vs 3-bet". */
export function spotName(spot) {
  const v = spot.villain;
  switch (spot.kind) {
    case 'open': return `${spot.hero} open`;
    case 'vs-open': return `${spot.hero} vs ${v} open`;
    case 'vs-3bet': return `${spot.hero} vs ${v} 3-bet`;
    case 'vs-4bet': return `${spot.hero} vs ${v} 4-bet`;
    case 'vs-limp': return `${spot.hero} vs ${v} limp`;
    case 'vs-iso': return `${spot.hero} limped, ${v} raised`;
    default: return spot.id;
  }
}

/** A short name for a spot from its id alone, for lists drawn before the chart loads. */
export function spotNameFromId(id) {
  const parts = id.replace(/^hu-/, '').split('-');
  if (parts[0] === 'open') return spotName({kind: 'open', hero: parts[1]});
  const kind = `vs-${parts[1]}`;
  return spotName({kind, hero: parts[2], villain: parts[3], id});
}

/** The question for a spot: "You're on the button, first to act." */
export function spotQuestion(spot, hu) {
  const where = {BTN: 'the button', SB: 'the small blind', BB: 'the big blind', UTG: 'UTG', HJ: 'the hijack', CO: 'the cutoff'};
  const at = p => where[p] || p;
  const facing = spot.facing ? ` to ${+Number(spot.facing).toFixed(1)} BB` : '';
  switch (spot.kind) {
    case 'open': return hu ? `You’re on ${at(spot.hero)}, first to act.` : `You’re ${spot.hero === 'UTG' ? 'UTG' : `on ${at(spot.hero)}`}, everyone before you folded.`;
    case 'vs-open': return `You’re on ${at(spot.hero)}. ${spot.villain} raises${facing}.`;
    case 'vs-3bet': return `You opened from ${at(spot.hero)}. ${spot.villain} 3-bets${facing}.`;
    case 'vs-4bet': return `You 3-bet from ${at(spot.hero)}. ${spot.villain} 4-bets${facing}.`;
    case 'vs-limp': return `You’re on ${at(spot.hero)}. ${spot.villain} limps.`;
    case 'vs-iso': return `You limped from ${at(spot.hero)}. ${spot.villain} raises${facing}.`;
    default: return '';
  }
}

/**
 * The actions asked about in a spot: [{a, verb}] for each action (0 fold, 1
 * call, 2 raise, 3 all-in) used at least MIN_ACTION% overall, and `into`:
 * where each action's share goes (itself, or the kept action it folds into).
 */
export function trainingActions(spot) {
  const verbs = sizedVerbs(spot, VERBS[spot.kind] || ['Fold', 'Call', 'Raise', 'All-in']);
  const kept = [0, 1, 2, 3].filter(a => spot.overall[a] >= MIN_ACTION);
  // A dropped action's share goes to the nearest kept action of the same
  // leaning: all-in to raise (else call), raise to all-in (else call), call to
  // raise (else fold), fold to call.
  const pref = {0: [1, 2], 1: [2, 3, 0], 2: [3, 1, 0], 3: [2, 1, 0]};
  const into = [0, 1, 2, 3].map(a => (kept.includes(a) ? a : pref[a].find(b => kept.includes(b)) ?? kept[0]));
  return {actions: kept.map(a => ({a, verb: verbs[a]})), into};
}

/** A hand class's mix over the kept actions, in % adding to 100 (cell i of the spot). */
export function handMix(spot, i, ta = trainingActions(spot)) {
  const cell = spot.cells[i];
  const out = ta.actions.map(() => 0);
  cell.forEach((p, a) => { out[ta.actions.findIndex(x => x.a === ta.into[a])] += p; });
  const sum = out.reduce((s, x) => s + x, 0) || 1;
  return out.map(x => (100 * x) / sum);
}

/** Fixed mode: the indexes (into the kept actions) that count as right for a mix. */
export function fixedAnswers(mix) {
  const top = Math.max(...mix);
  return mix.map((p, k) => (p === top || p >= FIXED_OK ? k : -1)).filter(k => k >= 0);
}

/** Fixed mode: how bad picking action k is, from 0 (right) to 1 (never taken by a pure hand). */
export function fixedSeverity(mix, k) {
  if (fixedAnswers(mix).includes(k)) return 0;
  return Math.min(1, (Math.max(...mix) - mix[k]) / 100);
}

/** Mixed mode: the distance between two mixes, 0 to 100 (half the summed differences). */
export function mixDistance(guess, truth) {
  return guess.reduce((s, g, k) => s + Math.abs(g - truth[k]), 0) / 2;
}

/** How hard a hand is to get right: 0 for one action always, 1 for an even split of the top two. */
export function difficulty(mix) {
  const [a, b = 0] = [...mix].sort((x, y) => y - x);
  return 1 - (a - b) / 100;
}

/** The main action (index into the kept actions) of a mix. */
export const mainAction = mix => mix.indexOf(Math.max(...mix));

/**
 * Hands too easy to ask about except as an occasional probe: always played one
 * way (95%+), with every neighbour on the grid played the same way, so it's
 * nowhere near an edge of the range (72o under the gun, aces anywhere).
 */
export function obviousCells(spot, ta = trainingActions(spot)) {
  const mixes = spot.cells.map((_, i) => handMix(spot, i, ta));
  const main = mixes.map(mainAction);
  return mixes.map((m, i) => {
    if (Math.max(...m) < 95) return false;
    const r = Math.floor(i / 13), c = i % 13;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && rr < 13 && cc >= 0 && cc < 13 && main[rr * 13 + cc] !== main[i]) return false;
    }
    return true;
  });
}

// Difficulty bands by level, for each mode: [min, max) of difficulty().
// Mixed practice keeps pure hands in play (a 100% raise is a mix too).
export const CHART_LEVELS = {
  fixed: [
    {name: 'Easy', from: 0, band: [0, 0.35]},
    {name: 'Medium', from: 50, band: [0.15, 0.65]},
    {name: 'Hard', from: 80, band: [0.4, 1.01]},
    {name: 'Challenge', from: 90, band: [0.6, 1.01]},
  ],
  mixed: [
    {name: 'Easy', from: 0, band: [0, 0.5]},
    {name: 'Medium', from: 50, band: [0, 1.01]},
    {name: 'Hard', from: 80, band: [0.3, 1.01]},
    {name: 'Challenge', from: 90, band: [0.5, 1.01]},
  ],
};
export const chartLevel = (mode, score) => [...CHART_LEVELS[mode]].reverse().find(l => score >= l.from);

const COMBOS = i => { const r = Math.floor(i / 13), c = i % 13; return r === c ? 6 : r < c ? 4 : 12; };

/**
 * Picks a hand class for practice: not obvious (unless `probe`), within the
 * difficulty band, weighted by how many combos it has. Relaxes the band, then
 * obviousness, rather than give up. Returns the cell index.
 */
export function pickCell(spot, {band = [0, 1.01], probe = false, rand = Math.random, ta = trainingActions(spot), obvious = obviousCells(spot, ta)} = {}) {
  const mixes = spot.cells.map((_, i) => handMix(spot, i, ta));
  const tries = probe
    ? [i => obvious[i]]
    : [i => !obvious[i] && difficulty(mixes[i]) >= band[0] && difficulty(mixes[i]) < band[1], i => !obvious[i], () => true];
  for (const ok of tries) {
    const pool = mixes.map((_, i) => i).filter(ok);
    if (!pool.length) continue;
    let x = rand() * pool.reduce((s, i) => s + COMBOS(i), 0);
    for (const i of pool) { x -= COMBOS(i); if (x < 0) return i; }
    return pool[pool.length - 1];
  }
  return 0;
}

const SUITS = ['s', 'h', 'd', 'c'];
/** Two cards of hand class `i` (random suits that fit it), high card first. */
export function cardsFor(i, rand = Math.random) {
  const h = cellHand(i);
  const pick = n => { const s = [...SUITS]; for (let k = s.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [s[k], s[j]] = [s[j], s[k]]; } return s.slice(0, n); };
  if (h.length === 2) { const [a, b] = pick(2); return [h[0] + a, h[1] + b]; }
  if (h[2] === 's') { const [a] = pick(1); return [h[0] + a, h[1] + a]; }
  const [a, b] = pick(2);
  return [h[0] + a, h[1] + b];
}

/** A fingerprint of a spot's chart, so progress earned on an older chart starts over. */
export function spotFingerprint(spot) {
  const text = JSON.stringify(spot.cells);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Points (the top-% track's pacing, trainer-skills.js gainFor) and penalties.
/** Points lost for a wrong fixed answer: 2 for a near miss up to 16; 20 on a probe. */
export function fixedPenalty(severity, probe) {
  if (probe) return 20;
  return Math.max(2, Math.round(16 * severity));
}

/** Points lost for a mixed answer that's off: 0 inside CLOSE_MIX, then up to 16. */
export function mixedPenalty(distance) {
  if (distance <= CLOSE_MIX) return 0;
  return Math.max(2, Math.round(16 * Math.min(1, (distance - CLOSE_MIX) / 50)));
}

/**
 * A slider change in mixed mode: action k set to v (0-100, in steps of 5),
 * the others scaled to make up the rest, keeping their proportions (or
 * splitting it evenly when they're all 0). Returns the new mix, whole numbers adding to 100.
 */
export function setShare(mix, k, v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  const rest = 100 - v;
  const others = mix.map((p, j) => (j === k ? 0 : p));
  const sum = others.reduce((s, p) => s + p, 0);
  const n = mix.length - 1;
  let out = mix.map((p, j) => (j === k ? v : sum ? (p * rest) / sum : n ? rest / n : 0));
  // Whole numbers that still add to 100: round, then settle the difference on the largest other share.
  out = out.map(Math.round);
  const diff = 100 - out.reduce((s, p) => s + p, 0);
  if (diff) {
    const j = out.map((p, j2) => [p, j2]).filter(([, j2]) => j2 !== k).sort((a, b) => b[0] - a[0])[0]?.[1];
    if (j != null) out[j] += diff;
    else out[k] += diff;
  }
  return out;
}

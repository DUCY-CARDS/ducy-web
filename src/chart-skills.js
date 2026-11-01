// Practising Ducybot's pre-flop ranges (#249, the training part of #248): a
// spot from his charts (charts/ducybot-*.json, the same files as #charts) is
// a skill, practised two ways:
//   fixed  - pick the action. A hand he plays one way has one right answer;
//            a hand he mixes accepts any action he takes often enough.
//   mixed  - set how often he takes each action, scored by how close the mix is.
// The rules (which actions are asked, the right answers, scoring, picking
// hands, the table as the hand reaches you) are ducy-training's chart module
// (#464); this keeps the lessons and their names, and passes the page's
// random draws in. trainer.js draws the screens.

import { training } from '../wasm/ducy_wasm.js';

// The Hold'em track: a table (heads-up or 6-max), then lessons in order, from
// opening ranges to the more advanced spots. A lesson with `soon` is shown
// but not practised yet: the six-handed solve facing a raise 3-bets only
// 2-6% and shoves 100 BB stacks with aces far too often, which isn't worth
// learning. Fill in its spots once the solve is right.
export const CHART_TRACKS = [
  {table: '6max', label: '6-max', lessons: [
    {label: 'Opening ranges', ids: ['open-UTG', 'open-HJ', 'open-CO', 'open-BTN', 'open-SB']},
    {label: 'Facing an open', ids: [], soon: true},
    {label: 'Facing a 3-bet', ids: [], soon: true},
  ]},
  {table: 'hu', label: 'Heads-up', lessons: [
    {label: 'Opening ranges', ids: ['hu-open-BTN']},
    {label: 'Facing an open', ids: ['hu-vs-open-BB-BTN', 'hu-vs-limp-BB-BTN']},
    {label: 'Facing a 3-bet', ids: ['hu-vs-3bet-BTN-BB', 'hu-vs-iso-BTN-BB']},
    {label: 'Facing a 4-bet', ids: ['hu-vs-4bet-BB-BTN']},
  ]},
];

/** A table's spots in lesson order. */
export const trackIds = table => CHART_TRACKS.find(t => t.table === table).lessons.flatMap(l => l.ids);
export const CHART_MODES = [
  {mode: 'fixed', label: 'Fixed hands', text: 'Pick the action.'},
  {mode: 'mixed', label: 'Mixed strategies', text: 'Set how often to take each action.'},
];
// Deep stacks to start with; other depths are under Settings.
export const DEFAULT_BB = 200;

// The thresholds ducy-training uses (chart.rs), for the pages' words.
export const MIN_ACTION = 4;
export const OPEN_LIMP_MIN = 10;
export const FIXED_OK = 30;
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

// A spot as ducy-training reads it: the chart's fields that matter.
const spotOf = s => ({id: String(s.id ?? ''), kind: String(s.kind ?? ''), hero: String(s.hero ?? ''), villain: s.villain ?? null, facing: s.facing ?? null, sizes: s.sizes || [], overall: s.overall || [], cells: s.cells || []});
// What's worked out once per spot object: its actions, every cell's mix,
// the obvious cells.
const perSpot = new WeakMap();
function known(spot) {
  let k = perSpot.get(spot);
  if (!k) perSpot.set(spot, (k = {}));
  return k;
}

/** A short name for a spot: "BTN open", "BB vs BTN open", "BTN vs 3-bet". */
export const spotName = spot => training({op: 'spotName', spot: spotOf(spot)});

/** A short name for a spot from its id alone, for lists drawn before the chart loads. */
export const spotNameFromId = id => training({op: 'spotNameFromId', id: String(id)});

/** The question for a spot: "You're on the button, first to act." */
export const spotQuestion = (spot, hu) => training({op: 'spotQuestion', spot: spotOf(spot), hu: !!hu});

/**
 * The actions asked about in a spot: [{a, verb}] for each action (0 fold, 1
 * call, 2 raise, 3 all-in) used at least MIN_ACTION% overall, and `into`:
 * where each action's share goes (itself, or the kept action it folds into).
 */
export function trainingActions(spot) {
  const k = known(spot);
  return (k.ta ||= training({op: 'trainingActions', spot: spotOf(spot)}));
}

/** A hand class's mix over the kept actions, in % adding to 100 (cell i of the spot). */
export function handMix(spot, i) {
  const k = known(spot);
  k.mixes ||= training({op: 'handMixes', spot: spotOf(spot)});
  return k.mixes[i];
}

/** Fixed mode: the indexes (into the kept actions) that count as right for a mix. */
export const fixedAnswers = mix => training({op: 'fixedAnswers', mix});

/** Fixed mode: how bad picking action k is, from 0 (right) to 1 (never taken by a pure hand). */
export const fixedSeverity = (mix, k) => training({op: 'fixedSeverity', mix, k});

/** Mixed mode: the distance between two mixes, 0 to 100 (half the summed differences). */
export const mixDistance = (guess, truth) => training({op: 'mixDistance', guess, truth});

/** How hard a hand is to get right: 0 for one action always, 1 for an even split of the top two. */
export const difficulty = mix => training({op: 'difficulty', mix});

/** The main action (index into the kept actions) of a mix. */
export const mainAction = mix => training({op: 'mainAction', mix});

/**
 * Hands too easy to ask about except as an occasional probe: always played one
 * way (95%+), with every neighbour on the grid played the same way, so it's
 * nowhere near an edge of the range (72o under the gun, aces anywhere).
 */
export function obviousCells(spot) {
  const k = known(spot);
  return (k.obvious ||= training({op: 'obviousCells', spot: spotOf(spot)}));
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

/**
 * Picks a hand class for practice: not obvious (unless `probe`), within the
 * difficulty band, weighted by how many combos it has. Relaxes the band, then
 * obviousness, rather than give up. Returns the cell index.
 */
export function pickCell(spot, {band = [0, 1.01], probe = false, rand = Math.random, avoid = null} = {}) {
  return training({op: 'pickCell', spot: spotOf(spot), band, probe: !!probe, r: rand(), avoid: avoid ?? null});
}

/** Two cards of hand class `i` (random suits that fit it), high card first. */
export function cardsFor(i, rand = Math.random) {
  return training({op: 'cardsFor', i, r: [rand(), rand(), rand()]});
}

/** A fingerprint of a spot's chart, so progress earned on an older chart starts over. */
export const spotFingerprint = spot => training({op: 'spotFingerprint', spot: spotOf(spot)});

// Points (the top-% track's pacing, trainer-skills.js gainFor) and penalties.
/** Points lost for a wrong fixed answer: 2 for a near miss up to 16; 20 on a probe. */
export const fixedPenalty = (severity, probe) => training({op: 'fixedPenalty', severity, probe: !!probe});

/** Points lost for a mixed answer that's off: 0 inside CLOSE_MIX, then up to 16. */
export const mixedPenalty = distance => training({op: 'mixedPenalty', distance});

/**
 * A slider change in mixed mode: action k set to v (0-100, in steps of 5),
 * the others scaled to make up the rest, keeping their proportions (or
 * splitting it evenly when they're all 0). Returns the new mix, whole numbers adding to 100.
 */
export const setShare = (mix, k, v) => training({op: 'setShare', mix, k, v: Number(v) || 0});

// ---- The table, as the hand reaches you ----

export const SIX_SEATS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const HU_SEATS = ['BTN', 'BB']; // the button is the small blind

/**
 * The table when it's your turn in `spot`: who sits where, what each did
 * before you, and the pot. `sizes` are raises the spot's chart doesn't carry
 * (in BB): {open, sbOpen, threeBet}.
 * Returns {seats: [{pos, state, label}], button, pot, story}: state 'hero',
 * 'fold', 'raise', 'call', 'blind' (posted, not acted yet) or 'waiting' (to
 * act after you); `story` the action in words, e.g. "UTG folds".
 */
export const tableScene = (spot, hu, sizes = {}) => training({op: 'tableScene', spot: spotOf(spot), hu: !!hu, sizes});

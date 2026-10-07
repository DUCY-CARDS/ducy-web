// Tournament blind structures (#78): presets, checking a structure, and how
// long a tournament will take. Pure functions; the tournament form (#77)
// shows the structure editor from tourney-structure-ui.js.
//
// A structure is a list of steps, in order:
//   {sb, bb, ante, minutes}   a level (ante: posted by every player dealt in)
//   {break: true, minutes}    a break between levels
// The last level stays once it's reached.

export const MAX_LEVELS = 60;
export const MAX_MINUTES = 240;
// About how many hands a table plays an hour, for the estimate.
export const HANDS_PER_HOUR = 30;

// Each preset sets: the first big blind as a share of the starting stack,
// how fast the blinds rise from level to level, the level length, the level
// antes start at, and a break after every so many levels.
export const PRESETS = [
  {id: 'turbo', label: 'Turbo', startBB: 1 / 50, growth: 1.5, minutes: 8, antesFrom: 4, breakEvery: 0},
  {id: 'regular', label: 'Regular', startBB: 1 / 100, growth: 1.35, minutes: 15, antesFrom: 4, breakEvery: 6},
  {id: 'deep', label: 'Deep', startBB: 1 / 200, growth: 1.25, minutes: 20, antesFrom: 5, breakEvery: 5},
];
const BREAK_MINUTES = 10;

// Round numbers blinds are made of: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k.
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
function niceAtLeast(x) {
  for (let p = 10 ** Math.floor(Math.log10(Math.max(x, 1))); ; p *= 10) {
    for (const m of NICE) if (m * p >= x - 1e-9) return m * p;
  }
}
// The largest whole round number at most x (0 below 1).
function niceAtMost(x) {
  if (x < 1) return 0;
  let best = 1;
  for (let p = 1; p <= x; p *= 10) for (const m of NICE) if (m * p <= x + 1e-9 && Number.isInteger(m * p)) best = m * p;
  return best;
}

// A preset's structure for a starting stack: levels until the big blind is
// several starting stacks, so it lasts even for a big field.
export function presetStructure(presetId, stack) {
  const p = PRESETS.find(q => q.id === presetId);
  if (!p) throw new Error(`no preset ${presetId}`);
  if (!Number.isSafeInteger(stack) || stack < 20) throw new Error('The starting stack must be at least 20 chips.');
  let bb = Math.ceil(niceAtLeast(Math.max(2, stack * p.startBB)));
  const steps = [];
  let levels = 0;
  while (levels < MAX_LEVELS) {
    const sb = Math.floor(bb / 2);
    const ante = levels + 1 >= p.antesFrom ? niceAtMost(bb / 8) : 0;
    steps.push({sb, bb, ante, minutes: p.minutes});
    levels++;
    if (bb >= stack * 4) break;
    if (p.breakEvery && levels % p.breakEvery === 0) steps.push({break: true, minutes: BREAK_MINUTES});
    const next = niceAtLeast(bb * p.growth * 0.97);
    bb = Math.max(Math.ceil(next), bb + 1);
  }
  return steps;
}

// Problems with a structure, as messages; none means it's playable.
export function checkStructure(steps) {
  const errors = [];
  if (!Array.isArray(steps) || !steps.length) return ['Add at least one level.'];
  const whole = n => Number.isSafeInteger(n);
  let prev = null, levels = 0;
  steps.forEach((s, i) => {
    const at = `Step ${i + 1}`;
    if (!whole(s.minutes) || s.minutes < 1 || s.minutes > MAX_MINUTES) errors.push(`${at}: minutes must be 1 to ${MAX_MINUTES}.`);
    if (s.break) {
      if (!prev) errors.push(`${at}: a break can’t come before the first level.`);
      return;
    }
    levels++;
    if (![s.sb, s.bb, s.ante].every(whole) || s.sb < 1 || s.ante < 0) errors.push(`${at}: blinds must be whole chips, the small blind at least 1.`);
    else if (s.sb > s.bb) errors.push(`${at}: the small blind can’t be more than the big blind.`);
    else if (s.ante > s.bb) errors.push(`${at}: the ante can’t be more than the big blind.`);
    if (prev && whole(s.bb) && s.bb <= prev.bb) errors.push(`${at}: the big blind must be higher than the level before.`);
    prev = s;
  });
  if (levels > MAX_LEVELS) errors.push(`At most ${MAX_LEVELS} levels.`);
  if (steps.at(-1)?.break) errors.push('The structure can’t end with a break.');
  return errors;
}

// The estimate's model, fitted to bot-only tournaments played by the engine
// (ducy-play's tourney_time example; see test/tourney-structure.test.mjs).
// Each table loses players at a rate that grows as stacks get short against
// the blinds: ELIM × (pot / average stack) ^ POWER per hand.
export const MODEL = {ELIM: 0.9, POWER: 0.7};

// About how long a tournament takes to find a winner: {minutes, hands, level}
// (play and breaks, the hands a table plays, the level it ends in, from 1).
export function estimate(steps, {stack, players, tableSize = 9, handsPerHour = HANDS_PER_HOUR, model = MODEL}) {
  const levels = [];
  const breaks = [];
  let at = 0;
  for (const s of steps) {
    if (s.break) breaks.push({at, minutes: s.minutes});
    else { levels.push({...s, start: at}); at += s.minutes; }
  }
  if (!levels.length || players < 2) return {minutes: 0, hands: 0, level: 1};
  const perHand = 60 / handsPerHour;
  const total = players * stack;
  let left = players, played = 0, hands = 0, li = 0;
  while (left > 1 && hands < 100_000) {
    while (li + 1 < levels.length && levels[li + 1].start <= played) li++;
    const {sb, bb, ante} = levels[li];
    const tables = Math.ceil(left / tableSize);
    const pot = sb + bb + ante * (left / tables);
    const rate = model.ELIM * (pot / (total / left)) ** model.POWER;
    left -= Math.min(rate * tables, left / 4 + 0.05);
    played += perHand;
    hands++;
  }
  const breakMinutes = breaks.filter(b => b.at > 0 && b.at <= played).reduce((a, b) => a + b.minutes, 0);
  return {minutes: Math.round(played + breakMinutes), hands, level: li + 1};
}

// "about 3 h 20 min"
export function durationText(minutes) {
  const m = Math.round(minutes / 5) * 5;
  if (m < 60) return `about ${Math.max(5, m)} min`;
  return `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

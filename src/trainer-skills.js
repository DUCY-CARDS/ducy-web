// Practice pacing and the list of skills (game × target) for the range
// trainer's adaptive practice. Pure functions, so they can be tested.

// A skill scores 0 to 100, and 90 or more masters it (V3, #225).
export const MASTERY = 90;

// Points for a correct answer at a given score. The climb gets slower as the
// score rises, and from 80 up every point is one more right answer, so
// mastery takes about 36 correct answers in a row from 0 (more with any
// misses), and the last 10 points are all close calls.
export function gainFor(score) {
  return score < 40 ? 4 : score < 60 ? 3 : score < 80 ? 2 : 1;
}

/** Correct answers in a row needed to go from `from` to mastery. */
export function answersToMaster(from = 0) {
  let s = from, n = 0;
  while (s < MASTERY) { s = Math.min(MASTERY, s + gainFor(s)); n++; }
  return n;
}

/** The progress key of a skill: a game (hole cards) and a top-% target. */
export const skillKey = (cards, pct) => (cards === 2 ? `holdem:${pct}` : `omaha:${cards}:${pct}`);

/** {cards, pct} for a skill's (all hands, not a drill) progress key, or null. */
export function parseSkillKey(key) {
  let m = /^holdem:(\d+)$/.exec(key);
  if (m) return {cards: 2, pct: +m[1]};
  m = /^omaha:(\d+):(\d+)$/.exec(key);
  return m ? {cards: +m[1], pct: +m[2]} : null;
}

/** A skill's state from its progress record (or none). */
export function skillState(rec) {
  if (!rec || !(rec.answered || rec.score || rec.best)) return {status: 'new', score: 0, best: 0, answered: 0};
  const best = Math.max(rec.best || 0, rec.score || 0);
  return {
    status: best >= MASTERY ? 'mastered' : 'started',
    score: rec.score || 0, best, answered: rec.answered || 0,
  };
}

/**
 * Every skill for the games and standard targets, plus any other target
 * already practiced: rows by target, a cell per game.
 * Returns {rows: [{pct, cells: [{cards, pct, ...state}]}], mastered, started, total}.
 */
export function skillTable(progress, games, targets) {
  const pcts = new Set(targets);
  for (const key of Object.keys(progress || {})) {
    const s = parseSkillKey(key);
    if (s && games.includes(s.cards) && skillState(progress[key]).status !== 'new') pcts.add(s.pct);
  }
  let mastered = 0, started = 0, total = 0;
  const rows = [...pcts].sort((a, b) => a - b).map(pct => ({
    pct,
    cells: games.map(cards => {
      const st = skillState(progress && progress[skillKey(cards, pct)]);
      total++;
      if (st.status === 'mastered') mastered++;
      if (st.status !== 'new') started++;
      return {cards, pct, ...st};
    }),
  }));
  return {rows, mastered, started, total};
}

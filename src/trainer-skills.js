// Practice pacing and the list of skills (game × target) for the range
// trainer's adaptive practice: ducy-training's skills module (#464).

import { training } from '../wasm/ducy_wasm.js';

// A skill scores 0 to 100, and 90 or more masters it (V3, #225).
export const MASTERY = 90;

// Points for a correct answer at a given score. The climb gets slower as the
// score rises, and from 80 up every point is one more right answer, so
// mastery takes about 36 correct answers in a row from 0 (more with any
// misses), and the last 10 points are all close calls.
export const gainFor = score => training({op: 'gainFor', score: Number(score) || 0});

/** Correct answers in a row needed to go from `from` to mastery. */
export const answersToMaster = (from = 0) => training({op: 'answersToMaster', from: Number(from) || 0});

/** The progress key of a skill: a game (hole cards) and a top-% target. */
export const skillKey = (cards, pct) => training({op: 'skillKey', cards, pct});

/** {cards, pct} for a skill's (all hands, not a drill) progress key, or null. */
export const parseSkillKey = key => training({op: 'parseSkillKey', key: String(key)}) ?? null;

/** A skill's state from its progress record (or none). */
export const skillState = rec => training({op: 'skillState', rec: rec && typeof rec === 'object' ? rec : null});

/**
 * Every skill for the games and standard targets, plus any other target
 * already practiced: rows by target, a cell per game.
 * Returns {rows: [{pct, cells: [{cards, pct, ...state}]}], mastered, started, total}.
 */
export const skillTable = (progress, games, targets) => training({op: 'skillTable', progress: progress || {}, games, targets});

/**
 * The skill to move on to after mastering `pct` in the game with `cards`
 * hole cards (#225): the next standard target of that game not mastered yet
 * (going up, then from the start), then the other games' in order.
 * Returns {cards, pct}, or null once every one is mastered.
 */
export const nextSkillAfter = (progress, games, targets, cards, pct) => training({op: 'nextSkillAfter', progress: progress || {}, games, targets, cards, pct}) ?? null;

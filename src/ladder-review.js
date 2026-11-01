// A ladder game's review (#284): each hand is graded against the GTO bot's
// strategy as it ends (play-review.js has the grades), and when the game is
// over the player sees their costliest decisions, the places to learn from.
// Kept with the game in progress, so a game left and resumed keeps it. The
// rules are ducy-bot-games' review (#465).
//
// A game's review is {totals, lessons}: the review totals (emptyTotals) and
// the costliest decisions, worst first, each {hand, at, hole, board, result,
// note, d} with the ladder game's hand number, the decision's place in the
// hand, the hand's cards and result (bb) and depth note, and the decision as
// the review gave it.
import { botGames } from '../wasm/ducy_wasm.js';
import { emptyTotals } from './play-review.js';

// Decisions kept for the game's review (as ducy-bot-games keeps them).
export const LESSONS_KEPT = 5;

export const newGameReview = () => ({totals: emptyTotals(), lessons: []});

// Adds one hand's review (BotTable.reviewLastHand) to a game's review, as
// hand number `hand` of the game, and returns the new one.
export const addHand = (g, review, hand) => botGames({op: 'addHand', g: g || null, review, hand});

// The lessons by hand, to show each hand once: hands in the order of their
// costliest lesson, each {hand, hole, board, result, note, items} with its
// lessons as {d, i, at} (i the lesson's place in the list, at its place in
// the hand) in the order they were played.
export const lessonsByHand = lessons => botGames({op: 'lessonsByHand', lessons: lessons || null});

// The big blinds the game's decisions gave up, in all and for the lessons
// shown: how much of the loss the list accounts for.
export const lessonsShare = g => botGames({op: 'lessonsShare', g: g || null});

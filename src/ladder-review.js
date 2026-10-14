// A ladder game's review (#284): each hand is graded against the GTO bot's
// strategy as it ends (play-review.js has the grades), and when the game is
// over the player sees their costliest decisions, the places to learn from.
// Kept with the game in progress, so a game left and resumed keeps it.
//
// A game's review is {totals, lessons}: the review totals (emptyTotals) and
// the costliest decisions, worst first, each {hand, at, hole, board, result,
// note, d} with the ladder game's hand number, the decision's place in the
// hand, the hand's cards and result (bb) and depth note, and the decision as
// the review gave it.
import { emptyTotals, addReview } from './play-review.js';

// Decisions kept for the game's review.
export const LESSONS_KEPT = 5;

export const newGameReview = () => ({totals: emptyTotals(), lessons: []});

// Worth learning from: a decision that gave up big blinds, or a preflop
// play the GTO bot (almost) never makes, whose cost isn't valued.
const isLesson = d => Number(d.bb_lost) > 0 || d.grade === 'deviation';

// Costliest first; off-strategy plays (not valued) after every charged one;
// then the earlier hand.
const byCost = (a, b) => (Number(b.d.bb_lost) || 0) - (Number(a.d.bb_lost) || 0) || a.hand - b.hand;

// Adds one hand's review (BotTable.reviewLastHand) to a game's review, as
// hand number `hand` of the game, and returns the new one.
export function addHand(g, review, hand) {
  const base = g || newGameReview();
  const totals = addReview({...emptyTotals(), ...base.totals}, review);
  const found = (review.decisions || []).map((d, at) => ({
    hand, at, hole: review.hole, board: review.board, result: review.result, note: review.note || null, d,
  })).filter(x => isLesson(x.d));
  const lessons = [...(base.lessons || []), ...found].sort(byCost).slice(0, LESSONS_KEPT);
  return {totals, lessons};
}

// The lessons by hand, to show each hand once: hands in the order of their
// costliest lesson, each {hand, hole, board, result, note, items} with its
// lessons as {d, i, at} (i the lesson's place in the list, at its place in
// the hand) in the order they were played.
export function lessonsByHand(lessons) {
  const hands = new Map();
  (lessons || []).forEach((x, i) => {
    if (!hands.has(x.hand)) hands.set(x.hand, {hand: x.hand, hole: x.hole, board: x.board, result: x.result, note: x.note, items: []});
    hands.get(x.hand).items.push({d: x.d, i, at: x.at ?? i});
  });
  for (const h of hands.values()) h.items.sort((a, b) => a.at - b.at);
  return [...hands.values()];
}

// The big blinds the game's decisions gave up, in all and for the lessons
// shown: how much of the loss the list accounts for.
export function lessonsShare(g) {
  const all = Number(g?.totals?.bbLost) || 0;
  const shown = (g?.lessons || []).reduce((a, x) => a + (Number(x.d.bb_lost) || 0), 0);
  return {all, shown};
}

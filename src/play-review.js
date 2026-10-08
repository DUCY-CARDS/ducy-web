// Hand review against the GTO bot: totals and labels for the reviews that
// ducy-wasm's BotTable.reviewLastHand() returns after each hand.
//
// A review lists the person's decisions, each with a grade:
//   fine        the bot's own play, a play it mixes in, or close in value
//   inaccuracy  gives up a little (from 0.25 bb)
//   mistake     from 1 bb
//   blunder     from 4 bb
//   deviation   something the bot (almost) never does preflop, where the
//               cost isn't valued
//   unknown     the hand left the bot's betting tree, nothing to compare
// and bb_lost, the big blinds it's charged (0 for the bot's own plays).

// Every counter a set of totals has, all zero.
export function emptyTotals() {
  return {
    hands: 0,
    decisions: 0,
    bbLost: 0,
    fine: 0,
    inaccuracies: 0,
    mistakes: 0,
    blunders: 0,
    deviations: 0,
    unknown: 0,
    variants: 0, // fine, but the less common side of the bot's mix
    mixLoss: 0, // bb those mixed plays gave up against the best play (not charged)
  };
}

// What an uncharged play still gave up: a play the bot mixes in isn't
// graded down, but in this spot it can still be worth less than the best
// play, and that's worth seeing. {loss, best, close} for a play graded fine
// and not charged that's worth less than the best, with `close` when the
// difference is within the estimate's error (2 standard errors); otherwise
// null.
export function mixCost(d) {
  const loss = Number(d.ev_loss);
  if (d.grade !== 'fine' || Number(d.bb_lost) > 0 || !(loss > 0) || !d.best || d.best === d.action) return null;
  return {loss, best: d.best, close: loss <= 2 * (Number(d.stderr) || 0)};
}

const GRADE_KEYS = {
  fine: 'fine',
  inaccuracy: 'inaccuracies',
  mistake: 'mistakes',
  blunder: 'blunders',
  deviation: 'deviations',
  unknown: 'unknown',
};

// Grades worth pointing out, worst first.
export const FLAGGED = ['blunder', 'mistake', 'inaccuracy', 'deviation'];

export const GRADE_LABEL = {
  fine: 'Fine',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
  deviation: 'Off-strategy',
  unknown: 'Not graded',
};

// Whether a fine decision took the less common side of the bot's mix.
export const isVariant = d => d.grade === 'fine' && typeof d.note === 'string' && d.note.startsWith('a less common');

// Adds one hand's review into `totals` and returns it.
export function addReview(totals, review) {
  totals.hands += 1;
  for (const d of review.decisions || []) {
    totals.decisions += 1;
    totals.bbLost += Number(d.bb_lost) || 0;
    const key = GRADE_KEYS[d.grade];
    if (key) totals[key] += 1;
    if (isVariant(d)) totals.variants += 1;
    const c = mixCost(d);
    if (c && !c.close) totals.mixLoss += c.loss;
  }
  return totals;
}

// Adds `b` into `a` (both totals) and returns `a`.
export function addTotals(a, b) {
  for (const k of Object.keys(emptyTotals())) a[k] = (a[k] || 0) + (b[k] || 0);
  return a;
}

// Big blinds lost per 100 hands, or null with no hands.
export const per100 = t => (t.hands ? (100 * t.bbLost) / t.hands : null);

// "1.5" or "0.25": bb amounts with as few decimals as read well.
export function bbText(x) {
  const v = Number(x) || 0;
  // Nothing that would show as 0.00 (or −0.00).
  if (Math.abs(v) < 0.005) return '0';
  if (Math.abs(v) < 0.1) return v.toFixed(2);
  return (Math.sign(v) * Math.round(Math.abs(v) * 10) / 10).toString();
}

// The bot's mix as "bet 75% pot 62% · check 38%", most frequent first,
// leaving out plays under 1%.
export function mixText(gto) {
  return (gto || [])
    .filter(a => a.frequency >= 0.01)
    .sort((a, b) => b.frequency - a.frequency)
    .map(a => `${a.action} ${Math.round(a.frequency * 100)}%`)
    .join(' · ');
}

// The bot's plays for the review's table, most frequent first: those it
// makes at least 1% of the time, and any with a value. Each is {action, pct
// (whole percent, or null under 1%), ev (bb, or null)}.
export function mixRows(gto) {
  return (gto || [])
    .filter(a => a.frequency >= 0.01 || a.ev != null)
    .sort((a, b) => b.frequency - a.frequency || (b.ev ?? -Infinity) - (a.ev ?? -Infinity))
    .map(a => ({action: a.action, pct: a.frequency >= 0.01 ? Math.round(a.frequency * 100) : null, ev: a.ev ?? null}));
}

// Whether a row of the table is the play that was made. The review names
// your play with its amount ("call 1.5bb"); the bot's plays without one
// ("call") or with a size ("raise to 100% pot").
export function isYourPlay(row, action) {
  if (row.action === action) return true;
  return !/\d/.test(row.action) && String(action).startsWith(`${row.action} `);
}

// The decision that cost the most in a review, as its index, or -1.
export function worstIndex(review) {
  let best = -1;
  (review.decisions || []).forEach((d, i) => {
    if (d.bb_lost > 0 && (best < 0 || d.bb_lost > review.decisions[best].bb_lost)) best = i;
  });
  return best;
}

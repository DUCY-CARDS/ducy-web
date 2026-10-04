// Builds the Omaha hand ranking and writes src/omaha-rank-model.js.
//
//   node scripts/fit-omaha-rank.mjs --data <dir> --bin <omaha_flop_quality> [--iters 2] [--hero 8000] [--blocker-weight 0.15] [--equity mw|hu] [--hu-weight 0.5] [--flop-opts "threebet=0.15"] [--reuse]
//       [--cards 5,6 --nut-cards 5,6 --w-nut 0.4 --w-loss 0.2]
//
// <dir> holds plo4.csv, plo5.csv, plo6.csv from ducy's `omaha_equity_dataset`
// example (`hand,hu,...`: uniform random hands with raw equity against a
// random hand). --bin is ducy's `omaha_flop_quality` example binary.
//
// A good Omaha hand has raw equity and flops well against opponents who are
// strong enough to give action, without being dominated. So, per variant:
//   round 0: rank all hands by raw equity; opponents play the top 25%
//   each round: measure favorable flops (omaha_flop_quality) for a subset of
//     hands against that range, score = equal blend of raw equity and
//     favorable-flop rate (z-scored), fit a linear model over hand features
//     (src/omaha-features.js) to that score, rank every hand with the model,
//     and use the new top 25% as the opponent range
// The final model is checked on held-out hands and used to score a large
// random sample for the percentile cutoffs.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { omahaFeatures, FEATURE_NAMES } from '../src/omaha-features.js';
import { randomHands, finishModel, CUTOFF_STEPS } from './omaha-percentiles.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!args.data || !args.bin) {
  console.error('usage: node scripts/fit-omaha-rank.mjs --data <dir> --bin <omaha_flop_quality> [--iters 2] [--hero 8000]');
  process.exit(2);
}
const ITERS = +(args.iters || 2);
const HERO = +(args.hero || 8000);
const RANGE_TOP = +(args.range || 0.25);
// Preflop equity column from the dataset: 'mw' (3-way, the default) or 'hu'
// (heads-up). Multiway equity matched solver opening charts better: it
// rewards connected, suited hands over pairs and aces with junk.
const EQUITY = args.equity || 'mw';
const HU_WEIGHT = +(args['hu-weight'] ?? 0.5);
const BLEND = {hu: HU_WEIGHT, favorable: 1 - HU_WEIGHT};
// --reuse: read existing work/flop<n>_<round>.csv measurements instead of
// running omaha_flop_quality again.
const REUSE = 'reuse' in args;
const CONTINUE = args.continue || '0.6';
const FAVORABLE = args.favorable || '0.55';
// --flop-opts passes extra key=value options to omaha_flop_quality, e.g.
// "threebet=0.15" for 3-bet pressure (opponent range files are written best
// first, as that option needs).
const EXTRA_FLOP_OPTS = (args['flop-opts'] || '').split(/\s+/).filter(Boolean);
const FLOP_OPTS = [`hand_flops=${args['hand-flops'] || 80}`, 'opponents=6', 'runouts=10', `favorable=${FAVORABLE}`, `continue=${CONTINUE}`, ...EXTRA_FLOP_OPTS];
const VARIANTS = (args.cards || '4,5,6').split(',').map(Number);
// Nut potential (omaha_flop_quality nuts=1) for the variants in --nut-cards:
// the target adds w-nut x z(nut_rate) and subtracts w-loss x z(big_loss). With
// more hole cards someone usually holds the nuts, so second-best hands lose
// the big pots; this matters most in PLO5 and PLO6.
const NUT_CARDS = args['nut-cards'] ? args['nut-cards'].split(',').map(Number) : [];
const W_NUT = +(args['w-nut'] ?? 0.4);
const W_LOSS = +(args['w-loss'] ?? 0.2);
const usesNuts = cards => NUT_CARDS.includes(cards);
const flopOpts = cards => (usesNuts(cards) ? [...FLOP_OPTS, 'nuts=1'] : FLOP_OPTS);
// The fitting target for one variant from preflop equity and a flop-quality
// file's rows (aligned with `eq`).
function targetFor(cards, eq, rows) {
  const zh = zscore(eq), zf = zscore(rows.map(r => r.favorable));
  let t = eq.map((_, j) => BLEND.hu * zh[j] + BLEND.favorable * zf[j]);
  if (usesNuts(cards)) {
    const zn = zscore(rows.map(r => r.nut_rate)), zl = zscore(rows.map(r => r.big_loss));
    t = t.map((x, j) => x + W_NUT * zn[j] - W_LOSS * zl[j]);
  }
  return t;
}
const OUT = args.out || new URL('../src/omaha-rank-model.js', import.meta.url).pathname;
const RIDGE = 1e-3;
// Blocker term added after fitting (scripts/omaha-percentiles.mjs).
const BLOCKER_WEIGHT = +(args['blocker-weight'] ?? 0.15);
const work = `${args.data}/work`;
mkdirSync(work, {recursive: true});

const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
const zscore = xs => { const m = mean(xs); const s = Math.sqrt(mean(xs.map(x => (x - m) ** 2))) || 1; return xs.map(x => (x - m) / s); };
const dot = (w, x) => w.reduce((a, wi, i) => a + wi * x[i], 0);

function readCsv(file) {
  const [head, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], i ? +v : v])));
}

function ranks(xs) {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array(xs.length);
  idx.forEach((i, k) => { r[i] = k; });
  return r;
}
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), n = a.length;
  return 1 - 6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0) / (n * (n * n - 1));
}

// Ridge regression via normal equations; the bias term isn't regularized.
function fit(X, y) {
  const k = X[0].length, n = X.length;
  const A = Array.from({length: k}, () => new Array(k + 1).fill(0));
  for (let r = 0; r < n; r++) {
    const x = X[r];
    for (let i = 0; i < k; i++) {
      if (!x[i]) continue;
      for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      A[i][k] += x[i] * y[r];
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += RIDGE * n;
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
}

const topRange = (hands, scores) => hands.map((h, i) => [h, scores[i]]).sort((a, b) => b[1] - a[1]).slice(0, Math.round(hands.length * RANGE_TOP)).map(x => x[0]);

const model = {};
const summary = [];
for (const cards of VARIANTS) {
  const t0 = Date.now();
  const base = readCsv(`${args.data}/plo${cards}.csv`);
  const hands = base.map(r => r.hand);
  const X = hands.map(h => omahaFeatures(h.match(/../g)));
  const heroIdx = base.slice(0, HERO).map((_, i) => i);
  writeFileSync(`${work}/hero${cards}.csv`, 'hand\n' + heroIdx.map(i => hands[i]).join('\n') + '\n');

  let scores = base.map(r => r[EQUITY]); // round 0: raw equity
  let w = null, prevScores = scores, target = null;
  for (let it = 1; it <= ITERS; it++) {
    writeFileSync(`${work}/range${cards}.txt`, topRange(hands, scores).join('\n') + '\n');
    if (!REUSE) execFileSync(args.bin, [String(cards), `${work}/hero${cards}.csv`, `${work}/range${cards}.txt`, `${work}/flop${cards}_${it}.csv`, ...flopOpts(cards), `seed=${it}`], {stdio: ['ignore', 'ignore', 'inherit']});
    const fq = readCsv(`${work}/flop${cards}_${it}.csv`);
    target = targetFor(cards, heroIdx.map(i => base[i][EQUITY]), fq);
    const train = heroIdx.filter((_, j) => j % 5 !== 0);
    w = fit(train.map(i => X[i]), train.map(j => target[j]));
    scores = X.map(x => dot(w, x));
    console.log(`PLO${cards} round ${it}: ranking vs previous round, rank corr ${spearman(scores, prevScores).toFixed(3)}`);
    prevScores = scores;
  }

  // Held-out accuracy of the final model against the final target.
  const test = heroIdx.filter((_, j) => j % 5 === 0);
  const pred = test.map(i => dot(w, X[i])), targ = test.map(j => target[j]);
  const rho = spearman(pred, targ);
  const rp = ranks(pred), rt = ranks(targ);
  const err = rp.map((x, k) => Math.abs(x - rt[k]) / test.length * 100);
  const huRho = spearman(test.map(i => base[i][EQUITY]), targ);
  // Re-measure the held-out hands with a different seed. The measured target is
  // noisy, so the fair question is how well the model predicts an independent
  // measurement, next to how well one measurement predicts another.
  writeFileSync(`${work}/test${cards}.csv`, 'hand\n' + test.map(i => hands[i]).join('\n') + '\n');
  if (!REUSE) execFileSync(args.bin, [String(cards), `${work}/test${cards}.csv`, `${work}/range${cards}.txt`, `${work}/retest${cards}.csv`, ...flopOpts(cards), 'seed=99'], {stdio: ['ignore', 'ignore', 'inherit']});
  const re = readCsv(`${work}/retest${cards}.csv`);
  const targB = targetFor(cards, test.map(i => base[i][EQUITY]), re);
  const rhoModelB = spearman(pred, targB), rhoAB = spearman(targ, targB);
  console.log(`PLO${cards}: vs an independent re-measurement, model rank corr ${rhoModelB.toFixed(3)}; one measurement vs another ${rhoAB.toFixed(3)}`);

  model[cards] = finishModel(w, cards, BLOCKER_WEIGHT);
  // One line per variant in the generated header, so a partial refit can keep
  // the other variants' descriptions.
  model[cards].note = `PLO${cards}: ${BLEND.hu} x ${EQUITY === 'mw' ? '3-way' : 'heads-up'} equity + ${BLEND.favorable} x favorable flops (>= ${FAVORABLE} vs opponents with >= ${CONTINUE})` +
    (usesNuts(cards) ? ` + ${W_NUT} x nut rate - ${W_LOSS} x big-hand losses` : '') +
    (EXTRA_FLOP_OPTS.length ? `, flops measured with ${EXTRA_FLOP_OPTS.join(' ')}` : '') +
    `; vs re-measurement ${rhoModelB.toFixed(3)} (measurement vs measurement ${rhoAB.toFixed(3)})`;
  summary.push({cards, rho, meanErr: mean(err), within10: err.filter(e => e <= 10).length / err.length * 100, huRho, rhoModelB, rhoAB});
  console.log(`PLO${cards}: held-out rank corr ${rho.toFixed(3)} (raw equity alone ${huRho.toFixed(3)}), mean percentile error ${mean(err).toFixed(1)}, ` +
    `within 10 pts ${summary.at(-1).within10.toFixed(0)}%  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
}

// Variants not refit this run keep their current model and description.
let previous = {};
try { previous = (await import('file://' + OUT + '?t=' + Date.now())).OMAHA_MODEL; } catch {}
let previousHeader = '';
try { previousHeader = readFileSync(OUT, 'utf8').split('\nexport ')[0]; } catch {}
for (const [cards, m] of Object.entries(previous)) {
  if (model[cards]) continue;
  // Older files have no per-variant note: describe the variant from their header.
  const acc = previousHeader.match(new RegExp(`PLO${cards} ([0-9.]+) / ([0-9.]+)`));
  const opts = previousHeader.match(new RegExp(`PLO${cards} measurements add 3-bet pressure \\(omaha_flop_quality (\\S+)\\)`)) ||
    previousHeader.match(/Flop measurement options: (\S+(?: \S+)*?) \(/);
  const fav = previousHeader.match(/has >= ([0-9.]+) equity/), cont = previousHeader.match(/>= ([0-9.]+) equity vs a random hand/);
  const ranking = previousHeader.match(/Ranking: ([^,]+?) \(z-scored\)/) || previousHeader.match(/Ranking: (.+?), where/);
  const fallback = `PLO${cards}: from an earlier fit` + (ranking ? `: ${ranking[1].replace(/\s+/g, ' ')}` : '') +
    (fav && cont ? `, favorable flops >= ${fav[1]} vs opponents with >= ${cont[1]}` : '') +
    (opts ? `, flops measured with ${opts[1]}` : '') + (acc ? `; vs re-measurement ${acc[1]} (measurement vs measurement ${acc[2]})` : '');
  model[cards] = {note: m.note || fallback, ...m};
}
const ordered = Object.fromEntries(Object.keys(model).sort().map(k => [k, model[k]]));
const header = `// Generated by scripts/fit-omaha-rank.mjs. Do not edit by hand.
// Each variant's score is a linear model over hand features fitted to a z-scored target. A flop
// is favorable when the hand has at least the stated equity against opponents from the top
// ${RANGE_TOP * 100}% who give action on it (at least the stated equity vs a random hand there).
// Per variant: target, and held-out rank corr with an independent re-measurement:
${Object.values(ordered).map(m => `// - ${m.note}`).join('\n')}
// Blockers: + ${BLOCKER_WEIGHT} score sd per sd of nut-flush blocking (src/omaha-blockers.js).
// weights follow FEATURES; cutoffs[i] is the score at the top (i / ${CUTOFF_STEPS} * 100)%.
`;
writeFileSync(OUT, header + `export const FEATURES = ${JSON.stringify(FEATURE_NAMES)};\nexport const OMAHA_MODEL = ${JSON.stringify(ordered)};\n`);
console.log(`wrote ${OUT}`);

// Re-weights the blocker term of the Omaha ranking without refitting it:
// keeps the fitted feature weights in scripts/omaha-rank-model.js and recomputes
// the blocker statistics and percentile cutoffs.
//
//   node scripts/omaha-blockers.mjs [--weight 0.15]
//
// --weight is how many standard deviations of the hand score one standard
// deviation of nut-flush blocking is worth (0 turns blockers off).

import { readFileSync, writeFileSync } from 'fs';
import { FEATURE_NAMES } from './omaha-features.js';
import { OMAHA_MODEL } from './omaha-rank-model.js';
import { finishModel } from './omaha-percentiles.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const WEIGHT = +(args.weight ?? 0.15);
const OUT = new URL('./omaha-rank-model.js', import.meta.url).pathname;

const model = {};
for (const cards of Object.keys(OMAHA_MODEL).map(Number)) {
  model[cards] = finishModel(OMAHA_MODEL[cards].weights, cards, WEIGHT);
  console.log(`PLO${cards}: blocker weight ${WEIGHT}, blocker mean ${model[cards].blocker.mean} sd ${model[cards].blocker.sd}`);
}
const header = readFileSync(OUT, 'utf8').split('\n').filter(l => l.startsWith('//') && !l.startsWith('// Blockers:'));
header.splice(header.length - 1, 0, blockerNote(WEIGHT));
writeFileSync(OUT, header.join('\n') + `\nexport const FEATURES = ${JSON.stringify(FEATURE_NAMES)};\nexport const OMAHA_MODEL = ${JSON.stringify(model)};\n`);
console.log(`wrote ${OUT}`);

function blockerNote(w) {
  return `// Blockers: + ${w} score sd per sd of nut-flush blocking (scripts/omaha-blockers.js).`;
}

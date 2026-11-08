// Checks the thresholds of the check for real-time assistance (#591,
// relay/src/assist.js) on made-up club weeks (test/assist-sim.mjs): how
// often honest players are flagged, and how often cheaters are.
//
//     node scripts/assist-calibrate.mjs [weeks] [hands per week]
//
// Each week is a six-handed club: the player being tested and five honest
// ones (strong, two average, weak, and one of elite, strong or average).
// Prints, per kind of player, the share flagged as the check runs (LIMITS),
// the share whose play alone is as close as the solver's (without the sign
// from how they decide, NEED_BEHAVIOR), and the spread of their numbers.
// Then what scoring costs. Needs the wasm build in wasm/.

import '../test/wasm.mjs';
import { assistFlags, decisionsOf, LIMITS, statsOf } from '../relay/src/assist.js';
import { makePlayer, playWeek, random } from '../test/assist-sim.mjs';

const WEEKS = Number(process.argv[2]) || 40;
const HANDS = Number(process.argv[3]) || 700;

const TESTED = {
  'human, elite': {type: 'human', skill: 'elite'},
  'human, strong': {type: 'human', skill: 'strong'},
  'human, average': {type: 'human', skill: 'average'},
  'human, weak': {type: 'human', skill: 'weak'},
  'chart memorizer, 0.5% slips': {type: 'memorizer', slip: 0.005},
  'chart memorizer, 2% slips': {type: 'memorizer', slip: 0.02},
  'solver, mixing as it mixes': {type: 'solver', mode: 'sample'},
  'solver, always its top play': {type: 'solver', mode: 'top'},
  'solver on 75% of decisions': {type: 'solver', mode: 'sample', share: 0.75, base: 'strong'},
  'solver on 50% of decisions': {type: 'solver', mode: 'sample', share: 0.5, base: 'strong'},
};

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const pct = x => `${(100 * x).toFixed(1)}%`;
const flaggedIds = by => new Set(assistFlags(by).flagged.map(e => e.ids[0]));

const t0 = performance.now();
let hands = 0, decisions = 0, honest = 0, honestFlagged = 0;
const rows = [];
for (const [label, spec] of Object.entries(TESTED)) {
  const row = {label, players: 0, flagged: 0, close: 0, n: [], off: [], top: []};
  for (let w = 0; w < WEEKS; w++) {
    const seed = 7919 * w + 104729 * rows.length;
    const R = random(seed);
    const others = ['strong', 'average', 'average', 'weak', ['elite', 'strong', 'average'][w % 3]].map(skill => ({type: 'human', skill}));
    const players = [spec, ...others].map(s => makePlayer(R, s));
    const names = players.map((_, i) => `p${i}`);
    const recs = playWeek({players, hands: HANDS, seed: seed + 1, names});
    hands += recs.length;
    const by = new Map();
    for (const rec of recs) {
      for (const d of decisionsOf(rec)) {
        decisions++;
        if (!by.has(d.id)) by.set(d.id, []);
        by.get(d.id).push(d);
      }
    }
    const flagged = flaggedIds(by);
    LIMITS.NEED_BEHAVIOR = false;
    const close = flaggedIds(by);
    LIMITS.NEED_BEHAVIOR = true;
    const st = statsOf(by.get('id-p0') || []);
    row.players++;
    if (flagged.has('id-p0')) row.flagged++;
    if (close.has('id-p0')) row.close++;
    row.n.push(st.n); row.off.push(st.off / st.n); row.top.push((st.top - st.expTop) / st.n);
    // The five honest players at every table count too.
    for (let i = 1; i < players.length; i++) { honest++; if (flagged.has(`id-p${i}`)) honestFlagged++; }
  }
  rows.push(row);
}
const ms = performance.now() - t0;

console.log(`${WEEKS} weeks of ${HANDS} hands per kind: ${hands.toLocaleString()} hands, ${decisions.toLocaleString()} decisions scored, ${(ms / 1000).toFixed(1)} s with the simulation`);
console.log(`thresholds: MIN_DECISIONS ${LIMITS.MIN_DECISIONS}, OFF_RATE ${LIMITS.OFF_RATE}, TOP_SLACK ${LIMITS.TOP_SLACK}, NEED_BEHAVIOR ${LIMITS.NEED_BEHAVIOR}`);
console.log('player | flagged | play alone as close | decisions (median) | plays the solver never makes (5th, 50th, 95th) | top play against the solver’s own (5th, 50th, 95th)');
for (const r of rows) {
  console.log(`${r.label} | ${pct(r.flagged / r.players)} | ${pct(r.close / r.players)} | ${q(r.n, 0.5)} | ${pct(q(r.off, 0.05))}, ${pct(q(r.off, 0.5))}, ${pct(q(r.off, 0.95))} | ${pct(q(r.top, 0.05))}, ${pct(q(r.top, 0.5))}, ${pct(q(r.top, 0.95))}`);
}
console.log(`the other honest players at those tables: ${honestFlagged} of ${honest} flagged`);

// What scoring alone costs, over a big week.
const R = random(1);
const recs = playWeek({players: ['strong', 'average', 'average', 'weak', 'strong', 'average'].map(skill => makePlayer(R, {type: 'human', skill})), hands: 10_000, seed: 2});
const t1 = performance.now();
const by = new Map();
let n = 0;
for (const rec of recs) for (const d of decisionsOf(rec)) { n++; if (!by.has(d.id)) by.set(d.id, []); by.get(d.id).push(d); }
assistFlags(by);
const t2 = performance.now();
console.log(`scoring ${recs.length.toLocaleString()} hands (${n.toLocaleString()} decisions): ${(t2 - t1).toFixed(0)} ms, ${((1000 * (t2 - t1)) / recs.length).toFixed(0)} µs a hand`);

// Checks the thresholds of the postflop check for real-time assistance
// (#615, relay/src/postflop.js) on simulated players, scored by ducy's
// judge: how often honest players are flagged, and how often cheaters are.
//
//     node scripts/postflop-calibrate.mjs scores.jsonl [windows] [decisions]
//
// scores.jsonl is ducy's `judge_calibration` example's output (allenpiscitello/
// ducy, ducy-gto/examples): one line per decision after the flop, by kind
// of player, each playing heads-up against ducy's GTO bot. Honest players
// are ducy's bot personalities (weak to very strong) and, in Hold'em,
// EquityBot; cheaters are `solver` (playing ducy's model itself) and
// `solver-river` (solving the river itself, as a solver other than ducy's
// would). A club's window is made by drawing whole hands of one player at
// random until it has [decisions] decisions (default 400); [windows] of
// them per kind (default 2000). Part-time cheaters mix a share of solver
// hands into a strong honest player's.
//
// Prints, per kind: the share of windows flagged (LIMITS as they are), and
// the spread of each number the check uses.

import { readFileSync } from 'node:fs';
import { LIMITS, statsOf, tooClose } from '../relay/src/postflop.js';

const [file, windowsArg, sizeArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/postflop-calibrate.mjs scores.jsonl [windows] [decisions]');
  process.exit(1);
}
// Thresholds to try instead of LIMITS', from the environment: e.g.
// OFF_RATE=0.06 TOP_SLACK=0.05 node scripts/postflop-calibrate.mjs …
for (const k of Object.keys(LIMITS)) if (process.env[k]) LIMITS[k] = Number(process.env[k]);
const WINDOWS = Number(windowsArg) || 2000;
const SIZE = Number(sizeArg) || 400;

// Player → hands → decisions, in the stored form (postflop.js).
const players = new Map();
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  if (!players.has(d.player)) players.set(d.player, new Map());
  const hands = players.get(d.player);
  if (!hands.has(d.hand)) hands.set(d.hand, []);
  hands.get(d.hand).push({f: d.frequency, top: d.top, loss: d.ev_loss, lost: d.bb_lost});
}
const pools = new Map([...players].map(([p, hands]) => [p, [...hands.values()]]));

// A seeded random number generator (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One window: hands drawn from `pool`, or with chance `share` from `solver`.
function window(R, pool, solver = null, share = 0) {
  const ds = [];
  while (ds.length < SIZE) {
    const from = solver && R() < share ? solver : pool;
    ds.push(...from[Math.floor(R() * from.length)]);
  }
  return ds;
}

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const pct = x => `${(100 * x).toFixed(1)}%`;
const spread = (xs, f = pct) => `${f(q(xs, 0.05))}, ${f(q(xs, 0.5))}, ${f(q(xs, 0.95))}`;

const solvers = ['solver', 'solver-river'].filter(p => pools.has(p));
const honest = [...pools.keys()].filter(p => !solvers.includes(p)).sort();
// The honest player part-timers start from: the closest honest player, by
// median top-play rate over the model's.
const closeness = p => { const st = statsOf(pools.get(p).flat()); return (st.top - st.expTop) / st.n - st.off / st.n; };
const base = honest.length ? honest.reduce((a, b) => (closeness(b) > closeness(a) ? b : a)) : null;

const kinds = [
  ...solvers.map(s => ({label: s, pool: pools.get(s), cheat: true})),
  ...(base ? solvers.flatMap(s => [0.75, 0.5, 0.25].map(share => ({label: `${s} on ${share * 100}% of hands, else ${base}`, pool: pools.get(base), solver: pools.get(s), share, cheat: true}))) : []),
  ...honest.map(p => ({label: p, pool: pools.get(p), cheat: false})),
];

console.log(`${file}: ${[...pools].map(([p, h]) => `${p} ${h.flat().length}`).join(', ')} decisions`);
console.log(`windows of ${SIZE} decisions, ${WINDOWS} per kind; MIN_DECISIONS ${LIMITS.MIN_DECISIONS}, OFF_P ${LIMITS.OFF_P}, OFF_RATE ${LIMITS.OFF_RATE}, TOP_SLACK ${LIMITS.TOP_SLACK}, MIN_VALUED ${LIMITS.MIN_VALUED}, LOSS_RATE ${LIMITS.LOSS_RATE}`);
console.log('player | flagged | rare plays (5th, 50th, 95th) | top play over the model’s own (5th, 50th, 95th) | bb lost per decision (5th, 50th, 95th)');
let honestWindows = 0, honestFlagged = 0;
kinds.forEach((k, i) => {
  const R = random(7919 * (i + 1));
  let flagged = 0;
  const off = [], top = [], lost = [];
  for (let w = 0; w < WINDOWS; w++) {
    const st = statsOf(window(R, k.pool, k.solver, k.share));
    if (tooClose(st)) flagged++;
    off.push(st.off / st.n);
    top.push((st.top - st.expTop) / st.n);
    lost.push(st.valued ? st.lost / st.valued : 0);
  }
  if (!k.cheat) { honestWindows += WINDOWS; honestFlagged += flagged; }
  console.log(`${k.label} | ${pct(flagged / WINDOWS)} | ${spread(off)} | ${spread(top)} | ${spread(lost, x => x.toFixed(3))}`);
});
console.log(`honest players: ${honestFlagged} of ${honestWindows} windows flagged (${pct(honestFlagged / Math.max(1, honestWindows))})`);

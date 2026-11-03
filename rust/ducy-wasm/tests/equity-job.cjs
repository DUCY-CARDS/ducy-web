// The equity calculator's sampling through ducy-wasm (EquityJob and its
// helpers), with jobs shaped as main.js builds them: each job type samples,
// exact range equity answers once, totals merge, and a bomb pot deal scores
// its scoops.
//
//   cd ducy-wasm && wasm-pack build --target nodejs --out-dir pkg-node && cd ..
//   node ducy-wasm/tests/equity-job.cjs
//
// Uses only Node built-ins so it runs without `npm install`.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const pkgDir = process.env.DUCY_WASM_PKG || path.join(__dirname, "..", "pkg-node");
const { EquityJob, emptyEquityTotals, mergeEquityTotals, rangeExactCost, bombPotDealTotals } =
  require(path.join(pkgDir, "ducy_wasm.js"));

function sample(job, runs) {
  const j = new EquityJob(job);
  try {
    for (let i = 0; i < runs; i++) j.run(1000);
    return j.totals();
  } finally {
    j.free();
  }
}
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);

// Hold'em ranges: AA against KK, exact and sampled.
const range = {type: "range", numPlayers: 2, hands: [], ranges: ["AA", "KK"], boardCards: [], dead: []};
assert.ok(rangeExactCost(range) > 0);
const exact = sample({...range, exact: true}, 3);
assert.equal(exact.done, 1);
close(exact.totals[0] / exact.weight, 0.82, 0.01, "AA vs KK exact");
const mc = sample(range, 5);
assert.equal(mc.done, 5000);
close(mc.totals[0] / mc.weight, 0.82, 0.03, "AA vs KK sampled");
assert.throws(() => rangeExactCost({...range, ranges: ["AsAh", "KK"], dead: ["As"]}));

// Omaha hands with the board to come, Hi and Hi-Lo.
const omaha = {type: "omaha", numPlayers: 2, cardsPer: 4,
  hands: [["As", "Ah", "Kd", "Kc"], ["7s", "6s", "5d", "4d"]], boardCards: ["2c"], dead: []};
for (const hilo of [false, true]) {
  const t = sample({...omaha, hilo}, 2);
  assert.equal(t.done, 2000);
  close(t.totals[0] + t.totals[1], 2000, 1e-6, "Omaha shares add up");
}

// Omaha ranges against a hand.
const orange = sample({type: "orange", numPlayers: 2, cardsPer: 4,
  hands: [["As", "Ah", "Kd", "Kc"]], ranges: ["$ds"], boardCards: [], dead: []}, 1);
assert.equal(orange.done, 1000);

// A bomb pot: one known hand, one random seat, one range seat, two boards.
const bomb = {type: "bombpot", numPlayers: 3, numBoards: 2, cardsPer: 4,
  hands: [["As", "Ah", "Kd", "Kc"]], randomIndices: [1], rangeSeats: [{seat: 2, text: "QQxx"}],
  allBoardCards: [["2c", "3d", "4h"], []], dead: []};
const b = sample(bomb, 2);
assert.equal(b.done, 2000);
assert.equal(b.boardWins.length, 2);
assert.ok(b.scoops.every(x => x >= 0) && b.scooped.length === 3);

// Totals from two workers add up.
const sum = mergeEquityTotals(b, b);
assert.equal(sum.done, 4000);
assert.deepEqual(sum.scoops, b.scoops.map(x => 2 * x));
assert.deepEqual(emptyEquityTotals(bomb).boardWins, [[0, 0, 0], [0, 0, 0]]);
assert.equal(emptyEquityTotals(range).boardWins, undefined);

// One deal dealt out: seat 1 alone on both boards scoops.
const deal = bombPotDealTotals([[1], [1]], 3);
assert.deepEqual([deal.scoops, deal.scooped], [[0, 1, 0], [1, 0, 1]]);
assert.deepEqual(bombPotDealTotals([[0, 1], [1]], 2).scoops, [0, 0]);

assert.throws(() => new EquityJob({type: "nonsense", numPlayers: 1}), /unknown job type/);

console.log("equity-job: ok");

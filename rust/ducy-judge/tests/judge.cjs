// ducy-judge's JavaScript API on tiny models (#615): a six-handed hand two
// players took to the flop is scored for both of them from the flop on, by
// seat, with no cards in what comes back; hands no model covers give [].
//
//   cd ducy-judge && wasm-pack build --target nodejs --out-dir pkg-node && cd ..
//   cargo run -p ducy-gto --example tiny_model -- target/tiny-model
//   node ducy-judge/tests/judge.cjs
//
// Uses only Node built-ins so it runs without `npm install`.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const pkgDir = process.env.DUCY_JUDGE_PKG || path.join(__dirname, "..", "pkg-node");
const modelDir = process.env.DUCY_TINY_MODEL || path.join(root, "target", "tiny-model");
const judge = require(path.join(pkgDir, "ducy_judge.js"));
const model = f => fs.readFileSync(path.join(modelDir, f));

const BOARD = ["Ks", "9d", "4c", "2h", "7d"];

// A full hand record (relay/src/hand-records.js) at a table with seats 1, 3,
// 4, 6, 7 and 9, the button on seat 6, everyone `stack` chips (big blind 2):
// seat 1 opens, the button calls, the rest fold; a bet and a call on each
// street after. `cards`: each seat's.
function record({game = "nlhe", stack = 200, cards, callers = []}) {
  const seats = [1, 3, 4, 6, 7, 9];
  const a = [
    { type: "small_blind", seat: 7, amount: 1 },
    { type: "big_blind", seat: 9, amount: 2 },
    { type: "raise", seat: 1, to: 5, all_in: false },
  ];
  for (const s of [3, 4]) a.push(callers.includes(s) ? { type: "call", seat: s, amount: 5, all_in: false } : { type: "fold", seat: s });
  a.push({ type: "call", seat: 6, amount: 5, all_in: false }, { type: "fold", seat: 7 }, { type: "fold", seat: 9 });
  a.push({ type: "board", street: "flop", cards: BOARD.slice(0, 3) }, { type: "bet", seat: 1, to: 6, all_in: false }, { type: "call", seat: 6, amount: 6, all_in: false });
  a.push({ type: "board", street: "turn", cards: [BOARD[3]] }, { type: "bet", seat: 1, to: 12, all_in: false }, { type: "call", seat: 6, amount: 12, all_in: false });
  a.push({ type: "board", street: "river", cards: [BOARD[4]] }, { type: "check", seat: 1 }, { type: "check", seat: 6 });
  return {
    game, sb: 1, bb: 2, button: 6,
    seats: seats.map((seat, i) => ({ seat, cards: cards[i], stackEnd: stack, net: 0 })),
    actions: a, board: BOARD,
  };
}

const HOLDEM = [["Ah", "Kd"], ["7c", "2d"], ["9h", "8s"], ["9c", "9s"], ["8d", "5h"], ["Qs", "Qd"]];

// Nothing loaded: nothing scored.
assert.deepEqual(judge.judgeModels(), { holdem: false, plo: [] });
assert.deepEqual(judge.judgeHand(record({ cards: HOLDEM }), { flopRunouts: 4 }), []);

judge.loadHoldem(model("cards.bin"), model("blueprint.bin"));
assert.deepEqual(judge.judgeModels(), { holdem: true, plo: [] });

const scored = judge.judgeHand(record({ cards: HOLDEM }), { flopRunouts: 4 });
assert.deepEqual(scored.map(d => [d.seat, d.street]).sort(), [[1, 1], [1, 2], [1, 3], [6, 1], [6, 2], [6, 3]]);
for (const d of scored) {
  assert.deepEqual(Object.keys(d).sort(), ["bbLost", "evLoss", "frequency", "seat", "stderr", "street", "top"]);
  assert.ok(d.frequency >= 0 && d.frequency <= d.top + 1e-9, JSON.stringify(d));
  assert.ok(d.evLoss >= 0, JSON.stringify(d));
}
// No card in what comes back.
const text = JSON.stringify(scored);
for (const c of [...HOLDEM.flat(), ...BOARD]) assert.ok(!text.includes(c), c);
// The same hand scores the same way again.
assert.deepEqual(judge.judgeHand(record({ cards: HOLDEM }), { flopRunouts: 4 }), scored);

// Three at the flop, stacks far from 100 big blinds, a game without a
// model, or a record that doesn't read: nothing.
assert.deepEqual(judge.judgeHand(record({ cards: HOLDEM, callers: [3] }), {}), []);
assert.deepEqual(judge.judgeHand(record({ cards: HOLDEM, stack: 1000 }), {}), []);
assert.deepEqual(judge.judgeHand(record({ cards: HOLDEM, game: "stud" }), {}), []);
const broken = record({ cards: HOLDEM });
broken.actions.push({ type: "shrug", seat: 1 });
assert.deepEqual(judge.judgeHand(broken, {}), []);

// PLO: frequencies only. The tiny model is 10 big blinds deep.
judge.loadPlo(model("plo-cards.bin"), model("plo-blueprint.bin"), 10n);
assert.deepEqual(judge.judgeModels(), { holdem: true, plo: [4] });
const PLO = [["Ah", "Kd", "Qs", "Jc"], ["7c", "2d", "3s", "4h"], ["9h", "8s", "6d", "5d"], ["9c", "9s", "8h", "7h"], ["8d", "5h", "Tc", "Td"], ["Qd", "Qh", "Jd", "Js"]];
const plo = judge.judgeHand(record({ game: "plo4", stack: 20, cards: PLO }), {});
assert.ok(plo.length > 0);
for (const d of plo) {
  assert.ok([1, 6].includes(d.seat) && d.street >= 1 && d.street <= 3, JSON.stringify(d));
  assert.equal(d.evLoss, null);
}
// No five-card model loaded.
assert.deepEqual(judge.judgeHand(record({ game: "plo5", stack: 20, cards: PLO.map(h => [...h, "2c"]) }), {}), []);

console.log("ducy-judge: ok");

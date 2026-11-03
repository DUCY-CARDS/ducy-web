// The range trainer's practice through ducy-wasm's `training` op, as
// trainer.js calls it: a session started the page's way, answered, and the
// answer put on the saved record (recordAnswer).
//
//   cd ducy-wasm && wasm-pack build --target nodejs --out-dir pkg-node && cd ..
//   node ducy-wasm/tests/training.cjs
//
// Uses only Node built-ins so it runs without `npm install`.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const pkgDir = process.env.DUCY_WASM_PKG || path.join(__dirname, "..", "pkg-node");
const { training } = require(path.join(pkgDir, "ducy_wasm.js"));

// A session as trainer.js's startPractice makes it.
let pr = {key: "holdem:20", baseKey: "holdem:20", drill: null, sessionId: "s1",
  cards: 2, pct: 20, score: 10, best: 10, startScore: 10,
  total: 0, answered: 0, correct: 0, streak: 0, history: [], tagStats: {},
  feedback: null, delta: 0, mastered: false};
pr.current = training({op: "practiceNext", pr, seed: 7});
pr = training({op: "practiceAnswer", pr, yes: true});
const {tags, correct} = pr.history.at(-1);

const rec = training({op: "recordAnswer", rec: {score: 10, model: "m"}, pr, tags, correct, now: 1000});
assert.equal(rec.model, "m");
assert.ok(tags.length > 0);
for (const t of tags) {
  assert.deepEqual(rec.kinds[t], {seen: 1, wrong: correct ? 0 : 1, recent: correct ? "1" : "0"});
}
assert.deepEqual(rec.sessions, [{id: "s1", at: 1000, drill: null, hands: 1, correct: correct ? 1 : 0, from: 10, to: pr.score}]);

// A record that isn't one starts fresh.
assert.equal(training({op: "recordAnswer", rec: null, pr, tags, correct, now: 1}).sessions.length, 1);

console.log("training: ok");

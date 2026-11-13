// A club table's ante (ClubTable.create's `ante`, ducy-web #655): every
// player posts it every hand, with the blinds; a hand that ends before the
// flop still isn't raked (no flop, no drop); a saved table keeps it.
//
//   cd ducy-wasm && wasm-pack build --target nodejs --out-dir pkg-node && cd ..
//   node ducy-wasm/tests/club-ante.cjs
//
// Uses only Node built-ins so it runs without `npm install`.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const pkgDir = process.env.DUCY_WASM_PKG || path.join(__dirname, "..", "pkg-node");
const { ClubTable } = require(path.join(pkgDir, "ducy_wasm.js"));

let now = 1000;
const t = () => (now += 10);
const results = step => step.actions.filter(a => a.type === "engine").map(a => a.res);
function runUntil(table, step, done) {
  for (let i = 0; i < 200 && step.wake != null; i++) {
    now = Math.max(now, step.wake);
    step = table.event({ type: "wake" }, now);
    if (done(step)) return step;
  }
  return null;
}

// Blinds 1.50/3.25 and an ante of 0.25 (hundredths), 5% rake capped at 4 BB.
const config = {
  seats: 6, minBuyIn: 3250, maxBuyIn: 32500, sb: 150, bb: 325, ante: 25, seed: 7, turnMs: 0,
  charge: { percent: 500, capBB: 400 },
};
const table = ClubTable.create("t1", config);
const ids = ["ann", "bo", "cy"];
const cmd = (id, c) => table.event({ type: "cmd", id, cmd: c, online: true }, t());
let step;
for (const [seat, id] of ids.entries()) {
  cmd(id, { type: "join", name: id });
  cmd(id, { type: "request_chips", amount: 10000 });
  step = table.event({ type: "chips", seat, ok: true }, t());
}
// Dealt as soon as enough are in (each one's fair-deal answer timed out).
const inHand = s => results(s).some(r => r.state.hand_number >= 1 && !r.state.complete);
step = inHand(step) ? step : runUntil(table, step, inHand);
assert.ok(step, "a hand is dealt");
let r = results(step).filter(x => !x.state.complete).pop();
assert.equal(r.state.ante, 25, "the table's ante");
const posts = type => r.state.events.filter(e => e.type === type);
assert.equal(posts("ante").length, 3, "everyone antes");
assert.ok(posts("ante").every(e => e.amount === 25));
assert.deepEqual([posts("small_blind")[0].amount, posts("big_blind")[0].amount], [150, 325]);
// 3 antes and the blinds.
assert.equal(r.state.pot, 3 * 25 + 150 + 325);

// Everyone folds to the big blind: no flop, no drop, so the antes and blinds
// all go back to them, and the stacks still add up to what was bought in.
const seq = () => r.seq;
while (!r.state.complete) {
  const id = ids[r.state.to_act];
  step = cmd(id, { type: "act", seq: seq(), kind: "fold", amount: 0 });
  r = results(step).pop();
}
const total = r.state.seats.reduce((n, s) => n + (s.empty ? 0 : s.stack), 0);
assert.equal(total, 3 * 10000, "nothing raked before the flop");

// Saved and restored: still the same ante.
const saved = table.save(t());
const back = ClubTable.restore("t1", saved, config, t());
r = results(back.event({ type: "state" }, t())).pop();
assert.equal(r.state.ante, 25);
back.free();
table.free();

// No ante given: none.
const { ante: _, ...noAnte } = config;
const plain = ClubTable.create("t2", noAnte);
r = results(plain.event({ type: "state" }, t())).pop();
assert.equal(r.state.ante, 0);
plain.free();
console.log("ok");

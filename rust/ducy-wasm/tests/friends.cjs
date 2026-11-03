// Smoke test for friends tables (ClubTable.friends: the table runner with
// the host in seat 0, ducy-web #462) in the ducy-wasm JavaScript API: empty
// seats, chip requests the host approves, the host dealing and playing,
// fair deals, auto-deal, saving and resuming, leaving.
//
//   cd ducy-wasm && wasm-pack build --target nodejs --out-dir pkg-node && cd ..
//   node ducy-wasm/tests/friends.cjs
//
// Uses only Node built-ins so it runs without `npm install`.

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const pkgDir = process.env.DUCY_WASM_PKG || path.join(__dirname, "..", "pkg-node");
const { ClubTable, MultiTable } = require(path.join(pkgDir, "ducy_wasm.js"));

let now = 1000;
const t = () => (now += 10);
const results = step => step.actions.filter(a => a.type === "engine").map(a => a.res);
const sends = step => step.actions.filter(a => a.type === "send");
const toAnnOf = step => results(step).flatMap(r => r.out).filter(m => m.to === "ann").map(m => m.data);
// Wakes the table whenever it asks, until `done(step)` or it stops asking.
function runUntil(table, step, done) {
  for (let i = 0; i < 100 && step.wake != null; i++) {
    now = Math.max(now, step.wake);
    step = table.event({ type: "wake" }, now);
    if (done(step)) return step;
  }
  return null;
}
const dealt = step => results(step).some(r => !r.state.complete);

// 6 seats, the host with 200 chips, buy-ins from 40 to 200, blinds 1/2.
const host = ClubTable.friends("f", { seats: 6, hostName: "Host", hostChips: 200, minBuyIn: 40, maxBuyIn: 200, sb: 1, bb: 2, seed: 3, turnMs: 0 });
let step = host.event({ type: "state" }, t());
let r = results(step).pop();
assert.equal(r.state.seats.length, 6);
assert.ok(r.state.seats.slice(1).every(s => s.empty), "empty seats");
assert.equal(r.playersIn, 1);
assert.deepEqual(r.buyIn, { min: 40, max: 200 });
assert.equal(results(host.event({ type: "deal" }, t())).length, 0, "no one to deal to");

// Ann joins with no chips and asks for some.
const ann = (cmd, online) => host.event({ type: "cmd", id: "ann", cmd, online }, t());
step = ann({ type: "join", name: "Ann" }, true);
assert.ok(toAnnOf(step).some(d => d.type === "welcome" && d.seat === 1));
step = ann({ type: "request_chips", amount: 500 });
assert.ok(toAnnOf(step).some(d => d.type === "rejected"), "too many chips");
step = ann({ type: "request_chips", amount: 120 });
r = results(step).pop();
assert.deepEqual(r.chipRequests.map(q => [q.seat, q.name, q.amount]), [[1, "Ann", 120]]);
assert.deepEqual(toAnnOf(step).filter(d => d.type === "state").pop().chips, { min: 40, max: 200, requested: 120, approved: 0 });
r = results(host.event({ type: "chips", seat: 1, ok: true }, t())).pop();
assert.equal(r.chipRequests.length, 0);
assert.equal(r.playersIn, 2);

// The host deals: Ann is asked into the fair-deal round first. She doesn't
// answer, so once its time is up the hand is dealt from the host's value.
step = host.event({ type: "deal" }, t());
assert.ok(sends(step).some(a => a.to === "ann" && a.update.step === "commit"));
step = runUntil(host, step, dealt);
assert.ok(step, "dealt");
r = results(step).find(x => !x.state.complete);
assert.match(r.seed, /^[0-9a-f]{64}$/);
assert.equal(r.state.seats[1].stack + r.state.seats[1].street_bet, 120);
assert.ok(r.state.seats.slice(2).every(s => s.empty));

// The host's own move that doesn't count says so.
step = host.event({ type: "host", cmd: { type: "chips", amount: 1000 } }, t());
assert.ok(step.actions.some(a => a.type === "refused"));

// They play it out; Ann gets the deal to check, her cards second (the
// host's seat was dealt first).
let annView = toAnnOf(step).filter(d => d.type === "state").pop()?.view;
while (!r.state.complete) {
  if (r.state.legal) {
    step = host.event({ type: "host", cmd: { type: "act", kind: r.state.legal.can_check ? "check" : "call" } }, t());
  } else {
    step = ann({ type: "act", seq: r.seq, kind: annView.legal.can_check ? "check" : "call", amount: 0 });
  }
  r = results(step).pop();
  annView = toAnnOf(step).filter(d => d.type === "state").pop()?.view || annView;
}
const result = sends(step).find(a => a.to === "ann" && a.update.step === "result");
assert.deepEqual([result.update.index, result.update.dealt], [1, 2]);

// Auto-deal: the next hand a second after this one.
step = host.event({ type: "autoDeal", on: true, afterMs: 1000 }, t());
assert.equal(step.dealAt, now + 1000);

// Saved, and restored after a restart: it waits for Ann, then goes on.
const friendsSaved = host.save(t());
const resumed = ClubTable.restoreFriends("f", friendsSaved, {}, t());
assert.ok(resumed.event({ type: "state" }, t()).paused);
assert.ok(!resumed.event({ type: "presence", id: "ann", on: true }, t()).paused);
resumed.free();

// Ann leaves: her seat is empty again, and only the host is left.
step = ann({ type: "leave" });
r = results(step).pop();
assert.equal(r.playersIn, 1);
assert.ok(r.state.seats[1].empty);
host.free();

// Saved mid-hand and restored, as after the host's browser restarts: the
// same hand, paused until people are back.
const club = MultiTable.club(4, 40n, 200n, 1n, 2n, 5n, undefined, 30000n);
for (const [seat, id] of ["ann", "bo"].entries()) {
  club.handle(id, { type: "join", name: id }, t());
  club.handle(id, { type: "request_chips", amount: 100 }, t());
  club.approveChips(seat, t());
}
const before = club.newHand(t()).state;
const saved = club.save(t());
assert.throws(() => MultiTable.restore(saved.replace('"version":1', '"version":99'), t()));
const back = MultiTable.restore(saved, t());
assert.ok(back.isPaused());
r = back.state(t());
assert.deepEqual([r.state.hand_number, r.state.pot, r.state.to_act], [before.hand_number, before.pot, before.to_act]);
assert.equal(r.turnMsLeft, 30000 - 10, "the clock stood still");
for (const id of ["ann", "bo"]) r = back.handle(id, { type: "join", name: id }, t());
const cards = id => r.out.filter(m => m.to === id && m.data.type === "state").pop().data.view.seats[0].cards;
assert.equal(cards("ann").length, 2, "they get their cards back");
r = back.resume(t());
assert.ok(!back.isPaused());

// The time bank: a minute more on the clock for whoever's turn it is.
const toAct = ["ann", "bo"][r.state.to_act];
const myStatus = res => res.out.filter(m => m.to === toAct && m.data.type === "state").pop().data.me;
const left = r.turnMsLeft;
r = back.handle(toAct, { type: "time_bank" }, t());
assert.equal(myStatus(r).time_bank_on, true);
assert.equal(myStatus(r).time_bank_ms, 0);
assert.ok(r.turnMsLeft >= left + 60000 - 20, `the clock got the bank (${left} → ${r.turnMsLeft})`);
console.log("ok");

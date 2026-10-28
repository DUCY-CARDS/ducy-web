// A club table's hit-and-run rule in the host (src/club-host.js), on ducy's
// engine: a member who is up keeps hearing how many hands they owe, and a
// leave before then is refused. Needs the wasm build in wasm/.
// Run with: node --test test/hit-and-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, totals } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test('up at a table with the rule, a member plays its hands before leaving', {skip: !haveWasm && 'no wasm build'}, async tc => {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ['ann', 'bob']) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0});
  t.stayHands = 2;
  const engine = clubEngine();
  // Ann goes all in whenever it's her turn and Bob folds, so Ann wins every hand.
  const stays = [];
  let host = null;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    if (u.type === 'stay' && to === 'ann') stays.push(u);
    if (u.type === 'state' && u.view.legal && !u.view.complete) {
      host.handle(t.id, to, {type: 'act', seq: u.seq, kind: to === 'ann' ? 'allin' : 'fold', amount: 0});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args), nextHandMs: 50,
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await host.start(t);
  tc.after(() => host.close(t.id));
  for (const id of ['ann', 'bob']) {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
    await until(`${id} seated`, () => club.members[id].seat?.stack === 150);
  }
  // A hand won: she owes 2 hands, and is told.
  const owed = await until('Ann told she owes hands', () => stays.find(s => s.hands > 0));
  assert.equal(owed.hands, 2);
  // Leaving now is refused, and she stays seated.
  await host.handle(t.id, 'ann', {type: 'leave'});
  await until('the leave refused', () => stays.some(s => s.refused));
  assert.ok(stays.find(s => s.refused).hands > 0);
  assert.ok(club.members.ann.seat, 'still seated');
  // Counted down as she plays, then free to go.
  await until('Ann free to go', () => stays.at(-1).hands === 0);
  assert.deepEqual(stays.filter(s => !s.refused).map(s => s.hands), [0, 2, 1, 0]);
  await host.handle(t.id, 'ann', {type: 'leave'});
  await until('Ann left', () => !club.members.ann.seat);
  assert.ok(club.members.ann.balance > 1000, 'she left with her winnings');
  assert.ok(totals(club).conserved);
});

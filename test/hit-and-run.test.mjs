// A club table's hit-and-run rule in the host (src/club-host.js): a member
// who is up keeps hearing how many hands they owe, and a leave before then is
// refused. Run with: node --test test/hit-and-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// A play worker that answers every table call with the state the test sets.
const calls = [];
let reply = {complete: true, hand_number: 2, chips: 140};
globalThis.Worker = class {
  postMessage({id, op, args}) {
    if (op === 'clubCall') calls.push({method: args[1], cmd: args[3]});
    const result = op === 'clubCall'
      ? {out: [], state: {complete: reply.complete, hand_number: reply.hand_number}, players: [{client_id: 'ann', seat: 0, chips: reply.chips}], turnMsLeft: null, seq: calls.length}
      : true;
    queueMicrotask(() => this.onmessage({data: {id, result}}));
  }
};

const { createTableHost } = await import('../src/club-host.js');

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => queueMicrotask(r)); };

test('up at a table with the rule, a member plays its hands before leaving', async () => {
  const table = {id: 't1', name: 'One', seats: 6, sb: 1, bb: 2, game: 'nlhe', turnSecs: 0, status: 'open', minBB: 20, maxBB: 100, stayHands: 5};
  const club = {
    code: 'ABCD-EFGH', tables: [table], chips: {ledger: []},
    members: {ann: {id: 'ann', name: 'Ann', status: 'member', balance: 900, seat: {table: 't1', stack: 100, put: 100}}},
  };
  const sent = [];
  const th = createTableHost({
    club: () => club, save() {}, chipsChanged() {}, tablesChanged() {},
    sendTable: (to, msg) => sent.push({to, ...msg.update}),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
    timers: {set: () => 0, clear() {}},
  });
  await th.start(table);
  await th.handle('t1', 'ann', {type: 'hello'});
  await settle();
  // Hand 2 ended with Ann up 40: she owes 5 hands, and is told.
  const stays = () => sent.filter(m => m.type === 'stay');
  assert.deepEqual(stays().at(-1), {to: 'ann', type: 'stay', hands: 5});
  // Leaving now is refused, and never reaches the table.
  await th.handle('t1', 'ann', {type: 'leave'});
  await settle();
  assert.deepEqual(stays().at(-1), {to: 'ann', type: 'stay', hands: 5, refused: true});
  assert.ok(!calls.some(c => c.cmd?.type === 'leave'), 'the engine never saw the leave');
  // Three hands on, two to go.
  reply = {complete: true, hand_number: 5, chips: 150};
  await th.handle('t1', 'ann', {type: 'hello'});
  await settle();
  assert.deepEqual(stays().at(-1), {to: 'ann', type: 'stay', hands: 2});
  // Hand 7 played: free to go, and the leave goes through.
  reply = {complete: true, hand_number: 7, chips: 150};
  await th.handle('t1', 'ann', {type: 'hello'});
  await settle();
  assert.deepEqual(stays().at(-1), {to: 'ann', type: 'stay', hands: 0});
  await th.handle('t1', 'ann', {type: 'leave'});
  await settle();
  assert.ok(calls.some(c => c.cmd?.type === 'leave'), 'the leave reached the table');
});

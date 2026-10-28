// Credit players (#404) in the club's host: the owner's commands (set a
// limit, raise it for a request at the limit, settle debt), what the member
// hears, and a table's chip requests on credit. Needs the wasm build in
// wasm/. Run with: node --test test/club-credit-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { buyIn, cashOut, setStack, totals } from '../src/club-chips.js';
import { createTableHost } from '../src/club-host.js';
import { clubEngine } from '../src/club-engine.js';

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}

// Signed messages go out after signing: a moment for them.
const wait = () => new Promise(r => setTimeout(r, 150));

test('the owner sets a limit, answers a request at it by raising it, and records a settlement', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CRED-ITPL';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Credit'}), code);
  const sent = [];
  const server = await openClub({storage, send: (to, data) => sent.push({to, data}), online: [], timers: {set: () => 0, clear() {}}});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ann]) await server.message({from: p.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  let n = 1;
  const cmd = async (op, args) => {
    const id = n++;
    await say(owner, {type: 'owner_cmd', op, args, id});
    await wait();
    return sent.filter(s => s.to === owner.id && s.data.body?.type === 'owner_result' && s.data.body.id === id).at(-1).data.body;
  };
  const lastAccount = () => sent.filter(s => s.to === ann.id && s.data.body?.type === 'account').at(-1)?.data.body;
  await say(ann, {type: 'join', invite, name: 'Ann'});
  assert.equal((await cmd('approve', {id: ann.id})).error, '');

  assert.match((await cmd('set_credit', {id: ann.id, amount: -5})).error, /whole number/);
  assert.equal((await cmd('set_credit', {id: ann.id, amount: 50000})).error, '');
  assert.deepEqual([lastAccount().credit, lastAccount().available, lastAccount().balance], [50000, 50000, 0], 'she hears her limit');

  // She sits with all of it on credit and loses it (the table's side, as club-host.js does it).
  const club = server.club;
  buyIn(club, ann.id, 't1', 50000, {min: 1, max: 50000});
  setStack(club, ann.id, 0);
  cashOut(club, ann.id);
  // From the table, she asks the manager for more.
  await say(ann, {type: 'chip_request', amount: 20000, note: 'one more', table: 't1'});
  await wait();
  assert.equal(lastAccount().request.atLimit, true);
  assert.match((await cmd('grant', {id: ann.id})).error, /at their credit limit: raise it, or say no/);
  assert.equal(club.members[ann.id].balance, -50000, 'no chips given past the limit');
  assert.match((await cmd('raise_credit', {id: ann.id, amount: 50000})).error, /Raise the limit above 500/);
  assert.equal((await cmd('raise_credit', {id: ann.id, amount: 70000})).error, '');
  assert.deepEqual([lastAccount().credit, lastAccount().available, lastAccount().request], [70000, 20000, null]);
  assert.deepEqual([lastAccount().answer.outcome, lastAccount().answer.given, lastAccount().answer.limit], ['granted', 20000, 70000]);

  // She pays some of it back outside ducy; the owner records it.
  assert.match((await cmd('settle_debt', {id: ann.id, amount: 60000})).error, /owes 500/);
  assert.equal((await cmd('settle_debt', {id: ann.id, amount: 30000, note: 'cash'})).error, '');
  const a = lastAccount();
  assert.equal(a.balance, -20000);
  assert.equal(a.available, 50000);
  assert.deepEqual(a.entries.map(e => [e.kind, e.amount, e.note]), [['settle', 30000, 'cash']]);
  assert.equal(totals(club).owedToClub, 20000);
});

// A table's chip requests on credit, on ducy's engine.
test('at a table: a buy-in on credit is approved; past what is available, refused with an offer to ask', async t => {
  const table = {id: 't1', name: 'One', seats: 6, sb: 1, bb: 2, game: 'nlhe', turnSecs: 0, status: 'open', minBB: 20, maxBB: 100};
  const club = {
    code: 'ABCD-EFGH', tables: [table], chips: {issued: 0, reclaimed: 0, next: 1, ledger: []}, ratholeHours: 0,
    members: {
      ann: {id: 'ann', name: 'Ann', status: 'member', balance: 0, credit: 300},
      bob: {id: 'bob', name: 'Bob', status: 'member', balance: 0, credit: 100},
    },
  };
  const sent = [], changed = [];
  const engine = clubEngine();
  const th = createTableHost({
    club: () => club, save() {}, chipsChanged: id => changed.push(id), tablesChanged() {}, onHand() {},
    call: async (op, ...args) => engine.ops[op](...args),
    sendTable: (to, msg) => sent.push({to, ...msg.update}),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  await th.start(table);
  t.after(() => th.close(table.id));
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 0)); };
  await th.handle('t1', 'ann', {type: 'join'});
  await th.handle('t1', 'ann', {type: 'request_chips', amount: 200});
  await settle();
  assert.equal(club.members.ann.seat?.stack, 200);
  assert.deepEqual(changed, ['ann']);
  assert.equal(club.members.ann.balance, -200);
  assert.equal(club.chips.ledger.at(-1).credit, 200);
  await th.handle('t1', 'bob', {type: 'join'});
  await th.handle('t1', 'bob', {type: 'request_chips', amount: 150});
  await settle();
  assert.deepEqual(sent.filter(m => m.to === 'bob' && m.type === 'rejected').at(-1), {to: 'bob', type: 'rejected', reason: 'You have 1 available (your chips and credit).', chips: true, ask: true});
  assert.equal(club.members.bob.seat?.stack ?? 0, 0);
  assert.equal(club.members.bob.balance, 0);
});

// An always-on club (#93) run by the relay's club room, in Node, with the
// real engine: created by its owner, joined, run by the owner's commands,
// and picked up again from storage as after the room restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createIdentity, signMessage, checkSignature } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';

const WASM = new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url);
const haveWasm = existsSync(WASM);

async function engine() {
  const m = await import('../wasm/ducy_wasm.js');
  m.initSync({module: readFileSync(WASM)});
  return m.MultiTable;
}

// A room's storage, as the dev relay keeps it: values copied in and out.
function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

// Messages the room sent each member, checked as signed by the club.
function inbox(hostId) {
  const got = new Map();
  // As on the wire: what was sent, then (later changes to the club don't show).
  const send = (to, data) => { if (!got.has(to)) got.set(to, []); got.get(to).push(JSON.parse(JSON.stringify(data))); };
  const bodies = async (to, type) => {
    const out = [];
    for (const env of got.get(to) || []) {
      if (env.type === 'table') continue; // encrypted table updates
      assert.ok(!(await checkSignature(env)), 'signed');
      assert.equal(env.from, hostId, 'by the club');
      if (!type || env.body.type === type) out.push(env.body);
    }
    return out;
  };
  return {send, bodies, got};
}

const settle = () => new Promise(r => setTimeout(r, 50));

test('an always-on club: created by its owner, joined, run by signed commands, and reopened from storage', {skip: !haveWasm && 'no wasm build'}, async () => {
  const MultiTable = await engine();
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CLUB-TEST';

  // The owner asks for the club.
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Always On'}), code);
  assert.notEqual(hostId, owner.id, 'the club signs as itself');
  await assert.rejects(createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Again'}), code), /in use/);

  let box = inbox(hostId);
  let server = await openClub({storage, send: box.send, online: [], MultiTable});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});

  // Ann asks to join; someone else can't run the club.
  await server.message({from: ann.id, event: 'open'});
  await say(ann, {type: 'join', invite, name: 'Ann'});
  assert.equal(server.club.members[ann.id].status, 'pending');
  await say(ann, {type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1});
  assert.equal(server.club.members[ann.id].status, 'pending', 'only the owner runs the club');

  // The owner approves her and gives her chips.
  await server.message({from: owner.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 2});
  await say(owner, {type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: 500}, id: 3});
  await say(owner, {type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: -5}, id: 4});
  await say(owner, {type: 'owner_cmd', op: 'new_table', args: {table: {name: 'Main', sb: 1, bb: 2}}, id: 5});
  await settle();
  const results = await box.bodies(owner.id, 'owner_result');
  assert.deepEqual(results.map(r => [r.id, !!r.error]), [[2, false], [3, false], [4, true], [5, false]]);
  assert.equal(typeof results.at(-1).value, 'string', 'new_table returns the table id');
  assert.equal(server.club.members[ann.id].status, 'member');
  assert.equal(server.club.members[ann.id].balance, 500);
  const views = await box.bodies(owner.id, 'owner_view');
  assert.ok(views.length, 'the owner gets the club');
  assert.equal(views.at(-1).data.members[ann.id].balance, 500);
  assert.deepEqual(views.at(-1).running, [results.at(-1).value], 'the table runs in the room');
  assert.ok((await box.bodies(ann.id, 'account')).length, 'Ann hears about her chips');

  // The room restarts: everything comes back from storage.
  await server.flush();
  box = inbox(hostId);
  server = await openClub({storage, send: box.send, online: [owner.id, ann.id], MultiTable});
  assert.equal(server.club.members[ann.id].balance, 500);
  assert.equal(server.club.tables.length, 1);
  await say(ann, {type: 'hello'});
  await settle();
  assert.ok((await box.bodies(ann.id, 'tables')).length, 'Ann gets the tables after the restart');
  // Her old messages can't be replayed: the verifier came back too.
  const old = await signMessage(ann, {club: code, type: 'cancel_request'});
  old.seq = 1;
  assert.equal((await server.message({from: ann.id, data: old})), undefined);
  assert.ok(storage.keys().includes('identity') && storage.keys().includes('hostKey'));
});

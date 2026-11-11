// An always-on club (#93) run by the relay's club room, in Node, with the
// real engine: created by its owner, joined, run by the owner's commands,
// and picked up again from storage as after the room restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createIdentity, signMessage, checkSignature } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';

const WASM = new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url);
const haveWasm = existsSync(WASM);

async function engine() {
  const m = await import('../wasm/ducy_wasm.js');
  m.initSync({module: readFileSync(WASM)});
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
  await engine();
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CLUB-TEST';

  // The owner asks for the club.
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Always On'}), code);
  assert.notEqual(hostId, owner.id, 'the club signs as itself');
  await assert.rejects(createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Again'}), code), /in use/);

  let box = inbox(hostId);
  let server = await openClub({storage, send: box.send, online: []});
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
  server = await openClub({storage, send: box.send, online: [owner.id, ann.id]});
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

test('the float (#589): gives stop at it, a refill and a raise wait, and a restart changes neither', {skip: !haveWasm && 'no wasm build'}, async () => {
  await engine();
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CAPS-TEST';
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Floated'}), code);
  let box = inbox(hostId);
  let server = await openClub({storage, send: box.send, online: [owner.id]});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  await server.message({from: ann.id, event: 'open'});
  await say(ann, {type: 'join', invite, name: 'Ann'});
  let n = 0;
  const cmd = async (op, args = {}) => {
    await say(owner, {type: 'owner_cmd', op, args, id: ++n});
    await settle();
    return (await box.bodies(owner.id, 'owner_result')).find(r => r.id === n);
  };
  await cmd('approve', {id: ann.id});
  // A new club's float: the default, filled as it starts.
  assert.equal(server.club.float.size, 200_000);
  assert.equal(server.club.money.float, 200_000);
  assert.equal((await cmd('float_size', {amount: 100_000})).error, '');
  assert.equal(server.club.money.float, 100_000, 'what was over it went back to the vault');
  assert.equal((await cmd('give', {id: ann.id, amount: 60_000})).error, '');
  assert.equal((await cmd('give', {id: ann.id, amount: 50_000})).error, 'That’s more than the float: 400 left. Refill it.');
  assert.equal((await cmd('float_size', {amount: 500_000})).error, '');
  assert.equal(server.club.float.raise.to, 500_000, 'a raise waits');
  assert.equal((await cmd('refill')).error, '');
  assert.equal((await cmd('give', {id: ann.id, amount: 60_000})).error, '');
  assert.deepEqual((await cmd('refill')).value, {waiting: true, applies: server.club.float.wait.at + 864e5}, 'a second refill waits');

  // The room restarts: the float, the raise and the refill waiting are as they were.
  await server.flush();
  box = inbox(hostId);
  server = await openClub({storage, send: box.send, online: [owner.id]});
  assert.equal(server.club.float.size, 100_000);
  assert.equal(server.club.float.raise.to, 500_000);
  assert.ok(server.club.float.wait);
  assert.match((await cmd('give', {id: ann.id, amount: 50_000})).error, /400 left/);
  // The owner hears of the float set lower, the refill, and a give over a full buy-in.
  const notes = server.club.log.filter(l => l.notice).map(l => l.text);
  assert.deepEqual(notes, ['Float set to 1,000', 'Gave Ann 600', 'Refilled the float: +600', 'Gave Ann 600']);
  assert.equal((await cmd('cancel_float_raise')).error, '');
  assert.equal(server.club.float.raise, undefined);
  assert.equal((await cmd('cancel_refill')).error, '');
  assert.equal(server.club.float.wait, undefined);
  // The books add up.
  const {totals} = await import('../src/club-chips.js');
  assert.ok(totals(server.club).conserved);
});

test('an agent’s player has a vault; the agent’s take back reaches it, with notices (#579)', {skip: !haveWasm && 'no wasm build'}, async () => {
  await engine();
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity(), bo = await createIdentity();
  const code = 'AGNT-VALT';
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Agents'}), code);
  const box = inbox(hostId);
  const server = await openClub({storage, send: box.send, online: [owner.id]});
  const say = async (who, body) => { await server.message({from: who.id, data: await signMessage(who, {club: code, ...body})}); await settle(); };
  for (const [who, name] of [[ann, 'Ann'], [bo, 'Bo']]) {
    await server.message({from: who.id, event: 'open'});
    await say(who, {type: 'join', invite, name});
    await server.run('approve', {id: who.id});
  }
  await server.run('offer_agent', {id: ann.id});
  await say(ann, {type: 'agent_reply', accept: true});
  await server.run('assign_agent', {id: bo.id, agent: ann.id});
  await say(ann, {type: 'agent_cmd', cmd: {op: 'give', id: bo.id, amount: 80_000}});
  // Bo's vault, on his link with Ann.
  await say(bo, {type: 'vault', op: 'in', amount: 50_000});
  assert.equal(server.club.members[bo.id].vault, 50_000);
  await say(bo, {type: 'vault', op: 'out', amount: 30_000});
  // Ann sees his vault, not what he asked to take out (her view goes out
  // at most every 200 ms).
  await new Promise(r => setTimeout(r, 300));
  const view = (await box.bodies(ann.id, 'agent')).at(-1);
  assert.equal(view.players[0].vault, 50_000);
  assert.ok(!JSON.stringify(view).includes('outs'));
  // Her take back: his balance, then his vault.
  await say(ann, {type: 'agent_cmd', cmd: {op: 'take', id: bo.id, amount: 70_000}});
  assert.equal(server.club.members[bo.id].balance, 0);
  assert.equal(server.club.members[bo.id].vault, 10_000);
  const acc = (await box.bodies(bo.id, 'account')).at(-1);
  assert.equal(acc.vault.taken.amount, 40_000);
  assert.equal(acc.vault.outs[0].amount, 10_000);
  assert.ok(server.club.log.some(l => l.notice && l.text === 'Bo’s agent Ann took 400 back from their vault'));
  const {totals} = await import('../src/club-chips.js');
  assert.ok(totals(server.club).conserved);
});

test('the owner deletes an always-on club (#98): members are told, storage is wiped, usage reported', {skip: !haveWasm && 'no wasm build'}, async () => {
  await engine();
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'GONE-SOON';
  const claimed = [];
  const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Short Lived'}), code, async (o, c) => claimed.push([o, c]));
  assert.deepEqual(claimed, [[owner.id, code]], 'the registry was asked');
  const box = inbox(hostId);
  let deleted = 0;
  const used = [];
  const server = await openClub({storage, send: box.send, online: [owner.id, ann.id], onDeleted: () => { deleted++; }, onUsage: m => used.push(m)});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  await say(ann, {type: 'join', invite, name: 'Ann'});
  await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1});

  // Seated players hold up deletion. Being seated isn't play time: only
  // hands in play are (#421, playClock below).
  server.club.members[ann.id].seat = {table: 't', stack: 100};
  await say(owner, {type: 'owner_cmd', op: 'settings', args: {sitOutMins: 5}, id: 2});
  await say(owner, {type: 'owner_cmd', op: 'delete_club', id: 3});
  server.club.members[ann.id].seat = null;
  await say(owner, {type: 'owner_cmd', op: 'settings', args: {sitOutMins: 10}, id: 4});
  assert.equal(used.length, 0, 'no hands, no play time');
  await say(owner, {type: 'owner_cmd', op: 'delete_club', id: 5});
  await settle();
  const results = await box.bodies(owner.id, 'owner_result');
  assert.match(results.find(r => r.id === 3).error, /at tables/);
  assert.equal(results.find(r => r.id === 5).error, '');
  assert.equal(deleted, 1);
  assert.equal((await box.bodies(ann.id, 'status')).at(-1).status, 'closed', 'Ann is told the club closed');
  assert.deepEqual(storage.keys(), [], 'nothing is left in the room');
});

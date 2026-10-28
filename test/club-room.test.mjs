// An always-on club (#93) run by the relay's club room, in Node, with the
// real engine: created by its owner, joined, run by the owner's commands,
// and picked up again from storage as after the room restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createIdentity, signMessage, checkSignature } from '../src/identity.js';
import { createClub, importClub, openClub } from '../relay/src/club-room.js';

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

test('a browser-run club moves to its room (#98): balances kept, members follow the handoff', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {newClub, approve, newMembership, playerReceive, hostReceive} = await import('../src/club.js');
  const {issue, totals} = await import('../src/club-chips.js');
  const {Verifier} = await import('../src/identity.js');
  await engine();
  const host = await createIdentity(), ann = await createIdentity(), eve = await createIdentity();
  const code = 'MOVE-HERE';

  // The club as the host's browser has it: Ann joined and holds 250 chips.
  const club = newClub('Home Game', code, host.id);
  const verifier = new Verifier();
  await hostReceive(club, verifier, await signMessage(ann, {club: code, type: 'join', invite: club.invite, name: 'Ann'}));
  approve(club, ann.id);
  issue(club, ann.id, 250, 1);
  const mem = newMembership({code, invite: club.invite, hostId: host.id});
  mem.status = 'member';

  // Someone else can't move it, and a club with people at a table can't move.
  const storage = memoryStorage();
  await assert.rejects(importClub(storage, await signMessage(eve, {type: 'import_club', club: code, data: club, senders: verifier.toJSON()}), code), /Only the club’s host/);
  const seated = structuredClone(club);
  seated.members[ann.id].seat = {table: 't', stack: 10};
  await assert.rejects(importClub(storage, await signMessage(host, {type: 'import_club', club: code, data: seated, senders: {}}), code), /at tables/);

  const {hostId} = await importClub(storage, await signMessage(host, {type: 'import_club', club: code, data: club, senders: verifier.toJSON()}), code);
  assert.notEqual(hostId, host.id);
  const box = inbox(hostId);
  const server = await openClub({storage, send: box.send, online: [host.id, ann.id]});
  assert.equal(server.club.ownerId, host.id, 'the host owns it now');
  assert.equal(server.club.members[ann.id].balance, 250);
  assert.ok(totals(server.club).conserved);

  // A forged handoff is ignored; the host's real one goes to Ann.
  await server.message({from: eve.id, data: await signMessage(eve, {club: code, type: 'host_moved', hostId})});
  assert.equal((box.got.get(ann.id) || []).length, 0);
  await server.message({from: host.id, data: await signMessage(host, {club: code, type: 'host_moved', hostId})});
  const handoff = box.got.get(ann.id)[0];
  assert.ok(await playerReceive(mem, handoff), 'Ann accepts the handoff from her host');
  assert.equal(mem.hostId, hostId);

  // From then on she talks to the club itself; her old messages still can't be replayed.
  await server.message({from: ann.id, data: await signMessage(ann, {club: code, type: 'hello', since: 0})});
  await settle();
  const replies = (box.got.get(ann.id) || []).filter(e => e.from === hostId);
  assert.ok(replies.length, 'the club answers her');
  let accepted = 0;
  for (const env of replies) if (await playerReceive(mem, env)) accepted++;
  assert.ok(accepted > 0, 'and she accepts what it sends');
  assert.equal(mem.status, 'member');

  // Ann, connecting again later, gets the handoff first.
  box.got.clear();
  await server.message({from: ann.id, event: 'open'});
  assert.equal(box.got.get(ann.id)[0].body.type, 'host_moved');
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

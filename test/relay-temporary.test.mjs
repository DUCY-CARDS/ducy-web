// Temporary clubs (#395) in the Node dev relay: a new club is temporary
// until its owner proves a backup (a signed owner command the room records
// in the registry); members are told; and one left unused is deleted.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-temporary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { relayClient } from './relay-helper.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { TEMP_DAYS } from '../relay/src/registry.js';
import { adminFetch, granter, testAdmin } from './admin-helper.mjs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));

// A dev relay on its own port, with `env` added, for test `t`.
async function relay(t, env = {}) {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const adm = await testAdmin();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(port)], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, ADMINS_FILE: adm.file, ...env}});
  await new Promise(resolve => server.stdout.once('data', resolve));
  t.after(() => server.kill());
  // Club connections prove the player's ID and are unlocked with a passkey (#575, #577).
  const r = relayClient(port);
  const open = (path, ident = null) => r.open(path, ident);
  const api = adminFetch(port, adm.ident);
  const clubs = () => api('/admin/clubs').then(r => r.body.clubs);
  return {open, clubs, grantFor: granter(port, adm.ident)};
}

test('a new club is temporary until its owner proves a backup; members see it', {skip: !haveWasm && 'no wasm build', timeout: 20_000}, async t => {
  const {open, clubs, grantFor} = await relay(t);
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'TTTT-AAAA';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Night Owls', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');

  let rec = (await clubs()).find(c => c.code === code);
  assert.equal(rec.temporary, true);
  assert.equal(rec.removesAt, rec.lastActive + TEMP_DAYS * 864e5);
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  assert.equal((await o.next('owner_view')).body.plan.temporary, true);

  // Ann is let in; the club's tables tell her it's temporary.
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  await a.next('status');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal((await a.next('tables')).body.temporary, true);
  // Letting her in gave her nothing (#395).
  const view = await o.next('owner_view');
  assert.equal(view.body.data.members[ann.id].balance || 0, 0);

  // Only the owner's signed command counts: Ann's is ignored.
  a.send(await signMessage(ann, {club: code, type: 'owner_cmd', op: 'backup_proved', id: 9}));
  // The owner proves a backup: recorded, and everyone hears.
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'backup_proved', id: 2}));
  assert.equal((await o.next('owner_result')).body.error, '');
  let v;
  do v = await o.next('owner_view'); while (v.body.plan.temporary);
  assert.ok(v.body.plan.provedAt > 0);
  let tb;
  do tb = await a.next('tables'); while (tb.body.temporary);
  assert.equal(tb.body.temporary, undefined);
  rec = (await clubs()).find(c => c.code === code);
  assert.equal(rec.temporary, false);
  assert.equal(rec.removesAt, null);
  o.ws.close(); a.ws.close();
});

test('a temporary club left unused is deleted', {skip: !haveWasm && 'no wasm build', timeout: 20_000}, async t => {
  // As if 8 days had passed whenever it looks.
  const {open, clubs, grantFor} = await relay(t, {RELAY_CLEANUP_MS: '200', RELAY_CLEANUP_AHEAD_MS: String(8 * 864e5)});
  const owner = await createIdentity();
  const code = 'TTTT-BBBB';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Gone Soon', grant: await grantFor(owner.id)}));
  // Deleting the club lets its connections go.
  assert.equal(await o.closed, 4004);
  assert.equal((await clubs()).find(c => c.code === code), undefined);
});

// Clubs are kept (#654) in the Node dev relay: a new club isn't temporary,
// there's no proving a backup, and members aren't told anything about it.
// The owner's passkey moves the club to a new device (passkeys.js status
// `copy`, checked in relay-club.test.mjs).
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-kept.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relayClient } from './relay-helper.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { adminFetch, granter, testAdmin } from './admin-helper.mjs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));

// A dev relay on its own port, for test `t`.
async function relay(t) {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const adm = await testAdmin();
  const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(port)], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, ADMINS_FILE: adm.file}});
  await new Promise(resolve => server.stdout.once('data', resolve));
  t.after(() => server.kill());
  // Club connections prove the player's ID and are unlocked with a passkey (#575, #577).
  const r = relayClient(port);
  const open = (path, ident = null) => r.open(path, ident);
  const api = adminFetch(port, adm.ident);
  const clubs = () => api('/admin/clubs').then(x => x.body.clubs);
  return {open, clubs, grantFor: granter(port, adm.ident), post: r.post};
}

test('a new club is kept: not temporary, no backup to prove, nothing for members (#654)', {skip: !haveWasm && 'no wasm build', timeout: 20_000}, async t => {
  const {open, clubs, grantFor, post} = await relay(t);
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'TTTT-AAAA';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Night Owls', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');

  const rec = (await clubs()).find(c => c.code === code);
  assert.equal(rec.name, 'Night Owls');
  for (const k of ['temporary', 'provedAt', 'removesAt']) assert.equal(k in rec, false, k);
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  const plan = (await o.next('owner_view')).body.plan;
  assert.equal(plan.plan, 'club');
  for (const k of ['temporary', 'provedAt', 'removesAt']) assert.equal(k in plan, false, k);

  // Ann is let in; the club's tables say nothing of backups.
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  await a.next('status');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal('temporary' in (await a.next('tables')).body, false);

  // Proving a backup is no command any more.
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'backup_proved', id: 2}));
  assert.match((await o.next('owner_result')).body.error, /no host action/);

  // The owner's passkey has no copy of their key yet: the page asks for one.
  const st = await post('status', {id: owner.id});
  assert.equal(st.body.enrolled, true);
  assert.equal(st.body.copy, false);
  o.ws.close(); a.ws.close();
});

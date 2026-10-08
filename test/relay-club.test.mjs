// Always-on clubs (#93) in the Node dev relay: a room becomes a club when
// its owner asks, and then runs it with no host connected.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-club.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { createIdentity, signMessage } from '../src/identity.js';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit']});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

function open(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
  const inbox = [], waiting = [];
  ws.on('message', d => { const m = JSON.parse(d); waiting.length ? waiting.shift()(m) : inbox.push(m); });
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  // The next message whose type (or signed body's type) is `type`.
  async function next(type) {
    for (;;) {
      const m = inbox.length ? inbox.shift() : await new Promise(r => waiting.push(r));
      if (!type || m.type === type || m.body?.type === type) return m;
    }
  }
  return {
    ws, closed, next,
    ready: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }),
    send: obj => ws.send(JSON.stringify(obj)),
  };
}

test('a room becomes an always-on club: members join and the owner runs it, with no host', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CCCC-CCCC';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Night Owls'}));
  const made = await o.next('club_created');
  assert.ok(made.hostId && made.invite);

  // A host can't take the room over.
  const h = open(`/room/${code}?role=host`);
  assert.equal(await h.closed, 4001);

  // Ann asks to join; the owner approves and gives her chips.
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  const pending = await a.next('status');
  assert.equal(pending.from, made.hostId, 'signed by the club');
  assert.equal(pending.body.status, 'pending');
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  const view = await o.next('owner_view');
  assert.equal(view.body.data.members[ann.id].status, 'pending');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal((await a.next('status')).body.status, 'member');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: 300}, id: 2}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal((await a.next('account')).body.balance, 300);

  // The owner leaves; Ann asks for chips and is still answered by the club.
  o.ws.close();
  await o.closed;
  a.send(await signMessage(ann, {club: code, type: 'chip_request', amount: 100}));
  const acc = await a.next('account');
  assert.equal(acc.body.request?.amount, 100, 'the club holds her request with no one hosting');
  a.ws.close();

  // A second room can't be claimed by someone who isn't alone in it.
  const b = open(`/room/DDDD-DDDD?role=guest&id=${ann.id}&queue=1`);
  const c = open(`/room/DDDD-DDDD?role=guest&id=${owner.id}&queue=1`);
  await Promise.all([b.ready, c.ready]);
  b.send(await signMessage(ann, {type: 'create_club', club: 'DDDD-DDDD', name: 'Mine'}));
  assert.match((await b.next('club_error')).reason, /in use/);
  b.ws.close(); c.ws.close();
});

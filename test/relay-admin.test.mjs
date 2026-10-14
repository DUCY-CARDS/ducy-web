// Clubs by permission (#265) in the Node dev relay: a player's one trial
// club, the super admin's API (permission, limits, pausing, a look inside),
// and the plan's limits on tables.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-admin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { createIdentity, signMessage } from '../src/identity.js';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const PORT = 21000 + Math.floor(Math.random() * 1000);
const TOKEN = 'test-admin-token-0123456789abcdef';
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, ADMIN_TOKEN: TOKEN}});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

function open(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
  const inbox = [], waiting = [];
  ws.on('message', d => { const m = JSON.parse(d); waiting.length ? waiting.shift()(m) : inbox.push(m); });
  const closed = new Promise(resolve => ws.on('close', (code, reason) => resolve({code, reason: String(reason)})));
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

const api = (path, body, token = TOKEN) => fetch(`http://localhost:${PORT}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  ...(body ? {body: JSON.stringify(body)} : {}),
}).then(async r => ({status: r.status, body: await r.json()}));

// `who` asks for an always-on club in room `code`: the reply.
async function create(who, code, name) {
  const c = open(`/room/${code}?role=guest&id=${who.id}&queue=1`);
  await c.ready;
  c.send(await signMessage(who, {type: 'create_club', club: code, name}));
  for (;;) {
    const m = await c.next();
    if (m.type === 'club_created' || m.type === 'club_error') return {c, m};
  }
}

test('trial clubs, permission, limits and pausing', {skip: !haveWasm && 'no wasm build'}, async () => {
  const ann = await createIdentity(), bob = await createIdentity();

  // The admin API wants the token.
  assert.equal((await api('/admin/clubs', null, 'wrong')).status, 401);

  // Ann's first club is her trial; her second is refused.
  const {c: o, m: made} = await create(ann, 'TTTT-TTTT', 'Trial Night');
  assert.equal(made.type, 'club_created');
  const second = await create(ann, 'UUUU-UUUU', 'Another');
  assert.equal(second.m.type, 'club_error');
  assert.match(second.m.reason, /free trial/);
  second.c.ws.close();

  let list = (await api('/admin/clubs')).body;
  const trial = list.clubs.find(c => c.code === 'TTTT-TTTT');
  assert.equal(trial.plan, 'trial');
  assert.equal(trial.owner, ann.id);
  assert.equal(trial.name, 'Trial Night');
  assert.ok(trial.expires > Date.now());
  assert.deepEqual(list.trials, {[ann.id]: 'TTTT-TTTT'});

  // The owner sees the plan, and the limit on tables.
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_hello'}));
  const view = await o.next('owner_view');
  assert.equal(view.body.plan.plan, 'trial');
  assert.deepEqual(view.body.plan.limits, {tables: 2, tourneysPerDay: 1});
  for (let i = 1; i <= 3; i++) {
    o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'new_table', args: {table: {name: `T${i}`}}, id: i}));
    const r = await o.next('owner_result');
    if (i <= 2) assert.equal(r.body.error, '');
    else assert.match(r.body.error, /2 tables open at once/);
  }

  // The admin raises the limit; it applies at once.
  assert.equal((await api('/admin/club/TTTT-TTTT', {limits: {tables: 3}})).status, 200);
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'new_table', args: {table: {name: 'T3'}}, id: 4}));
  assert.equal((await o.next('owner_result')).body.error, '');

  // A look inside: its tables and members.
  const look = (await api('/admin/club/TTTT-TTTT')).body;
  assert.equal(look.blocked, '');
  assert.equal(look.inside.club.name, 'Trial Night');
  assert.equal(look.inside.club.tables.length, 3);
  assert.equal(look.inside.online, 1);

  // Bob joins as a guest; pausing the club lets him go, and keeps him out.
  const b = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`);
  await b.ready;
  assert.equal((await api('/admin/club/TTTT-TTTT', {suspended: true})).status, 200);
  const gone = await b.closed;
  assert.equal(gone.code, 4003);
  assert.match(gone.reason, /paused/);
  const again = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`);
  assert.equal((await again.closed).code, 4003);
  // The owner still gets in, to see why.
  const o2 = open(`/room/TTTT-TTTT?role=guest&id=${ann.id}&queue=1`);
  await o2.ready;
  o2.ws.close();
  await api('/admin/club/TTTT-TTTT', {suspended: false});
  const back = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`);
  await back.ready;
  back.ws.close();

  // Permission: granted, Ann may have a (non-trial) club with the grant's limits.
  assert.equal((await api('/admin/grant', {id: ann.id, note: 'test', limits: {tables: 6, tourneysPerDay: 2}})).status, 200);
  const third = await create(ann, 'VVVV-VVVV', 'Granted');
  assert.equal(third.m.type, 'club_created');
  list = (await api('/admin/clubs')).body;
  const granted = list.clubs.find(c => c.code === 'VVVV-VVVV');
  assert.equal(granted.plan, 'club');
  assert.deepEqual(granted.limits, {tables: 6, tourneysPerDay: 2});
  assert.equal(list.grants[ann.id].note, 'test');
  assert.equal((await api('/admin/revoke', {id: ann.id})).status, 200);
  assert.equal((await api('/admin/clubs')).body.grants[ann.id], undefined);
  for (const s of [o, third.c]) s.ws.close();
});

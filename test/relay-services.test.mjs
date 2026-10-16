// Club services over the Node dev relay's HTTP endpoint, end to end: the
// service's command line makes its key, the owner adds it by its service
// line, the command line gives a member chips, and revoking stops it.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-services.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { createIdentity, signMessage } from '../src/identity.js';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const PORT = 22000 + Math.floor(Math.random() * 1000);
const RELAY = `http://localhost:${PORT}`;
const CLI = fileURLToPath(new URL('../tools/ducy-service.mjs', import.meta.url));
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit']});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

// The service's command line: resolves to {code, out, err}.
const cli = (args, env = {}) => promisify(execFile)(process.execPath, [CLI, ...args], {env: {...process.env, ...env}})
  .then(r => ({code: 0, out: r.stdout, err: r.stderr}), e => ({code: e.code, out: e.stdout, err: e.stderr}));

function open(path) {
  const ws = new WebSocket(`ws://localhost:${PORT}${path}`);
  const inbox = [], waiting = [];
  ws.on('message', d => { const m = JSON.parse(d); waiting.length ? waiting.shift()(m) : inbox.push(m); });
  async function next(type) {
    for (;;) {
      const m = inbox.length ? inbox.shift() : await new Promise(r => waiting.push(r));
      if (!type || m.type === type || m.body?.type === type) return m;
    }
  }
  return {ws, next, ready: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }), send: obj => ws.send(JSON.stringify(obj))};
}

test('a service made with its command line gives chips through the relay, until revoked', {skip: !haveWasm && 'no wasm build'}, async () => {
  const code = 'SRVC-RXAY';
  const owner = await createIdentity(), ann = await createIdentity();

  // The owner makes an always-on club; Ann joins.
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Rewards Club'}));
  const made = await o.next('club_created');
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  await a.next('status');
  let n = 0;
  const cmd = async (op, args) => {
    o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op, args, id: ++n}));
    for (;;) { const r = await o.next('owner_result'); if (r.body.id === n) return r.body; }
  };
  assert.equal((await cmd('approve', {id: ann.id})).error, '');

  // The service makes its key on its own server: private, and only the
  // public half in the line it prints.
  const dir = mkdtempSync(join(tmpdir(), 'ducy-service-'));
  const keyFile = join(dir, 'key.json');
  const init = await cli(['init', keyFile]);
  assert.equal(init.code, 0, init.err);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'only its owner can read the key file');
  const line = init.out.split('\n').find(l => l.startsWith('ducy-service:1:'));
  assert.ok(line && !line.includes(JSON.parse(readFileSync(keyFile, 'utf8')).key.d), 'the line has no private key');
  assert.equal((await cli(['init', keyFile])).code, 1, 'init never overwrites a key');

  // Before the owner adds it, the club refuses it.
  const flags = ['--keyfile', keyFile, '--relay', RELAY, '--club', code];
  const early = await cli(['give', ann.id, '100', ...flags]);
  assert.equal(early.code, 1);
  assert.match(early.err, /401: This club has no such service/);

  assert.equal((await cmd('service_add', {line, name: 'League', budget: 1000 * 100, perGive: 500 * 100})).error, '');
  const give = await cli(['give', ann.id, '250', 'Week 1 winner', '--key', 'week-1', ...flags]);
  assert.equal(give.code, 0, give.err);
  assert.equal(JSON.parse(give.out).balance, 250);
  const balance = await a.next('account');
  assert.equal(balance.body.balance, 250 * 100, 'Ann hears at once');
  // The same key again pays once.
  assert.equal(JSON.parse((await cli(['give', ann.id, '250', '--key', 'week-1', ...flags])).out).repeat, true);
  const over = await cli(['give', ann.id, '501', ...flags]);
  assert.match(over.err, /403: At most 500/);
  const status = JSON.parse((await cli(['status', ...flags])).out);
  assert.equal(status.budget, 750);
  const members = JSON.parse((await cli(['members', ...flags])).out);
  assert.deepEqual(members.map(m => [m.name, m.balance]), [['Ann', 250]]);

  // From a web page: refused, whatever it carries.
  const env = await signMessage(await createIdentity(), {type: 'service', club: code, op: 'status', args: {}});
  const fromPage = await fetch(`${RELAY}/club/${code}/service`, {method: 'POST', headers: {Origin: 'https://evil.example', 'content-type': 'application/json'}, body: JSON.stringify(env)});
  assert.equal(fromPage.status, 403);
  assert.equal((await fetch(`${RELAY}/club/NOPE-NOPE/service`, {method: 'POST', body: JSON.stringify(env)})).status, 404);

  // Revoked: the next request fails.
  const view = (await (async () => { o.send(await signMessage(owner, {club: code, type: 'owner_hello'})); return o.next('owner_view'); })()).body.data;
  const id = Object.keys(view.services)[0];
  assert.equal(view.services[id].name, 'League');
  assert.equal((await cmd('service_revoke', {id})).error, '');
  const after = await cli(['give', ann.id, '1', ...flags]);
  assert.match(after.err, /401: This service was revoked/);
  o.ws.close();
  a.ws.close();
});

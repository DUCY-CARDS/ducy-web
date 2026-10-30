// Tournament commands through the club server (#456): the manager's new
// and cancelled tournaments and members registering run in ducy-play's
// club host (club-commands.js); the server sends accounts and the lobby,
// times starts and stops cancelled tournaments. Needs the wasm build in wasm/.
// Run with: node --test test/tourney-commands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue } = await import('../src/club-chips.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createClubServer } = await import('../src/club-server.js');
const { createIdentity, signMessage, Verifier } = await import('../src/identity.js');

const LEVELS = [{sb: 10, bb: 20, ante: 0, minutes: 10}];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const engineCall = engine => async (op, ...args) => engine.ops[op](...args);
const memStore = () => {
  const store = new Map();
  return {get: async (c, t) => store.get(t) || null, put: async (c, t, rec) => { store.set(t, rec); }, drop: async (c, t) => { store.delete(t); }};
};

async function serverFor() {
  const ids = {};
  for (const n of ['ann', 'bob']) ids[n] = await createIdentity();
  const hostId = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', hostId.id, 0);
  for (const n of ['ann', 'bob']) {
    const id = ids[n].id;
    club.members[id] = {id, name: n[0].toUpperCase() + n.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const sent = [];
  const timers = [];
  const server = createClubServer({
    identity: hostId, club, verifier: new Verifier(), persist() {},
    transport: {send: (to, data) => sent.push({to, data}), ack() {}},
    engine: {call: engineCall(clubEngine()), store: memStore(), timers: {set: (fn, ms) => timers.push({fn, ms}) - 1, clear: i => { if (timers[i]) timers[i].fn = null; }}},
  });
  await server.relayOpen();
  for (const n of ['ann', 'bob']) await server.message({from: ids[n].id, event: 'open'});
  const say = async (n, body) => server.message({from: ids[n].id, data: await signMessage(ids[n], {club: club.code, ...body})});
  const got = (n, type) => sent.filter(s => s.to === ids[n].id && s.data?.body?.type === type).map(s => s.data.body);
  return {club, server, ids, say, got, timers};
}

const tourney = () => ({name: 'Sunday', buyIn: 100, stack: 1500, structure: LEVELS, opensAt: Date.now() - 1000, startsAt: Date.now() + 3600e3});

test('members register and unregister; the manager cancels with every buy-in back', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, server, ids, say, got, timers} = await serverFor();
  const tid = await server.run('new_tourney', {tourney: tourney()});
  // Its start is timed.
  assert.ok(timers.some(t => t.fn && t.ms > 3500e3));
  const balance = n => club.members[ids[n].id].balance;
  await say('ann', {type: 'tourney', tourney: tid, op: 'register'});
  await say('bob', {type: 'tourney', tourney: tid, op: 'register'});
  assert.equal(balance('ann'), 900);
  // Ann's account shows the buy-in; everyone hears the lobby.
  await until('the buy-in', () => got('ann', 'account').at(-1)?.entries.at(-1)?.kind === 'tourney_buy_in');
  await until('the lobby', () => got('bob', 'tourneys').at(-1)?.tourneys[0].entries === 2);
  await say('bob', {type: 'tourney', tourney: tid, op: 'unregister'});
  assert.equal(balance('bob'), 1000);
  // A refusal goes back to the member alone.
  await say('ann', {type: 'tourney', tourney: tid, op: 'register'});
  assert.match((await until('the refusal', () => got('ann', 'tourney_error').at(-1))).reason, /already/);
  await server.run('cancel_tourney', {id: tid});
  assert.equal(club.tourneys[0].status, 'cancelled');
  assert.equal(balance('ann'), 1000);
  await until('the refund', () => got('ann', 'account').at(-1)?.entries.at(-1)?.kind === 'refund');
  assert.ok(club.log.some(l => l.text.includes('Sunday was cancelled')));
  // Its start no longer fires.
  assert.ok(!timers.some(t => t.fn && t.ms > 3500e3));
  await assert.rejects(async () => server.run('cancel_tourney', {id: 'nope'}), /No such tournament/);
});

test('the plan limits new tournaments a day', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {server} = await serverFor();
  server.setLimits({tourneysPerDay: 1});
  await server.run('new_tourney', {tourney: tourney()});
  await assert.rejects(async () => server.run('new_tourney', {tourney: tourney()}));
});

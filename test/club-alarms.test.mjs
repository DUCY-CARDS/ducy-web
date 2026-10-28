// An always-on club's tables on the room's alarm (#135), in Node with the
// real engine: the room is evicted mid-hand (its memory and timers gone),
// and with no message afterwards its alarm wakes it; the club reopens from
// storage, the player to act times out and the next hand is dealt.
// Needs the wasm build in wasm/. Run with: node --test test/club-alarms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { newKeyPair } from '../src/e2e.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}

// The Worker's alarm-backed timers (worker.js tableTimers), in memory: due
// times kept, and pump() runs what's due, as the alarm does. evict() drops
// them all, as the runtime evicting the room would.
function alarmTimers() {
  let map = new Map(), n = 0;
  return {
    timers: {
      set: (fn, ms) => { map.set(++n, {at: Date.now() + Math.max(0, ms), fn}); return n; },
      clear: h => { map.delete(h); },
    },
    pump() {
      const now = Date.now();
      for (const [h, t] of [...map]) if (t.at <= now) { map.delete(h); t.fn(); }
    },
    evict() { map = new Map(); },
    get next() { return Math.min(...[...map.values()].map(t => t.at)); },
  };
}

test('a room evicted mid-hand wakes on its alarm: the player to act times out and the next hand is dealt', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity(), bob = await createIdentity();
  const code = 'ALRM-TEST';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Alarms'}), code);
  const send = () => {};
  let clock = alarmTimers();
  let server = await openClub({storage, send, online: [], timers: clock.timers});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ann, bob]) await server.message({from: p.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  let id = 1;
  for (const [p, name] of [[ann, 'Ann'], [bob, 'Bob']]) {
    await say(p, {type: 'join', invite, name});
    await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: p.id}, id: id++});
    await say(owner, {type: 'owner_cmd', op: 'give', args: {id: p.id, amount: 500}, id: id++});
  }
  // A table with a 1 s turn.
  await say(owner, {type: 'owner_cmd', op: 'new_table', args: {table: {name: 'Main', sb: 1, bb: 2, turnSecs: 1}}, id: id++});
  await sleep(100);
  const tid = server.club.tables[0].id;
  for (const p of [ann, bob]) {
    // A member's key for encrypted table updates comes first; no one sits without one.
    await say(p, {type: 'hello', key: (await newKeyPair()).pub});
    await say(p, {type: 'table', table: tid, cmd: {type: 'join'}});
    await say(p, {type: 'table', table: tid, cmd: {type: 'request_chips', amount: 100}});
  }
  // The first hand is dealt (after the fair-deal round gives up on these
  // players, who don't answer it); no one acts.
  const hands = async () => ((await storage.get('hands')) || []).length;
  const until = async (cond, ms) => {
    const end = Date.now() + ms;
    while (!(await cond()) && Date.now() < end) { clock.pump(); await sleep(50); }
    return cond();
  };
  const seatedStack = async () => (await storage.get(`table:${tid}`))?.seq ?? -1;
  const before = await seatedStack();
  assert.ok(await until(async () => (await seatedStack()) > before && Number.isFinite(clock.next), 10_000), 'a hand is under way');
  await sleep(200);
  const dealtSeq = await seatedStack();
  assert.equal(await hands(), 0, 'no hand finished yet');

  // The room is evicted mid-hand: its memory and timers are gone. No one
  // sends anything; only the alarm wakes it, and the club reopens.
  await server.flush();
  clock.evict();
  server = null;
  await sleep(1500); // the turn runs out meanwhile
  clock = alarmTimers();
  server = await openClub({storage, send, online: [owner.id, ann.id, bob.id], timers: clock.timers});
  // The player to act times out, the hand finishes, and the next is dealt.
  assert.ok(await until(async () => (await hands()) >= 1, 15_000), 'the hand finished after waking');
  assert.ok((await seatedStack()) > dealtSeq);
  assert.ok(await until(async () => (await hands()) >= 2, 25_000), 'the next hand was dealt and played out');
  server.club.tables[0].status = 'closed';
});

// #96: measured on the live relay, a room whose seated players had all
// closed their tabs still woke every 5 s, for the sit-out tick, which
// re-armed itself while the table's clock was stopped. With no one there to
// connect, nothing should wake it.
test('a table whose seated players are all gone sets no ticking timers, so the room can sleep; one coming back starts them again', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity(), bob = await createIdentity();
  const code = 'IDLE-TEST';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Idle'}), code);
  const clock = alarmTimers();
  const server = await openClub({storage, send: () => {}, online: [], timers: clock.timers});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ann, bob]) await server.message({from: p.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  let id = 1;
  for (const [p, name] of [[ann, 'Ann'], [bob, 'Bob']]) {
    await say(p, {type: 'join', invite, name});
    await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: p.id}, id: id++});
    await say(owner, {type: 'owner_cmd', op: 'give', args: {id: p.id, amount: 500}, id: id++});
  }
  await say(owner, {type: 'owner_cmd', op: 'new_table', args: {table: {name: 'Main', sb: 1, bb: 2, turnSecs: 30}}, id: id++});
  await sleep(100);
  const tid = server.club.tables[0].id;
  for (const p of [ann, bob]) {
    await say(p, {type: 'hello', key: (await newKeyPair()).pub});
    await say(p, {type: 'table', table: tid, cmd: {type: 'join'}});
    await say(p, {type: 'table', table: tid, cmd: {type: 'request_chips', amount: 100}});
  }
  const pending = () => Number.isFinite(clock.next);
  const settle = async () => { for (let i = 0; i < 20; i++) { clock.pump(); await sleep(50); } await server.flush(); };
  await settle();
  assert.ok(pending(), 'two seated and connected: the table has timers');

  // Everyone leaves: the owner's tab and both players' tabs close.
  for (const p of [owner, ann, bob]) await server.message({from: p.id, event: 'close'});
  await settle();
  // What's left wakes it once, not every 5 s: the play time's report after
  // the pause, and the idle check that stands them up (#421).
  assert.ok(clock.next - Date.now() > 30_000, 'no one connected: nothing wakes the room soon');

  // Ann comes back: the table's clock, and its sit-out tick, run again.
  await server.message({from: ann.id, event: 'open'});
  await settle();
  assert.ok(pending(), 'someone back: the table has timers again');
  server.club.tables[0].status = 'closed';
});

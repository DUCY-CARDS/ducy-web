// Idle seats and play time (#421): someone seated without being dealt a hand
// is stood up after a while (asked "Still here?" first if they're
// connected), even while the table's clock is stopped; usage counts only
// while hands are in play, reported as it goes; and the old seated-time
// usage starts again once. The table parts use a real club table
// (club-host.js and ducy's engine), with short times. Needs the wasm build
// in wasm/. Run with: node --test test/idle-seats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PLAY_GAP_MS, playClock } from '../relay/src/club-room.js';
import { limitsFrom, registry } from '../relay/src/registry.js';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, totals } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A club table with ann and bob; `online` is who's connected. Players in
// `acting` check or call whenever it's their turn.
function setUp({idleMs, askMs}) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ['ann', 'bob']) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const t = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 6, turnSecs: 0});
  const engine = clubEngine();
  const online = new Set(), acting = new Set();
  const got = {ann: [], bob: []};
  let host = null, plays = 0;
  const deliver = (to, msg) => queueMicrotask(() => {
    const u = msg.update;
    got[to]?.push(u);
    if (u.type === 'state' && acting.has(to) && u.view.legal && !u.view.complete) {
      host.handle(t.id, to, {type: 'act', seq: u.seq, kind: u.view.legal.can_check ? 'check' : 'call', amount: 0});
    }
  });
  host = createTableHost({
    club: () => club, save() {}, sendTable: deliver, chipsChanged() {}, tablesChanged() {}, onHand() {},
    online: id => online.has(id), onPlay: () => { plays++; }, idleMs, askMs,
    call: async (op, ...args) => engine.ops[op](...args),
    store: {get: async () => null, put: async () => {}, drop: async () => {}},
  });
  const sit = async id => {
    await host.handle(t.id, id, {type: 'join'});
    await host.handle(t.id, id, {type: 'request_chips', amount: 150});
    await until(`${id} seated`, () => club.members[id].seat?.stack === 150);
  };
  return {club, t, host, online, acting, got, sit, plays: () => plays};
}

test('alone and not connected: stood up after the idle time, with the clock stopped; no play time', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, got, sit, plays} = setUp({idleMs: 600, askMs: 300});
  await host.start(t);
  // Ann sits down alone and goes away: the table's clock stops (no one
  // seated is connected), which is how a seat was once held two weeks.
  await sit('ann');
  await until('ann stood up', () => !club.members.ann.seat, 5000);
  const out = club.money.ledger.filter(e => e.member === 'ann' && e.kind === 'cash_out').at(-1);
  assert.equal(out.amount, 150, 'her chips went back to her');
  assert.equal(club.members.ann.balance, 1000);
  assert.ok(totals(club).conserved);
  assert.equal(club.log.at(-1).text, 'Ann was idle, so they left Main');
  const r = got.ann.find(u => u.type === 'removed');
  assert.ok(r?.idle, 'her page hears why');
  assert.ok(!got.ann.some(u => u.type === 'idle'), 'not connected: not asked');
  assert.equal(plays(), 0, 'no hand, no play time');
  await host.close(t.id);
});

test('connected: asked "Still here?"; answering keeps the seat for another while; not answering stands them up', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, online, got, sit} = setUp({idleMs: 600, askMs: 400});
  online.add('bob');
  await host.start(t);
  await sit('bob');
  const ask = await until('bob asked', () => got.bob.find(u => u.type === 'idle' && !u.done), 5000);
  assert.ok(ask.secs >= 0);
  await host.handle(t.id, 'bob', {type: 'still_here'});
  assert.ok(got.bob.some(u => u.type === 'idle' && u.done), 'the question goes away');
  await sleep(500);
  assert.ok(club.members.bob.seat, 'still seated after the time to answer');
  // Asked again after another idle time; this time he doesn't answer.
  await until('asked again', () => got.bob.filter(u => u.type === 'idle' && !u.done).length === 2, 5000);
  await until('bob stood up', () => !club.members.bob.seat, 5000);
  assert.ok(got.bob.find(u => u.type === 'removed')?.idle);
  assert.equal(club.members.bob.balance, 1000);
  await host.close(t.id);
});

test('playing hands is never idle, and it counts as play time', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, t, host, online, acting, got, sit, plays} = setUp({idleMs: 5000, askMs: 300});
  for (const id of ['ann', 'bob']) { online.add(id); acting.add(id); }
  await host.start(t);
  await sit('ann');
  await sit('bob');
  // Hands come every few seconds: each one dealt to them is activity.
  await sleep(9000);
  assert.ok(club.members.ann.seat && club.members.bob.seat, 'both still seated');
  assert.ok(!got.ann.some(u => u.type === 'idle') && !got.bob.some(u => u.type === 'idle'), 'never asked');
  assert.ok(plays() > 0, 'hands in play were counted');
  acting.clear();
  await host.close(t.id);
});

test('play time: hands in play count, long pauses don’t; reported as it goes, on its day', () => {
  let now = Date.UTC(2026, 9, 26, 12);
  const sent = [];
  const pending = [];
  const timers = {set: (fn, ms) => { pending.push({fn, at: now + ms}); return pending.length; }, clear() {}};
  const runDue = () => { for (const p of pending.splice(0)) if (p.at <= now) p.fn(); else pending.push(p); };
  const clock = playClock((minutes, at) => sent.push({minutes, at}), timers, () => now);
  // Ten minutes of play, a signal every 5 s: reported every 5 minutes.
  for (let i = 0; i <= 120; i++) { clock.playing(); now += 5000; }
  assert.equal(sent.length, 2);
  assert.ok(Math.abs(sent[0].minutes - 5) < 0.1 && Math.abs(sent[1].minutes - 5) < 0.1, JSON.stringify(sent));
  // Play stops: the rest is reported once the pause is long enough.
  clock.playing();
  now += PLAY_GAP_MS * 3;
  runDue();
  runDue();
  const total = sent.reduce((s, x) => s + x.minutes, 0);
  assert.ok(Math.abs(total - 10.08) < 0.1, `total ${total}`);
  // A long pause between two signals isn't play time.
  const before = sent.length;
  clock.playing();
  now += 10 * 60_000;
  clock.playing();
  clock.report();
  assert.equal(sent.length, before, 'nothing played in the pause');
  // Across midnight: what was played goes on its own day.
  now = Date.UTC(2026, 9, 26, 23, 59, 30);
  const c2 = [];
  const clock2 = playClock((minutes, at) => c2.push({minutes, at}), null, () => now);
  for (let i = 0; i < 12; i++) { clock2.playing(); now += 5000; }
  clock2.report();
  assert.equal(c2.length, 2);
  assert.equal(new Date(c2[0].at).toISOString().slice(0, 10), '2026-10-26');
  assert.equal(new Date(c2[1].at).toISOString().slice(0, 10), '2026-10-27');
});

test('the old seated-time usage starts again once (#421)', async () => {
  const m = new Map();
  const storage = {get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
  const today = new Date().toISOString().slice(0, 10);
  // As it was: a seat held two weeks, all on one day.
  m.set(`day:${today}`, {minutes: 18_480});
  m.set('clubs', {'AAAA-AAAA': {owner: 'ann', at: 0, minutes: 18_480, days: {[today]: 18_480}}});
  const reg = registry(storage, limitsFrom({}));
  const u = await reg.usage();
  assert.equal(u.days[0].clubHours, 0);
  assert.equal((await reg.list()).clubs.find(c => c.code === 'AAAA-AAAA').minutes, 0);
  // From now on it counts, and a new registry (the object restarted) doesn't reset it again.
  await reg.used(30, Date.now(), 'AAAA-AAAA');
  const again = registry(storage, limitsFrom({}));
  assert.equal((await again.usage()).days[0].clubHours, 0.5);
});

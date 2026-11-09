// Scheduled cash games (#599): times across a daylight-saving change, and
// the club server running one: sign-up and the waitlist, check-in opening
// on its timer, no-shows' seats going to the checked-in waitlist, a table
// opening at the start with seats held, and a start with too few checked in
// left to the owner. Needs the wasm build in wasm/.
// Run with: node --test test/club-scheduled.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { localToUtc, roster, timeLeft, utcToLocal, whenText } = await import('../src/club-scheduled.js');
const { approve, newClub } = await import('../src/club.js');
const { issue } = await import('../src/club-chips.js');
const { newTable } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createClubServer } = await import('../src/club-server.js');
const { createIdentity, signMessage, Verifier } = await import('../src/identity.js');
const { listOf } = await import('../src/club-lists.js');

const CHI = 'America/Chicago';
const H = 3600e3;

test('a time entered in the owner’s zone is an exact instant, across a clock change', () => {
  // Thursday 7:00 PM in Chicago: CDT (UTC-5) before Nov 1 2026, CST (UTC-6) after.
  const before = localToUtc('2026-10-29T19:00', CHI);
  const after = localToUtc('2026-11-05T19:00', CHI);
  assert.equal(new Date(before).toISOString(), '2026-10-30T00:00:00.000Z');
  assert.equal(new Date(after).toISOString(), '2026-11-06T01:00:00.000Z');
  // A week apart on the wall clock, 169 hours apart in fact.
  assert.equal(after - before, 7 * 24 * H + H);
  // Both read back as 7:00 PM, the zone named.
  assert.equal(whenText(before, {timeZone: CHI, now: before - H}), 'Thu 7:00 PM CDT');
  assert.equal(whenText(after, {timeZone: CHI, now: after - H}), 'Thu 7:00 PM CST');
  // The same instant seen elsewhere: in New York, 8:00 PM.
  assert.equal(whenText(after, {timeZone: 'America/New_York', now: after}), 'Thu 8:00 PM EST');
  // A week or more off: with the date.
  assert.equal(whenText(after, {timeZone: CHI, now: after - 10 * 24 * H}), 'Thu, Nov 5, 7:00 PM CST');
  // Back into the form as it was entered.
  assert.equal(utcToLocal(after, CHI), '2026-11-05T19:00');
  // The night of the change: 1:30 AM happens twice (the first, CDT); 2:30
  // AM in March doesn't happen at all (read as 3:30 CDT).
  assert.equal(new Date(localToUtc('2026-11-01T01:30', CHI)).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(whenText(localToUtc('2026-03-08T02:30', CHI), {timeZone: CHI, now: Date.UTC(2026, 2, 8)}), 'Sun 3:30 AM CDT');
  assert.ok(Number.isNaN(localToUtc('next thursday', CHI)));
  // Time left, in words.
  assert.equal(timeLeft(1000 + 125 * 60e3, 1000), '2h 5m');
  assert.equal(timeLeft(0, 1000), 'now');
});

const PEOPLE = ['ann', 'bob', 'cy', 'dee', 'eve'];
// The clock, moved on by `fire`.
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const start = realNow();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (realNow() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const memStore = () => {
  const store = new Map();
  return {get: async (c, t) => store.get(t) || null, put: async (c, t, rec) => { store.set(t, rec); }, drop: async (c, t) => { store.delete(t); }};
};

// The club server with five members and a running Hold'em 1/2 table for
// two (so the game is one it deals), timers run by hand.
async function serverFor() {
  const ids = {};
  for (const n of PEOPLE) ids[n] = await createIdentity();
  const hostId = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', hostId.id, 0);
  for (const n of PEOPLE) {
    const id = ids[n].id;
    club.members[id] = {id, name: n[0].toUpperCase() + n.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const main = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  const sent = [];
  const timers = [];
  const engine = clubEngine();
  const server = createClubServer({
    identity: hostId, club, verifier: new Verifier(), persist() {},
    transport: {send: (to, data) => sent.push({to, data}), ack() {}},
    engine: {call: async (op, ...args) => engine.ops[op](...args), store: memStore(), timers: {set: (fn, ms) => timers.push({fn, ms}) - 1, clear: i => { if (timers[i]) timers[i].fn = null; }}},
  });
  await server.relayOpen();
  await until('Main runs', () => server.running(main.id));
  for (const n of PEOPLE) await server.message({from: ids[n].id, event: 'open'});
  const say = async (n, body) => server.message({from: ids[n].id, data: await signMessage(ids[n], {club: club.code, ...body})});
  const of = type => n => sent.filter(s => s.to === ids[n].id && s.data?.body?.type === type).map(s => s.data.body);
  const act = (n, id, type) => say(n, {type: 'table', table: `sched:${id}`, cmd: {type}});
  // The scheduled games' timer, run with the clock moved to it.
  const fire = async () => {
    const t = timers.findLast(x => x.fn && String(x.fn).includes('scheduledTick'));
    assert.ok(t, 'a scheduled games timer');
    const fn = t.fn;
    t.fn = null;
    shift += t.ms;
    await fn();
  };
  // The latest of member n's news or views once it's arrived (sends are signed, so they go out a moment later).
  const latest = (get, n, ok = () => true) => until(`${n}'s message`, () => { const v = get(n).at(-1); return v && ok(v) ? v : null; });
  const news = of('sched'), views = of('scheduled');
  return {club, main, server, ids, act, fire, news, views, newsOf: (n, ok) => latest(news, n, ok), viewOf: (n, ok) => latest(views, n, ok)};
}

test('sign up, the waitlist, check-in, and no-shows’ seats to the checked-in waitlist', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, server, ids, act, fire, news, newsOf, viewOf} = await serverFor();
  const key = 'nlhe:1/2:2';
  // Thursday's game, in two hours: one table's worth (2), check-in an hour before.
  const id = await server.run('schedule_game', {game: {key, startAt: Date.now() + 2 * H, players: 2}});
  const g = club.scheduled[0];
  assert.equal(g.id, id);
  assert.equal(g.minPlayers, 2);
  // Everyone hears of it.
  assert.equal((await viewOf('eve', v => v.games.length)).games[0].id, id);
  // Ann and Bob get the seats; Cy and Dee wait.
  for (const n of ['ann', 'bob', 'cy', 'dee']) await act(n, id, 'sign_up');
  await newsOf('ann', b => b.kind === 'confirmed');
  assert.equal((await newsOf('dee', b => b.kind === 'confirmed')).place, 2);
  assert.equal((await viewOf('dee', v => v.games[0].mine)).games[0].mine.place, 2);
  // Checking in before the window: refused, and said.
  await act('ann', id, 'check_in');
  assert.match((await newsOf('ann', b => b.kind === 'refused')).reason, /isn’t open/);
  // Bob leaves: Cy gets his seat, and hears it.
  await act('bob', id, 'leave');
  await newsOf('cy', b => b.kind === 'seat');
  await viewOf('dee', v => v.games[0].mine.place === 1);
  await act('bob', id, 'sign_up');
  // An hour before: check-in opens, everyone signed up hears.
  await fire();
  assert.ok(club.scheduled[0].checkInTold);
  await newsOf('dee', b => b.kind === 'checkin');
  // Ann and Dee (waitlisted) check in, and Bob; Cy, with a seat, doesn't.
  for (const n of ['ann', 'dee', 'bob']) await act(n, id, 'check_in');
  // The start: a table of the game opens, seats held for Ann and Dee
  // (Cy's seat went to Dee); Bob, checked in and left over, is on the
  // game's live waitlist.
  await fire();
  assert.deepEqual(roster(club.scheduled[0]).noShows, [ids.cy.id]);
  assert.equal(club.scheduled[0].status, 'started');
  const tid = club.scheduled[0].tables[0];
  assert.notEqual(tid, main.id);
  await until('it runs', () => server.running(tid));
  const start = await newsOf('dee', b => b.kind === 'start');
  assert.equal(start.table, tid);
  assert.ok(news('ann').some(b => b.kind === 'start'));
  assert.deepEqual((club.waitlist[tid] || []).map(x => x.member).sort(), [ids.ann.id, ids.dee.id].sort());
  await newsOf('bob', b => b.kind === 'waitlist');
  assert.ok(listOf(club, key).some(e => e.member === ids.bob.id));
  await viewOf('cy', v => v.games[0]?.mine?.result === 'noShow');
});

test('a start with too few checked in waits for the owner: start short or cancel', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, server, act, fire, newsOf, viewOf} = await serverFor();
  const id = await server.run('schedule_game', {game: {key: 'nlhe:1/2:2', startAt: Date.now() + 2 * H, players: 2}});
  for (const n of ['ann', 'bob']) await act(n, id, 'sign_up');
  // Another next week, cancelled: everyone signed up hears.
  const later = await server.run('schedule_game', {game: {key: 'nlhe:1/2:2', startAt: Date.now() + 7 * 24 * H, players: 2}});
  await act('bob', later, 'sign_up');
  await server.run('cancel_scheduled', {id: later});
  await newsOf('bob', b => b.kind === 'cancelled' && b.id === later);
  await viewOf('bob', v => v.games.find(g => g.id === later)?.status === 'cancelled');
  // Check-in opens; only Ann checks in, of the two needed.
  await fire();
  await act('ann', id, 'check_in');
  // The start: no table; Ann hears it's waiting on the owner.
  const before = club.tables.length;
  await fire();
  assert.equal(club.scheduled.find(g => g.id === id).status, 'short');
  await newsOf('ann', b => b.kind === 'short');
  assert.equal(club.tables.length, before);
  // Started short: Ann's seat is held at the table it opens.
  await server.run('start_scheduled', {id});
  assert.equal(club.tables.length, before + 1);
  const tid = club.scheduled.find(g => g.id === id).tables[0];
  await until('it runs', () => server.running(tid));
  assert.equal((await newsOf('ann', b => b.kind === 'start')).table, tid);
  await assert.rejects(async () => server.run('start_scheduled', {id}), /started/);
});

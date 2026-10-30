// Grouped tables with must-move (#501): a seat free at a table brings up
// the player longest in the group at the table below, after their hand;
// when the group's tables are full, everyone online but those at them is
// asked "We're starting a new table. Join?", and once the group's minimum
// say yes, a table like the main one opens. Real club tables (club-host.js
// and ducy's engine) and the club server. Needs the wasm build in wasm/.
// Run with: node --test test/table-groups.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
if (haveWasm) await import('./wasm.mjs');
const { approve, newClub } = await import('../src/club.js');
const { issue, totals } = await import('../src/club-chips.js');
const { newTable, tablesBody } = await import('../src/club-tables.js');
const { clubEngine } = await import('../src/club-engine.js');
const { createTableHost } = await import('../src/club-host.js');
const { createClubServer } = await import('../src/club-server.js');
const { createIdentity, signMessage, Verifier } = await import('../src/identity.js');
const { groupOf, makeGroup } = await import('../src/club-groups.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const PEOPLE = ['ann', 'bob', 'cy', 'dee', 'eve'];
const engineCall = engine => async (op, ...args) => engine.ops[op](...args);
const memStore = () => {
  const store = new Map();
  return {get: async (c, t) => store.get(t) || null, put: async (c, t, rec) => { store.set(t, rec); }, drop: async (c, t) => { store.delete(t); }};
};

// A club whose members are `ids`, 1000 chips each, with Main and MM (2
// seats each) in a group, Main first.
function groupedClub(ids = PEOPLE) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const main = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  const mm = newTable(club, {name: 'MM', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  const g = makeGroup(club, main.id, 2);
  club.groups[0].tables.push(mm.id);
  return {club, main, mm, gid: g.id};
}

function hostFor(club, opts = {}) {
  const engine = clubEngine();
  const got = Object.fromEntries(PEOPLE.map(id => [id, []]));
  const full = [];
  const host = createTableHost({
    club: () => club, save() {}, chipsChanged() {}, tablesChanged() {}, onHand() {},
    sendTable: (to, msg) => queueMicrotask(() => got[to]?.push({...msg.update, table: msg.table})),
    call: engineCall(engine), store: memStore(), groupFull: gid => full.push(gid), ...opts,
  });
  return {host, got, full};
}

const seated = (club, id) => club.members[id].seat;
async function sit(host, tid, id, amount = 150) {
  await host.handle(tid, id, {type: 'join'});
  await host.handle(tid, id, {type: 'request_chips', amount});
}

test('a seat free at the main table brings up the player longest in the group below', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, mm, gid} = groupedClub();
  const {host, got, full} = hostFor(club);
  await host.start(main);
  await host.start(mm);
  await sit(host, main.id, 'ann');
  await sit(host, main.id, 'bob');
  await until('Main full', () => seated(club, 'ann') && seated(club, 'bob'));
  // Cy sits at MM first, so he's been in the group longer than Dee.
  await sit(host, mm.id, 'cy');
  await until('cy at MM', () => seated(club, 'cy'));
  await sleep(5);
  await sit(host, mm.id, 'dee');
  await until('dee at MM', () => seated(club, 'dee'));
  const joined = club.groups[0].joined;
  assert.ok(joined.cy < joined.dee);
  // The group is full: someone turned away asks about a new table.
  await host.handle(main.id, 'eve', {type: 'join'});
  await until('eve refused', () => got.eve.find(u => u.type === 'rejected'));
  assert.deepEqual(full, [gid]);
  // Bob leaves Main: Cy moves up, after his hand, and isn't logged as anyone's move.
  const logged = (club.log || []).length;
  await host.handle(main.id, 'bob', {type: 'leave'});
  const m = await until('cy moved', () => got.cy.find(u => u.type === 'moved'));
  assert.equal(m.to, main.id);
  assert.equal(seated(club, 'cy'), null);
  assert.equal((club.log || []).length, logged);
  // Moving within the group keeps his time in it; Bob left the group.
  assert.equal(club.groups[0].joined.cy, joined.cy);
  assert.ok(!('bob' in club.groups[0].joined));
  // He sits at Main as usual; Dee stays at MM, alone, and it stays open.
  await sit(host, main.id, 'cy', 120);
  await until('cy at Main', () => seated(club, 'cy')?.table === main.id);
  assert.equal(seated(club, 'dee').table, mm.id);
  assert.ok(host.running(mm.id));
  // Members see each table's place.
  const body = tablesBody(club, host.seatedCounts());
  assert.deepEqual(body.tables.map(t => t.group?.place), [0, 1]);
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(mm.id);
});

// The club server, its members' messages signed, with timers run by hand.
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
    engine: {call: engineCall(engine), store: memStore(), timers: {set: (fn, ms) => timers.push({fn, ms}) - 1, clear: i => { if (timers[i]) timers[i].fn = null; }}},
  });
  await server.relayOpen();
  const say = async (n, body) => server.message({from: ids[n].id, data: await signMessage(ids[n], {club: club.code, ...body})});
  const groupMsgs = n => sent.filter(s => s.to === ids[n].id && s.data?.body?.type === 'group').map(s => s.data.body);
  return {club, main, server, ids, say, groupMsgs, timers};
}

test('asked about a new table: it opens once the minimum say yes, like the main one', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, server, ids, say, groupMsgs} = await serverFor();
  const gid = await server.run('make_group', {table: main.id, min: 2});
  assert.equal(groupOf(club, main.id).place, 0);
  // Too few online to ask.
  await server.message({from: ids.ann.id, event: 'open'});
  await assert.rejects(async () => server.run('ask_group', {id: gid}), /Fewer than 2/);
  for (const n of ['bob', 'cy']) await server.message({from: ids[n].id, event: 'open'});
  assert.equal(await server.run('ask_group', {id: gid}), 3);
  await until('the questions', () => groupMsgs('cy').length);
  const ask = groupMsgs('cy')[0];
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.name, 'Main');
  await assert.rejects(async () => server.run('ask_group', {id: gid}), /already/);
  // Ann says no, Bob and Cy yes: the table opens.
  const answer = (n, yes) => say(n, {type: 'table', table: `group:${gid}`, cmd: {type: 'group_answer', group: gid, yes}});
  await answer('ann', false);
  await answer('bob', true);
  assert.equal(club.groups[0].tables.length, 1);
  await answer('cy', true);
  await until('the new table', () => club.groups[0].tables.length === 2);
  const t = club.tables.find(x => x.id === club.groups[0].tables[1]);
  assert.deepEqual([t.game, t.sb, t.bb, t.seats], [main.game, main.sb, main.bb, main.seats]);
  await until('it runs', () => server.running(t.id));
  // Bob and Cy are told to sit down there; Ann hears it's over.
  await until('told', () => groupMsgs('bob').some(b => b.kind === 'open'));
  assert.equal(groupMsgs('bob').find(b => b.kind === 'open').table, t.id);
  assert.ok(groupMsgs('ann').some(b => b.kind === 'closed'));
  // The minimum changes, and the group ends: its tables go on alone.
  await server.run('set_group_min', {id: gid, min: 2});
  await server.run('end_group', {id: gid});
  assert.equal(club.groups, undefined);
});

test('time runs out before enough say yes: no table, and those who said yes are told', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, server, ids, say, groupMsgs, timers} = await serverFor();
  const gid = await server.run('make_group', {table: main.id, min: 2});
  for (const n of ['ann', 'bob', 'cy']) await server.message({from: ids[n].id, event: 'open'});
  await server.run('ask_group', {id: gid});
  await say('ann', {type: 'table', table: `group:${gid}`, cmd: {type: 'group_answer', group: gid, yes: true}});
  const timer = timers.findLast(x => x.fn && x.ms > 50_000);
  assert.ok(timer, 'a minute to answer');
  await timer.fn();
  await until('told', () => groupMsgs('ann').some(b => b.kind === 'closed'));
  assert.equal(groupMsgs('ann').find(b => b.kind === 'closed').reason, 'Not enough players for a new table.');
  assert.equal(groupMsgs('bob').find(b => b.kind === 'closed').reason, undefined);
  assert.equal(club.groups[0].tables.length, 1);
  assert.equal(club.tables.length, 1);
});

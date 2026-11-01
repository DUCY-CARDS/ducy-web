// Must move and waitlists (#501, #518): a seat free at a main table brings
// up the player who sat earliest at the must-move table, after their hand;
// a free seat goes to the next on the game's list for a minute, then the
// next; and a game that opens must-move tables by itself asks the first on
// its list "We're starting a new table. Join?", then further down, and opens
// one once enough say yes. Real club tables (club-host.js and ducy's engine)
// and the club server. Needs the wasm build in wasm/.
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
const { command } = await import('../src/club-commands.js');
const { gameKey, listOf } = await import('../src/club-lists.js');

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
// The clock, moved on by `fire` (below): offers lapse by it.
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const engineCall = engine => async (op, ...args) => engine.ops[op](...args);
const memStore = () => {
  const store = new Map();
  return {get: async (c, t) => store.get(t) || null, put: async (c, t, rec) => { store.set(t, rec); }, drop: async (c, t) => { store.delete(t); }};
};

// A club whose members are `ids`, 1000 chips each, with Main and MM (2
// seats each), must move with Main its main table.
function mustMoveClub(ids = PEOPLE) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id[0].toUpperCase() + id.slice(1), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
    issue(club, id, 1000, 0);
  }
  const main = newTable(club, {name: 'Main', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  const mm = newTable(club, {name: 'MM', sb: 1, bb: 2, minBB: 40, maxBB: 100, seats: 2, turnSecs: 0});
  command(club, 'set_must_move', {key: gameKey(main), on: true, mains: 1});
  return {club, main, mm, gid: club.groups[0].id};
}

function hostFor(club, opts = {}) {
  const engine = clubEngine();
  const got = Object.fromEntries(PEOPLE.map(id => [id, []]));
  const host = createTableHost({
    club: () => club, save() {}, chipsChanged() {}, tablesChanged() {}, onHand() {},
    sendTable: (to, msg) => queueMicrotask(() => got[to]?.push({...msg.update, table: msg.table})),
    call: engineCall(engine), store: memStore(), ...opts,
  });
  return {host, got};
}

const seated = (club, id) => club.members[id].seat;
async function sit(host, tid, id, amount = 150) {
  await host.handle(tid, id, {type: 'join'});
  await host.handle(tid, id, {type: 'request_chips', amount});
}

test('a seat free at the main table brings up who sat earliest at the must-move table', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, mm} = mustMoveClub();
  assert.equal(club.groups[0].tables.join(), [main.id, mm.id].join());
  const {host, got} = hostFor(club);
  await host.start(main);
  await host.start(mm);
  await sit(host, main.id, 'ann');
  await sit(host, main.id, 'bob');
  await until('Main full', () => seated(club, 'ann') && seated(club, 'bob'));
  // Cy sits at MM first, then Dee.
  await sit(host, mm.id, 'cy');
  await until('cy at MM', () => seated(club, 'cy'));
  await sleep(5);
  await sit(host, mm.id, 'dee');
  await until('dee at MM', () => seated(club, 'dee'));
  assert.ok(seated(club, 'cy').satAt < seated(club, 'dee').satAt);
  // Members see MM feed Main, in its move order.
  const body = tablesBody(club, host.seatedCounts());
  assert.deepEqual(body.tables.map(t => t.group?.main), [true, false]);
  assert.deepEqual(body.tables[1].group.to, ['Main']);
  assert.deepEqual(body.tables[1].group.order.map(p => p.id), ['cy', 'dee']);
  // Bob leaves Main: Cy moves up, after his hand, and isn't logged as anyone's move.
  const logged = (club.log || []).length;
  await host.handle(main.id, 'bob', {type: 'leave'});
  const m = await until('cy moved', () => got.cy.find(u => u.type === 'moved'));
  assert.equal(m.to, main.id);
  assert.equal(seated(club, 'cy'), null);
  assert.equal((club.log || []).length, logged);
  // He sits at Main as usual; Dee stays at MM, alone, and it stays open.
  await sit(host, main.id, 'cy', 120);
  await until('cy at Main', () => seated(club, 'cy')?.table === main.id);
  assert.equal(seated(club, 'dee').table, mm.id);
  assert.ok(host.running(mm.id));
  assert.ok(totals(club).conserved);
  await host.close(main.id);
  await host.close(mm.id);
});

// The club server, its members' messages signed, with timers run by hand.
// Main seats 2, and no one sits: seats offered from the list are held.
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
  await until('Main runs', () => server.running(main.id));
  for (const n of PEOPLE) await server.message({from: ids[n].id, event: 'open'});
  const say = async (n, body) => server.message({from: ids[n].id, data: await signMessage(ids[n], {club: club.code, ...body})});
  const of = type => n => sent.filter(s => s.to === ids[n].id && s.data?.body?.type === type).map(s => s.data.body);
  const key = gameKey(main);
  const list = (n, type) => say(n, {type: 'table', table: `list:${key}`, cmd: {type}});
  // The latest timer that calls `what` (the waitlists' lapseNow, the
  // question's nextRound), run with the clock moved on past it.
  const fire = async what => {
    const t = timers.findLast(x => x.fn && String(x.fn).includes(what));
    assert.ok(t, `a ${what} timer`);
    const fn = t.fn;
    t.fn = null;
    shift += t.ms + 100;
    await fn();
  };
  return {club, main, server, ids, say, list, key, fire, groupMsgs: of('group'), listMsgs: of('list'), listsOf: of('lists')};
}

test('a free seat goes to the next on the list; a missed one keeps their place a while', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, ids, say, list, key, fire, listMsgs, listsOf} = await serverFor();
  await list('ann', 'join_list');
  await list('bob', 'join_list');
  await list('cy', 'join_list');
  // Two seats: Ann and Bob are offered them; Cy waits, 1st in line.
  await until('offers', () => listMsgs('bob').some(b => b.kind === 'offer'));
  assert.equal(listMsgs('ann').find(b => b.kind === 'offer').table, main.id);
  assert.ok(!listMsgs('cy').some(b => b.kind === 'offer'));
  await until('cy’s lists', () => listsOf('cy').length);
  assert.deepEqual(listsOf('cy').at(-1).lists, [{key, count: 3, place: 3}]);
  // A minute on: both missed theirs, so the seats go to Cy; they keep
  // their places.
  await fire('lapseNow');
  await until('missed', () => listMsgs('ann').some(b => b.kind === 'missed'));
  await until('cy offered', () => listMsgs('cy').some(b => b.kind === 'offer'));
  assert.ok(listOf(club, key).find(e => e.member === ids.ann.id).missed);
  // Ann's back: her place again.
  await list('ann', 'list_back');
  assert.equal(listOf(club, key).find(e => e.member === ids.ann.id).missed, undefined);
  // Bob leaves the list.
  await list('bob', 'leave_list');
  assert.ok(!listOf(club, key).some(e => e.member === ids.bob.id));
  // Joining a game that isn't running is refused, and said.
  await say('dee', {type: 'table', table: 'list:plo4:1/2:6', cmd: {type: 'join_list'}});
  const refused = await until('refused', () => listMsgs('dee').find(b => b.kind === 'refused'));
  assert.match(refused.reason, /isn’t running/);
});

test('a new must-move table: the first on the list are asked, then the next, and it opens', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, main, server, ids, say, list, key, fire, groupMsgs, listsOf} = await serverFor();
  await server.run('set_must_move', {key, on: true, mains: 1, autoOpen: true, min: 2});
  // Ann and Bob take Main's two seats (offered, held); Cy, Dee and Eve wait.
  for (const n of ['ann', 'bob', 'cy', 'dee', 'eve']) await list(n, 'join_list');
  // Every table full and enough waiting: Cy and Dee, first in line, are asked.
  await until('asked', () => groupMsgs('dee').some(b => b.kind === 'ask'));
  const gid = club.groups[0].id;
  assert.equal(groupMsgs('cy')[0].name, 'Main');
  assert.ok(!groupMsgs('eve').length);
  const answer = (n, yes) => say(n, {type: 'table', table: `group:${gid}`, cmd: {type: 'group_answer', group: gid, yes}});
  // Cy says no: off the list. Dee says yes.
  await answer('cy', false);
  assert.ok(!listOf(club, key).some(e => e.member === ids.cy.id));
  await answer('dee', true);
  // A minute on, not enough: Eve, next down, is asked too.
  await fire('nextRound');
  await until('eve asked', () => groupMsgs('eve').some(b => b.kind === 'ask'));
  await answer('eve', true);
  // Enough: a table like Main opens at the end of the chain.
  await until('the new table', () => club.groups[0].tables.length === 2);
  const t = club.tables.find(x => x.id === club.groups[0].tables[1]);
  assert.deepEqual([t.game, t.sb, t.bb, t.seats], [main.game, main.sb, main.bb, main.seats]);
  await until('it runs', () => server.running(t.id));
  // Dee and Eve are told to sit there, off the list; Cy hears it's over.
  await until('told', () => groupMsgs('eve').some(b => b.kind === 'open'));
  assert.equal(groupMsgs('dee').find(b => b.kind === 'open').table, t.id);
  assert.ok(!listOf(club, key).some(e => e.member === ids.dee.id));
  await until('eve off the list', () => listsOf('eve').at(-1)?.lists.length === 0);
  assert.ok(groupMsgs('cy').some(b => b.kind === 'closed'));
  // A main table never goes back to must move; off, the tables go on alone.
  await server.run('set_must_move', {key, on: true, mains: 2, autoOpen: true, min: 2});
  await assert.rejects(async () => server.run('set_must_move', {key, on: true, mains: 1}), /can’t go back/);
  await server.run('set_must_move', {key, on: false});
  assert.equal(club.groups, undefined);
});

test('an offered game opens once those interested say yes; no answer keeps your place', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {club, server, ids, say, fire, groupMsgs, listsOf} = await serverFor();
  // On the menu, not running: PLO 1/2 for three.
  const offered = await server.run('offer_game', {table: {game: 'plo4', sb: 1, bb: 2, seats: 3, minBB: 40, maxBB: 100, turnSecs: 0}});
  assert.equal(offered, 'plo4:1/2:3');
  assert.equal(club.tables.filter(t => t.game === 'plo4').length, 0);
  const join = (n, min) => say(n, {type: 'table', table: `list:${offered}`, cmd: {type: 'join_list', ...(min ? {min} : {})}});
  const gid = `interest:${offered}`;
  const answer = (n, yes) => say(n, {type: 'table', table: `group:${gid}`, cmd: {type: 'group_answer', group: gid, yes}});
  const asks = n => groupMsgs(n).filter(b => b.kind === 'ask').length;
  // Ann would start with 2: one isn't enough.
  await join('ann', 2);
  await until('ann’s lists', () => listsOf('ann').at(-1)?.lists.length);
  assert.equal(listsOf('ann').at(-1).lists[0].min, 2);
  assert.equal(asks('ann'), 0);
  // Bob too: two who'd start with 2 are asked.
  await join('bob', 2);
  await until('asked', () => asks('bob') === 1);
  assert.equal(groupMsgs('ann')[0].group, gid);
  // Cy wants a full table: not asked about two.
  await join('cy');
  await answer('ann', true);
  // Bob doesn't answer. A minute on, no one else would start with 2: it
  // doesn't open, and Ann hears why. Everyone keeps their place.
  await fire('nextRound');
  await until('not enough', () => groupMsgs('ann').some(b => b.reason === 'Not enough players for a new table.'));
  assert.equal(listOf(club, offered).length, 3);
  // Dee would start with 2: four interested, three willing to start with 3
  // or fewer, so a table of three. The first three are asked.
  await join('dee', 2);
  await until('asked again', () => asks('cy') === 1);
  assert.equal(asks('dee'), 0);
  await answer('ann', true);
  await answer('bob', true);
  // Cy doesn't answer: a minute on, the next one down is asked.
  await fire('nextRound');
  await until('dee asked', () => asks('dee') === 1);
  await answer('dee', true);
  // Enough: a table of the game opens, and they're told to sit there.
  await until('the table', () => club.tables.some(t => t.game === 'plo4'));
  const t = club.tables.find(x => x.game === 'plo4');
  await until('it runs', () => server.running(t.id));
  await until('told', () => groupMsgs('dee').some(b => b.kind === 'open'));
  assert.equal(groupMsgs('ann').find(b => b.kind === 'open').table, t.id);
  // Cy, who didn't answer, is still on the list; the others are off it.
  assert.deepEqual(listOf(club, offered).map(e => e.member), [ids.cy.id]);
  assert.ok(groupMsgs('cy').some(b => b.kind === 'closed'));
  // No longer offered.
  await server.run('remove_offer', {key: offered});
  assert.equal(club.menu, undefined);
});

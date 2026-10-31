// Admins by key (#401): the checks on a signed admin request, the admin
// log, and what the admin sees of a club, chats and cards hidden unless
// shown. No relay needed (relay/src/admin.js, club-room.js, registry.js).
// Run with: node --test test/admin-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { readFileSync } from 'node:fs';
import { createIdentity, signMessage } from '../src/identity.js';
import { adminApi, adminsFrom, checkAdmin, mergePeople, WINDOW_MS } from '../relay/src/admin.js';
import { adminView } from '../relay/src/club-room.js';
import { ADMIN_LOG, registry, limitsFrom } from '../relay/src/registry.js';

const mem = () => {
  const m = new Map();
  return {get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
};
const sign = (ident, path, data = {}) => signMessage(ident, {type: 'admin', path, data});

test('admins.json is a list of {id, pub, name}', () => {
  const list = JSON.parse(readFileSync(new URL('../admins.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(list) && list.length);
  for (const a of list) assert.deepEqual(Object.keys(a).sort(), ['id', 'name', 'pub']);
});

test('only well-formed entries count: a placeholder lets no one in', async () => {
  const ann = await createIdentity();
  const admins = adminsFrom([{id: '', pub: '', name: 'Placeholder'}, {id: ann.id, pub: ann.pub, name: 'Ann'}, null, 'x']);
  assert.deepEqual([...admins.keys()], [ann.id]);
  assert.equal(adminsFrom({}).size, 0);
});

test('a signed request: listed, fresh and for this path', async () => {
  const ann = await createIdentity(), eve = await createIdentity();
  const admins = adminsFrom([{id: ann.id, pub: ann.pub, name: 'Ann'}]);
  const env = await sign(ann, '/admin/grant', {id: eve.id});
  const ok = await checkAdmin(env, '/admin/grant', admins, env.seq);
  assert.equal(ok.admin.name, 'Ann');
  assert.deepEqual(ok.data, {id: eve.id});

  const refused = async (p, status, re) => {
    await assert.rejects(p, e => e.status === status && re.test(e.message));
  };
  await refused(checkAdmin(null, '/admin/grant', admins), 400, /signed/);
  await refused(checkAdmin(env, '/admin/revoke', admins, env.seq), 401, /something else/);
  await refused(checkAdmin({...env, body: {...env.body, data: {id: ann.id}}}, '/admin/grant', admins, env.seq), 401, /signed properly/);
  await refused(checkAdmin(env, '/admin/grant', admins, env.seq + WINDOW_MS + 1), 401, /too old/);
  await refused(checkAdmin(env, '/admin/grant', admins, env.seq - WINDOW_MS - 1), 401, /too old/);
  const theirs = await sign(eve, '/admin/clubs');
  await assert.rejects(checkAdmin(theirs, '/admin/clubs', admins, theirs.seq), e => e.status === 403 && e.extra.id === eve.id && e.extra.pub === eve.pub);
  // Listed by ID, but with another key.
  const swapped = adminsFrom([{id: ann.id, pub: eve.pub, name: 'Ann'}]);
  await refused(checkAdmin(env, '/admin/grant', swapped, env.seq), 403, /admin list/);
});

test('replays are refused; seqs are forgotten after twice the window', async () => {
  const reg = registry(mem(), limitsFrom({}));
  await reg.adminSeen('a', 100, 1000);
  await assert.rejects(reg.adminSeen('a', 100, 1001), /already received/);
  await reg.adminSeen('b', 100, 1001);
  await reg.adminSeen('a', 101, 1002);
  await reg.adminSeen('a', 102, 1000 + 2 * WINDOW_MS + 1);
  await reg.adminSeen('a', 100, 1000 + 2 * WINDOW_MS + 1);
});

test('the admin log keeps the last ADMIN_LOG actions', async () => {
  // Storage that doesn't copy, to be quick.
  const m = new Map();
  const reg = registry({get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }}, limitsFrom({}));
  for (let i = 0; i < ADMIN_LOG + 3; i++) await reg.adminLog({at: i, action: 'grant'});
  const log = await reg.adminLogList();
  assert.equal(log.length, ADMIN_LOG);
  assert.equal(log[0].at, 3);
});

test('every action is logged, a reveal before anything is shown', async () => {
  const ann = await createIdentity();
  const admins = adminsFrom([{id: ann.id, pub: ann.pub, name: 'Ann'}]);
  const reg = registry(mem(), limitsFrom({}));
  await reg.claim('owner1', 'AAAA-BBBB', Date.now(), 'Owls');
  const order = [];
  const ops = {
    seen: (id, seq) => reg.adminSeen(id, seq),
    log: e => { order.push('log:' + e.action); return reg.adminLog(e); },
    logList: () => reg.adminLogList(),
    list: () => reg.list(), grant: (id, b) => reg.grant(id, b), revoke: id => reg.revoke(id),
    setClub: (c, ch) => reg.setClub(c, ch), status: c => reg.status(c),
    room: async (code, what, p) => { order.push(`room:${what}${p?.reveal ? ':reveal' : ''}`); return {}; },
    refresh: async () => {},
  };
  const call = async (path, data) => adminApi(path, await sign(ann, path, data), admins, ops);
  assert.equal((await call('/admin/grant', {id: 'p1', note: 'friend'})).status, 200);
  assert.equal((await call('/admin/revoke', {id: 'p1'})).status, 200);
  assert.equal((await call('/admin/club/AAAA-BBBB/set', {suspended: true, limits: {tables: 4}})).status, 200);
  assert.equal((await call('/admin/club/AAAA-BBBB/set', {plan: 'club'})).status, 200);
  order.length = 0;
  assert.equal((await call('/admin/club/AAAA-BBBB', {reveal: true})).status, 200);
  assert.equal(order[0], 'log:reveal');
  assert.ok(order.includes('room:full:reveal'));
  // Looking without revealing isn't an action.
  assert.equal((await call('/admin/club/AAAA-BBBB', {})).status, 200);
  const log = (await call('/admin/log')).body.log;
  assert.deepEqual(log.map(e => [e.action, e.target]), [['grant', 'p1'], ['revoke', 'p1'], ['pause', 'AAAA-BBBB'], ['limits', 'AAAA-BBBB'], ['plan', 'AAAA-BBBB'], ['reveal', 'AAAA-BBBB']]);
  assert.equal(log[0].detail, 'friend');
  assert.equal(log[3].detail, '4 tables, 1/day');
  assert.ok(log.every(e => e.by === ann.id && e.name === 'Ann'));
  // A replay of a reveal isn't logged twice.
  const env = await sign(ann, '/admin/club/AAAA-BBBB', {reveal: true});
  await adminApi('/admin/club/AAAA-BBBB', env, admins, ops);
  assert.equal((await adminApi('/admin/club/AAAA-BBBB', env, admins, ops)).status, 401);
  assert.equal((await reg.adminLogList()).filter(e => e.action === 'reveal').length, 2);
  // A club that isn't there.
  assert.equal((await call('/admin/club/ZZZZ-ZZZZ/set', {suspended: true})).status, 409);
  assert.equal((await call('/admin/nothing')).status, 404);
});

// A club's storage with a member, a lobby line and a finished hand.
async function clubStorage() {
  const s = mem();
  await s.put('club', {
    code: 'AAAA-BBBB', name: 'Owls', ownerId: 'own', hostId: 'host', invite: 'x', createdAt: 1,
    members: {bob: {id: 'bob', name: 'Bob', status: 'member', balance: 500, role: 'assistant'}, cy: {id: 'cy', name: 'Cy', status: 'pending', balance: 0}},
    chips: {issued: 500, reclaimed: 0},
    money: {links: [{member: 'bob', backer: 'club', balance: 500, credit: 0}], accounts: {bob: {through: 'club'}}, ledger: [{n: 1, at: 5, tx: 1, member: 'bob', backer: 'club', kind: 'give', amount: 500, balance: 500, note: null, about: null}]},
    requestLog: [{member: 'bob', asked: 100, given: 100, outcome: 'granted', at: 4}],
    help: [{id: 'h1', from: 'bob', name: 'Bob', text: 'stuck', at: 6, handled: null}],
    log: [{at: 7, by: 'bob', text: 'Bob opened a table'}],
    lobby: [{id: 'l1', from: 'bob', name: 'Bob', text: 'hi all', at: 8}],
    tables: [{id: 't1', name: 'Main', status: 'open'}], tourneys: [],
  });
  await s.put('hands', [{key: 'hand:1', at: 9}]);
  await s.put('hand:1', {id: 'hand:1', at: 9, tableName: 'Main', board: ['As', 'Kd', '7c'], events: [{deal: 'As'}], pot: 40, seats: [{i: 0, name: 'Bob', cards: ['Ah', 'Ad'], net: 20, inHand: true}]});
  await s.put('seen', {bob: 10, own: 11});
  return s;
}

test('a club in full: chats and cards hidden unless shown', async () => {
  const s = await clubStorage();
  const hid = await adminView(s, 'full');
  assert.equal(hid.lobby, null);
  assert.equal(hid.lobbyCount, 1);
  assert.equal(hid.revealed, false);
  assert.equal(hid.hands.length, 1);
  assert.deepEqual(hid.hands[0].board, []);
  assert.deepEqual(hid.hands[0].events, []);
  assert.equal(hid.hands[0].seats[0].cards, null);
  assert.equal(hid.hands[0].seats[0].net, 20);
  assert.ok(!JSON.stringify(hid).includes('hi all'));
  assert.ok(!JSON.stringify(hid).includes('Ah'));
  // Everything else it stores.
  assert.deepEqual([hid.ledger[0].name, hid.ledger[0].backerName], ['Bob', 'Club']);
  assert.equal(hid.links.length, 1);
  assert.equal(hid.money, undefined, 'the ledger once, not twice');
  assert.equal(hid.requestLog.length, 1);
  assert.equal(hid.help[0].text, 'stuck');
  assert.equal(hid.log.length, 1);
  assert.equal(hid.members.find(m => m.id === 'bob').lastSeen, 10);
  assert.equal(hid.ownerSeen, 11);

  const shown = await adminView(s, 'full', {reveal: true});
  assert.equal(shown.lobby[0].text, 'hi all');
  assert.deepEqual(shown.hands[0].seats[0].cards, ['Ah', 'Ad']);
  assert.deepEqual(shown.hands[0].board, ['As', 'Kd', '7c']);
  assert.equal(await adminView(mem(), 'full'), null);
});

test('people and one person\'s part in a club', async () => {
  const s = await clubStorage();
  const {people} = await adminView(s, 'people');
  assert.deepEqual(people.map(p => [p.id, p.status, p.lastSeen]), [['bob', 'member', 10], ['cy', 'pending', null], ['own', null, 11]]);
  const bob = await adminView(s, 'person', {id: 'bob'});
  assert.equal(bob.member.name, 'Bob');
  assert.equal(bob.ledger.length, 1);
  assert.equal(bob.requests.length, 1);
  assert.equal(bob.help.length, 1);
  assert.equal(bob.log.length, 1);
  assert.ok(!JSON.stringify(bob).includes('hi all'));
  assert.equal((await adminView(s, 'person', {id: 'zed'})).member, null);

  // Across clubs, with grants and trials.
  const merged = mergePeople(
    {clubs: [{code: 'AAAA-BBBB', name: 'Owls', owner: 'own'}], grants: {g1: {note: 'x'}}, trials: {own: 'AAAA-BBBB'}},
    {'AAAA-BBBB': {name: 'Owls', people}},
  );
  const by = Object.fromEntries(merged.map(p => [p.id, p]));
  assert.deepEqual(Object.keys(by).sort(), ['bob', 'cy', 'g1', 'own']);
  assert.deepEqual(by.own.clubs, [{code: 'AAAA-BBBB', club: 'Owls', role: 'owner'}]);
  assert.equal(by.own.trial, 'AAAA-BBBB');
  assert.equal(by.bob.clubs[0].role, 'assistant');
  assert.equal(by.bob.clubs[0].balance, 500);
  assert.deepEqual(by.g1.grant, {note: 'x'});
  assert.equal(merged[0].id, 'own');
});

// Clubs by permission (#265) in the Node dev relay: a player's one trial
// club, the super admin's API (permission, limits, pausing, a look inside),
// and the plan's limits on tables. Admins by key (#401): requests signed by
// a key in admins.json, the admin log, People, and showing chats and cards.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-admin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { relayClient } from './relay-helper.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { adminFetch, postAdmin, signAdmin, testAdmin } from './admin-helper.mjs';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const PORT = 21000 + Math.floor(Math.random() * 1000);
const ADMIN = await testAdmin('Tess');
// As before #401, to show the token no longer works.
const TOKEN = 'test-admin-token-0123456789abcdef';
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, ADMINS_FILE: ADMIN.file, ADMIN_TOKEN: TOKEN}});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

const relay = relayClient(PORT);
// `closed` here resolves to {code, reason}.
const open = (path, ident = null, opts) => {
  const c = relay.open(path, ident, opts);
  return {...c, closed: c.closedWith};
};

const api = adminFetch(PORT, ADMIN.ident);
// A club change (#401: /admin/club/<code>/set).
const setClub = (code, change) => api(`/admin/club/${code}/set`, change);

// `who` asks for an always-on club in room `code`, with `grant` (its link's
// token, #636): the reply.
async function create(who, code, name, grant = '') {
  const c = open(`/room/${code}?role=guest&id=${who.id}&queue=1`, who);
  await c.ready;
  c.send(await signMessage(who, {type: 'create_club', club: code, name, ...(grant ? {grant} : {})}));
  for (;;) {
    const m = await c.next();
    if (m.type === 'club_created' || m.type === 'club_error') return {c, m};
  }
}
const grant = async (id, data = {}) => {
  const r = await api('/admin/grant', {id, ...data});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
};
const refused = async (who, code, token) => {
  const r = await create(who, code, 'Nope', token);
  assert.equal(r.m.type, 'club_error');
  assert.match(r.m.reason, /isn’t for this player ID, or it was used or taken back/);
  r.c.ws.close();
};

test('grants and their one-time links, limits, pausing, and Wipe all clubs (#636)', {skip: !haveWasm && 'no wasm build'}, async () => {
  const ann = await createIdentity(), bob = await createIdentity();

  // No grant, no club: no trials any more.
  await refused(ann, 'UUUU-UUUU', '');
  const token = await grant(ann.id, {note: 'Thursdays'});
  // Ann's link, forwarded to Bob, does nothing for him.
  await refused(bob, 'UUUU-UUUU', token);
  const {c: o, m: made} = await create(ann, 'TTTT-TTTT', 'Night Owls', token);
  assert.equal(made.type, 'club_created');
  // Used: not again.
  await refused(ann, 'UUUU-UUUU', token);

  let list = (await api('/admin/clubs')).body;
  const rec = list.clubs.find(c => c.code === 'TTTT-TTTT');
  assert.equal(rec.plan, 'club');
  assert.equal(rec.owner, ann.id);
  assert.equal(rec.name, 'Night Owls');
  assert.deepEqual(list.grants, {});
  assert.deepEqual(list.invites[ann.id], {at: list.invites[ann.id].at, note: 'Thursdays', limits: null, usedAt: list.invites[ann.id].usedAt, code: 'TTTT-TTTT', used: true});
  assert.equal(JSON.stringify(list).includes(token), false);

  // The owner sees the plan, and the limit on tables.
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_hello'}));
  const view = await o.next('owner_view');
  assert.equal(view.body.plan.plan, 'club');
  assert.deepEqual(view.body.plan.limits, {tables: 2, tourneysPerDay: 1});
  for (let i = 1; i <= 3; i++) {
    o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'new_table', args: {table: {name: `T${i}`}}, id: i}));
    const r = await o.next('owner_result');
    if (i <= 2) assert.equal(r.body.error, '');
    else assert.match(r.body.error, /2 tables open at once/);
  }

  // The admin raises the limit; it applies at once.
  assert.equal((await setClub('TTTT-TTTT', {limits: {tables: 3}})).status, 200);
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'new_table', args: {table: {name: 'T3'}}, id: 4}));
  assert.equal((await o.next('owner_result')).body.error, '');

  // A look inside: its tables and members.
  const look = (await api('/admin/club/TTTT-TTTT')).body;
  assert.equal(look.blocked, '');
  assert.equal(look.inside.club.name, 'Night Owls');
  assert.equal(look.inside.club.tables.length, 3);
  assert.equal(look.inside.online, 1);
  // …and the club in full (#401).
  assert.equal(look.full.name, 'Night Owls');
  assert.equal(look.full.ownerId, ann.id);
  assert.equal(look.full.tables.filter(t => t.status !== 'closed').length, 3);

  // Bob joins and is let in; he says something in the lobby (#401).
  const b = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`, bob);
  await b.ready;
  b.send(await signMessage(bob, {club: 'TTTT-TTTT', type: 'join', invite: made.invite, name: 'Bob'}));
  await b.next('status');
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'approve', args: {id: bob.id}, id: 5}));
  assert.equal((await o.next('owner_result')).body.error, '');
  b.send(await signMessage(bob, {club: 'TTTT-TTTT', type: 'lobby_say', text: 'hi all'}));
  let lobby;
  do lobby = await b.next('lobby'); while (!lobby.body.chat.length);

  // The chat is hidden by default; showing it is logged.
  let full = (await api('/admin/club/TTTT-TTTT')).body.full;
  assert.equal(full.lobby, null);
  assert.equal(full.lobbyCount, 1);
  assert.equal(full.revealed, false);
  assert.equal(full.members.find(m => m.id === bob.id).status, 'member');
  assert.ok(full.members.find(m => m.id === bob.id).lastSeen > 0);
  full = (await api('/admin/club/TTTT-TTTT', {reveal: true})).body.full;
  assert.equal(full.revealed, true);
  assert.equal(full.lobby[0].text, 'hi all');

  // People: every player ID the server knows, with their clubs.
  const people = (await api('/admin/people')).body.people;
  const pb = people.find(p => p.id === bob.id), pa = people.find(p => p.id === ann.id);
  assert.deepEqual(pb.names, ['Bob']);
  assert.equal(pb.clubs[0].code, 'TTTT-TTTT');
  assert.equal(pb.clubs[0].status, 'member');
  assert.ok(pb.lastSeen > 0);
  assert.equal(pa.clubs[0].role, 'owner');
  // And one person's activity in every club.
  const person = (await api('/admin/person', {id: bob.id})).body;
  assert.equal(person.clubs.length, 1);
  assert.equal(person.clubs[0].member.name, 'Bob');

  // Pausing the club lets Bob go, and keeps him out.
  assert.equal((await setClub('TTTT-TTTT', {suspended: true})).status, 200);
  const gone = await b.closed;
  assert.equal(gone.code, 4003);
  assert.match(gone.reason, /paused/);
  const again = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`, bob);
  assert.equal((await again.closed).code, 4003);
  // The owner still gets in, to see why.
  const o2 = open(`/room/TTTT-TTTT?role=guest&id=${ann.id}&queue=1`, ann);
  await o2.ready;
  o2.ws.close();
  await setClub('TTTT-TTTT', {suspended: false});
  const back = open(`/room/TTTT-TTTT?role=guest&id=${bob.id}&queue=1`, bob);
  await back.ready;

  // A second grant: a second club, with the grant's limits.
  const second = await create(ann, 'VVVV-VVVV', 'Granted', await grant(ann.id, {note: 'test', limits: {tables: 6, tourneysPerDay: 2}}));
  assert.equal(second.m.type, 'club_created');
  list = (await api('/admin/clubs')).body;
  assert.deepEqual(list.clubs.find(c => c.code === 'VVVV-VVVV').limits, {tables: 6, tourneysPerDay: 2});
  // Revoking an unused grant kills its link; granting again replaces it.
  const bobs = await grant(bob.id);
  const bobs2 = await grant(bob.id);
  await refused(bob, 'WWWW-WWWW', bobs);
  assert.equal((await api('/admin/revoke', {id: bob.id})).status, 200);
  await refused(bob, 'WWWW-WWWW', bobs2);
  assert.equal((await api('/admin/clubs')).body.invites[bob.id], undefined);
  for (const s of [o, second.c]) s.ws.close();

  // Wipe all clubs: refused without this relay's name, typed exactly.
  const unused = await grant(bob.id);
  for (const confirm of [undefined, 'live', 'Local']) assert.equal((await api('/admin/wipe', {confirm})).status, 400);
  assert.equal((await api('/admin/clubs')).body.clubs.length, 2);
  const wiped = await api('/admin/wipe', {confirm: 'local'});
  assert.deepEqual([wiped.status, wiped.body], [200, {clubs: 2}]);
  // Its members are let go, and the clubs, grants and links are gone.
  assert.equal((await back.closed).code, 4004);
  list = (await api('/admin/clubs')).body;
  assert.deepEqual([list.clubs, list.grants, list.invites], [[], {}, {}]);
  assert.deepEqual((await fetch(`http://localhost:${PORT}/code/TTTT-TTTT`).then(r => r.json())), {kind: 'none'});
  assert.deepEqual((await api('/admin/fair-play')).body.clubs, []);
  await refused(bob, 'WWWW-WWWW', unused);
  // A room wiped is empty: a new grant makes a new club in it.
  const fresh = await create(ann, 'TTTT-TTTT', 'Again', await grant(ann.id));
  assert.equal(fresh.m.type, 'club_created');
  fresh.c.ws.close();

  // The admin log: every action, with who did it; the wipe before anything went.
  const log = (await api('/admin/log')).body.log;
  assert.deepEqual(log.map(e => e.action), ['grant', 'limits', 'reveal', 'pause', 'resume', 'grant', 'grant', 'grant', 'revoke', 'grant', 'wipe', 'grant']);
  assert.ok(log.every(e => e.by === ADMIN.ident.id && e.name === 'Tess' && e.at > 0));
  assert.equal(JSON.stringify(log).includes(token), false);
  const shown = log.find(e => e.action === 'reveal');
  assert.equal(shown.target, 'TTTT-TTTT');
  assert.equal(log.find(e => e.action === 'grant').target, ann.id);
  assert.deepEqual(log.filter(e => e.action === 'wipe').map(e => [e.target, e.detail]), [['local', '2 clubs']]);
});

test('only signed requests from a listed key get in', async () => {
  // The old token no longer works, in a header or otherwise.
  const old = await fetch(`http://localhost:${PORT}/admin/clubs`, {headers: {authorization: `Bearer ${TOKEN}`}});
  assert.equal(old.status, 405);
  const oldPost = await fetch(`http://localhost:${PORT}/admin/clubs`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`}});
  assert.equal(oldPost.status, 400);

  // A listed key is accepted.
  assert.equal((await api('/admin/clubs')).status, 200);

  // An unlisted key is refused, and told its ID and key to add.
  const eve = await createIdentity();
  const no = await adminFetch(PORT, eve)('/admin/clubs');
  assert.equal(no.status, 403);
  assert.match(no.body.error, /admin list/);
  assert.equal(no.body.id, eve.id);
  assert.equal(no.body.pub, eve.pub);

  // A bad signature: the admin's request with its data changed.
  const env = await signAdmin(ADMIN.ident, '/admin/grant', {id: eve.id});
  const forged = {...env, body: {...env.body, data: {id: eve.id, note: 'forged'}}};
  assert.equal((await postAdmin(PORT, '/admin/grant', forged)).status, 401);
  // Someone else's key in the admin's name.
  const claimed = await signAdmin(eve, '/admin/clubs');
  assert.equal((await postAdmin(PORT, '/admin/clubs', {...claimed, from: ADMIN.ident.id})).status, 401);
  // Signed for another path.
  const other = await signAdmin(ADMIN.ident, '/admin/clubs');
  assert.equal((await postAdmin(PORT, '/admin/log', other)).status, 401);

  // A replayed request: accepted once, then refused.
  const once = await signAdmin(ADMIN.ident, '/admin/clubs');
  assert.equal((await postAdmin(PORT, '/admin/clubs', once)).status, 200);
  const again = await postAdmin(PORT, '/admin/clubs', once);
  assert.equal(again.status, 401);
  assert.match(again.body.error, /already received/);
});

// Usage counts (#601): a club's players and the admins left out; and what's
// live now. A tab can't host a game any more (#643).
test('usage: players, clubs, now; the admins not counted', {skip: !haveWasm && 'no wasm build'}, async () => {
  const today = async () => (await api('/admin/stats')).body.days.at(-1);
  const before = await today();
  assert.equal((await api('/admin/stats')).body.days.length, 30);

  // No friends game: a host is refused.
  const host = open('/room/GGGG-HHHH?role=host');
  assert.equal((await host.closed).code, 4000);
  // Carl's club, and the admin in it.
  const carl = await createIdentity();
  const {c: cc, m} = await create(carl, 'WWWW-WWWW', 'Carl’s', await grant(carl.id));
  assert.equal(m.type, 'club_created');
  cc.send(await signMessage(carl, {club: 'WWWW-WWWW', type: 'owner_hello'}));
  await cc.next('owner_view');
  const adm = open(`/room/WWWW-WWWW?role=guest&id=${ADMIN.ident.id}&queue=1`, ADMIN.ident);
  await adm.ready;
  await new Promise(r => setTimeout(r, 200));

  const st = (await api('/admin/stats')).body;
  const after = st.days.at(-1);
  assert.equal(after.clubHands, before.clubHands);
  assert.equal(after.active - before.active, 1, 'Carl, not the admin');
  assert.equal(after.newPlayers - before.newPlayers, 1);
  assert.ok(after.clubsActive >= 1);
  assert.equal(after.games, undefined, 'no friends games');
  assert.equal(st.now.games, undefined);
  assert.ok(st.now.players >= 1, 'Carl');
  assert.ok(st.now.rooms >= 1);
  for (const s of [cc, adm]) s.ws.close();

  // No Cloudflare token here: nothing to show.
  assert.deepEqual((await api('/admin/cloudflare')).body, {enabled: false});
  // Only signed requests from a listed key.
  const eve = await createIdentity();
  assert.equal((await adminFetch(PORT, eve)('/admin/stats')).status, 403);
  assert.equal((await fetch(`http://localhost:${PORT}/admin/stats`, {method: 'POST', body: '{}'})).status, 401);
});

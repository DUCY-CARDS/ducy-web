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

// `who` asks for an always-on club in room `code`: the reply.
async function create(who, code, name) {
  const c = open(`/room/${code}?role=guest&id=${who.id}&queue=1`, who);
  await c.ready;
  c.send(await signMessage(who, {type: 'create_club', club: code, name}));
  for (;;) {
    const m = await c.next();
    if (m.type === 'club_created' || m.type === 'club_error') return {c, m};
  }
}

test('trial clubs, permission, limits and pausing', {skip: !haveWasm && 'no wasm build'}, async () => {
  const ann = await createIdentity(), bob = await createIdentity();

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
  assert.equal((await setClub('TTTT-TTTT', {limits: {tables: 3}})).status, 200);
  o.send(await signMessage(ann, {club: 'TTTT-TTTT', type: 'owner_cmd', op: 'new_table', args: {table: {name: 'T3'}}, id: 4}));
  assert.equal((await o.next('owner_result')).body.error, '');

  // A look inside: its tables and members.
  const look = (await api('/admin/club/TTTT-TTTT')).body;
  assert.equal(look.blocked, '');
  assert.equal(look.inside.club.name, 'Trial Night');
  assert.equal(look.inside.club.tables.length, 3);
  assert.equal(look.inside.online, 1);
  // …and the club in full (#401).
  assert.equal(look.full.name, 'Trial Night');
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
  assert.equal(pa.trial, 'TTTT-TTTT');
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
  assert.equal((await setClub('TTTT-TTTT', {plan: 'club'})).status, 200);
  for (const s of [o, third.c]) s.ws.close();

  // The admin log: every action, with who did it.
  const log = (await api('/admin/log')).body.log;
  assert.deepEqual(log.map(e => e.action), ['limits', 'reveal', 'pause', 'resume', 'grant', 'revoke', 'plan']);
  assert.ok(log.every(e => e.by === ADMIN.ident.id && e.name === 'Tess' && e.at > 0));
  const shown = log.find(e => e.action === 'reveal');
  assert.equal(shown.target, 'TTTT-TTTT');
  assert.equal(shown.by, ADMIN.ident.id);
  assert.equal(log.find(e => e.action === 'grant').target, ann.id);
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
  const forged = {...env, body: {...env.body, data: {id: eve.id, maxClubs: 9}}};
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

// Usage counts (#601): a friends game, its players and hands, a club's
// players, the admins left out; and what's live now.
test('usage: games, players, hands, now; the admins not counted', {skip: !haveWasm && 'no wasm build'}, async () => {
  const today = async () => (await api('/admin/stats')).body.days.at(-1);
  const before = await today();
  assert.equal((await api('/admin/stats')).body.days.length, 30);

  // A friends game: the host and one player, one hand.
  const host = open('/room/GGGG-HHHH?role=host');
  await host.ready;
  const guest = open('/room/GGGG-HHHH?role=guest&id=tab-1');
  await guest.ready;
  await host.next();
  host.send({stat: 'hand'});
  host.send({stat: 'hand'}); // too soon after the last: not counted again
  // Carl's club, and the admin in it.
  const carl = await createIdentity();
  const {c: cc, m} = await create(carl, 'WWWW-WWWW', 'Carl’s');
  assert.equal(m.type, 'club_created');
  cc.send(await signMessage(carl, {club: 'WWWW-WWWW', type: 'owner_hello'}));
  await cc.next('owner_view');
  const adm = open(`/room/WWWW-WWWW?role=guest&id=${ADMIN.ident.id}&queue=1`, ADMIN.ident);
  await adm.ready;
  await new Promise(r => setTimeout(r, 200));

  const st = (await api('/admin/stats')).body;
  const after = st.days.at(-1);
  assert.equal(after.games - before.games, 1);
  assert.equal(after.hands - before.hands, 1);
  assert.equal(after.clubHands, before.clubHands);
  assert.equal(after.active - before.active, 1, 'Carl, not the admin');
  assert.equal(after.newPlayers - before.newPlayers, 1);
  assert.ok(after.clubsActive >= 1);
  assert.ok(after.playersPerGame >= 1);
  assert.ok(st.now.games >= 1);
  assert.ok(st.now.players >= 3, 'the game\'s two and Carl');
  assert.ok(st.now.rooms >= 2);

  // The host reloads: the same game.
  host.ws.close();
  await new Promise(r => setTimeout(r, 100));
  const back = open('/room/GGGG-HHHH?role=host');
  await back.ready;
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await today()).games, after.games);
  for (const s of [back, guest, cc, adm]) s.ws.close();

  // No Cloudflare token here: nothing to show.
  assert.deepEqual((await api('/admin/cloudflare')).body, {enabled: false});
  // Only signed requests from a listed key.
  const eve = await createIdentity();
  assert.equal((await adminFetch(PORT, eve)('/admin/stats')).status, 403);
  assert.equal((await fetch(`http://localhost:${PORT}/admin/stats`, {method: 'POST', body: '{}'})).status, 401);
});

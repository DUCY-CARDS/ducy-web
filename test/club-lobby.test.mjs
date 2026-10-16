// The club lobby: who's online, and the chat for members waiting for a game.
// Needs the wasm build in wasm/. Run with: node --test test/club-lobby.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { MultiTable } from '../wasm/ducy_wasm.js';
import { createIdentity, signMessage, Verifier } from '../src/identity.js';
import { approve, hostReceive, newClub, newMembership, playerReceive } from '../src/club.js';
import { LOBBY_KEEP, LOBBY_MAX_AGE_MS, lobbyBody, onlineList, readLobby, sayInLobby } from '../src/club-lobby.js';
import { answerRole, offerAssistant } from '../src/club-roles.js';
import { createClub, openClub } from '../relay/src/club-room.js';

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

test('members and the host chat; old and extra lines go', () => {
  const club = clubWith('p', 'q');
  club.members.x = {id: 'x', name: 'X', status: 'pending'};
  assert.throws(() => sayInLobby(club, 'x', 'hi'), /Only members/);
  assert.throws(() => sayInLobby(club, 'p', '  \n '), /Say something/);
  const a = sayInLobby(club, 'p', 'anyone   up for\nPLO?', 1);
  assert.deepEqual([a.name, a.text, a.host], ['P', 'anyone up for PLO?', undefined]);
  const h = sayInLobby(club, 'HOSTHOST', 'Opening a table at 8', 2);
  assert.deepEqual([h.name, h.host], ['Host', true]);
  for (let i = 0; i < LOBBY_KEEP + 5; i++) sayInLobby(club, 'q', `line ${i}`, 10 + i);
  assert.equal(club.lobby.length, LOBBY_KEEP);
  assert.equal(club.lobby.at(-1).text, `line ${LOBBY_KEEP + 4}`);
  // A day later, only the new line is left.
  sayInLobby(club, 'p', 'morning', 10 + LOBBY_MAX_AGE_MS + 100);
  assert.deepEqual(club.lobby.map(x => x.text), ['morning']);
});

test('who’s online: the host first, then members by name, with their table', () => {
  const club = clubWith('zed', 'amy', 'bo');
  club.members.pend = {id: 'pend', name: 'Pending', status: 'pending'};
  club.tables = [{id: 't1', name: 'NLH 1/2'}];
  club.members.zed.seat = {table: 't1', stack: 100};
  offerAssistant(club, 'bo');
  answerRole(club, 'bo', true);
  const ids = new Set(['zed', 'amy', 'bo', 'pend']);
  assert.deepEqual(onlineList(club, ids).map(x => [x.name, x.role, x.table]), [['AMY', '', ''], ['BO', 'assistant', ''], ['ZED', '', 'NLH 1/2']]);
  assert.equal(onlineList(club, ids, true)[0].role, 'host');
  // An always-on club's owner is the host when they're online.
  club.ownerId = 'OWNEROWN';
  club.members.OWNEROWN = {id: 'OWNEROWN', name: 'Olive', status: 'member'};
  assert.deepEqual(onlineList(club, new Set(['OWNEROWN', 'amy'])).map(x => [x.name, x.role]), [['Olive', 'host'], ['AMY', '']]);
});

test('a member reads the lobby, checked', () => {
  const club = clubWith('p');
  sayInLobby(club, 'p', 'hi', Date.now());
  const body = lobbyBody(club, new Set(['p']));
  assert.equal(body.chat[0].from, undefined, 'members don’t get each other’s IDs in the chat');
  const got = readLobby({...body, online: [...body.online, {name: 'x'.repeat(40), role: 'boss'}, null], chat: [...body.chat, {text: ''}]});
  assert.equal(got.online.length, 2);
  assert.equal(got.online[1].name.length, 20);
  assert.equal(got.online[1].role, '');
  assert.deepEqual(got.chat.map(x => x.text), ['hi']);
});

test('a signed lobby_say reaches the caller, members only; the lobby reaches the member', async () => {
  const club = clubWith();
  const p = await createIdentity(), q = await createIdentity(), host = await createIdentity();
  club.hostId = host.id;
  club.members[p.id] = {id: p.id, name: 'Pat', status: 'pending', requestedAt: 0};
  approve(club, p.id, 0);
  const verifier = new Verifier();
  const r = await hostReceive(club, verifier, await signMessage(p, {type: 'lobby_say', club: club.code, text: 'game?'}));
  assert.deepEqual(r.lobby, {from: p.id, text: 'game?'});
  const r2 = await hostReceive(club, verifier, await signMessage(q, {type: 'lobby_say', club: club.code, text: 'hi'}));
  assert.equal(r2.reason, 'not a member');
  const mem = newMembership({code: club.code, hostId: host.id, invite: club.invite});
  sayInLobby(club, p.id, 'game?');
  assert.ok(await playerReceive(mem, await signMessage(host, lobbyBody(club, new Set([p.id])))));
  assert.deepEqual(mem.lobby.online.map(x => x.name), ['Pat']);
  assert.deepEqual(mem.lobby.chat.map(x => [x.name, x.text]), [['Pat', 'game?']]);
});

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}
const wait = (ms = 450) => new Promise(r => setTimeout(r, ms));

test('in an always-on club, members online get who’s here and the chat; the owner chats too', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ann = await createIdentity(), bob = await createIdentity();
  const code = 'LOBB-YCHT';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Lobby'}), code);
  const sent = [];
  const server = await openClub({storage, send: (to, data) => sent.push({to, data}), online: [], MultiTable});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ann, bob]) await server.message({from: p.id, event: 'open'});
  let id = 1;
  for (const [p, name] of [[ann, 'Ann'], [bob, 'Bob']]) {
    await say(p, {type: 'join', invite, name});
    await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: p.id}, id: id++});
  }
  await say(ann, {type: 'lobby_say', text: 'Anyone for PLO?'});
  await say(owner, {type: 'owner_cmd', op: 'lobby_say', args: {text: 'Table at 8'}, id: id++});
  await wait();
  const lastLobby = who => sent.filter(s => s.to === who.id && s.data.body?.type === 'lobby').at(-1)?.data.body;
  const b = lastLobby(bob);
  assert.deepEqual(b.online.map(x => [x.name, x.role]), [['Host', 'host'], ['Ann', ''], ['Bob', '']]);
  assert.deepEqual(b.chat.map(x => [x.name, x.text, !!x.host]), [['Ann', 'Anyone for PLO?', false], ['Host', 'Table at 8', true]]);
  // Bob leaves: Ann hears.
  await server.message({from: bob.id, event: 'close'});
  await wait();
  assert.deepEqual(lastLobby(ann).online.map(x => x.name), ['Host', 'Ann']);
  // Flooding is cut off.
  for (let i = 0; i < 8; i++) await say(ann, {type: 'lobby_say', text: `spam ${i}`});
  await wait();
  assert.ok(lastLobby(ann).chat.filter(x => x.text.startsWith('spam')).length <= 5);
  server.close?.();
});

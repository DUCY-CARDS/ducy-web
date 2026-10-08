// Clubs (#66): creating a club, invites, join requests and the host's decisions.
// Run with: node --test test/club.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import {
  approve, clubName, decline, hostReceive, inviteLink, membersByStatus, newClub, newMembership,
  parseInvite, playerReceive, removeMember, revokeInvite,
} from '../src/club.js';

async function setup() {
  const host = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', host.id, 1000);
  return {host, club, verifier: new Verifier()};
}

const join = (club, invite = club.invite, name = 'Ann') => ({type: 'join', club: club.code, invite, name});

test('club names are 1–50 characters, trimmed', () => {
  assert.equal(clubName('  Friday   Game '), 'Friday Game');
  assert.equal(clubName('x'.repeat(50)).length, 50);
  assert.throws(() => clubName('x'.repeat(51)), /at most 50/);
  assert.throws(() => clubName('   '), /name/);
});

test('invite links round-trip and carry the relay when given', async () => {
  const {club} = await setup();
  const link = inviteLink(club, 'https://ducy.example/?table=X#play');
  const inv = parseInvite(link);
  assert.deepEqual(inv, {code: club.code, invite: club.invite, hostId: club.hostId});
  assert.ok(link.endsWith('#join'), 'opens the Join tab');
  assert.equal(new URL(link).searchParams.get('table'), null);
  assert.equal(new URL(inviteLink(club, 'https://ducy.example/', 'ws://localhost:8787')).searchParams.get('relay'), 'ws://localhost:8787');
  assert.equal(parseInvite('https://ducy.example/#clubs'), null);
});

test('join → pending → approve → member, with signed status replies', async () => {
  const {host, club, verifier} = await setup();
  const ann = await createIdentity();
  const mem = newMembership(parseInvite(inviteLink(club, 'https://ducy.example/')));

  const r = await hostReceive(club, verifier, await signMessage(ann, join(club)), 2000);
  assert.ok(r.changed);
  assert.deepEqual(r.replies, [{to: ann.id, body: {type: 'status', club: club.code, name: 'Friday Game', status: 'pending'}}]);
  assert.deepEqual(membersByStatus(club, 'pending').map(m => m.name), ['Ann']);

  assert.ok(await playerReceive(mem, await signMessage(host, r.replies[0].body)));
  assert.equal(mem.status, 'pending');
  assert.equal(mem.name, 'Friday Game');

  const a = approve(club, ann.id, 3000);
  assert.equal(a.body.status, 'member');
  assert.equal(club.members[ann.id].joinedAt, 3000);
  assert.ok(await playerReceive(mem, await signMessage(host, a.body)));
  assert.equal(mem.status, 'member');
});

test('a wrong or revoked invite is refused; members are unaffected by revoking', async () => {
  const {club, verifier} = await setup();
  const ann = await createIdentity(), bob = await createIdentity();
  await hostReceive(club, verifier, await signMessage(ann, join(club)));
  approve(club, ann.id);

  const bad = await hostReceive(club, verifier, await signMessage(bob, join(club, 'nope')));
  assert.equal(bad.replies[0].body.status, 'bad_invite');
  assert.equal(club.members[bob.id], undefined);

  const old = club.invite;
  revokeInvite(club);
  assert.notEqual(club.invite, old);
  const late = await hostReceive(club, verifier, await signMessage(bob, join(club, old)));
  assert.equal(late.replies[0].body.status, 'bad_invite');
  // Ann is already a member, so her old link still works for her.
  const again = await hostReceive(club, verifier, await signMessage(ann, join(club, old)));
  assert.equal(again.replies[0].body.status, 'member');
});

test('declined and removed players can ask again with a valid invite', async () => {
  const {club, verifier} = await setup();
  const ann = await createIdentity();
  await hostReceive(club, verifier, await signMessage(ann, join(club)));
  assert.equal(decline(club, ann.id).body.status, 'declined');
  assert.equal(approve(club, ann.id), null); // only pending requests can be approved
  const r = await hostReceive(club, verifier, await signMessage(ann, join(club)));
  assert.equal(r.replies[0].body.status, 'pending');
  approve(club, ann.id);
  assert.equal(removeMember(club, ann.id)[0].body.status, 'removed');
  assert.equal(removeMember(club, ann.id), null);
});

test('hello reports status and updates the display name', async () => {
  const {club, verifier} = await setup();
  const ann = await createIdentity(), eve = await createIdentity();
  await hostReceive(club, verifier, await signMessage(ann, join(club)));
  const r = await hostReceive(club, verifier, await signMessage(ann, {type: 'hello', club: club.code, name: 'Annie'}));
  assert.equal(r.replies[0].body.status, 'pending');
  assert.equal(club.members[ann.id].name, 'Annie');
  const u = await hostReceive(club, verifier, await signMessage(eve, {type: 'hello', club: club.code}));
  assert.equal(u.replies[0].body.status, 'unknown');
});

test('the host ignores forged, replayed and other-club messages', async () => {
  const {club, verifier} = await setup();
  const ann = await createIdentity();
  const env = await signMessage(ann, join(club));
  assert.equal((await hostReceive(club, verifier, {...env, body: join(club, club.invite, 'Mallory')})).reason, 'bad signature');
  assert.ok((await hostReceive(club, verifier, env)).changed);
  assert.equal((await hostReceive(club, verifier, env)).reason, 'replayed');
  assert.equal((await hostReceive(club, verifier, await signMessage(ann, {...join(club), club: 'ZZZZ-ZZZZ'}))).reason, 'wrong club');
});

test('players ignore status messages not signed by the club host, and replays', async () => {
  const {host, club} = await setup();
  const mallory = await createIdentity();
  const mem = newMembership(parseInvite(inviteLink(club, 'https://ducy.example/')));
  const body = {type: 'status', club: club.code, name: 'Friday Game', status: 'member'};
  assert.equal(await playerReceive(mem, await signMessage(mallory, body)), false);
  const forged = {...(await signMessage(mallory, body)), from: host.id};
  assert.equal(await playerReceive(mem, forged), false);
  const real = await signMessage(host, {...body, status: 'pending'});
  assert.ok(await playerReceive(mem, real));
  assert.equal(await playerReceive(mem, real), false);
  assert.equal(mem.status, 'pending');
});

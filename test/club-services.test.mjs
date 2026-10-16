// Club services (club-services.js): outside servers an always-on club's
// owner lets give chips, by their own signing key, within limits; their
// signed requests over the relay's HTTP endpoint (relay/src/service-http.js);
// and the whole path through a club room with the real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createIdentity, signMessage, showId } from '../src/identity.js';
import { newClub, approve } from '../src/club.js';
import { hostReceive } from '../src/club.js';
import { Verifier } from '../src/identity.js';
import {
  addService, checkRequest, parseServiceLine, revokeService, runRequest, serviceLine, servicesView, updateService, ServiceError, SKEW_MS,
} from '../src/club-services.js';
import { serviceClient, newService, openService } from '../src/service-client.js';
import { serviceHttp, serviceInRoom, SERVICE_BURST } from '../relay/src/service-http.js';

const CODE = 'SRVC-TEST';
// The club keeps hundredths of a chip; services count in chips.
const C = 100;

// An always-on club with members Ann and Bob, and an owner.
async function setup() {
  const owner = await createIdentity(), ann = await createIdentity(), bob = await createIdentity();
  const club = newClub('Rewards Club', CODE, (await createIdentity()).id);
  club.ownerId = owner.id;
  club.alwaysOn = true;
  const v = new Verifier();
  for (const [p, name] of [[ann, 'Ann'], [bob, 'Bob']]) {
    await hostReceive(club, v, await signMessage(p, {club: CODE, type: 'join', invite: club.invite, name}));
    approve(club, p.id);
  }
  return {club, owner, ann, bob};
}

const request = (svc, op, args = {}, club = CODE) => signMessage(svc, {type: 'service', club, op, args});

// A request checked and run as the club server does; throws a ServiceError.
async function send(club, env, now = Date.now()) {
  const s = await checkRequest(club, env, now);
  return runRequest(club, s, env.body, now).value;
}

async function refused(p, status, re) {
  await assert.rejects(p, e => e instanceof ServiceError && e.status === status && re.test(e.message));
}

test('a service line holds only the public key, and names the service ID', async () => {
  const svc = await createIdentity();
  const line = serviceLine(svc);
  assert.match(line, /^ducy-service:1:(ed25519|p256):[\w-]+$/);
  assert.ok(!line.includes('"d"'), 'no private key');
  const parsed = await parseServiceLine(line);
  assert.equal(parsed.id, svc.id);
  assert.equal(parsed.pub, svc.pub);
  await assert.rejects(parseServiceLine('ducy-service:1:ed25519:short'), /isn’t a service line/);
  await assert.rejects(parseServiceLine(svc.pub), /isn’t a service line/);
});

test('the owner adds a service: only to an always-on club, named, once', async () => {
  const {club, ann} = await setup();
  const svc = await createIdentity();
  await assert.rejects(addService({...club, ownerId: null}, {line: serviceLine(svc), name: 'X'}), /always-on/);
  await assert.rejects(addService(club, {line: serviceLine(svc), name: ' '}), /name/);
  await assert.rejects(addService(club, {line: serviceLine(ann), name: 'Ann?'}), /member’s/);
  const s = await addService(club, {line: serviceLine(svc), name: 'Rewards server', budget: 1000 * C, perGive: 300 * C, perDay: 500 * C});
  assert.equal(s.id, svc.id);
  assert.deepEqual(s.perms, {give: true, take: false, read: true}, 'giving and listing by default, not taking');
  await assert.rejects(addService(club, {line: serviceLine(svc), name: 'Again'}), /already added/);
  assert.match(club.log.at(-1).text, /Added the service Rewards server/);
  assert.ok(!JSON.stringify(club.services).includes('"d":'), 'the club holds no private key');
});

test('a service gives chips within its budget and caps, and the history says so', async () => {
  const {club, ann, bob} = await setup();
  const svc = await createIdentity();
  await addService(club, {line: serviceLine(svc), name: 'Rewards server', budget: 1000 * C, perGive: 300 * C, perDay: 500 * C});

  const out = await send(club, await request(svc, 'give', {member: ann.id, amount: 200, note: 'League week 1'}));
  assert.equal(out.balance, 200, 'in chips');
  assert.equal(out.budget, 800);
  assert.equal(club.members[ann.id].balance, 200 * C, 'kept in hundredths');
  const e = club.chips.ledger.at(-1);
  assert.equal(e.kind, 'issue');
  assert.equal(e.note, 'Rewards server: League week 1');
  assert.match(club.log.at(-1).text, /Rewards server \(service\) gave Ann 200/);
  assert.equal(club.log.at(-1).by, svc.id);

  // By the ID members see too.
  await send(club, await request(svc, 'give', {member: showId(bob.id), amount: 100.5}));
  assert.equal(club.members[bob.id].balance, 10050);

  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 301})), 403, /At most 300/);
  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 250})), 403, /500 a day/);
  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 0})), 400, /above 0/);
  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 1.234})), 400, /two decimals/);
  await refused(send(club, await request(svc, 'give', {member: 'nobody', amount: 5})), 404, /No such member/);
  assert.equal(servicesView(club)[0].givenToday, 300.5 * C);

  // Without the caps, the budget still holds; topped up, it pays.
  updateService(club, svc.id, {perDay: 0, perGive: 0});
  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 700})), 403, /budget has 699.50 left/);
  updateService(club, svc.id, {addBudget: 300 * C});
  assert.equal(club.services[svc.id].budget, 999.5 * C);
  await send(club, await request(svc, 'give', {member: ann.id, amount: 700}));
  assert.equal(club.members[ann.id].balance, 900 * C);
});

test('a give sent again with the same key pays once', async () => {
  const {club, ann} = await setup();
  const svc = await createIdentity();
  await addService(club, {line: serviceLine(svc), name: 'Rewards', budget: 1000 * C});
  const first = await send(club, await request(svc, 'give', {member: ann.id, amount: 100, key: 'week-1-ann'}));
  const again = await send(club, await request(svc, 'give', {member: ann.id, amount: 100, key: 'week-1-ann'}));
  assert.equal(again.repeat, true);
  assert.equal(again.entry, first.entry);
  assert.equal(club.members[ann.id].balance, 100 * C);
  await send(club, await request(svc, 'give', {member: ann.id, amount: 100, key: 'week-2-ann'}));
  assert.equal(club.members[ann.id].balance, 200 * C);
});

test('requests that are copied, stale, altered, misaddressed or from another key are refused', async () => {
  const {club, ann} = await setup();
  const svc = await createIdentity(), other = await createIdentity();
  await addService(club, {line: serviceLine(svc), name: 'Rewards', budget: 1000 * C});

  const env = await request(svc, 'give', {member: ann.id, amount: 10});
  await send(club, env);
  await refused(send(club, env), 401, /already received/);
  assert.equal(club.members[ann.id].balance, 10 * C, 'a copied request pays nothing');

  const stale = await request(svc, 'give', {member: ann.id, amount: 10});
  await refused(send(club, stale, stale.seq + SKEW_MS + 1), 401, /too old/);

  const altered = await request(svc, 'give', {member: ann.id, amount: 10});
  altered.body.args.amount = 1000;
  await refused(send(club, altered), 401, /signature/);

  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 10}, 'OTHR-CLUB')), 400, /for this club/);

  // Another key claiming the service's ID.
  const forged = await request(other, 'give', {member: ann.id, amount: 10});
  forged.from = svc.id;
  await refused(send(club, forged), 401, /Not this service’s key/);

  await refused(send(club, await request(other, 'give', {member: ann.id, amount: 10})), 401, /no such service/);
  assert.equal(club.serviceRefused.count, 1, 'unknown senders are counted');
  assert.equal(club.services[svc.id].failures, 5, 'the service’s own refusals are counted');
  assert.equal(club.members[ann.id].balance, 10 * C);
});

test('permissions: taking is off unless allowed, listing needs read; expiry and revoking stop it at once', async () => {
  const {club, ann} = await setup();
  const svc = await createIdentity();
  await addService(club, {line: serviceLine(svc), name: 'Rewards', budget: 1000 * C, perms: {give: true, take: false, read: false}});
  await send(club, await request(svc, 'give', {member: ann.id, amount: 100}));
  await refused(send(club, await request(svc, 'take', {member: ann.id, amount: 50})), 403, /may not take/);
  await refused(send(club, await request(svc, 'members')), 403, /may not list/);
  assert.equal((await send(club, await request(svc, 'status'))).budget, 900);

  updateService(club, svc.id, {perms: {give: true, take: true, read: true}});
  const members = await send(club, await request(svc, 'members'));
  assert.deepEqual(members.map(m => [m.name, m.balance]).sort(), [['Ann', 100], ['Bob', 0]]);
  await send(club, await request(svc, 'take', {member: ann.id, amount: 50, note: 'refund'}));
  assert.equal(club.members[ann.id].balance, 50 * C);
  await refused(send(club, await request(svc, 'take', {member: ann.id, amount: 51})), 409, /only has/);

  updateService(club, svc.id, {expires: Date.now() - 1});
  await refused(send(club, await request(svc, 'status')), 401, /expired/);
  updateService(club, svc.id, {expires: null});
  await send(club, await request(svc, 'status'));

  revokeService(club, svc.id);
  await refused(send(club, await request(svc, 'give', {member: ann.id, amount: 1})), 401, /revoked/);
  assert.equal(club.services[svc.id].pub, undefined, 'the key is forgotten');
  assert.match(club.log.at(-1).text, /Revoked the service Rewards/);
  // Added again later (a new key, or the same one), it starts fresh.
  await addService(club, {line: serviceLine(svc), name: 'Rewards 2', budget: 5 * C});
  assert.equal((await send(club, await request(svc, 'status'))).budget, 5);
});

test('the HTTP endpoint: servers only, JSON only, small, and rate limited per club', async () => {
  const post = (body, headers = {}) => new Request('http://relay/club/SRVC-TEST/service', {method: 'POST', headers, body});
  const toRoom = async () => Response.json({ok: true, value: 1});
  assert.equal((await serviceHttp(post('{}', {Origin: 'https://evil.example'}), CODE, toRoom)).status, 403);
  assert.equal((await serviceHttp(new Request('http://relay/x'), CODE, toRoom)).status, 405);
  assert.equal((await serviceHttp(post('not json'), CODE, toRoom)).status, 400);
  assert.equal((await serviceHttp(post('x'.repeat(9000)), CODE, toRoom)).status, 400);
  assert.equal((await serviceHttp(post('{}'), 'bad', toRoom)).status, 404);
  assert.equal((await serviceHttp(post('{}'), CODE, toRoom)).status, 200);

  const room = {};
  const club = {serviceRequest: async () => ({status: 200, body: {ok: true}})};
  assert.equal((await serviceInRoom(room, null, {})).status, 404);
  const now = Date.now();
  for (let i = 0; i < SERVICE_BURST; i++) assert.equal((await serviceInRoom(room, club, {}, now)).status, 200);
  assert.equal((await serviceInRoom(room, club, {}, now)).status, 429);
  assert.equal((await serviceInRoom(room, club, {}, now + 1000)).status, 200, 'and recovers');
});

test('the service client: a key file locked with a password, and its calls signed', async () => {
  const made = await newService({password: 'correct horse'});
  assert.match(made.file, /"lock"/);
  await assert.rejects(openService(made.file), /password/);
  const identity = await openService(made.file, {password: 'correct horse'});
  assert.equal(identity.id, made.identity.id);
  assert.equal(made.line, serviceLine(identity));

  const seen = [];
  const fetchFn = async (url, opts) => { seen.push([url, JSON.parse(opts.body)]); return Response.json({ok: false, error: 'This service was revoked.'}, {status: 401}); };
  const client = serviceClient({identity, relay: 'wss://relay.example/', club: CODE, fetchFn});
  await assert.rejects(client.give('ann', 5, {key: 'k'}), e => e.status === 401 && /revoked/.test(e.message));
  assert.equal(seen[0][0], 'https://relay.example/club/SRVC-TEST/service');
  assert.deepEqual(seen[0][1].body, {type: 'service', club: CODE, op: 'give', args: {member: 'ann', amount: 5, note: '', key: 'k'}});
});

// The whole path, with the real engine: the owner adds the service with a
// signed command, the service's client gives chips over HTTP, the member
// hears about it, it survives the room restarting, and revoking stops it.
const WASM = new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url);
test('through a club room: added by the owner, paid over HTTP, kept across a restart, revoked', {skip: !existsSync(WASM) && 'no wasm build'}, async () => {
  const m = await import('../wasm/ducy_wasm.js');
  m.initSync({module: readFileSync(WASM)});
  const {createClub, openClub} = await import('../relay/src/club-room.js');
  const store = new Map();
  const storage = {get: async k => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async k => { store.delete(k); }};
  const owner = await createIdentity(), ann = await createIdentity();
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: CODE, name: 'Always On'}), CODE);
  const sent = [];
  const open = () => openClub({storage, send: (to, data) => sent.push([to, data]), online: [], MultiTable: m.MultiTable});
  let server = await open();
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: CODE, ...body})});
  await say(ann, {type: 'join', invite, name: 'Ann'});
  await server.message({from: owner.id, event: 'open'});
  await server.message({from: ann.id, event: 'open'});
  await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1});

  const svc = await createIdentity();
  // Someone else can't add a service.
  await say(ann, {type: 'owner_cmd', op: 'service_add', args: {line: serviceLine(svc), name: 'Mine', budget: 1e6}, id: 2});
  assert.equal(server.club.services, undefined);
  await say(owner, {type: 'owner_cmd', op: 'service_add', args: {line: serviceLine(svc), name: 'Rewards server', budget: 1000 * C}, id: 3});
  assert.equal(server.club.services[svc.id].budget, 1000 * C);

  const room = {};
  const fetchFn = async (url, opts) => serviceHttp(new Request(url, opts), CODE, async env => {
    const out = await serviceInRoom(room, server, env);
    return Response.json(out.body, {status: out.status});
  });
  const client = serviceClient({identity: svc, relay: 'https://relay.example', club: CODE, fetchFn});
  const got = await client.give(ann.id, 250, {note: 'Welcome', key: 'welcome-ann'});
  assert.equal(got.balance, 250);
  assert.equal(server.club.members[ann.id].balance, 250 * C);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(sent.some(([to, d]) => to === ann.id && d.body?.type === 'account' && d.body.balance === 250 * C), 'Ann hears about her chips');

  // The room restarts: the service, its budget and its used keys come back.
  await server.flush();
  server = await open();
  assert.equal((await client.status()).budget, 750);
  assert.equal((await client.give(ann.id, 250, {key: 'welcome-ann'})).repeat, true);
  assert.equal(server.club.members[ann.id].balance, 250 * C);

  await server.message({from: owner.id, event: 'open'});
  await say(owner, {type: 'owner_cmd', op: 'service_revoke', args: {id: svc.id}, id: 4});
  await assert.rejects(client.give(ann.id, 1), e => e.status === 401 && /revoked/.test(e.message));
  await server.flush();
});

// Always-on clubs (#93) in the Node dev relay: a room becomes a club when
// its owner asks, and then runs it with no host connected.
// Needs the relay's dependency (npm ci --prefix relay) and the wasm build in wasm/.
// Run with: node --test test/relay-club.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from '../relay/node_modules/ws/index.js';
import { relayClient, softPasskey } from './relay-helper.mjs';
import { granter, testAdmin } from './admin-helper.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { passkeys, rpIdFor } from '../relay/src/passkeys.js';
import { check as unlockCheck, movesChips } from '../relay/src/unlock.js';

const haveWasm = existsSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url));
const PORT = 19000 + Math.floor(Math.random() * 1000);
// An admin, to grant each club (#636).
const ADMIN = await testAdmin();
const server = spawn(process.execPath, [fileURLToPath(new URL('../relay/dev-server.mjs', import.meta.url)), String(PORT)], {stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, ADMINS_FILE: ADMIN.file}});
await new Promise(resolve => server.stdout.once('data', resolve));
test.after(() => server.kill());

const relay = relayClient(PORT);
const grantFor = granter(PORT, ADMIN.ident);
const open = (path, ident = null, opts) => relay.open(path, ident, opts);

test('a room becomes an always-on club: members join and the owner runs it, with no host', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'CCCC-CCCC';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Night Owls', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');
  assert.ok(made.hostId && made.invite);

  // A host can't take the room over.
  const h = open(`/room/${code}?role=host`);
  assert.equal(await h.closed, 4000);

  // Ann asks to join; the owner approves and gives her chips.
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  const pending = await a.next('status');
  assert.equal(pending.from, made.hostId, 'signed by the club');
  assert.equal(pending.body.status, 'pending');
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  // (A view from before she asked may come first: the lobby's, as it opened.)
  let view;
  do view = await o.next('owner_view'); while (!view.body.data.members[ann.id]);
  assert.equal(view.body.data.members[ann.id].status, 'pending');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal((await a.next('status')).body.status, 'member');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: 300}, id: 2}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.equal((await a.next('account')).body.balance, 300);

  // The owner leaves; Ann asks for chips and is still answered by the club.
  o.ws.close();
  await o.closed;
  a.send(await signMessage(ann, {club: code, type: 'chip_request', amount: 100}));
  const acc = await a.next('account');
  assert.equal(acc.body.request?.amount, 100, 'the club holds her request with no one hosting');
  a.ws.close();

  // A second room can't be claimed by someone who isn't alone in it.
  const b = open(`/room/DDDD-DDDD?role=guest&id=${ann.id}&queue=1`, ann);
  const c = open(`/room/DDDD-DDDD?role=guest&id=${owner.id}&queue=1`, owner);
  await Promise.all([b.ready, c.ready]);
  b.send(await signMessage(ann, {type: 'create_club', club: 'DDDD-DDDD', name: 'Mine'}));
  assert.match((await b.next('club_error')).reason, /in use/);
  b.ws.close(); c.ws.close();
});

test('what a code is: a club tells its name only when it takes requests by code (#393)', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), bob = await createIdentity();
  const code = 'EEEE-EEEE';
  const look = c => fetch(`http://localhost:${PORT}/code/${c}`).then(async r => ({status: r.status, body: await r.json()}));
  assert.deepEqual((await look('FFFF-FFFF')).body, {kind: 'none'}, 'no club, and no game open (#566)');
  assert.equal((await look('nope')).status, 400);

  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Code Night', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');
  // Off by default: a club, and nothing more.
  assert.deepEqual((await look(code)).body, {kind: 'club', ask: false});
  const b = open(`/room/${code}?role=guest&id=${bob.id}&queue=1`, bob);
  await b.ready;
  b.send(await signMessage(bob, {club: code, type: 'join', invite: '', name: 'Bob'}));
  const refused = await b.next('status');
  assert.equal(refused.body.status, 'invite_only');
  assert.equal(refused.body.name, undefined);

  // The owner turns it on (the manager's Settings tab).
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  await o.next('owner_view');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'settings', args: {codeJoin: true}, id: 1}));
  assert.equal((await o.next('owner_result')).body.error, '');
  assert.deepEqual((await look(code)).body, {kind: 'club', ask: true, name: 'Code Night', hostId: made.hostId});
  b.send(await signMessage(bob, {club: code, type: 'join', invite: '', name: 'Bob'}));
  assert.equal((await b.next('status')).body.status, 'pending');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'settings', args: {codeJoin: 'yes'}, id: 2}));
  assert.match((await o.next('owner_result')).body.error, /codeJoin/);
  o.ws.close(); b.ws.close();
});

test('no tab hosts a game: a host is refused, and the lookup finds nothing (#643)', async () => {
  const look = c => fetch(`http://localhost:${PORT}/code/${c}`).then(r => r.json());
  const h = open('/room/GGGG-GGGG?role=host');
  assert.equal(await h.closed, 4000);
  assert.deepEqual(await look('GGGG-GGGG'), {kind: 'none'});
  // Nor can a guest join one without a club there.
  const g = open('/room/GGGG-GGGG?role=guest&id=g1');
  assert.equal(await g.closed, 4004);
});

// ---- passkeys (#575) ----

// The relay's passkeys over storage of their own, on a clock the test moves.
function memoryPasskeys(origins = []) {
  const m = new Map();
  const clock = {t: 1_000_000};
  const pk = passkeys({get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }}, {origins, now: () => clock.t});
  return {pk, clock};
}
const enrolEnv = async (pk, ident, p, extra = {}) => signMessage(ident, {type: 'passkey_enrol', challenge: (await pk.challenge()).challenge, credId: p.credId, spki: p.spki, alg: p.alg, name: 'Phone', ...extra});

test('a passkey is attached by its player only, and its sign-ins are checked', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {pk, clock} = memoryPasskeys();
  const ann = await createIdentity(), eve = await createIdentity();
  const p = await softPasskey();
  // Signed by someone else, or with a made-up challenge: refused.
  const forged = await enrolEnv(pk, eve, p);
  forged.from = ann.id;
  await assert.rejects(pk.enrol(forged), /signed/);
  await assert.rejects(pk.enrol(await signMessage(ann, {type: 'passkey_enrol', challenge: 'nope', credId: p.credId, spki: p.spki, alg: -7})), /too long/);
  const made = await pk.enrol(await enrolEnv(pk, ann, p));
  assert.ok(made.token);
  assert.deepEqual(await pk.status(ann.id), {enrolled: true, creds: [p.credId], movedTo: null});

  // A good sign-in starts a session the rooms accept.
  const ok = await pk.unlock(await p.sign((await pk.challenge()).challenge));
  assert.equal(ok.id, ann.id);
  assert.equal((await pk.session(ok.token)).id, ann.id);
  // Bad ones: the same challenge again, not verified, another site, a wrong
  // signature, a made-up challenge, and a stale one.
  const c1 = (await pk.challenge()).challenge;
  const once = await p.sign(c1);
  await pk.unlock(once);
  await assert.rejects(pk.unlock(once), /challenge/);
  await assert.rejects(pk.unlock(await p.sign((await pk.challenge()).challenge, {flags: 0x01})), /not verified/);
  await assert.rejects(pk.unlock(await p.sign((await pk.challenge()).challenge, {origin: 'https://evil.example'})), /not from ducy/);
  await assert.rejects(pk.unlock(await p.sign((await pk.challenge()).challenge, {rpId: 'evil.example'})), /wrong site/);
  const other = await softPasskey();
  await assert.rejects(pk.unlock({...(await other.sign((await pk.challenge()).challenge)), credId: p.credId}), /bad signature/);
  await assert.rejects(pk.unlock(await p.sign('made-up')), /challenge/);
  const old = (await pk.challenge()).challenge;
  clock.t += 6 * 60_000;
  await assert.rejects(pk.unlock(await p.sign(old)), /challenge/);
  // A passkey no one attached.
  await assert.rejects(pk.unlock(await other.sign((await pk.challenge()).challenge)), /isn’t known/);

  // A second passkey needs a fresh session; a stale one won't do.
  const p2 = await softPasskey();
  await assert.rejects(pk.enrol(await enrolEnv(pk, ann, p2)), /Unlock/);
  await assert.rejects(pk.enrol(await enrolEnv(pk, ann, p2, {token: ok.token})), /Unlock/);
  const s = await pk.unlock(await p.sign((await pk.challenge()).challenge));
  await pk.enrol(await enrolEnv(pk, ann, p2, {token: s.token}));
  assert.equal((await pk.list(s.token)).creds.length, 2);

  // A lost device: its passkey removed, its sign-ins and sessions refused.
  const lost = await pk.unlock(await p2.sign((await pk.challenge()).challenge));
  await pk.remove(s.token, p2.credId);
  assert.equal(await pk.session(lost.token), null);
  await assert.rejects(pk.unlock(await p2.sign((await pk.challenge()).challenge)), /isn’t known/);
  await assert.rejects(pk.remove(s.token, p.credId), /only passkey/);
  // Sessions end after 4 hours unused.
  clock.t += 4 * 3600e3 + 1;
  assert.equal(await pk.session(s.token), null);
});

test('only pages of the relay’s site count; ducy.cards passkeys work on its subdomains', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {pk} = memoryPasskeys(['https://staging.ducy.cards']);
  const ann = await createIdentity(), p = await softPasskey();
  await pk.enrol(await enrolEnv(pk, ann, p));
  const v = await pk.unlock(await p.sign((await pk.challenge()).challenge, {origin: 'https://staging.ducy.cards', rpId: 'ducy.cards'}));
  assert.equal(v.id, ann.id);
  await assert.rejects(pk.unlock(await p.sign((await pk.challenge()).challenge, {origin: 'http://localhost:4173'})), /not from ducy/);
  assert.equal(rpIdFor('https://ducy.cards'), 'ducy.cards');
  assert.equal(rpIdFor('https://staging.ducy.cards'), 'ducy.cards');
  assert.equal(rpIdFor('http://localhost:4173'), 'localhost');
});

test('without PRF the relay vouches: the new device’s ID takes over, and the old one can’t come back', {skip: !haveWasm && 'no wasm build'}, async () => {
  const {pk} = memoryPasskeys();
  const old = await createIdentity(), fresh = await createIdentity();
  const p = await softPasskey();
  await pk.enrol(await enrolEnv(pk, old, p));
  const s = await pk.unlock(await p.sign((await pk.challenge()).challenge));
  await pk.session(s.token, {code: 'CLUB-1234', hostId: 'H', name: 'Night Owls', owner: false});
  const v = await pk.vouch(await signMessage(fresh, {type: 'passkey_vouch', challenge: (await pk.challenge()).challenge, token: s.token}));
  assert.deepEqual([v.from, v.to], [old.id, fresh.id]);
  const after = await pk.session(s.token);
  assert.deepEqual([after.id, after.movedFrom], [fresh.id, old.id]);
  const again = await pk.unlock(await p.sign((await pk.challenge()).challenge));
  assert.equal(again.id, fresh.id);
  assert.deepEqual(Object.keys(again.clubs), ['CLUB-1234'], 'their clubs came with them');
  assert.equal((await pk.status(old.id)).movedTo, fresh.id);
  await assert.rejects(pk.enrol(await enrolEnv(pk, old, await softPasskey())), /moved/);
});

test('a club connection acts only once unlocked; chips need a recent unlock', async () => {
  const live = {id: 'ann', at: 0, movedFrom: null};
  const session = async t => (t === 'good' ? {...live} : null);
  const t0 = 1_000_000;
  // Nothing yet: refused.
  let g = await unlockCheck({body: {type: 'hello'}}, null, 'ann', session, t0);
  assert.equal(g.pass, false);
  assert.equal(g.reply.type, 'locked');
  // A bad token, or someone else's: refused.
  assert.equal((await unlockCheck({type: 'unlock', token: 'bad'}, null, 'ann', session, t0)).reply.type, 'locked');
  assert.equal((await unlockCheck({type: 'unlock', token: 'good'}, null, 'bob', session, t0)).reply.type, 'locked');
  // Unlocked: it acts, and may move chips while the sign-in is recent.
  live.at = t0;
  g = await unlockCheck({type: 'unlock', token: 'good'}, null, 'ann', session, t0);
  assert.equal(g.reply.type, 'unlocked');
  let u = g.u;
  assert.equal(u.device, '', 'which passkey, when the relay says (#589)');
  g = await unlockCheck({body: {type: 'chip_request', amount: 5}}, u, 'ann', session, t0 + 60_000);
  assert.equal(g.pass, true);
  u = g.u;
  // Later: play goes on, chips need the passkey again.
  g = await unlockCheck({body: {type: 'hello'}}, u, 'ann', session, t0 + 4 * 60_000);
  assert.equal(g.pass, true);
  u = g.u;
  g = await unlockCheck({body: {type: 'owner_cmd', op: 'give', args: {}}}, u, 'ann', session, t0 + 6 * 60_000);
  assert.equal(g.reply.type, 'unlock_again');
  assert.equal(movesChips({body: {type: 'owner_cmd', op: 'settings'}}), false);
  assert.equal(movesChips({body: {type: 'agent_cmd'}}), true);
  // The float (#589) and a member's vault (#579): taking chips out and the
  // wait need it; putting chips in and cancelling don't.
  assert.equal(movesChips({body: {type: 'owner_cmd', op: 'refill'}}), true);
  assert.equal(movesChips({body: {type: 'owner_cmd', op: 'approve_refill'}}), true);
  assert.equal(movesChips({body: {type: 'vault', op: 'out'}}), true);
  assert.equal(movesChips({body: {type: 'vault', op: 'wait'}}), true);
  assert.equal(movesChips({body: {type: 'vault', op: 'in'}}), false);
  assert.equal(movesChips({body: {type: 'vault', op: 'cancel'}}), false);
  // Idle 4 hours: locked again.
  g = await unlockCheck({body: {type: 'hello'}}, u, 'ann', session, t0 + 5 * 3600e3);
  assert.equal(g.reply.type, 'locked');
  // The session ended (its passkey removed): locked at the next check.
  const gone = async () => null;
  g = await unlockCheck({body: {type: 'hello'}}, {...u, checked: t0}, 'ann', gone, t0 + 6 * 60_000);
  assert.equal(g.reply.type, 'locked');
});

test('the relay refuses a club connection that isn’t unlocked', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'PPPP-PPPP';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Locked Night', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');
  // Ann proves her ID but has no passkey session: nothing she sends counts.
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann, {unlock: false});
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  assert.equal((await a.next('locked')).type, 'locked');
  a.send({type: 'unlock', token: 'made-up'});
  assert.equal((await a.next('locked')).type, 'locked');
  // The owner's session doesn't unlock Ann's connection.
  a.send({type: 'unlock', token: await relay.session(owner)});
  assert.equal((await a.next('locked')).type, 'locked');
  // Her own does.
  a.send({type: 'unlock', token: await relay.session(ann)});
  assert.equal((await a.next('unlocked')).type, 'unlocked');
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  assert.equal((await a.next('status')).body.status, 'pending');
  o.ws.close(); a.ws.close();
});

test('the relay vouches: a member who lost their ID is moved to their new one, chips and all', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), ann = await createIdentity(), annNew = await createIdentity();
  const code = 'VVVV-VVVV';
  const o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Vouch Night', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  await a.next('status');
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  await o.next('owner_view');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1}));
  await o.next('owner_result');
  o.send(await signMessage(owner, {club: code, type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: 700}, id: 2}));
  await o.next('owner_result');
  a.ws.close();

  // Ann's phone is gone. On a new one (no PRF), she signs in with her passkey.
  const p = await relay.passkeyOf(ann);
  const s = await relay.post('unlock', await p.sign(await relay.challenge()));
  const v = await relay.post('vouch', {env: await signMessage(annNew, {type: 'passkey_vouch', challenge: await relay.challenge(), token: s.body.token})});
  assert.equal(v.status, 200, v.body.error);
  // Her new ID's connection unlocks with that session: the club moves her.
  const n = open(`/room/${code}?role=guest&id=${annNew.id}&queue=1`, annNew, {unlock: false});
  await n.ready;
  n.send({type: 'unlock', token: s.body.token});
  await n.next('unlocked');
  n.send(await signMessage(annNew, {club: code, type: 'hello', ledger: 'links'}));
  const acc = await n.next('account');
  assert.equal(acc.body.balance, 700);
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  let view;
  do view = await o.next('owner_view'); while (!view.body.data.members[annNew.id]);
  assert.equal(view.body.data.members[annNew.id].name, 'Ann');
  assert.equal(view.body.data.members[ann.id], undefined);
  assert.ok(view.body.data.log.some(l => /Moved Ann to a new ID \(ducy vouched\)/.test(l.text)));
  // The old ID can't unlock any more.
  const old = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann, {unlock: false});
  await old.ready;
  old.send({type: 'unlock', token: s.body.token});
  assert.equal((await old.next('locked')).type, 'locked');
  o.ws.close(); n.ws.close(); old.ws.close();
});

test('the float (#589): a second refill in a day waits, unless approved with another device’s passkey', {skip: !haveWasm && 'no wasm build'}, async () => {
  const owner = await createIdentity(), ann = await createIdentity();
  const code = 'FFFF-FFFF';
  let o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner);
  await o.ready;
  o.send(await signMessage(owner, {type: 'create_club', club: code, name: 'Float Night', grant: await grantFor(owner.id)}));
  const made = await o.next('club_created');
  const a = open(`/room/${code}?role=guest&id=${ann.id}&queue=1`, ann);
  await a.ready;
  a.send(await signMessage(ann, {club: code, type: 'join', invite: made.invite, name: 'Ann'}));
  await a.next('status');
  let n = 0;
  const cmd = async (conn, op, args = {}) => {
    conn.send(await signMessage(owner, {club: code, type: 'owner_cmd', op, args, id: ++n}));
    for (;;) { const r = await conn.next('owner_result'); if (r.body.id === n) return r.body; }
  };
  await cmd(o, 'approve', {id: ann.id});
  // A new club's float: 2,000 chips, all given.
  assert.equal((await cmd(o, 'give', {id: ann.id, amount: 200_000})).error, '');
  assert.equal((await cmd(o, 'give', {id: ann.id, amount: 100})).error, 'The float is empty. Refill it.');
  // The first refill in a day: at once.
  assert.deepEqual((await cmd(o, 'refill')).value, {added: 200_000});
  assert.equal((await cmd(o, 'give', {id: ann.id, amount: 50_000})).error, '');
  // The next one waits; this device can't approve it, whatever its page says.
  assert.equal((await cmd(o, 'refill')).value.waiting, true);
  assert.match((await cmd(o, 'approve_refill', {device: 'another'})).error, /another of your devices/);
  // From another device, with its own passkey: it goes ahead.
  const second = await relay.addPasskey(owner);
  o.ws.close();
  await o.closed;
  o = open(`/room/${code}?role=guest&id=${owner.id}&queue=1`, owner, {passkey: second});
  await o.ready;
  const r = await cmd(o, 'approve_refill');
  assert.equal(r.error, '');
  assert.deepEqual(r.value, {added: 50_000});

  // Ann's vault (#579): in at once; out after her wait, which the owner
  // doesn't see.
  a.send(await signMessage(ann, {club: code, type: 'vault', op: 'in', amount: 100_000}));
  let acc;
  do acc = await a.next('account'); while (acc.body.vault?.vault !== 100_000);
  assert.equal(acc.body.balance, 150_000);
  a.send(await signMessage(ann, {club: code, type: 'vault', op: 'out', amount: 30_000}));
  assert.equal((await a.next('vault_result')).body.error, '');
  do acc = await a.next('account'); while (!acc.body.vault?.outs?.length);
  assert.equal(acc.body.vault.outs[0].amount, 30_000);
  o.send(await signMessage(owner, {club: code, type: 'owner_hello'}));
  // (Views from before her vault may be waiting first.)
  let view;
  do view = await o.next('owner_view'); while (view.body.data.members[ann.id].vault == null);
  assert.equal(view.body.data.members[ann.id].vault, 100_000, 'the owner sees her vault');
  assert.equal(view.body.data.vaults, undefined, 'but not what she asked to take out');
  // The owner can't run her vault for her.
  assert.match((await cmd(o, 'member_vault', {id: ann.id, op: 'out', amount: 1})).error, /no host action/);
  o.ws.close(); a.ws.close();
});

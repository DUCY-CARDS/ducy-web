// ducy's sites (#637): which site a page is on and where the others are
// (src/sites.js); a subdomain's first visit signing in with the player's
// passkey (src/site-signin.js); and the relay keeping club running to the
// club sites (relay/src/unlock.js siteOk, passkeys.js sessions and vouch).
// Run with: node --test test/sites.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clubUrl, isSubsite, playerHost, playerUrl, siteHost, siteOf } from '../src/sites.js';
import { asksFirst, signInHtml } from '../src/site-signin.js';
import { managerOnly, movesChips } from '../src/chip-moves.js';
import { siteOk } from '../relay/src/unlock.js';
import { passkeys, rpIdFor } from '../relay/src/passkeys.js';
import { createIdentity, signMessage } from '../src/identity.js';
import { softPasskey } from './relay-helper.mjs';

const haveWasm = existsSync(fileURLToPath(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)));
const at = (href) => { const u = new URL(href); return {hostname: u.hostname, hash: u.hash}; };

test('which site a page is on, and where the player app and the club site are', () => {
  assert.equal(siteOf('ducy.cards'), 'player');
  assert.equal(siteOf('www.ducy.cards'), 'player');
  assert.equal(siteOf('staging.ducy.cards'), 'player');
  assert.equal(siteOf('club.ducy.cards'), 'club');
  assert.equal(siteOf('club-staging.ducy.cards'), 'club');
  assert.equal(siteOf('club-sandbox.ducy.cards'), 'club');
  for (const h of ['localhost', '127.0.0.1', 'admin.ducy.cards', 'evil.example', 'club.ducy.cards.evil.example', 'club-prod.ducy.cards']) assert.equal(siteOf(h), 'local', h);
  assert.equal(playerHost('club.ducy.cards'), 'ducy.cards');
  assert.equal(playerHost('club-sandbox.ducy.cards'), 'sandbox.ducy.cards');
  assert.equal(siteHost('club', 'ducy.cards'), 'club.ducy.cards');
  assert.equal(siteHost('club', 'www.ducy.cards'), 'club.ducy.cards');
  assert.equal(siteHost('club', 'staging.ducy.cards'), 'club-staging.ducy.cards');
  assert.equal(siteHost('club', 'localhost'), '');
  assert.ok(isSubsite('club.ducy.cards'));
  assert.ok(!isSubsite('ducy.cards'));
  assert.ok(!isSubsite('localhost'));
});

test('links between them: the manager on the club site, the player app on its own; side by side on a local page', () => {
  assert.equal(clubUrl('clubs/members', at('https://ducy.cards/#clubs')), 'https://club.ducy.cards/#clubs/members');
  assert.equal(clubUrl('clubs/own', at('https://staging.ducy.cards/')), 'https://club-staging.ducy.cards/#clubs/own');
  assert.equal(clubUrl('clubs', at('https://club.ducy.cards/')), './#clubs');
  assert.equal(clubUrl('clubs/new', at('http://localhost:4173/')), 'manage.html#clubs/new');
  assert.equal(clubUrl('', at('https://ducy.cards/')), 'https://club.ducy.cards/');
  assert.equal(playerUrl('clubs/c/ABCD-EFGH', at('https://club.ducy.cards/')), 'https://ducy.cards/#clubs/c/ABCD-EFGH');
  assert.equal(playerUrl('', at('https://club-sandbox.ducy.cards/')), 'https://sandbox.ducy.cards/');
  assert.equal(playerUrl('play', at('https://ducy.cards/')), './#play');
  assert.equal(playerUrl('play', at('https://www.ducy.cards/')), './#play');
  assert.equal(playerUrl('play', at('http://localhost:4173/manage.html')), './#play');
});

test('first visit: a subdomain with no player ID yet asks for the passkey first; anywhere else, never', async () => {
  const has = v => async () => v;
  assert.equal(await asksFirst({host: 'club.ducy.cards', has: has(false), supported: () => true}), true);
  assert.equal(await asksFirst({host: 'club.ducy.cards', has: has(true), supported: () => true}), false);
  assert.equal(await asksFirst({host: 'club.ducy.cards', has: has(false), supported: () => false}), false, 'no passkeys in this browser: a new ID');
  assert.equal(await asksFirst({host: 'ducy.cards', has: has(false), supported: () => true}), false);
  assert.equal(await asksFirst({host: 'localhost', has: has(false), supported: () => true}), false);
  const h = signInHtml();
  assert.match(h, /<h1>Sign in<\/h1>/);
  assert.match(h, /data-signin="passkey">Use your passkey</);
  assert.match(h, /data-signin="new">I’m new to ducy</);
  assert.match(signInHtml('No <b>', true), /disabled.*No &lt;b&gt;/s);
});

const owner = (type, op) => ({body: {type, op}});
test('what only a club site sends: running a club, and an agent\'s commands; a player\'s own chip asks go anywhere', () => {
  for (const t of ['create_club', 'import_club', 'owner_hello', 'owner_cmd', 'agent_cmd']) assert.ok(managerOnly(owner(t, 'give')), t);
  for (const m of [owner('chip_request'), owner('vault', 'out'), owner('join'), owner('agent_reply'), {}, null]) assert.ok(!managerOnly(m));
  assert.ok(movesChips(owner('chip_request')), 'still needs a fresh unlock');
  const club = ['https://club.ducy.cards'];
  const clubU = {origin: 'https://club.ducy.cards'}, appU = {origin: 'https://ducy.cards'};
  assert.ok(siteOk(owner('owner_cmd', 'give'), clubU, 'https://club.ducy.cards', club));
  assert.ok(!siteOk(owner('owner_cmd', 'give'), clubU, 'https://ducy.cards', club), 'a connection from the player app');
  assert.ok(!siteOk(owner('owner_cmd', 'give'), appU, 'https://club.ducy.cards', club), 'a session made on the player app');
  assert.ok(!siteOk(owner('agent_cmd'), null, 'https://club.ducy.cards', club));
  assert.ok(!siteOk(owner('create_club'), appU, 'https://ducy.cards', club));
  assert.ok(siteOk(owner('chip_request'), appU, 'https://ducy.cards', club));
  assert.ok(siteOk(owner('owner_cmd', 'give'), appU, 'http://localhost:4173', []), 'a local relay: anywhere');
});

test('one passkey for every site: the same relying party, and each session keeps the site it was made on', {skip: !haveWasm && 'no wasm build'}, async () => {
  assert.equal(rpIdFor('https://club.ducy.cards'), 'ducy.cards');
  assert.equal(rpIdFor('https://club-staging.ducy.cards'), 'ducy.cards');
  const m = new Map();
  const pk = passkeys({get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }},
    {origins: ['https://ducy.cards', 'https://club.ducy.cards'], clubOrigins: ['https://club.ducy.cards']});
  const ann = await createIdentity(), p = await softPasskey();
  const made = await pk.enrol(await signMessage(ann, {type: 'passkey_enrol', challenge: (await pk.challenge()).challenge, credId: p.credId, spki: p.spki, alg: p.alg}), 'https://club.ducy.cards');
  assert.equal((await pk.session(made.token)).origin, 'https://club.ducy.cards');
  const onApp = await pk.unlock(await p.sign((await pk.challenge()).challenge, {origin: 'https://ducy.cards', rpId: 'ducy.cards'}));
  const onClub = await pk.unlock(await p.sign((await pk.challenge()).challenge, {origin: 'https://club.ducy.cards', rpId: 'ducy.cards'}));
  assert.equal(onApp.id, ann.id);
  assert.equal(onClub.id, ann.id, 'the same player on both');
  assert.equal((await pk.session(onApp.token)).origin, 'https://ducy.cards');
  assert.equal((await pk.session(onClub.token)).origin, 'https://club.ducy.cards');
  // Never vouched for on a club site: from its page, or with its session.
  const fresh = await createIdentity();
  const vouch = async token => signMessage(fresh, {type: 'passkey_vouch', challenge: (await pk.challenge()).challenge, token});
  await assert.rejects(pk.vouch(await vouch(onApp.token), 'https://club.ducy.cards'), /only on ducy\.cards/);
  await assert.rejects(pk.vouch(await vouch(onClub.token), 'https://ducy.cards'), /only on ducy\.cards/);
  const out = await pk.http('vouch', {env: await vouch(onClub.token)}, 'https://club.ducy.cards');
  assert.equal(out.status, 400);
  assert.equal((await pk.status(ann.id)).enrolled, true, 'nothing moved');
  assert.equal((await pk.status(fresh.id)).enrolled, false);
});

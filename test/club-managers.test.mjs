// Managers (#417): the owner makes a member a manager, who then runs the
// club from the same pages (owner_view, owner_cmd) with everything but the
// owner's own actions, each in the activity log as theirs. Also the club
// info (#398) going out to members, and a table's dealing clock (#398).
// Needs the wasm build in wasm/. Run with: node --test test/club-managers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { MultiTable } from '../wasm/ducy_wasm.js';
import { createIdentity, signMessage } from '../src/identity.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { createTableHost } from '../src/club-host.js';
import { fakeTables } from './fake-table.mjs';
import { isDealing } from '../src/club-overview.js';
import { checkManagerOp, managerLogText, OWNER_ONLY } from '../src/club-roles.js';

function memoryStorage() {
  const m = new Map();
  return {
    get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { m.delete(k); },
  };
}
const wait = () => new Promise(r => setTimeout(r, 150));

test('a manager runs the club from the owner’s pages, but not the owner’s own actions', async () => {
  const storage = memoryStorage();
  const owner = await createIdentity(), ben = await createIdentity(), ann = await createIdentity(), cy = await createIdentity();
  const code = 'MGRS-TEST';
  const {invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Managers'}), code);
  const sent = [];
  const server = await openClub({storage, send: (to, data) => sent.push({to, data}), online: [], MultiTable, timers: {set: () => 0, clear() {}}});
  const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
  for (const p of [owner, ben, ann, cy]) await server.message({from: p.id, event: 'open'});
  await say(owner, {type: 'owner_hello'});
  let n = 1;
  const cmd = async (who, op, args = {}) => {
    const id = n++;
    await say(who, {type: 'owner_cmd', op, args, id});
    await wait();
    return sent.filter(s => s.to === who.id && s.data.body?.type === 'owner_result' && s.data.body.id === id).at(-1)?.data.body;
  };
  for (const [p, name] of [[ben, 'Ben'], [ann, 'Ann'], [cy, 'Cy']]) {
    await say(p, {type: 'join', invite, name});
    assert.equal((await cmd(owner, 'approve', {id: p.id})).error, '');
  }
  // A member who isn't a manager can't: the club doesn't even answer.
  assert.equal(await cmd(cy, 'give', {id: cy.id, amount: 100}), undefined);
  assert.equal(server.club.members[cy.id].balance, 0);

  // The owner makes Ben a manager; he accepts.
  assert.equal((await cmd(owner, 'offer_assistant', {id: ben.id})).error, '');
  await say(ben, {type: 'role_reply', accept: true});
  await wait();
  await say(ben, {type: 'owner_hello'});
  await wait();
  const view = sent.filter(s => s.to === ben.id && s.data.body?.type === 'owner_view').at(-1)?.data.body;
  assert.ok(view, 'he gets the whole club');
  assert.equal(view.owner, false);
  assert.equal(view.data.members[ann.id].name, 'Ann');
  assert.equal(sent.filter(s => s.to === owner.id && s.data.body?.type === 'owner_view').at(-1).data.body.owner, true);

  // Everything a manager does: chips (created), credit, debts, tables, info.
  assert.equal((await cmd(ben, 'give', {id: ann.id, amount: 50_000})).error, '');
  assert.equal(server.club.members[ann.id].balance, 50_000);
  assert.equal(server.club.chips.issued, 50_000, 'new chips, not his own');
  assert.equal((await cmd(ben, 'set_credit', {id: cy.id, amount: 20_000})).error, '');
  assert.equal(server.club.members[cy.id].credit, 20_000);
  assert.equal((await cmd(ben, 'set_info', {info: {about: 'Friday nights'}})).error, '');
  assert.equal(server.club.info.about, 'Friday nights');
  const info = sent.filter(s => s.to === ann.id && s.data.body?.type === 'info').at(-1)?.data.body;
  assert.equal(info.info.about, 'Friday nights', 'members get the club info');
  const t = (await cmd(ben, 'new_table', {table: {name: 'Main', sb: 100, bb: 200}})).value;
  assert.ok(t);
  // Each in the log as his.
  const mine = server.club.log.filter(l => l.by === ben.id).map(l => l.text);
  assert.deepEqual(mine.slice(-4), ['Ben gave Ann 500', 'Cy’s credit limit is now 200', 'Updated the club info', 'Ben opened table Main']);

  // Not the owner's own.
  for (const [op, args] of [['settings', {ratholeHours: 1}], ['offer_assistant', {id: ann.id}], ['revoke_role', {id: ben.id}], ['offer_agent', {id: ann.id, amount: 0}], ['service_add', {}], ['delete_club', {}]]) {
    assert.match((await cmd(ben, op, args)).error, /Only the club’s owner/, op);
  }
  // He removes members, but not another manager or the owner.
  assert.equal((await cmd(owner, 'offer_assistant', {id: cy.id})).error, '');
  await say(cy, {type: 'role_reply', accept: true});
  await wait();
  assert.match((await cmd(ben, 'remove', {id: cy.id})).error, /owner can remove a manager/);
  assert.equal((await cmd(ben, 'take', {id: ann.id, amount: 50_000})).error, '');
  assert.equal((await cmd(ben, 'remove', {id: ann.id})).error, '');
  assert.equal(server.club.members[ann.id].status, 'removed');

  // No longer a manager: no more of it.
  assert.equal((await cmd(owner, 'revoke_role', {id: ben.id})).error, '');
  assert.equal(await cmd(ben, 'give', {id: ben.id, amount: 100}), undefined);
});

test('managers: the owner’s own actions, and what a manager’s look like in the log', () => {
  const club = {ownerId: 'o', members: {o: {id: 'o', name: 'Owner'}, b: {id: 'b', name: 'Ben', role: 'assistant'}, a: {id: 'a', name: 'Ann'}}, tables: [{id: 't', name: 'Main'}]};
  for (const op of ['settings', 'offer_assistant', 'revoke_role', 'delete_club', 'service_add']) assert.ok(OWNER_ONLY.has(op), op);
  for (const op of ['give', 'grant', 'set_credit', 'raise_credit', 'settle_debt', 'approve', 'new_table', 'close_table', 'set_info', 'new_tourney', 'new_promo']) assert.ok(!OWNER_ONLY.has(op), op);
  assert.throws(() => checkManagerOp(club, 'b', 'remove', {id: 'o'}), /owner can remove/);
  assert.doesNotThrow(() => checkManagerOp(club, 'b', 'remove', {id: 'a'}));
  assert.equal(managerLogText(club, 'b', 'close_table', {table: 't'}), 'Ben closed Main');
  assert.equal(managerLogText(club, 'b', 'grant', {id: 'a', amount: 2500}), 'Ben granted Ann’s chip request (25)');
  assert.equal(managerLogText(club, 'b', 'hands', {}), '', 'looking changes nothing');
});

test('a table’s dealing clock runs while hands are dealt, and stops with fewer than two in', async () => {
  const table = {id: 't1', name: 'One', seats: 6, sb: 1, bb: 2, game: 'nlhe', turnSecs: 0, status: 'open', minBB: 20, maxBB: 100};
  const club = {code: 'ABCD-EFGH', tables: [table], chips: {issued: 0, reclaimed: 0, next: 1, ledger: []}, ratholeHours: 0, members: {}};
  let next = {complete: true, playersIn: 0};
  const {call} = fakeTables(() => ({out: [], state: {complete: next.complete, hand_number: 1}, players: [{client_id: 'x', seat: 0, chips: 100}], playersIn: next.playersIn, chipRequests: [], turnMsLeft: null, seq: Math.random()}));
  const th = createTableHost({
    club: () => club, save() {}, chipsChanged() {}, tablesChanged() {}, call, sendTable() {},
    store: {get: async () => null, put: async () => {}, drop: async () => {}}, timers: {set: () => 0, clear() {}},
  });
  await th.start(table);
  const step = async s => { next = s; await th.handle('t1', 'x', {type: 'sit_in'}); for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  await step({complete: true, playersIn: 1});
  assert.ok(!isDealing(table.dealing), 'one player: not dealing');
  await step({complete: false, playersIn: 2});
  assert.ok(isDealing(table.dealing), 'a hand under way');
  await step({complete: true, playersIn: 2});
  assert.ok(isDealing(table.dealing), 'between hands, two to deal to');
  await step({complete: true, playersIn: 1});
  assert.ok(!isDealing(table.dealing) && table.dealing.stoppedAt, 'everyone else sitting out: stopped');
});

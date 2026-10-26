// Game assistants (#62): offering the role, what assistants may do, and the log.
// Run with: node --test test/club-roles.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import { approve, hostReceive, newClub, newMembership, playerReceive } from '../src/club.js';
import { checkOwnLedger, accountBody, issue, requestChips, totals, buyIn } from '../src/club-chips.js';
import { newTable } from '../src/club-tables.js';
import { adminBody, answerRole, bigMove, isAssistant, isBigMove, offerAssistant, revokeRole, runAdmin } from '../src/club-roles.js';

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

function assistant(club, id) {
  offerAssistant(club, id);
  answerRole(club, id, true);
}

test('offer, accept, decline and revoke', () => {
  const club = clubWith('ann', 'bob');
  assert.equal(offerAssistant(club, 'ann').body.role, 'offered');
  assert.equal(isAssistant(club, 'ann'), false, 'not until she accepts');
  assert.equal(answerRole(club, 'ann', true).body.role, 'assistant');
  assert.ok(isAssistant(club, 'ann'));
  assert.throws(() => offerAssistant(club, 'ann'), /already/);
  offerAssistant(club, 'bob');
  assert.equal(answerRole(club, 'bob', false).body.role, null);
  assert.equal(isAssistant(club, 'bob'), false);
  assert.equal(revokeRole(club, 'ann').body.role, null);
  assert.equal(isAssistant(club, 'ann'), false);
  assert.throws(() => runAdmin(club, 'ann', {op: 'approve', id: 'x'}), /not a manager/);
  assert.deepEqual(club.log.map(l => l.text), ['ann became a manager', 'ann is no longer a manager']);
});

test('assistants approve, decline and remove members, and it is logged', () => {
  const club = clubWith('ann', 'bob');
  assistant(club, 'ann');
  club.members.cy = {id: 'cy', name: 'Cy', status: 'pending', requestedAt: 1};
  club.members.di = {id: 'di', name: 'Di', status: 'pending', requestedAt: 1};
  const r = runAdmin(club, 'ann', {op: 'approve', id: 'cy'});
  assert.equal(r.replies[0].body.status, 'member');
  runAdmin(club, 'ann', {op: 'decline', id: 'di'});
  assert.equal(club.members.di.status, 'declined');
  issue(club, 'bob', 300);
  runAdmin(club, 'ann', {op: 'remove', id: 'bob'});
  assert.equal(club.members.bob.status, 'removed');
  assert.equal(club.members.bob.balance, 0, 'balance back to the host');
  assert.throws(() => runAdmin(club, 'ann', {op: 'remove', id: 'ann'}), /yourself/);
  assert.deepEqual(club.log.slice(1).map(l => l.text), ['ann approved Cy', 'ann declined Di', 'ann removed bob']);
  assert.ok(club.log.every(l => l.by === 'ann' || l.text.includes('became')));
});

test('assistants give and grant from their own balance, never creating chips', () => {
  const club = clubWith('ann', 'bob');
  assistant(club, 'ann');
  issue(club, 'ann', 1000);
  const before = totals(club);
  runAdmin(club, 'ann', {op: 'give', id: 'bob', amount: 300, note: 'buy-in'});
  assert.equal(club.members.ann.balance, 700);
  assert.equal(club.members.bob.balance, 300);
  requestChips(club, 'bob', 200, 'rebuy');
  runAdmin(club, 'ann', {op: 'grant', id: 'bob'});
  assert.equal(club.members.bob.balance, 500);
  assert.equal(club.members.bob.request, null);
  requestChips(club, 'bob', 100);
  runAdmin(club, 'ann', {op: 'deny', id: 'bob'});
  assert.equal(club.members.bob.request, null);
  assert.throws(() => runAdmin(club, 'ann', {op: 'give', id: 'bob', amount: 1000}), /You have 5 chips/, 'shown in chips: 500 hundredths');
  const after = totals(club);
  assert.equal(after.issued, before.issued, 'no chips created');
  assert.ok(after.conserved);
  // Each side's own ledger copy still adds up.
  for (const id of ['ann', 'bob']) {
    const b = accountBody(club, id);
    assert.ok(checkOwnLedger(b.entries, b.balance), id);
  }
});

test('assistants open, close and hide tables', () => {
  const club = clubWith('ann');
  assistant(club, 'ann');
  const r = runAdmin(club, 'ann', {op: 'new_table', table: {name: 'Side game', game: 'plo4', sb: 1, bb: 2}});
  const t = r.table.start;
  assert.equal(t.name, 'Side game');
  assert.deepEqual(runAdmin(club, 'ann', {op: 'close_table', table: t.id}).table, {close: t.id});
  assert.equal(t.status, 'closing');
  assert.throws(() => runAdmin(club, 'ann', {op: 'hide_table', table: t.id}), /closed tables/);
  t.status = 'closed';
  runAdmin(club, 'ann', {op: 'hide_table', table: t.id});
  assert.equal(adminBody(club).tables.length, 0);
});

test('a seated member can’t be removed by an assistant', () => {
  const club = clubWith('ann', 'bob');
  assistant(club, 'ann');
  issue(club, 'bob', 500);
  const t = newTable(club);
  buyIn(club, 'bob', t.id, 100, {min: 80, max: 200});
  assert.throws(() => runAdmin(club, 'ann', {op: 'remove', id: 'bob'}), /at a table/);
});

test('over the wire: the offer reaches the member, their acceptance and commands reach the host', async () => {
  const host = await createIdentity(), ann = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', host.id, 0);
  const verifier = new Verifier();
  const mem = newMembership({code: club.code, invite: club.invite, hostId: host.id});
  await hostReceive(club, verifier, await signMessage(ann, {type: 'join', club: club.code, invite: club.invite, name: 'Ann'}));
  approve(club, ann.id);
  assert.ok(await playerReceive(mem, await signMessage(host, offerAssistant(club, ann.id).body)));
  assert.equal(mem.role, 'offered');
  const r = await hostReceive(club, verifier, await signMessage(ann, {type: 'role_reply', club: club.code, accept: true}));
  assert.deepEqual(r.admin.type, 'role_reply');
  assert.equal(r.admin.from, ann.id);
  answerRole(club, ann.id, r.admin.body.accept);
  assert.ok(await playerReceive(mem, await signMessage(host, adminBody(club))));
  assert.equal(mem.admin.members.length, 1);
  const c = await hostReceive(club, verifier, await signMessage(ann, {type: 'admin_cmd', club: club.code, cmd: {op: 'new_table'}}));
  assert.equal(c.admin.body.cmd.op, 'new_table');
});

test('big chip moves: logged with their amount, measured against the biggest open table (#190)', () => {
  const club = clubWith('ann', 'bob');
  assistant(club, 'ann');
  issue(club, 'ann', 100000);
  assert.equal(bigMove(club), null, 'no open table to measure by');
  newTable(club, {sb: 1, bb: 2, maxBB: 100});
  const t = newTable(club, {sb: 5, bb: 10, maxBB: 200});
  assert.equal(bigMove(club), 2000, 'a full buy-in at the biggest table');
  runAdmin(club, 'ann', {op: 'give', id: 'bob', amount: 500});
  runAdmin(club, 'ann', {op: 'give', id: 'bob', amount: 2500});
  const gives = club.log.filter(l => l.amount != null);
  assert.deepEqual(gives.map(l => l.amount), [500, 2500]);
  assert.deepEqual(gives.map(l => isBigMove(l, bigMove(club))), [false, true]);
  assert.equal(isBigMove(club.log[0], bigMove(club)), false, 'entries without chips never count');
  t.status = 'closed';
  assert.equal(bigMove(club), 200, 'closed tables don’t count');
});

// Club chips (#67): balances, requests, the ledger, buy-ins and the rathole rule.
// Run with: node --test test/club-chips.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import { approve, hostReceive, newClub, newMembership, playerReceive, removeMember, lastEntry } from '../src/club.js';
import {
  accountBody, buyIn, cashOut, checkOwnLedger, declineRequest, grantRequest, issue, ratholeMin, reclaim,
  requestChips, setStack, topUp, totals,
} from '../src/club-chips.js';

const H = 3600e3;

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id, status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

test('issue and reclaim move the balance and keep the club conserved', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 500, 1);
  reclaim(club, 'ann', 200, 2, 'settled');
  assert.equal(club.members.ann.balance, 300);
  assert.deepEqual(club.chips.ledger.map(e => [e.kind, e.amount, e.balance]), [['issue', 500, 500], ['reclaim', 200, 300]]);
  assert.ok(totals(club).conserved);
  assert.throws(() => reclaim(club, 'ann', 301), /only has 3 chips/);
  assert.throws(() => issue(club, 'ann', 0), /above 0/);
  assert.throws(() => issue(club, 'ann', 1.5), /whole number/);
  assert.throws(() => issue(club, 'nobody', 10), /Not a member/);
});

test('requests: ask, replace, grant (for a different amount), decline', () => {
  const club = clubWith('ann');
  requestChips(club, 'ann', 300, 'rebuy', 1);
  requestChips(club, 'ann', 400, 'rebuy', 2);
  assert.deepEqual(club.members.ann.request, {amount: 400, note: 'rebuy', at: 2});
  const e = grantRequest(club, 'ann', 250, 3);
  assert.equal(e.kind, 'grant');
  assert.equal(e.note, 'rebuy');
  assert.equal(club.members.ann.balance, 250);
  assert.equal(club.members.ann.request, null);
  requestChips(club, 'ann', 100, '', 4);
  assert.ok(declineRequest(club, 'ann'));
  assert.equal(club.members.ann.request, null);
  assert.throws(() => grantRequest(club, 'ann'), /no request/);
});

test('buy in, play, cash out: balance = issued + net result; conservation holds throughout', () => {
  const club = clubWith('ann', 'bob');
  issue(club, 'ann', 1000, 0);
  issue(club, 'bob', 1000, 0);
  const limits = {min: 80, max: 200};
  buyIn(club, 'ann', 't1', 200, limits, 1);
  buyIn(club, 'bob', 't1', 150, limits, 1);
  assert.ok(totals(club).conserved);
  // A hand: Ann wins 120 from Bob.
  setStack(club, 'ann', 320);
  setStack(club, 'bob', 30);
  assert.ok(totals(club).conserved);
  topUp(club, 'bob', 500, limits.max, 2);
  assert.equal(club.members.bob.seat.stack, 200); // capped at the max
  cashOut(club, 'ann', 3);
  cashOut(club, 'bob', 3);
  assert.equal(club.members.ann.balance, 1120);
  assert.equal(club.members.bob.balance, 880);
  assert.ok(totals(club).conserved);
});

test('buy-in limits, balance and one seat at a time', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 150, 0);
  const limits = {min: 80, max: 200};
  assert.throws(() => buyIn(club, 'ann', 't1', 50, limits), /minimum buy-in is 80/);
  assert.throws(() => buyIn(club, 'ann', 't1', 250, limits), /maximum buy-in is 2\./);
  assert.throws(() => buyIn(club, 'ann', 't1', 180, limits), /You have 1\.50 chips/);
  buyIn(club, 'ann', 't1', 100, limits);
  assert.throws(() => buyIn(club, 'ann', 't2', 10, {min: 1, max: 100}), /Already seated/);
});

test('rathole: leaving with 300 means coming back to that table with 300 until the window passes', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 2000, 0);
  const limits = {min: 80, max: 400};
  buyIn(club, 'ann', 't1', 100, limits, 0);
  setStack(club, 'ann', 300);
  cashOut(club, 'ann', 10);
  assert.equal(ratholeMin(club, 'ann', 't1', 10 + H), 300);
  assert.throws(() => buyIn(club, 'ann', 't1', 100, limits, 10 + H), /at least that/);
  // Another table isn't affected.
  buyIn(club, 'ann', 't2', 100, limits, 10 + H);
  cashOut(club, 'ann', 10 + H);
  // After the default 2 hours, normal limits.
  assert.equal(ratholeMin(club, 'ann', 't1', 10 + 2 * H), 0);
  buyIn(club, 'ann', 't1', 100, limits, 10 + 2 * H);
  // The host can change the window.
  cashOut(club, 'ann', 20 * H);
  club.ratholeHours = 5;
  assert.equal(ratholeMin(club, 'ann', 't1', 23 * H), 100);
});

test('removing a member reclaims their balance', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 400, 0);
  requestChips(club, 'ann', 100);
  const replies = removeMember(club, 'ann', 5);
  assert.equal(replies[0].body.status, 'removed');
  assert.equal(replies[1].body.balance, 0);
  assert.equal(club.members.ann.balance, 0);
  assert.equal(club.members.ann.request, null);
  assert.equal(club.chips.ledger.at(-1).kind, 'reclaim');
  assert.ok(totals(club).conserved);
});

test('a seated member can’t be removed until the table cashes them out', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 400, 0);
  buyIn(club, 'ann', 't1', 200, {min: 1, max: 400});
  assert.equal(removeMember(club, 'ann'), null);
  cashOut(club, 'ann');
  assert.ok(removeMember(club, 'ann'));
});

test('a player’s own ledger checks out against the balance, and tampering is caught', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 500, 1);
  buyIn(club, 'ann', 't1', 200, {min: 1, max: 500}, 2);
  setStack(club, 'ann', 260);
  cashOut(club, 'ann', 3);
  const body = accountBody(club, 'ann');
  assert.equal(body.balance, 560);
  assert.ok(checkOwnLedger(body.entries, body.balance));
  assert.equal(checkOwnLedger(body.entries, 600), false);
  const tampered = body.entries.map(e => (e.kind === 'issue' ? {...e, amount: 900} : e));
  assert.equal(checkOwnLedger(tampered, body.balance), false);
});

test('over the wire: request chips, host grants, player keeps a signed copy that agrees', async () => {
  const host = await createIdentity(), ann = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', host.id, 0);
  const verifier = new Verifier();
  const mem = newMembership({code: club.code, invite: club.invite, hostId: host.id});
  const deliver = async replies => { for (const r of replies) assert.ok(await playerReceive(mem, await signMessage(host, r.body))); };

  await deliver((await hostReceive(club, verifier, await signMessage(ann, {type: 'join', club: club.code, invite: club.invite, name: 'Ann'}))).replies);
  await deliver([approve(club, ann.id)]);
  assert.equal(mem.status, 'member');

  const r = await hostReceive(club, verifier, await signMessage(ann, {type: 'chip_request', club: club.code, amount: 300, note: 'buy-in'}));
  assert.ok(r.changed);
  await deliver(r.replies);
  assert.deepEqual(mem.request.amount, 300);

  grantRequest(club, ann.id, 300);
  const hello = await hostReceive(club, verifier, await signMessage(ann, {type: 'hello', club: club.code, since: lastEntry(mem)}));
  await deliver(hello.replies);
  assert.equal(mem.balance, 300);
  assert.equal(mem.request, null);
  assert.equal(mem.entries.length, 1);
  assert.ok(mem.ledgerOk);
  assert.equal(mem.receipts.length, 1);

  // A second hello sends nothing new.
  const again = await hostReceive(club, verifier, await signMessage(ann, {type: 'hello', club: club.code, since: lastEntry(mem)}));
  assert.deepEqual(again.replies[1].body.entries, []);

  // Non-members can't ask for chips.
  const eve = await createIdentity();
  const no = await hostReceive(club, verifier, await signMessage(eve, {type: 'chip_request', club: club.code, amount: 5}));
  assert.equal(no.reason, 'not a member');
});

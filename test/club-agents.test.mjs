// Agents (#74, #75, #76), including the worked examples A–E from #63.
// Run with: node --test test/club-agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import { approve, hostReceive, newClub, removeMember } from '../src/club.js';
import { accountBody, checkOwnLedger, issue, totals } from '../src/club-chips.js';
import { chipsForTable, leftTable, newTable } from '../src/club-tables.js';
import {
  accountOf, agentBody, answerAgent, assignToAgent, isAgent, offerAgent, playersOf, revokeAgent, runAgent, setCreditLimit, settle,
} from '../src/club-agents.js';

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

// Agent A (limit 1,000, given 500 by the host) with players P, Q, R, and a table.
function setup() {
  const club = clubWith('a', 'p', 'q', 'r');
  offerAgent(club, 'a', 1000);
  answerAgent(club, 'a', true);
  for (const id of ['p', 'q', 'r']) assignToAgent(club, id, 'a');
  issue(club, 'a', 500);
  const t = newTable(club, {sb: 1, bb: 2, minBB: 1, maxBB: 1000});
  return {club, t};
}

test('offer, accept, credit limit, assign, revoke', () => {
  const club = clubWith('a', 'p');
  assert.equal(offerAgent(club, 'a', 300).body.agent, 'offered');
  assert.equal(isAgent(club, 'a'), false);
  answerAgent(club, 'a', true);
  assert.ok(isAgent(club, 'a'));
  assert.ok(club.members.a.agentInvite, 'their own invite token');
  setCreditLimit(club, 'a', 500);
  assert.equal(club.members.a.creditLimit, 500);
  assignToAgent(club, 'p', 'a');
  assert.deepEqual(playersOf(club, 'a').map(m => m.id), ['p']);
  assert.throws(() => assignToAgent(club, 'a', 'a'), /under another agent/);
  revokeAgent(club, 'a');
  assert.equal(isAgent(club, 'a'), false);
  assert.equal(club.members.p.agentOf, undefined, 'players become regular members');
});

test('#63 example A: buying in on credit', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  assert.equal(club.members.a.balance, -300);
  chipsForTable(club, 'p', t, 800);
  const acc = accountOf(club, 'a');
  assert.equal(acc.total, -300);
  assert.equal(acc.creditUsed, 300, 'credit used 300 / 1,000');
  assert.ok(totals(club).conserved);
});

test('#63 example B: losing, then settling', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  chipsForTable(club, 'p', t, 800);
  // Lost it all (to other players at the table, not modelled here, so the
  // club's own totals aren't checked in this example).
  leftTable(club, 'p', 0);
  assert.equal(accountOf(club, 'a').total, -300);
  settle(club, 'a', 300);
  assert.equal(accountOf(club, 'a').total, 0);
  assert.equal(accountOf(club, 'a').creditUsed, 0);
});

test('#63 example C: winning pays credit back', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  chipsForTable(club, 'p', t, 800);
  leftTable(club, 'p', 1000);
  const acc = accountOf(club, 'a');
  assert.equal(acc.total, 700);
  assert.equal(acc.creditUsed, 0);
});

test('#63 example D: hitting the limit', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800}); // own −300
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 700}); // own −1,000: at the limit
  chipsForTable(club, 'p', t, 800);
  chipsForTable(club, 'q', t, 700);
  assert.equal(accountOf(club, 'a').creditUsed, 1000);
  assert.throws(() => runAgent(club, 'a', {op: 'give', id: 'r', amount: 100}), /balance plus credit allows \(0\)/);
  // Q cashes out 300 and gives... no: A takes it back to make room.
  leftTable(club, 'q', 300);
  runAgent(club, 'a', {op: 'take', id: 'q', amount: 300});
  runAgent(club, 'a', {op: 'give', id: 'r', amount: 100});
  assert.equal(club.members.r.balance, 100);
});

test('#63 example E: lowering the limit below credit used', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 1100}); // own −600
  chipsForTable(club, 'p', t, 1000);
  setCreditLimit(club, 'a', 500);
  // Chips on the table aren't touched; no new chips can go out.
  assert.equal(club.members.p.seat.stack, 1000);
  assert.throws(() => runAgent(club, 'a', {op: 'give', id: 'q', amount: 1}), /allows \(0\)/);
  settle(club, 'a', 200); // own −400: back above −500
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 100});
});

test('agents only handle their own players, grant and decline requests, approve their recruits', () => {
  const {club} = setup();
  club.members.x = {id: 'x', name: 'X', status: 'member', balance: 0};
  assert.throws(() => runAgent(club, 'a', {op: 'give', id: 'x', amount: 10}), /Not one of your players/);
  club.members.p.request = {amount: 200, note: 'rebuy', at: 1};
  runAgent(club, 'a', {op: 'grant', id: 'p'});
  assert.equal(club.members.p.balance, 200);
  assert.equal(club.members.p.request, null);
  club.members.q.request = {amount: 50, note: '', at: 1};
  runAgent(club, 'a', {op: 'deny', id: 'q'});
  assert.equal(club.members.q.request, null);
  club.members.n = {id: 'n', name: 'N', status: 'pending', requestedAt: 1, agentOf: 'a'};
  const body = agentBody(club, 'a');
  assert.deepEqual(body.recruits.map(r => r.id), ['n']);
  runAgent(club, 'a', {op: 'approve', id: 'n'});
  assert.equal(club.members.n.status, 'member');
  assert.throws(() => runAgent(club, 'p', {op: 'give', id: 'q', amount: 1}), /not an agent/);
});

test('ledgers: both sides of every agent transfer add up, and the host keeps the final say', () => {
  const {club} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 900});
  runAgent(club, 'a', {op: 'take', id: 'p', amount: 100});
  for (const id of ['a', 'p']) {
    const b = accountBody(club, id);
    assert.ok(checkOwnLedger(b.entries, b.balance), id);
  }
  // The host removes the agent's player: their share goes back to the host.
  removeMember(club, 'p');
  assert.equal(club.members.p.balance, 0);
  assert.ok(totals(club).conserved);
  // An agent in credit can't be revoked until they settle.
  assert.equal(accountOf(club, 'a').creditUsed, 300);
  assert.throws(() => revokeAgent(club, 'a'), /settle up first/);
  settle(club, 'a', 300);
  assert.ok(revokeAgent(club, 'a'));
});

test('joining through an agent’s link puts the recruit under that agent', async () => {
  const {club} = setup();
  const n = await createIdentity();
  const verifier = new Verifier();
  const r = await hostReceive(club, verifier, await signMessage(n, {type: 'join', club: club.code, invite: club.members.a.agentInvite, name: 'Newbie'}));
  assert.equal(r.replies[0].body.status, 'pending');
  assert.equal(club.members[n.id].agentOf, 'a');
  // An agent command passes through, verified.
  const c = await hostReceive(club, verifier, await signMessage(n, {type: 'agent_cmd', club: club.code, cmd: {op: 'give'}}));
  assert.equal(c.reason, 'not a member', 'only members');
});

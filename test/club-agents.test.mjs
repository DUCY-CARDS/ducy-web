// Agents (#74, #75, #76), including the worked examples A–E from #63.
// Run with: node --test test/club-agents.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import { approve, hostReceive, newClub, removeMember } from '../src/club.js';
import { accountBody, checkOwnLedger, ensureChips, issue, totals } from '../src/club-chips.js';
import { setCredit } from '../src/club-credit.js';
import { settleRows, startMoney } from '../src/club-money.js';
import { chipsForTable, leftTable, newTable } from '../src/club-tables.js';
import {
  accountOf, agentBody, answerAgent, assignToAgent, isAgent, offerAgent, playersOf, revokeAgent, runAgent, tableResult,
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
  setCredit(club, 'a', 1000);
  offerAgent(club, 'a');
  answerAgent(club, 'a', true);
  for (const id of ['p', 'q', 'r']) assignToAgent(club, id, 'a');
  issue(club, 'a', 500);
  const t = newTable(club, {sb: 1, bb: 2, minBB: 1, maxBB: 1000});
  return {club, t};
}

test('offer, accept, credit limit, assign, revoke', () => {
  const club = clubWith('a', 'p');
  assert.deepEqual(offerAgent(club, 'a').body, {type: 'agent_role', club: club.code, agent: 'offered'});
  assert.equal(isAgent(club, 'a'), false);
  answerAgent(club, 'a', true);
  assert.ok(isAgent(club, 'a'));
  assert.ok(club.members.a.agentInvite, 'their own invite token');
  setCredit(club, 'a', 500);
  assert.equal(accountOf(club, 'a').limit, 500, 'the agent’s limit is their member credit');
  assignToAgent(club, 'p', 'a');
  assert.deepEqual(playersOf(club, 'a').map(m => m.id), ['p']);
  assert.throws(() => assignToAgent(club, 'a', 'a'), /under another agent/);
  revokeAgent(club, 'a');
  assert.equal(isAgent(club, 'a'), false);
  assert.equal(club.members.p.agentOf, undefined, 'players become regular members');
  assert.equal(club.members.a.credit, 500, 'they keep their credit as a member');
});

test('an agent’s old credit limit becomes their member credit (#445)', () => {
  const club = clubWith('a', 'b', 'c');
  Object.assign(club.members.a, {agent: 'yes', creditLimit: 800});
  Object.assign(club.members.b, {agent: 'yes', creditLimit: 300, credit: 500});
  Object.assign(club.members.c, {agent: 'yes', creditLimit: 0});
  ensureChips(club);
  assert.deepEqual(['a', 'b', 'c'].map(id => [club.members[id].credit, 'creditLimit' in club.members[id]]), [[800, false], [500, false], [undefined, false]]);
});

test('#63 example A: buying in on credit', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  assert.equal(club.members.a.balance, 500, 'giving costs the agent nothing until the chips are played (#454)');
  assert.equal(club.members.p.balance, 800);
  chipsForTable(club, 'p', t, 800);
  const acc = accountOf(club, 'a');
  assert.equal(acc.total, -300, 'the buy-in moved the agent’s link too');
  assert.equal(acc.creditUsed, 300, 'credit used 300 / 1,000');
  assert.ok(totals(club).conserved);
});

test('#63 example B: losing, then paying up', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  chipsForTable(club, 'p', t, 800);
  // Lost it all (to other players at the table, not modelled here, so the
  // club's own totals aren't checked in this example).
  leftTable(club, 'p', 0);
  assert.equal(accountOf(club, 'a').total, -300);
  issue(club, 'a', 300, 5, 'Cash');
  assert.equal(accountOf(club, 'a').total, 0);
  assert.equal(accountOf(club, 'a').creditUsed, 0);
});

test('the agent view: players’ results at the tables, and a payment on their own copy (#190, #454)', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  chipsForTable(club, 'p', t, 800);
  leftTable(club, 'p', 0);
  issue(club, 'a', 300, 5, 'cash at the bar');
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 200});
  chipsForTable(club, 'q', t, 200);
  leftTable(club, 'q', 450);
  // Seated again (with what they left with: the rathole rule): a session
  // still running doesn't count.
  chipsForTable(club, 'q', t, 450);
  assert.equal(tableResult(club, 'p'), -800);
  assert.equal(tableResult(club, 'q'), 250);
  const v = agentBody(club, 'a');
  assert.deepEqual(v.players.map(x => [x.id, x.result]), [['p', -800], ['q', 250], ['r', 0]]);
  assert.deepEqual(accountBody(club, 'a').entries.filter(e => e.kind === 'issue').map(e => [e.amount, e.note]), [[500, undefined], [300, 'cash at the bar']]);
});

test('the agent view: where each player sits, and what the agent would owe if they stood up (#428)', () => {
  const {club, t} = setup();
  t.name = 'Main';
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  chipsForTable(club, 'p', t, 800); // the agent's link: −300
  let v = agentBody(club, 'a');
  assert.deepEqual(v.players.find(x => x.id === 'p'), {id: 'p', name: 'P', balance: 0, request: null, seated: true, result: 0, table: 'Main', stack: 800});
  assert.equal(v.players.find(x => x.id === 'q').table, undefined, 'not at a table');
  // Credit used counts chips at the table (#63 example A); owed doesn't.
  assert.deepEqual([v.creditUsed, v.owed, v.room], [300, 0, 700]);
  // Lost 600 at the table so far: owed only once it's more than the agent's 500.
  club.members.p.seat.stack = 100;
  assert.equal(agentBody(club, 'a').owed, 200);
  leftTable(club, 'p', 100);
  v = agentBody(club, 'a');
  assert.deepEqual([v.creditUsed, v.owed], [200, 200]);
  // A 0-credit agent below zero backs no one's buy-in: their players can be
  // given chips, but can't bring them to a table.
  setCredit(club, 'a', 0);
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 100});
  assert.throws(() => chipsForTable(club, 'q', t, 100), e => e.short && /your agent can’t back more/.test(e.message));
  assert.equal(agentBody(club, 'a').room, 0);
  assert.equal(club.members.q.room, 0, 'the least room on their path');
});

test('Settle: the club’s rows are its own members, an agent’s row their whole tree; an agent’s rows are their players (#454)', () => {
  const {club, t} = setup();
  club.members.x = {id: 'x', name: 'X', status: 'pending', requestedAt: 0};
  approve(club, 'x', 0);
  issue(club, 'x', 50);
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 100});
  chipsForTable(club, 'p', t, 800);
  leftTable(club, 'p', 0); // the agent's link: 500 − 800
  assert.deepEqual(settleRows(club), [{member: 'a', balance: -300}, {member: 'x', balance: 50}]);
  assert.deepEqual(settleRows(club, 'a'), [{member: 'q', balance: 100}], 'P is square with A; R has nothing');
  issue(club, 'a', 300, 2, 'Cash');
  assert.deepEqual(settleRows(club), [{member: 'x', balance: 50}]);
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
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 800});
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 700});
  chipsForTable(club, 'p', t, 800); // the agent's link: −300
  chipsForTable(club, 'q', t, 700); // −1,000: at the limit
  assert.equal(accountOf(club, 'a').creditUsed, 1000);
  // R can be given chips, but not sit with them.
  runAgent(club, 'a', {op: 'give', id: 'r', amount: 100});
  assert.throws(() => chipsForTable(club, 'r', t, 100), /your agent can’t back more/);
  // Q stands up with 300: room for R.
  leftTable(club, 'q', 300);
  chipsForTable(club, 'r', t, 100);
  assert.equal(club.members.r.seat.stack, 100);
  assert.equal(accountOf(club, 'a').creditUsed, 800);
});

test('#63 example E: lowering the limit below credit used', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 1100});
  chipsForTable(club, 'p', t, 1000); // the agent's link: −500
  setCredit(club, 'a', 400);
  // Chips on the table aren't touched; no new chips can go on one.
  assert.equal(club.members.p.seat.stack, 1000);
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 100});
  assert.throws(() => chipsForTable(club, 'q', t, 2), /your agent can’t back more/);
  issue(club, 'a', 200); // −300: back above −400
  chipsForTable(club, 'q', t, 100);
  assert.equal(accountOf(club, 'a').creditUsed, 400);
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

test('ledgers: every agent move adds up on both links, and the host keeps the final say', () => {
  const {club, t} = setup();
  runAgent(club, 'a', {op: 'give', id: 'p', amount: 900});
  runAgent(club, 'a', {op: 'take', id: 'p', amount: 100});
  runAgent(club, 'a', {op: 'give', id: 'q', amount: 300});
  chipsForTable(club, 'q', t, 300);
  leftTable(club, 'q', 300);
  assert.deepEqual(['a', 'p', 'q'].map(id => club.members[id].balance), [500, 800, 300]);
  // Q's buy-in and cash-out are on the agent's copy too, marked as Q's.
  const mine = accountBody(club, 'a').entries.filter(e => e.player === 'q').map(e => e.kind);
  assert.deepEqual(mine, ['buy_in', 'cash_out']);
  for (const id of ['a', 'p', 'q']) {
    const b = accountBody(club, id);
    assert.ok(checkOwnLedger(b.entries, b.balance), id);
  }
  // The host removes the agent's player: their chips go back to the agent.
  removeMember(club, 'p');
  assert.equal(club.members.p.balance, 0);
  assert.ok(totals(club).conserved);
  // An agent in credit can't be revoked until they settle.
  // (R's loss goes to players this test doesn't model.)
  runAgent(club, 'a', {op: 'give', id: 'r', amount: 800});
  chipsForTable(club, 'r', t, 800);
  leftTable(club, 'r', 0);
  assert.equal(accountOf(club, 'a').creditUsed, 300);
  assert.throws(() => revokeAgent(club, 'a'), /account is in credit: settle up first/);
  issue(club, 'a', 300);
  // Q still has 300 from A: they settle that first too.
  assert.throws(() => revokeAgent(club, 'a'), /A and Q settle up first/);
  runAgent(club, 'a', {op: 'take', id: 'q', amount: 300});
  assert.ok(revokeAgent(club, 'a'));
  // Their players play through the club now.
  assert.equal(club.money.accounts.q.through, 'club');
  issue(club, 'q', 50);
  assert.equal(club.members.q.balance, 50);
});

test('a club from before links: an agent’s link is their chips and their players’, and every copy still adds up (#454)', () => {
  const club = clubWith('a', 'p', 'q', 'd');
  setCredit(club, 'a', 1000);
  offerAgent(club, 'a');
  answerAgent(club, 'a', true);
  // As a club saved before links had it: no money yet, the agent's own
  // chips below zero, P with chips under them and Q seated.
  delete club.money;
  Object.assign(club.members.p, {agentOf: 'a', balance: 600});
  Object.assign(club.members.q, {agentOf: 'a', balance: 0, seat: {table: 't1', stack: 400, put: 300}});
  Object.assign(club.members.a, {balance: -500});
  Object.assign(club.members.d, {balance: 250});
  club.chips = {issued: 750, reclaimed: 0, next: 1, ledger: []};
  for (const [id, amount] of [['a', 500], ['d', 250]]) club.chips.ledger.push({n: club.chips.next++, at: 0, kind: 'issue', member: id, amount, balance: amount});
  club.chips.ledger.push({n: club.chips.next++, at: 0, kind: 'transfer_out', member: 'a', amount: 1000, balance: -500});
  club.chips.ledger.push({n: club.chips.next++, at: 0, kind: 'transfer_in', member: 'p', amount: 1000, balance: 1000});
  club.chips.ledger.push({n: club.chips.next++, at: 0, kind: 'buy_in', member: 'p', amount: 400, balance: 600});
  delete club.money;
  startMoney(club, 1);
  assert.equal(club.money.accounts.p.through, 'a');
  assert.deepEqual(['a', 'p', 'q', 'd'].map(id => club.members[id].balance), [100, 600, 0, 250]);
  assert.equal(accountOf(club, 'a').own, -500, 'their own part is what it was');
  for (const id of ['a', 'p', 'd']) {
    const b = accountBody(club, id);
    assert.ok(checkOwnLedger(b.entries, b.balance), id);
  }
  // Q stands up up the path they're seated on.
  leftTable(club, 'q', 900);
  assert.deepEqual([club.members.q.balance, club.members.a.balance], [900, 1000]);
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

// Credit players (#404): sitting down on credit up to a limit, paying it back
// on standing up, requests at the limit, settling debt, and the books still
// adding up. Run with: node --test test/club-credit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { Verifier, createIdentity, signMessage } from '../src/identity.js';
import { approve, hostReceive, newClub, newMembership, playerReceive } from '../src/club.js';
import {
  accountBody, available, buyIn, cashOut, checkOwnLedger, declineRequest, grantRequest, issue, owedBy, refundTopUp,
  requestChips, setStack, topUp, totals,
} from '../src/club-chips.js';
import { creditNotices, creditRow, raiseCredit, setCredit } from '../src/club-credit.js';
import { chipsForTable, leftTable, newTable } from '../src/club-tables.js';
import { answerAgent, assignToAgent, offerAgent, runAgent } from '../src/club-agents.js';
import { drawnOn, ledgerOf, repaidBy } from '../src/club-money.js';

const LIMITS = {min: 10, max: 1000};

// A club with these members, and Rex, who sits at every table with plenty
// of chips: what others win or lose there is his loss or win, so the club's
// books stay whole. The rathole rule is off, to sit again straight away.
function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of [...ids, 'rex']) {
    club.members[id] = {id, name: id, status: 'member', requestedAt: 0};
  }
  totals(club);
  club.ratholeHours = 0;
  issue(club, 'rex', 100000, 0);
  buyIn(club, 'rex', 'rex-table', 100000, {min: 1, max: 100000}, 0);
  return club;
}

// Member `id`'s stack becomes `stack`, the difference won from or lost to Rex.
function play(club, id, stack) {
  const rex = club.members.rex.seat;
  rex.stack -= stack - club.members[id].seat.stack;
  setStack(club, id, stack);
}

const ann = club => club.members.ann;

test('a member has no credit unless the host sets it, and never goes below zero without it', () => {
  const club = clubWith('ann');
  issue(club, 'ann', 100, 0);
  assert.equal(available(ann(club)), 100);
  assert.throws(() => buyIn(club, 'ann', 't1', 150, LIMITS), /You have 1 chips/);
  buyIn(club, 'ann', 't1', 100, LIMITS);
  assert.throws(() => topUp(club, 'ann', 10, 1000), e => e.short && /You have 0 chips/.test(e.message));
  assert.equal(ann(club).balance, 0);
  assert.equal(drawnOn(ledgerOf(club).at(-1)), 0, 'nothing drawn on credit');
  cashOut(club, 'ann');
  assert.equal(repaidBy(ledgerOf(club).at(-1)), 0);
  assert.ok(totals(club).conserved);
});

test('example: limit 500, sit with 200 on credit, win to 300, stand: balance 100, available 600', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 500, 0);
  assert.equal(available(ann(club)), 500);
  const e = buyIn(club, 'ann', 't1', 200, LIMITS, 1);
  assert.equal(drawnOn(e), 200, 'the credit draw shows in the balances');
  assert.equal(ann(club).balance, -200);
  assert.equal(available(ann(club)), 300);
  assert.ok(totals(club).conserved, 'the chips on the table offset what is owed');
  play(club, 'ann', 300);
  const out = cashOut(club, 'ann', 2);
  assert.equal(repaidBy(out), 200);
  assert.equal(out.balance, 100);
  assert.equal(ann(club).balance, 100);
  assert.equal(available(ann(club)), 600);
  assert.equal(owedBy(ann(club)), 0);
  assert.ok(totals(club).conserved);
  assert.ok(checkOwnLedger(accountBody(club, 'ann').entries, ann(club).balance));
});

test('example: limit 500, sit with 200, lose it all, stand: balance −200, available 300', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 500, 0);
  buyIn(club, 'ann', 't1', 200, LIMITS, 1);
  play(club, 'ann', 0);
  const out = cashOut(club, 'ann', 2);
  assert.equal(repaidBy(out), 0, 'nothing to pay back with');
  assert.equal(out.balance, -200);
  assert.equal(ann(club).balance, -200);
  assert.equal(available(ann(club)), 300);
  assert.ok(totals(club).conserved);
  // A player's own copy still checks out with a negative balance.
  assert.ok(checkOwnLedger(accountBody(club, 'ann').entries, -200));
});

test('example: balance 50, sit with 200: 50 of their own, 150 on credit', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 500, 0);
  issue(club, 'ann', 50, 0);
  const e = buyIn(club, 'ann', 't1', 200, LIMITS, 1);
  assert.equal(drawnOn(e), 150);
  assert.equal(ann(club).balance, -150);
  assert.equal(available(ann(club)), 350);
});

test('a buy-in or top-up is capped at what is available; top-ups draw on credit too', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 500, 0);
  issue(club, 'ann', 100, 0);
  assert.throws(() => buyIn(club, 'ann', 't1', 700, LIMITS), e => e.short && /You have 6 available/.test(e.message));
  buyIn(club, 'ann', 't1', 50, LIMITS, 1);
  const t = topUp(club, 'ann', 300, 1000, 2);
  assert.equal(drawnOn(t), 250, '50 own left, then 250 credit');
  assert.equal(available(ann(club)), 250);
  assert.throws(() => topUp(club, 'ann', 300, 1000, 3), /You have 2\.50 available/);
  topUp(club, 'ann', 250, 1000, 3);
  assert.equal(available(ann(club)), 0);
  assert.equal(ann(club).balance, -500);
  assert.throws(() => topUp(club, 'ann', 1, 1000, 4), e => e.short);
  assert.equal(ann(club).balance, -500, 'never past the limit');
  // A top-up handed back over the table's maximum goes back against the debt.
  refundTopUp(club, 'ann', 100, 5);
  assert.equal(ann(club).balance, -400);
  assert.ok(totals(club).conserved);
});

test('an earlier debt is repaid from a later win', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 500, 0);
  buyIn(club, 'ann', 't1', 200, LIMITS, 1);
  play(club, 'ann', 0);
  cashOut(club, 'ann', 2);
  assert.equal(ann(club).balance, -200);
  // Next session: 100 more on credit, and a big win.
  const e = buyIn(club, 'ann', 't1', 100, LIMITS, 3);
  assert.equal(drawnOn(e), 100);
  play(club, 'ann', 450);
  const out = cashOut(club, 'ann', 4);
  assert.equal(repaidBy(out), 300, 'this session’s 100 and the earlier 200');
  assert.equal(ann(club).balance, 150);
  // A smaller win pays back as far as it goes.
  buyIn(club, 'ann', 't1', 400, LIMITS, 5);
  play(club, 'ann', 100);
  const short = cashOut(club, 'ann', 6);
  assert.equal(repaidBy(short), 100);
  assert.equal(short.balance, -150);
  assert.equal(ann(club).balance, -150);
  assert.ok(totals(club).conserved);
});

test('the host changes the limit: raising it, removing it, lowering it below the debt', () => {
  const club = clubWith('ann');
  assert.throws(() => setCredit(club, 'ann', -1), /whole number/);
  assert.throws(() => setCredit(club, 'ann', 1.5), /whole number/);
  assert.throws(() => setCredit(club, 'nobody', 100), /Not a member/);
  setCredit(club, 'ann', 300, 1);
  assert.equal(ann(club).credit, 300);
  assert.match(club.log.at(-1).text, /ann’s credit limit is now 3/);
  buyIn(club, 'ann', 't1', 200, LIMITS, 2);
  play(club, 'ann', 0);
  cashOut(club, 'ann', 3);
  // Lowered below what she owes: nothing available, the debt stays.
  setCredit(club, 'ann', 100, 4);
  assert.equal(available(ann(club)), 0);
  assert.equal(ann(club).balance, -200);
  assert.throws(() => buyIn(club, 'ann', 't1', 10, LIMITS), e => e.short);
  setCredit(club, 'ann', 0, 5);
  assert.equal(ann(club).credit, undefined, 'none');
  assert.deepEqual(creditRow(ann(club)), {balance: -200, credit: 0, owes: 200, available: 0, onTable: 0});
});

test('at the limit, a request may only be answered by raising the limit or no', () => {
  const club = clubWith('ann', 'bob');
  setCredit(club, 'ann', 200, 0);
  chipsForTable(club, 'ann', newTable(club, {sb: 1, bb: 2, minBB: 40, maxBB: 100}), 200, 1);
  // Nothing left: she asks the manager from the table.
  const q = requestChips(club, 'ann', 100, 'rebuy', 2, {table: 'T1'});
  assert.deepEqual(q, {amount: 100, note: 'rebuy', at: 2, table: 'T1', atLimit: true});
  assert.throws(() => grantRequest(club, 'ann', 100), /at their credit limit: raise it, or say no/);
  assert.equal(ann(club).balance, -200, 'never given chips past the limit');
  // Raising: above the current limit only.
  assert.throws(() => raiseCredit(club, 'ann', 200), /Raise the limit above 2/);
  raiseCredit(club, 'ann', 350, 3);
  assert.equal(ann(club).credit, 350);
  assert.equal(ann(club).request, null);
  assert.deepEqual(ann(club).answer, {asked: 100, given: 150, outcome: 'granted', note: '', at: 3, limit: 350});
  assert.equal(available(ann(club)), 150);
  assert.ok(topUp(club, 'ann', 100, 1000, 4), 'she adds the chips herself');
  assert.throws(() => raiseCredit(club, 'ann', 500), /no request/);
  // Or no.
  requestChips(club, 'ann', 500, '', 5);
  assert.ok(declineRequest(club, 'ann', 'not tonight', 6));
  assert.equal(ann(club).credit, 350);
  // A member without credit asks as before, and may be given chips.
  const b = requestChips(club, 'bob', 100, '', 7);
  assert.equal(b.atLimit, undefined);
  grantRequest(club, 'bob', 100, 8);
  assert.equal(club.members.bob.balance, 100);
  assert.ok(totals(club).conserved);
});

test('an agent can’t grant chips to a player of theirs at their credit limit', () => {
  const club = clubWith('agent', 'ann');
  setCredit(club, 'agent', 1000, 0);
  offerAgent(club, 'agent');
  answerAgent(club, 'agent', true);
  assignToAgent(club, 'ann', 'agent');
  setCredit(club, 'ann', 100, 0);
  requestChips(club, 'ann', 200, '', 1);
  assert.throws(() => runAgent(club, 'agent', {op: 'grant', id: 'ann'}), /at their credit limit/);
  runAgent(club, 'agent', {op: 'deny', id: 'ann'});
  assert.equal(ann(club).answer.outcome, 'declined');
});

test('paying up: the host gives what was received, with a note (#454)', () => {
  const club = clubWith('ann', 'bob');
  setCredit(club, 'ann', 500, 0);
  buyIn(club, 'ann', 't1', 300, LIMITS, 1);
  play(club, 'ann', 0);
  cashOut(club, 'ann', 2);
  assert.equal(ann(club).balance, -300);
  const e = issue(club, 'ann', 300, 3, 'cash');
  assert.deepEqual([e.kind, e.amount, e.balance, e.note], ['give', 300, 0, 'cash']);
  assert.equal(available(ann(club)), 500);
  assert.ok(totals(club).conserved);
  assert.ok(checkOwnLedger(accountBody(club, 'ann').entries, 0));
});

test('the overview: owed to the club and owed to players', () => {
  const club = clubWith('ann', 'bob', 'cy');
  setCredit(club, 'ann', 500, 0);
  setCredit(club, 'bob', 500, 0);
  issue(club, 'cy', 250, 0);
  for (const [id, lost] of [['ann', 200], ['bob', 50]]) {
    buyIn(club, id, 't1', lost, LIMITS, 1);
    play(club, id, 0);
    cashOut(club, id, 2);
  }
  issue(club, 'bob', 80, 3); // a gift clears bob's debt and leaves him 30
  const t = totals(club);
  assert.equal(t.owedToClub, 200);
  assert.equal(t.owedToPlayers, 280);
  assert.ok(t.conserved);
});

test('notifications: a player at their limit asking, and a player who stood up owing', () => {
  const club = clubWith('ann', 'bob');
  setCredit(club, 'ann', 100, 0);
  setCredit(club, 'bob', 100, 0);
  buyIn(club, 'ann', 't1', 100, LIMITS, 1);
  requestChips(club, 'ann', 50, '', 2, {table: 't1'});
  buyIn(club, 'bob', 't1', 100, LIMITS, 1);
  play(club, 'bob', 40);
  cashOut(club, 'bob', 3);
  assert.deepEqual(creditNotices(club), [
    {kind: 'left_owing', member: 'bob', name: 'bob', owes: 60, owesNow: 60, table: 't1', at: 3, n: ledgerOf(club).at(-1).n},
    {kind: 'at_limit', member: 'ann', name: 'ann', asked: 50, credit: 100, available: 0, table: 't1', at: 2},
  ]);
  issue(club, 'bob', 60, 4, 'cash');
  declineRequest(club, 'ann');
  assert.deepEqual(creditNotices(club).map(n => [n.kind, n.owesNow]), [['left_owing', 0]], 'settled: still listed, owing nothing now');
});

test('at a table: a credit buy-in, a top-up past what is available is refused, standing up repays', () => {
  const club = clubWith('ann');
  setCredit(club, 'ann', 300, 0);
  const t = newTable(club, {sb: 1, bb: 2, minBB: 40, maxBB: 100}); // 80 to 200
  assert.equal(drawnOn(chipsForTable(club, 'ann', t, 200, 1)), 200);
  assert.throws(() => chipsForTable(club, 'ann', t, 150, 2), e => e.short);
  assert.equal(drawnOn(chipsForTable(club, 'ann', t, 100, 2)), 100);
  play(club, 'ann', 360);
  const out = leftTable(club, 'ann', 360, 3);
  assert.equal(repaidBy(out), 300);
  assert.equal(ann(club).balance, 60);
  assert.ok(totals(club).conserved);
});

test('over the wire: the member hears their limit and what is available, and asks from a table', async () => {
  const host = await createIdentity(), a = await createIdentity();
  const club = newClub('Friday Game', 'ABCD-EFGH', host.id, 0);
  const verifier = new Verifier();
  const mem = newMembership({code: club.code, invite: club.invite, hostId: host.id});
  const deliver = async replies => { for (const r of replies) assert.ok(await playerReceive(mem, await signMessage(host, r.body))); };
  await deliver((await hostReceive(club, verifier, await signMessage(a, {type: 'join', club: club.code, invite: club.invite, name: 'Ann'}))).replies);
  await deliver([approve(club, a.id)]);
  setCredit(club, a.id, 200, 0);
  buyIn(club, a.id, 't1', 200, LIMITS, 1);
  const r = await hostReceive(club, verifier, await signMessage(a, {type: 'chip_request', club: club.code, amount: 100, table: 't1'}));
  await deliver(r.replies);
  assert.equal(club.members[a.id].request.atLimit, true);
  assert.equal(mem.request.table, 't1');
  const hello = await hostReceive(club, verifier, await signMessage(a, {type: 'hello', club: club.code, since: 0}));
  await deliver(hello.replies);
  assert.equal(mem.balance, -200);
  assert.equal(mem.credit, 200);
  assert.equal(mem.available, 0);
  assert.ok(mem.ledgerOk, 'a negative balance still checks out');
  // From a host without credit fields: available is the balance.
  const old = newMembership({code: 'X', hostId: host.id});
  await playerReceive(old, await signMessage(host, {type: 'account', club: 'X', balance: 50, request: null, entries: []}));
  assert.deepEqual([old.credit, old.available], [0, 50]);
});

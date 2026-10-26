// Help requests (#192).
// Run with: node --test test/club-help.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, signMessage, Verifier } from '../src/identity.js';
import { approve, hostReceive, newClub } from '../src/club.js';
import { answerHelp, askHelp, helpBody, MAX_HELP, openHelp, staffOnline } from '../src/club-help.js';
import { answerRole, offerAssistant } from '../src/club-roles.js';

function clubWith(...ids) {
  const club = newClub('Friday Game', 'ABCD-EFGH', 'HOSTHOST', 0);
  for (const id of ids) {
    club.members[id] = {id, name: id.toUpperCase(), status: 'pending', requestedAt: 0};
    approve(club, id, 0);
  }
  return club;
}

test('ask, reply, mark handled; one open request each', () => {
  const club = clubWith('p', 'a');
  assert.throws(() => askHelp(club, 'x', 'hi'), /Only members/);
  assert.throws(() => askHelp(club, 'p', '   '), /Say what/);
  const h1 = askHelp(club, 'p', 'Table 2 is   stuck', 'NLH - 1/2', 1);
  assert.equal(h1.text, 'Table 2 is stuck');
  const h2 = askHelp(club, 'p', 'Can someone top me up?', '', 2);
  assert.deepEqual(openHelp(club).map(h => h.id), [h2.id], 'a new one replaces the open one');
  // Only the host and assistants answer.
  assert.throws(() => answerHelp(club, 'p', h2.id, {reply: 'me'}), /Only the club’s managers/);
  offerAssistant(club, 'a');
  answerRole(club, 'a', true);
  answerHelp(club, 'a', h2.id, {reply: 'On it', handled: false}, 3);
  assert.equal(openHelp(club).length, 1, 'a reply alone leaves it open');
  answerHelp(club, 'HOSTHOST', h2.id, {}, 4);
  assert.equal(openHelp(club).length, 0);
  assert.deepEqual(helpBody(club, 'p', []).mine.map(h => [h.text, h.reply, h.handled, h.by]), [['Can someone top me up?', 'On it', true, 'Manager']]);
});

test('the list keeps the last MAX_HELP', () => {
  const club = clubWith(...Array.from({length: 60}, (_, i) => `m${i}`));
  for (let i = 0; i < 60; i++) askHelp(club, `m${i}`, `help ${i}`, '', i);
  assert.equal(club.help.length, MAX_HELP);
  assert.equal(club.help[0].text, 'help 10');
});

test('who’s around: the host (in their tab, or the owner online) and assistants online', () => {
  const club = clubWith('a', 'b', 'p');
  for (const id of ['a', 'b']) { offerAssistant(club, id); answerRole(club, id, true); }
  assert.deepEqual(staffOnline(club, new Set(['a', 'p'])), [{name: 'A', role: 'assistant'}]);
  assert.deepEqual(staffOnline(club, new Set(), true), [{name: 'Manager', role: 'host'}]);
  club.ownerId = 'OWNEROWN';
  assert.deepEqual(staffOnline(club, new Set(['OWNEROWN', 'b'])).map(s => s.role), ['host', 'assistant']);
});

test('a signed help_ask reaches the caller as a help request, members only', async () => {
  const club = clubWith();
  const p = await createIdentity();
  club.members[p.id] = {id: p.id, name: 'Pat', status: 'pending', requestedAt: 0};
  approve(club, p.id, 0);
  const verifier = new Verifier();
  const r = await hostReceive(club, verifier, await signMessage(p, {type: 'help_ask', club: club.code, text: 'stuck', table: 'T1'}));
  assert.deepEqual(r.help, {from: p.id, text: 'stuck', table: 'T1'});
  const q = await createIdentity();
  const r2 = await hostReceive(club, verifier, await signMessage(q, {type: 'help_ask', club: club.code, text: 'hi'}));
  assert.equal(r2.reason, 'not a member');
});

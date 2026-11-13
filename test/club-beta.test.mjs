// What the beta hides from the club manager (#560, src/club-beta.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { OFF, isOff } from '../src/club-beta.js';
import { managerPage, pageHash, pageOff, shownNav } from '../src/club-nav.js';
import { newDraft, hostTourneysHtml } from '../src/club-tourneys-ui.js';
import { structureEditor } from '../src/tourney-structure-ui.js';
import { chargeOn } from '../src/club-rake.js';

test('the unfinished features are off', () => {
  assert.deepEqual([...OFF].sort(), ['cashRake', 'demoClub', 'promos', 'services']);
});

test('Try a demo club is off, and ?on=demoClub turns it on for that page only (#636)', () => {
  assert.equal(isOff('demoClub', ''), true);
  assert.equal(isOff('demoClub', '?relay=x&on=demoClub'), false);
  assert.equal(isOff('demoClub', '?on=promos'), true);
  assert.equal(isOff('credit', ''), false);
});

test('agents, credit, Balances and tournament rake are on (#623)', () => {
  for (const f of ['agents', 'credit', 'balances', 'rake']) assert.ok(!OFF.has(f), f);
});

test('rake at cash tables stays off, unless the club already has one (#449)', () => {
  assert.equal(chargeOn({tables: []}), false);
  assert.equal(chargeOn({charge: {percent: 500, capBB: 0, timeBB: 0}, tables: []}), true);
});

test('Promotions leaves the sidebar, Balances is in it, and their addresses still parse', () => {
  const shown = shownNav().flatMap(g => g.pages.map(([id]) => id));
  assert.ok(!shown.includes('promos'));
  assert.ok(pageOff('promos'));
  assert.ok(!pageOff('settle'));
  for (const id of ['promos', 'settle']) assert.equal(managerPage(`#${pageHash(id)}`).page, id);
  assert.deepEqual(shown, ['overview', 'cash', 'tourneys', 'requests', 'members', 'players', 'settle', 'chips', 'fairplay', 'info', 'rules', 'backup', 'history']);
  assert.ok(shownNav().every(g => g.pages.length), 'no empty group');
});

const NOW = 1_000_000_000;
const wizard = d => hostTourneysHtml({members: {}, tourneys: [], payoutTables: []}, {}, {
  wizard: {step: 1, d, editor: structureEditor({stack: 10000, presets: false}), edit: null},
}, NOW);

test('the tournament wizard asks for a rake', () => {
  const d = newDraft({}, NOW);
  assert.match(wizard(d), /name="rake"/);
  assert.match(wizard({...d, rake: 200}), /name="rakePick" value="200" checked/);
});

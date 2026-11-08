// What the beta hides from the club manager (#560, src/club-beta.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { OFF } from '../src/club-beta.js';
import { managerPage, pageHash, pageOff, shownNav } from '../src/club-nav.js';
import { newDraft, hostTourneysHtml } from '../src/club-tourneys-ui.js';
import { structureEditor } from '../src/tourney-structure-ui.js';

test('the unfinished features are off', () => {
  assert.deepEqual([...OFF].sort(), ['agents', 'balances', 'credit', 'promos', 'rake', 'services']);
});

test('their pages leave the sidebar, and their addresses still parse', () => {
  const shown = shownNav().flatMap(g => g.pages.map(([id]) => id));
  for (const id of ['promos', 'settle']) {
    assert.ok(!shown.includes(id));
    assert.ok(pageOff(id));
    assert.equal(managerPage(`#${pageHash(id)}`).page, id);
  }
  assert.deepEqual(shown, ['overview', 'cash', 'tourneys', 'requests', 'members', 'chips', 'fairplay', 'info', 'rules', 'backup', 'history']);
  assert.ok(shownNav().every(g => g.pages.length), 'no empty group');
});

const NOW = 1_000_000_000;
const wizard = d => hostTourneysHtml({members: {}, tourneys: [], payoutTables: []}, {}, {
  wizard: {step: 1, d, editor: structureEditor({stack: 10000, presets: false}), edit: null},
}, NOW);

test('the tournament wizard asks for no rake, unless one is already set', () => {
  const d = newDraft({}, NOW);
  assert.doesNotMatch(wizard(d), /name="rake"/);
  assert.match(wizard({...d, rake: 200}), /name="rake"/);
});

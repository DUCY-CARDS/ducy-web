// Starting a new Bankroll Quest run by choice (#299): asked once, and the
// run you leave is saved to your records with where it ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { START_BANKROLL, newQuest, newRun, startIn } from '../src/quest.js';
import { questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);

test('the lobby offers a new run, and asks before starting it', () => {
  const q = {...startIn(newQuest(T0, 4), 'tx', 'mesquite', 'mesquite'), bankroll: 234000, best: 310000};
  assert.match(questLobbyHtml(q, T0), /data-qquit="ask"[^>]*>Start a new run</);
  const asking = questLobbyHtml(q, T0, {confirmNew: true});
  assert.match(asking, /Start over at \$1,000\?/);
  assert.match(asking, /\$2,340 now, best \$3,100/);
  assert.match(asking, /data-qnew="quit"/);
  assert.match(asking, /data-qquit="no"/);
});

test('a run left by choice is saved with where it ended; the new one starts at $1,000', () => {
  const q = {...startIn(newQuest(T0, 4), 'tx', 'mesquite', 'mesquite'), bankroll: 234000, best: 310000, reads: {x: 1}};
  const next = newRun(q, T0 + 60000, 'quit');
  assert.equal(next.bankroll, START_BANKROLL);
  assert.deepEqual(next.reads, {x: 1});
  const rec = next.runs.at(-1);
  assert.equal(rec.result, 'quit');
  assert.equal(rec.final, 234000);
  assert.equal(rec.peak, 310000);
  assert.match(questLobbyHtml(next, T0 + 60000), /Ended at \$2,340 · best \$3,100/);
});

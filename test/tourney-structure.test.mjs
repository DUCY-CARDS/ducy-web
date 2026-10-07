import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, checkStructure, durationText, estimate, presetStructure } from '../src/tourney-structure.js';
import { structureEditor } from '../src/tourney-structure-ui.js';

const sims = JSON.parse(readFileSync(new URL('./fixtures/tourney-sims.json', import.meta.url), 'utf8'));

test('every preset gives a valid structure for any starting stack: blinds always rise', () => {
  for (const p of PRESETS) {
    for (const stack of [20, 100, 1000, 1500, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 1000000]) {
      const steps = presetStructure(p.id, stack);
      assert.deepEqual(checkStructure(steps), [], `${p.id} ${stack}`);
      const levels = steps.filter(s => !s.break);
      levels.forEach((l, i) => {
        assert.ok(i === 0 || l.bb > levels[i - 1].bb, `${p.id} ${stack}: level ${i + 1} rises`);
        assert.ok(l.sb >= 1 && l.sb <= l.bb && l.ante <= l.bb);
        assert.equal(l.minutes, p.minutes);
      });
      assert.ok(levels.at(-1).bb >= stack * 4, `${p.id} ${stack}: lasts for a big field`);
      assert.ok(Math.abs(stack / levels[0].bb - 1 / p.startBB) <= 1 / p.startBB, `${p.id} ${stack}: starting depth`);
    }
  }
});

test('regular at 10,000: 100 big blinds deep, antes from level 4, a break after level 6', () => {
  const steps = presetStructure('regular', 10000);
  assert.deepEqual(steps.slice(0, 4), [
    {sb: 50, bb: 100, ante: 0, minutes: 15}, {sb: 75, bb: 150, ante: 0, minutes: 15},
    {sb: 100, bb: 200, ante: 0, minutes: 15}, {sb: 150, bb: 300, ante: 30, minutes: 15},
  ]);
  assert.deepEqual(steps[6], {break: true, minutes: 10});
});

test('checkStructure finds what makes a structure unplayable', () => {
  const ok = {sb: 50, bb: 100, ante: 0, minutes: 15};
  assert.deepEqual(checkStructure([ok]), []);
  assert.match(checkStructure([])[0], /at least one level/);
  assert.match(checkStructure([ok, {sb: 50, bb: 100, ante: 0, minutes: 15}])[0], /higher than the level before/);
  assert.match(checkStructure([{...ok, sb: 200}])[0], /small blind can’t be more/);
  assert.match(checkStructure([{...ok, ante: 150}])[0], /ante can’t be more/);
  assert.match(checkStructure([{...ok, sb: 1.5}])[0], /whole chips/);
  assert.match(checkStructure([{...ok, minutes: 0}])[0], /minutes/);
  assert.match(checkStructure([{break: true, minutes: 10}, ok])[0], /before the first level/);
  assert.match(checkStructure([ok, {break: true, minutes: 10}])[0], /end with a break/);
});

// The estimate against bot-only tournaments the engine played (#78: within
// about ±25%). The fixture comes from ducy-play's tourney_time example.
test('the estimate is within 25% of simulated bot tournaments, presets and a hand-made structure', () => {
  const off = [];
  for (const c of sims.presets) {
    const e = estimate(sims.structures[`${c.preset}-${c.stack}`], c);
    off.push([`${c.preset} ${c.stack} ${c.tableSize}-max ${c.players}p`, e.minutes / c.minutes - 1]);
  }
  const {levels, minutes, ...opts} = sims.custom;
  for (const [n, m] of Object.entries(minutes)) off.push([`custom ${n}p`, estimate(levels, {...opts, players: +n}).minutes / m - 1]);
  for (const [name, d] of off) assert.ok(Math.abs(d) <= 0.25, `${name}: ${(d * 100).toFixed(0)}% off`);
  // And well inside it on the whole.
  assert.ok(Math.max(...off.map(([, d]) => Math.abs(d))) < 0.15);
});

test('the estimate grows with the field and the structure, and counts breaks', () => {
  const regular = presetStructure('regular', 10000);
  const at = (steps, players) => estimate(steps, {stack: 10000, players}).minutes;
  assert.ok(at(regular, 9) < at(regular, 45));
  assert.ok(at(presetStructure('turbo', 10000), 27) < at(regular, 27));
  assert.ok(at(regular, 27) < at(presetStructure('deep', 10000), 27));
  const noBreaks = regular.filter(s => !s.break);
  assert.ok(at(regular, 45) > at(noBreaks, 45));
  assert.equal(estimate(regular, {stack: 10000, players: 1}).minutes, 0);
});

test('durationText rounds to 5 minutes', () => {
  assert.equal(durationText(42), 'about 40 min');
  assert.equal(durationText(2), 'about 5 min');
  assert.equal(durationText(120), 'about 2 h');
  assert.equal(durationText(203), 'about 3 h 25 min');
});

test('the editor: presets, edits, adding and removing levels, and the estimate updating', () => {
  const changes = [];
  const ed = structureEditor({stack: 10000, onChange: s => changes.push(s.length)});
  const click = attrs => ed.click({target: {closest: () => ({dataset: attrs})}});
  const edit = (i, k, value) => ed.input({target: {closest: () => ({dataset: {tsI: String(i), tsK: k}, value})}});
  const estimates = () => [...ed.html().matchAll(/<td>(about [^<]+)<\/td>/g)].map(m => m[1]);

  assert.match(ed.html(), /data-preset="regular">Regular/);
  assert.equal(estimates().length, 5);
  const regular = estimates();

  assert.ok(click({ts: 'preset', preset: 'turbo'}));
  assert.deepEqual(ed.steps(), presetStructure('turbo', 10000));
  assert.notDeepEqual(estimates(), regular, 'the estimate follows the structure');

  // A bad edit shows what's wrong instead of an estimate.
  assert.ok(edit(1, 'bb', '100'));
  assert.match(ed.html(), /higher than the level before/);
  assert.equal(estimates().length, 0);
  assert.ok(edit(1, 'bb', '300'));
  assert.deepEqual(ed.errors(), []);

  const n = ed.steps().length;
  assert.ok(click({ts: 'add-level'}));
  const [prev, last] = ed.steps().filter(s => !s.break).slice(-2);
  assert.ok(last.bb > prev.bb);
  assert.ok(click({ts: 'add-break'}));
  assert.match(ed.errors()[0], /end with a break/);
  assert.ok(click({ts: 'remove', i: String(n + 1)}));
  assert.equal(ed.steps().length, n + 1);
  assert.deepEqual(ed.errors(), []);

  // A new starting stack re-makes a chosen preset, but not an edited structure.
  const edited = ed.steps();
  ed.setStack(20000);
  assert.deepEqual(ed.steps(), edited);
  click({ts: 'preset', preset: 'deep'});
  ed.setStack(20000);
  assert.deepEqual(ed.steps(), presetStructure('deep', 20000));
  assert.ok(changes.length >= 8);
});

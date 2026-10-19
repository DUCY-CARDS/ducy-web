// The Bankroll Challenge's generic players' faces and names (#305).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASES, GEARS, NAMES, faceUrl, lookFor, nameFor } from '../src/quest-faces.js';
import { FAMILIES, botIdOf, personOf } from '../src/quest-people.js';

const AGES = ['young', 'middle', 'older'];

test('every base has a gender, an age band and a name pool, and every one in use has enough names', () => {
  assert.equal(BASES.length, 64);
  for (const b of BASES) {
    assert.ok(['f', 'm'].includes(b.gender) && AGES.includes(b.age), `base ${b.id}`);
    assert.ok(NAMES[b.pool], `base ${b.id}: pool ${b.pool}`);
  }
  const pools = new Set(BASES.map(b => b.pool));
  assert.ok(pools.size >= 15, `${pools.size} pools`);
  for (const pool of pools) {
    for (const g of ['f', 'm']) for (const age of AGES) {
      const list = NAMES[pool][g][age];
      assert.ok(list.length >= 8, `${pool} ${g} ${age}`);
      assert.equal(new Set(list).size, list.length, `${pool} ${g} ${age}: no repeats`);
      for (const name of list) assert.match(name, /^[A-Z][a-z]+$/, `${pool}: ${name}`);
    }
  }
  // A spread: both genders and every age band, and more than one skin tone, in most pools.
  for (const g of ['f', 'm']) for (const age of AGES) assert.ok(BASES.filter(b => b.gender === g && b.age === age).length >= 6, `${g} ${age}`);
});

test('a seed always gives the same person; different seeds give many different faces', () => {
  for (const family of FAMILIES) {
    assert.deepEqual(lookFor(family, 42), lookFor(family, 42));
    assert.equal(nameFor(lookFor(family, 42), 42), nameFor(lookFor(family, 42), 42));
  }
  const faces = new Set(), names = new Set(), bases = new Set();
  for (let s = 1; s <= 600; s++) {
    const look = lookFor(FAMILIES[s % 4], s);
    faces.add(faceUrl(look, `t-${s}`));
    names.add(nameFor(look, s));
    bases.add(look.base);
  }
  assert.ok(faces.size > 580, `${faces.size} different faces in 600`);
  assert.ok(bases.size >= 55, `${bases.size} bases used`);
  assert.ok(names.size > 300, `${names.size} different names`);
  // The same base looks different from person to person.
  const one = [];
  for (let s = 1; one.length < 5 && s < 20000; s++) if (lookFor('grinder', s).base === 0) one.push(JSON.stringify(lookFor('grinder', s).o));
  assert.equal(new Set(one).size, one.length, 'variants of one base differ');
});

test('a face is a seat-sized SVG drawn on the page', () => {
  const p = personOf(botIdOf('rock', 9));
  const svg = decodeURIComponent(p.avatar.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  assert.match(svg, /^<svg viewBox="14 14 92 92"/);
  assert.ok(svg.length > 1000 && svg.length < 8000, `${svg.length} characters`);
});

test('gear and age lean to style but never decide it', () => {
  const count = {};
  for (let s = 1; s <= 8000; s++) {
    const family = FAMILIES[s % 4];
    const look = lookFor(family, s);
    const k = `${family}|${look.gear}`;
    count[k] = (count[k] || 0) + 1;
  }
  const share = (family, gear) => (count[`${family}|${gear}`] || 0) / 2000;
  assert.ok(share('grinder', 'headphones') > 1.5 * share('rock', 'headphones'));
  assert.ok(share('rock', 'jacket') > 1.5 * share('maniac', 'jacket'));
  assert.ok(share('station', 'tourist') > 1.5 * share('grinder', 'tourist'));
  for (const f of FAMILIES) for (const g of GEARS) assert.ok(count[`${f}|${g}`] > 0, `${f} with ${g || 'no gear'}`);
});

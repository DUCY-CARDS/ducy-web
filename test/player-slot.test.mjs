// Player slots on staging (#671, src/player-slot.js): which hosts may have
// them (never the live sites), how a window picks its slot, each slot's
// storage names, and links to the other staging site keeping the slot.
// Run with: node --test test/player-slot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SLOT, isStaging, nextSlot, parseSlot, pickSlot, setCurrentSlot, slotDbSuffix, slotList, slotPrefix, slotUrl, slotsAllowed, withSlot } from '../src/player-slot.js';
import { clubUrl, playerUrl } from '../src/sites.js';

const LIVE = ['ducy.cards', 'www.ducy.cards', 'club.ducy.cards', 'admin.ducy.cards', 'sandbox.ducy.cards', 'club-sandbox.ducy.cards', 'admin-staging.ducy.cards', 'staging.ducy.cards.evil.example', 'evil.example'];

test('only staging and local pages have slots; the live sites never do', () => {
  for (const h of ['staging.ducy.cards', 'club-staging.ducy.cards', 'localhost', '127.0.0.1']) assert.equal(slotsAllowed(h), true, h);
  for (const h of LIVE) {
    assert.equal(slotsAllowed(h), false, h);
    for (const search of ['?player=2', '?player=7&club=X', '']) {
      assert.deepEqual(pickSlot({host: h, search, saved: '3'}), {slot: 1, chosen: false}, `${h} ${search}`);
    }
  }
  assert.equal(isStaging('staging.ducy.cards'), true);
  assert.equal(isStaging('club-staging.ducy.cards'), true);
  assert.equal(isStaging('localhost'), false);
  assert.equal(isStaging('ducy.cards'), false);
});

test('a window’s slot: the address first, then the window’s own, else slot 1', () => {
  const host = 'staging.ducy.cards';
  assert.deepEqual(pickSlot({host}), {slot: 1, chosen: false});
  assert.deepEqual(pickSlot({host, search: '?player=3'}), {slot: 3, chosen: true});
  assert.deepEqual(pickSlot({host, saved: '4'}), {slot: 4, chosen: true});
  // A new window that inherited another slot's copy: the address wins.
  assert.deepEqual(pickSlot({host, search: '?player=2', saved: '5'}), {slot: 2, chosen: true});
  assert.deepEqual(pickSlot({host, search: '?player=1', saved: '5'}), {slot: 1, chosen: true});
  // Nonsense is ignored.
  for (const bad of ['0', '-1', '2.5', 'x', '', ' ', String(MAX_SLOT + 1), '007']) {
    assert.equal(parseSlot(bad), null, bad);
    assert.deepEqual(pickSlot({host, search: `?player=${encodeURIComponent(bad)}`, saved: '2'}), {slot: 2, chosen: true}, bad);
  }
  assert.equal(parseSlot(MAX_SLOT), MAX_SLOT);
  assert.equal(parseSlot(' 3 '), 3);
});

test('slot 1 keeps the normal storage; the others are named apart from profiles and demos', () => {
  assert.equal(slotPrefix(1), '');
  assert.equal(slotDbSuffix(1), '');
  assert.equal(slotPrefix(2), 'slot#2:');
  assert.equal(slotDbSuffix(2), '#slot2');
  assert.notEqual(slotPrefix(2), slotPrefix(12));
  // profile.js names are letters, digits, _ and -; demos' start ducyDemo: / @demo-.
  assert.doesNotMatch(slotPrefix(3), /^[a-z0-9_-]+:$/i);
  assert.doesNotMatch(slotDbSuffix(3), /^@/);
});

test('the slots in use, and the next one', () => {
  assert.deepEqual(slotList(null), [1]);
  assert.deepEqual(slotList('not json'), [1]);
  assert.deepEqual(slotList('{"a":1}'), [1]);
  assert.deepEqual(slotList('[3, 2, 3, "x", 99]'), [1, 2, 3]);
  assert.equal(nextSlot([1]), 2);
  assert.equal(nextSlot([1, 2, 4]), 3);
  const all = Array.from({length: MAX_SLOT}, (_, i) => i + 1);
  assert.equal(nextSlot(all), null);
});

test('a slot’s address, and links to the other staging site keep the slot', () => {
  assert.equal(slotUrl('https://staging.ducy.cards/?club=X&relay=y#clubs', 3), 'https://staging.ducy.cards/?player=3#clubs');
  assert.equal(slotUrl('https://club-staging.ducy.cards/', 1), 'https://club-staging.ducy.cards/?player=1');
  assert.equal(withSlot('https://club-staging.ducy.cards/#clubs/own', 1), 'https://club-staging.ducy.cards/#clubs/own');
  assert.equal(withSlot('https://club-staging.ducy.cards/#clubs/own', 2), 'https://club-staging.ducy.cards/?player=2#clubs/own');
  assert.equal(withSlot('https://staging.ducy.cards/', 4), 'https://staging.ducy.cards/?player=4');
  assert.equal(withSlot('https://staging.ducy.cards/?a=1#x', 4), 'https://staging.ducy.cards/?a=1&player=4#x');
  assert.equal(withSlot('./#clubs', 4), './#clubs');
  assert.equal(withSlot('manage.html#clubs', 4), 'manage.html#clubs');

  const at = href => { const u = new URL(href); return {hostname: u.hostname, hash: u.hash}; };
  try {
    setCurrentSlot(3);
    assert.equal(clubUrl('clubs/own', at('https://staging.ducy.cards/')), 'https://club-staging.ducy.cards/?player=3#clubs/own');
    assert.equal(playerUrl('clubs', at('https://club-staging.ducy.cards/')), 'https://staging.ducy.cards/?player=3#clubs');
    // Same-site links stay as they were (the window keeps its slot).
    assert.equal(clubUrl('clubs', at('https://club-staging.ducy.cards/')), './#clubs');
    assert.equal(playerUrl('play', at('https://staging.ducy.cards/')), './#play');
  } finally {
    setCurrentSlot(1);
  }
  assert.equal(clubUrl('clubs/own', at('https://staging.ducy.cards/')), 'https://club-staging.ducy.cards/#clubs/own');
});

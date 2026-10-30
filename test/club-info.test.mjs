// Club info (#398, src/club-info.js): the sections as kept, what changed,
// the next event, safe formatting, and About on the invite screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { changedSince, cleanInfo, formatInfo, infoBody, isEmpty, MAX_EVENTS, MAX_INFO_TEXT, nextEvent } from '../src/club-info.js';
import { codeInfo } from '../relay/src/club-room.js';

const T = 1_800_000_000_000;

test('club info is trimmed and checked, and says when each part changed', () => {
  const a = cleanInfo({about: '  Friday   nights\r\n\r\n\r\n\r\nat Sam’s  ', rules: 'x'.repeat(MAX_INFO_TEXT + 50), events: [{at: T + 2, text: 'Second'}, {at: T + 1, text: ' First\nline '}, {at: 'soon', text: 'Bad'}, {at: T, text: ''}], extra: '<script>'}, null, T);
  assert.equal(a.about, 'Friday nights\n\nat Sam’s');
  assert.equal(a.rules.length, MAX_INFO_TEXT);
  assert.deepEqual(a.events, [{at: T + 1, text: 'First line'}, {at: T + 2, text: 'Second'}]);
  assert.equal(a.extra, undefined);
  assert.deepEqual(a.at, {about: T, events: T, rules: T});
  // Saving again: only what changed gets a new time.
  const b = cleanInfo({...a, rules: 'No phones at the table'}, a, T + 100);
  assert.deepEqual(b.at, {about: T, events: T, rules: T + 100});
  assert.equal(cleanInfo({events: Array.from({length: 30}, (_, i) => ({at: T + i, text: `E${i}`}))}).events.length, MAX_EVENTS);
  assert.ok(isEmpty(cleanInfo({})) && !isEmpty(a));
  assert.deepEqual(infoBody({code: 'C', info: a}), {type: 'info', club: 'C', info: a});
});

test('members see what changed since they last looked, and the next event', () => {
  const info = cleanInfo({about: 'A', chips: 'Ask Sam', rules: 'R', events: [{at: T - 10, text: 'Gone'}, {at: T + 10, text: 'Turbo'}]}, null, T);
  assert.deepEqual(changedSince(info, {}), ['about', 'events', 'chips', 'rules']);
  const later = cleanInfo({...info, rules: 'New rules'}, info, T + 50);
  assert.deepEqual(changedSince(later, {about: T, events: T, chips: T, rules: T}), ['rules']);
  // Emptied: nothing to point at.
  assert.deepEqual(changedSince(cleanInfo({...info, rules: ''}, info, T + 60), {about: T, events: T, chips: T}), []);
  assert.deepEqual(nextEvent(info, T), {at: T + 10, text: 'Turbo'});
  assert.equal(nextEvent(info, T + 11), null);
});

test('formatting: paragraphs, lists, bold and links, and nothing else', () => {
  assert.equal(formatInfo('Hi **all**\nsecond line\n\n- one\n- [Map](https://maps.example/x?a=1&b=2)'),
    '<p>Hi <b>all</b><br>second line</p><ul><li>one</li><li><a href="https://maps.example/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">Map</a></li></ul>');
  assert.equal(formatInfo('See https://ducy.cards/rules.'), '<p>See <a href="https://ducy.cards/rules" target="_blank" rel="noopener noreferrer nofollow">https://ducy.cards/rules</a>.</p>');
  // Safe: markup is text, only http(s) links, and quotes can't leave the href.
  for (const bad of ['<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '<script>alert(1)</script>', 'https://x.example/"onmouseover="alert(1)', '[a](https://x.example/"><script>)']) {
    const h = formatInfo(bad);
    assert.doesNotMatch(h, /<(?!\/?(p|b|br|ul|li|a)\b)/, bad);
    assert.doesNotMatch(h, /href="(?!https?:\/\/)/, bad);
    assert.doesNotMatch(h, /href="[^"]*"[^>]*\son\w+=/i, bad);
  }
  assert.equal(formatInfo(''), '');
});

test('About the club shows on the invite screen, only with the club’s (or an agent’s) invite', () => {
  const club = {name: 'Riverside', hostId: 'H', invite: 'INV', codeJoin: false, info: {about: 'Friday nights'}, members: {a: {agent: 'yes', agentInvite: 'AG'}}};
  assert.deepEqual(codeInfo(club), {kind: 'club', ask: false});
  assert.deepEqual(codeInfo(club, 'wrong'), {kind: 'club', ask: false});
  assert.deepEqual(codeInfo(club, 'INV'), {kind: 'club', ask: false, about: 'Friday nights'});
  assert.deepEqual(codeInfo(club, 'AG'), {kind: 'club', ask: false, about: 'Friday nights'});
  assert.deepEqual(codeInfo({...club, codeJoin: true}, 'INV'), {kind: 'club', ask: true, name: 'Riverside', hostId: 'H', about: 'Friday nights'});
});

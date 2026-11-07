// Error reports (#552): what a page sends has nothing about anyone in it, and
// the registry keeps a bounded list of what went wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { browserOf, buildOf, cleanStack, cleanText, pageOf, reportOf } from '../src/error-report.js';
import { MAX_ERRORS, addReport, cleanReport, reportLimiter } from '../relay/src/error-log.js';
import { limitsFrom, registry } from '../relay/src/registry.js';

const mem = () => {
  const m = new Map();
  return {get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }};
};

test('player IDs, keys and addresses are taken out of the text', () => {
  assert.equal(cleanText('No member Ab3dEf7hIj9lMn1pQr3tUv5x here'), 'No member [id] here');
  assert.equal(cleanText('failed at https://ducy.cards/v/abc123/src/play.js?x=secret:10:5 now'), 'failed at play.js:10:5 now');
  assert.equal(cleanText('https://ducy.cards/?invite=ABCD#clubs/member/x'), 'address');
  assert.equal(cleanText('a b '.repeat(200)).length, 300);
});

test('a stack keeps its file names and lines, and its top only', () => {
  const stack = ['Error: boom', ...Array.from({length: 20}, (_, i) => `    at f${i} (https://ducy.cards/v/1a2b3c4d/src/clubs.js:${i + 1}:7)`)].join('\n');
  const out = cleanStack(stack).split('\n');
  assert.equal(out.length, 8);
  assert.equal(out[1], 'at f0 (clubs.js:1:7)');
});

test('the page is the hash’s first word only', () => {
  assert.equal(pageOf('#clubs/member/abc?show=owes'), 'clubs');
  assert.equal(pageOf('#g=nlhe&p0=As.Kd'), 'g');
  assert.equal(pageOf(''), 'home');
});

test('the version comes from the script’s address', () => {
  assert.equal(buildOf('https://ducy.cards/v/1a2b3c4d/src/error-report.js'), '1a2b3c4d');
  assert.equal(buildOf('http://localhost:8000/src/error-report.js'), 'dev');
});

test('the browser is its name, major version and kind of device', () => {
  assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'), 'Safari 17, iOS');
  assert.equal(browserOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'), 'Chrome 130, Android');
  assert.equal(browserOf(''), 'Other, other');
});

test('a report holds only what it should; browser noise isn’t one', () => {
  const r = reportOf(new Error('boom'), {where: 'play-worker', hash: '#clubs/member/x', build: 'abc', ua: 'Firefox/120.0 Windows'});
  assert.deepEqual(Object.keys(r).sort(), ['build', 'message', 'page', 'stack', 'ua', 'where']);
  assert.equal(r.message, 'boom');
  assert.equal(r.page, 'clubs');
  assert.equal(r.ua, 'Firefox 120, Windows');
  assert.equal(reportOf('Script error.'), null);
  assert.equal(reportOf(''), null);
  // A worker's error event has no stack, only where it happened.
  assert.equal(reportOf({message: 'bad', filename: 'https://ducy.cards/v/1/src/play-worker.js', lineno: 4, colno: 2}).stack, 'at play-worker.js:4:2');
});

test('the relay keeps only known fields, cut to size', () => {
  assert.equal(cleanReport(null), null);
  assert.equal(cleanReport({stack: 'no message'}), null);
  const r = cleanReport({message: 'x'.repeat(1000), stack: 7, cards: 'As Kd', id: 'someone'});
  assert.equal(r.message.length, 300);
  assert.equal(r.stack, '');
  assert.deepEqual(Object.keys(r), ['message', 'stack', 'where', 'page', 'build', 'ua']);
});

test('the same error counts up; the list stays bounded, dropping the stalest', () => {
  const all = {};
  const report = message => cleanReport({message, stack: 'at a.js:1:1'});
  addReport(all, report('a'), 1);
  addReport(all, report('a'), 5);
  assert.deepEqual(Object.values(all).map(r => [r.message, r.count, r.first, r.last]), [['a', 2, 1, 5]]);
  for (let i = 0; i < MAX_ERRORS; i++) addReport(all, report(`e${i}`), 10 + i);
  assert.equal(Object.keys(all).length, MAX_ERRORS);
  assert.ok(!Object.values(all).some(r => r.message === 'a'), 'the one seen longest ago went');
});

test('at most so many reports a minute are kept', () => {
  const take = reportLimiter(2);
  assert.deepEqual([take(0), take(1), take(2)], [true, true, false]);
  assert.equal(take(60_000), true);
});

test('the registry keeps reports for the admin, newest first, and ignores junk', async () => {
  const reg = registry(mem(), limitsFrom({}));
  await reg.report({message: 'old', stack: ''}, 1000);
  await reg.report({message: 'new', stack: ''}, 2000);
  await reg.report({nothing: true}, 3000);
  assert.deepEqual((await reg.errors()).map(e => e.message), ['new', 'old']);
});

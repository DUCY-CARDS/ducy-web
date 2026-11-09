// The admin site's Fair play (#612): each club's run summarised for ducy's
// admin (relay/src/fair-play-admin.js), kept by the registry with weekly
// summaries for 90 days, read through the signed /admin/fair-play routes,
// and shown as sortable tables (src/admin-fair-play.js). Never a card.
// Run with: node --test test/fair-play-admin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { createIdentity, signMessage } from '../src/identity.js';
import { adminApi, adminsFrom } from '../relay/src/admin.js';
import { collusionReport, strengthOf } from '../relay/src/collusion.js';
import { assistReport, LIMITS as A } from '../relay/src/assist.js';
import { fairPlayReport, fairPlayRun } from '../relay/src/fair-play.js';
import { adminSummary, fairPlayStore, fitSummary, KEEP_DAYS, seatCounts, THRESHOLDS, weekOf } from '../relay/src/fair-play-admin.js';
import { keepFullHand } from '../relay/src/hand-records.js';
import { averageRows, fairHtml, flagRows, historyHtml, nextSort, numbers, pairRows, playerRows, sortRows, strength } from '../src/admin-fair-play.js';
import { makePlayer, playWeek, random } from './assist-sim.mjs';

const NAMES = ['Ava', 'Bo', 'Cy', 'Dee', 'Eli', 'Flo'];
const mem = () => {
  const m = new Map();
  return {m, get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
};
// A made-up week: Ava plays as `spec`, the rest as honest players.
function week(spec, seed, hands = 800) {
  const R = random(seed);
  const specs = [spec, ...['strong', 'average', 'average', 'weak', 'elite'].map(skill => ({type: 'human', skill}))];
  return playWeek({players: specs.map(s => makePlayer(R, s)), hands, seed: seed + 1, names: NAMES});
}
const CARD = /"[2-9TJQKA][shdc]"/;

let cached = null;
async function run() {
  if (cached) return cached;
  const storage = mem();
  const recs = week({type: 'solver', mode: 'sample'}, 41);
  // Seat flags as the room keeps them: Bo behind a VPN for a while.
  recs.forEach((r, i) => { if (i % 4 === 0) r.prox = [{kind: 'vpn', ids: ['id-Bo']}, {kind: 'near', ids: ['id-Cy', 'id-Dee']}]; });
  const now = recs[recs.length - 1].at + 1000;
  for (const rec of recs) await keepFullHand(storage, rec, {days: 7}, now);
  cached = {recs, now, ...(await fairPlayRun(storage, {now, days: 7})), storage};
  return cached;
}

test('one run: the owner’s report as before, and the admin’s summary beside it', async () => {
  const {report, summary, storage, now} = await run();
  assert.deepEqual(await fairPlayReport(storage, {now, days: 7}), report);
  assert.ok(!('pairStats' in report) && !('stats' in report));
  assert.deepEqual(report.flagged.find(e => e.ids.length === 1 && e.ids[0] === 'id-Ava')?.ids, ['id-Ava']);
  assert.equal(summary.hands, report.hands);
  assert.deepEqual(summary.flags, report.flagged);
});

test('every player’s numbers, flagged or not, with the club’s averages', async () => {
  const {summary} = await run();
  assert.deepEqual(summary.players.map(p => p.id).sort(), NAMES.map(n => `id-${n}`).sort());
  const ava = summary.players.find(p => p.id === 'id-Ava');
  assert.ok(ava.flags.includes('gto-top'));
  for (const p of summary.players) {
    assert.ok(p.hands > 0 && p.a.n > 0, p.id);
    for (const k of ['n', 'top', 'exp', 'off', 'clear', 'hard', 'median', 'spread', 'away', 'awayKnown']) assert.ok(k in p.a, `${p.id} ${k}`);
    assert.ok(p.a.top <= p.a.n && p.a.exp <= p.a.n);
  }
  // Honest players under the line still show their numbers.
  assert.ok(summary.players.some(p => !p.flags.length && p.a.n >= A.MIN_BASELINE));
  const club = summary.club.assist;
  assert.ok(club.players >= 5 && club.n > 0 && club.top > 0 && club.exp > 0);
  assert.ok(club.pace > 0 && club.even > 0);
  // Ava matches the model more than the club does.
  assert.ok(ava.a.top / ava.a.n > club.top / club.n);
  // Seat flags counted per player, and per pair.
  assert.equal(summary.players.find(p => p.id === 'id-Bo').p.vpn, 200);
  assert.equal(summary.players.find(p => p.id === 'id-Ava').p.vpn, 0);
  assert.equal(summary.club.p.vpn, 200);
  assert.equal(summary.pairs.find(p => p.ids.join() === 'id-Cy,id-Dee').near, 200);
});

test('every pair’s numbers: hands together, each comparison and its strength, the club’s rates', async () => {
  const {summary} = await run();
  assert.equal(summary.pairs.length, 15);
  for (const p of summary.pairs) {
    assert.ok(p.shared > 0 && Number.isFinite(p.flow) && Number.isFinite(p.bb));
    for (const t of p.tests) {
      assert.ok(p.ids.includes(t.who) && typeof t.flagged === 'boolean');
      if (t.with && t.elsewhere) assert.equal(t.x, strengthOf(t));
    }
  }
  // The made-up week is preflop only: no heads-up play after the flop.
  const kinds = new Set(summary.pairs.flatMap(p => p.tests.map(t => t.kind)));
  for (const k of ['enters', 'folds', 'chips', 'contest']) assert.ok(kinds.has(k), k);
  assert.ok(summary.pairs.every(p => p.tests.filter(t => t.kind !== 'chips').every(t => t.x > 0)));
  for (const k of ['raises', 'enters', 'folds', 'checks', 'dumps', 'partner']) assert.ok(summary.club.pairs[k] && 'n' in summary.club.pairs[k], k);
});

test('no card, folded card, seed or chart cell leaves in the summary', async () => {
  const {summary, recs} = await run();
  const json = JSON.stringify(summary);
  assert.doesNotMatch(json, CARD);
  assert.doesNotMatch(json, /"(cards|cls|cells|probs|seed|deal|conn)"/);
  for (const r of recs.slice(0, 50)) for (const s of r.seats) for (const c of s.cards) assert.ok(!json.includes(`"${c}"`));
});

test('strength: how far the odds lean the suspicious way', () => {
  // Folding to them: 30 of 40 against 20 of 80 elsewhere.
  const folds = {kind: 'folds', with: {k: 30, n: 40}, elsewhere: {k: 20, n: 80}};
  assert.ok(strengthOf(folds) > 4);
  // Betting against them less: the same numbers mean the inverse.
  assert.ok(strengthOf({...folds, kind: 'raises', with: {k: 2, n: 40}, elsewhere: {k: 40, n: 80}}) > 4);
  assert.equal(strengthOf({kind: 'chips', bb: 1200}), null);
  assert.equal(strengthOf({kind: 'contest', with: {k: 0, n: 300}, expected: 10}), 21);
  // The page's own number is the relay's.
  assert.equal(strength(folds).value, strengthOf(folds));
  assert.equal(strength({kind: 'chips', bb: -1234, chips: -2468}).text, '1,234 bb');
  assert.equal(strength({kind: 'vpn', with: {k: 5, n: 20}}).text, '25.0%');
  assert.equal(strength({kind: 'gto-pace', clear: 4, hard: 4.4}).value, 1.1);
  assert.equal(numbers(folds), '30/40 vs 20/80');
  assert.equal(numbers({kind: 'gto-top', with: {k: 560, n: 620}, solver: 0.88, club: 0.58}), '560/620 · model 88.0% · club 58.0%');
  assert.equal(numbers({kind: 'fake', with: {k: 3, n: 9}, why: ['jump']}), '3/9 hands · jump');
});

test('seat counts: each one-player flag once per hand', () => {
  const recs = [
    {seats: [{id: 'a', name: 'Ann'}, {id: 'b'}], prox: [{kind: 'vpn', ids: ['a']}, {kind: 'vpn', ids: ['a']}, {kind: 'hidden', ids: ['b']}, {kind: 'near', ids: ['a', 'b']}]},
    {seats: [{id: 'a'}], prox: [{kind: 'relay', ids: ['a']}, {kind: 'fake', ids: ['z']}]},
  ];
  assert.deepEqual(seatCounts(recs), {
    a: {name: 'Ann', hands: 2, vpn: 1, relay: 1, fake: 0, hidden: 0},
    b: {name: '', hands: 1, vpn: 0, relay: 0, fake: 0, hidden: 1},
  });
});

test('a summary is cut to fit a stored value', async () => {
  const {summary} = await run();
  const big = {...summary, pairs: Array.from({length: 400}, (_, i) => ({...summary.pairs[0], ids: [`a${i}`, `b${i}`]}))};
  const cut = fitSummary(big, 60_000);
  assert.ok(JSON.stringify(cut).length <= 60_000);
  assert.ok(cut.players.length === summary.players.length && cut.pairs.length < 400);
  assert.equal(JSON.stringify(fitSummary(summary)).length, JSON.stringify(summary).length, 'a small one is kept whole');
});

test('weeks start on Monday, UTC', () => {
  assert.equal(weekOf(Date.UTC(2026, 10, 9, 12)), '2026-11-09'); // a Monday
  assert.equal(weekOf(Date.UTC(2026, 10, 15, 23, 59)), '2026-11-09'); // Sunday
  assert.equal(weekOf(Date.UTC(2026, 10, 16)), '2026-11-16');
});

test('the registry keeps the latest per club, and each player’s weeks for 90 days', async () => {
  const s = mem();
  const fp = fairPlayStore(s);
  const day = 864e5, t0 = Date.UTC(2026, 7, 3, 12); // a Monday
  const sum = (at, top) => ({at, hands: 10, flags: [], pairs: [], club: {}, players: [{id: 'p1', name: 'Ann', hands: 10, flags: top > 300 ? ['gto-top'] : [], a: {n: 400, top, exp: 300, off: 1}, p: {vpn: 0, relay: 0, fake: 0, hidden: 0}}]});
  // Two runs in one week: the later one is that week's.
  await fp.note('AAAA-BBBB', sum(t0, 250), t0);
  await fp.note('AAAA-BBBB', sum(t0 + 2 * day, 260), t0 + 2 * day);
  await fp.note('CCCC-DDDD', sum(t0 + 8 * day, 320), t0 + 8 * day);
  let h = await fp.history('p1', t0 + 8 * day);
  assert.deepEqual(h.map(w => [w.week, w.code, w.a.top]), [['2026-08-10', 'CCCC-DDDD', 320], ['2026-08-03', 'AAAA-BBBB', 260]]);
  assert.deepEqual((await fp.history('nobody', t0)), []);
  assert.deepEqual((await fp.list()).map(c => [c.code, c.players[0].a.top]), [['CCCC-DDDD', 320], ['AAAA-BBBB', 260]]);
  // A deleted club's latest goes; its weeks age out.
  await fp.drop('AAAA-BBBB');
  assert.deepEqual((await fp.list()).map(c => c.code), ['CCCC-DDDD']);
  assert.equal((await fp.history('p1', t0 + 8 * day)).length, 2);
  h = await fp.history('p1', t0 + (KEEP_DAYS + 7) * day);
  assert.deepEqual(h.map(w => w.code), ['CCCC-DDDD']);
  assert.equal(s.m.has('fpw:AAAA-BBBB:2026-08-03'), false);
  assert.equal('AAAA-BBBB' in (await s.get('fpIndex')), false);
  h = await fp.history('p1', t0 + (KEEP_DAYS + 20) * day);
  assert.deepEqual(h, []);
  assert.deepEqual((await fp.list()).map(c => c.code), ['CCCC-DDDD'], 'the latest stays while the club does');
});

test('/admin/fair-play: signed, every club’s summary with its name; history by player', async () => {
  const ann = await createIdentity(), eve = await createIdentity();
  const admins = adminsFrom([{id: ann.id, pub: ann.pub, name: 'Ann'}]);
  const fp = fairPlayStore(mem());
  // As a run today makes it.
  const summary = {...(await run()).summary, at: Date.now()};
  await fp.note('AAAA-BBBB', summary);
  await fp.note('GONE-GONE', summary);
  const ops = {
    seen: async () => {}, log: async () => {},
    list: async () => ({clubs: [{code: 'AAAA-BBBB', name: 'Owls'}], grants: {}, trials: {}}),
    fairPlay: () => fp.list(), fairPlayHistory: id => fp.history(id),
  };
  const ask = async (who, path, data) => { const env = await signMessage(who, {type: 'admin', path, data}); return adminApi(path, env, admins, ops, env.seq); };
  const r = await ask(ann, '/admin/fair-play', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clubs.map(c => [c.code, c.name]), [['AAAA-BBBB', 'Owls']]);
  assert.deepEqual(r.body.limits, THRESHOLDS);
  assert.doesNotMatch(JSON.stringify(r.body), CARD);
  const h = await ask(ann, '/admin/fair-play/history', {id: 'id-Ava'});
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.weeks.map(w => [w.code, w.club, w.name]), [['AAAA-BBBB', 'Owls', 'Ava'], ['GONE-GONE', '', 'Ava']]);
  assert.equal((await ask(ann, '/admin/fair-play/history', {id: '../x'})).status, 400);
  assert.equal((await ask(eve, '/admin/fair-play', {})).status, 403);
  assert.equal((await adminApi('/admin/fair-play', null, admins, ops)).status, 400);
  const env = await signMessage(ann, {type: 'admin', path: '/admin/clubs', data: {}});
  assert.equal((await adminApi('/admin/fair-play', env, admins, ops, env.seq)).status, 401, 'signed for another path');
});

test('the page: flags, players, pairs and averages, each sortable, names escaped', async () => {
  const {summary} = await run();
  const evil = {...summary, players: summary.players.map(p => (p.id === 'id-Bo' ? {...p, name: '<img src=x>'} : p))};
  const x = {clubs: [{...evil, code: 'AAAA-BBBB', name: 'Owls <b>'}], limits: THRESHOLDS};
  const flags = flagRows(x.clubs);
  assert.ok(flags.length && flags.every(f => f.club === 'Owls <b>' && f.signal && f.strength.text && f.numbers));
  assert.ok(flags.some(f => f.kind === 'gto-top' && f.players === 'Ava'));
  const players = playerRows(x.clubs);
  assert.equal(players.length, 6);
  const ava = players.find(p => p.id === 'id-Ava');
  assert.ok(ava.top > ava.model - THRESHOLDS.topSlack && ava.decisions >= THRESHOLDS.minDecisions);
  const [avg] = averageRows(x.clubs);
  assert.ok(avg.top > 0 && avg.model > 0 && avg.pace > 0 && avg.vpn > 0);
  const pairs = pairRows(x.clubs);
  assert.equal(pairs.length, 15);
  assert.ok(pairs.some(p => p.enters?.x > 0 && p.enters.title.includes(' vs ')));
  assert.ok(pairs.every(p => p.raises === null && p.contest?.title.includes('expected')));
  assert.equal(pairs.find(p => p.ids.join() === 'id-Cy,id-Dee').near, 200);

  const html = fairHtml(x, {});
  assert.doesNotMatch(html, /<img src=x>|Owls <b>/);
  assert.match(html, /&lt;img src=x&gt;/);
  for (const t of ['flags', 'players', 'averages', 'pairs', 'rates']) assert.match(html, new RegExp(`data-table="${t}"`), t);
  for (const label of ['Top play', 'Model', 'Never-plays', 'Timing ratio', 'Evenness', 'Hidden tab', 'Strength', 'Hands', 'Partner cards', 'Within 100 m']) assert.ok(html.includes(`>${label}`), label);
  assert.doesNotMatch(html, CARD);
  // One club picked: only its rows.
  const two = {clubs: [...x.clubs, {...summary, code: 'CCCC-DDDD', name: 'Rooks'}], limits: THRESHOLDS};
  assert.equal(playerRows(two.clubs, 'CCCC-DDDD').length, 6);
  assert.match(fairHtml(two, {club: 'CCCC-DDDD'}), /<option value="CCCC-DDDD" selected>/);
  assert.match(fairHtml({clubs: []}), /No fair play runs yet/);
});

test('sorting: by any column, either way, missing values last', () => {
  const rows = [{name: 'Bo', top: 0.5}, {name: 'ava', top: null}, {name: 'Cy', top: 0.7}, {name: 'Dee', top: {value: 0.6}}];
  assert.deepEqual(sortRows(rows, 'top', 'desc').map(r => r.name), ['Cy', 'Dee', 'Bo', 'ava']);
  assert.deepEqual(sortRows(rows, 'top', 'asc').map(r => r.name), ['Bo', 'Dee', 'Cy', 'ava']);
  assert.deepEqual(sortRows(rows, 'name', 'asc').map(r => r.name), ['ava', 'Bo', 'Cy', 'Dee']);
  let s = nextSort({}, 'players', 'top');
  assert.deepEqual(s.players, {key: 'top', dir: 'desc'});
  s = nextSort(s, 'players', 'top');
  assert.deepEqual(s.players, {key: 'top', dir: 'asc'});
  assert.deepEqual(nextSort(s, 'players', 'name', true).players, {key: 'name', dir: 'asc'});
  const html = fairHtml({clubs: [{code: 'AAAA-BBBB', name: 'Owls', at: 1, flags: [], pairs: [], club: {}, players: [{id: 'p1', name: 'Zed', hands: 5, flags: [], a: null, p: {}}, {id: 'p2', name: 'Abe', hands: 9, flags: [], a: null, p: {}}]}]}, {sort: {players: {key: 'name', dir: 'asc'}}});
  assert.ok(html.indexOf('>Abe<') < html.indexOf('>Zed<'));
  assert.match(html, /aria-sort="ascending"/);
});

test('a player’s weeks', () => {
  const x = {id: 'p1', weeks: [
    {week: '2026-11-02', code: 'AAAA-BBBB', club: 'Owls', name: 'Ann', hands: 50, flags: [], a: {n: 120, top: 70, exp: 80, off: 6, away: 1, awayKnown: 100}, p: {vpn: 0, relay: 0, fake: 0}},
    {week: '2026-11-09', code: 'AAAA-BBBB', club: 'Owls', name: 'Ann', hands: 60, flags: ['gto-top'], a: {n: 400, top: 330, exp: 320, off: 1, away: 90, awayKnown: 300}, p: {vpn: 3, relay: 0, fake: 0}},
  ]};
  const html = historyHtml(x);
  assert.ok(html.indexOf('2026-11-09') < html.indexOf('2026-11-02'), 'newest first');
  assert.match(html, /Ann/);
  assert.match(html, /Top play/);
  assert.match(html, /<span class="warn">30\.0%<\/span>/, 'the hidden tab rate past the line');
  assert.match(historyHtml({id: 'p2', weeks: []}), /No weeks kept/);
});

test('the summary from a run with no hands is empty, not broken', () => {
  const report = collusionReport([], {now: 5, stats: true});
  const a = assistReport([], {stats: true});
  const s = adminSummary({report, pairStats: report.pairStats, assistStats: a.stats, recs: []});
  assert.deepEqual({players: s.players, pairs: s.pairs, flags: s.flags, hands: s.hands}, {players: [], pairs: [], flags: [], hands: 0});
  assert.equal(s.club.assist.players, 0);
});

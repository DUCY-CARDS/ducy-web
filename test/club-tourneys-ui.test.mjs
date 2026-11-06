// A member's view of the club's tournaments (#189): the calls (started while
// you're away, starting soon), the lobby details, how a running one is
// going, and a cancelled one's refund. Run with:
// node --test test/club-tourneys-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import {
  draftKey, draftSettings, hostTourneysHtml, levelText, memberTourneysHtml, newDraft, readStep, repeatText, tableSizes, tourneyCallsFor, tourneyCards,
} from '../src/club-tourneys-ui.js';
import { structureEditor } from '../src/tourney-structure-ui.js';
import { pickHtml, readPick } from '../src/amount-picks.js';

const NOW = 1_000_000_000;
const structure = [{sb: 25, bb: 50, ante: 0, minutes: 10}, {break: true, minutes: 5}, {sb: 50, bb: 100, ante: 10, minutes: 10}];

function tourney(over = {}) {
  return {
    id: 't1', name: 'Friday Freezeout', game: 'nlhe', buyIn: 10000, added: 0, stack: 1500,
    opensAt: NOW - 1000, startsAt: NOW + 60 * 60_000, minPlayers: 2, maxPlayers: 20, tableSize: 9,
    lateLevel: 2, reentry: false, maxReentries: 0, status: 'scheduled', why: '',
    entries: 2, players: [{id: 'me', name: 'Ann'}, {id: 'bo', name: 'Bo'}], in: ['me', 'bo'], places: [],
    pool: 20000, prizes: [14000, 6000], structure, ...over,
  };
}
const member = tourneys => ({code: 'ABCD-EFGH', name: 'Friday Game', status: 'member', tourneys});

test('calls: started while you are away, or starting within the window', () => {
  const soon = 5 * 60_000;
  const running = tourney({status: 'running'});
  const starting = tourney({id: 't2', startsAt: NOW + 3 * 60_000});
  const later = tourney({id: 't3', startsAt: NOW + 30 * 60_000});
  const notMine = tourney({id: 't4', status: 'running', in: ['bo'], players: [{id: 'bo', name: 'Bo'}]});
  const calls = tourneyCallsFor([member([running, starting, later, notMine])], 'me', null, soon, NOW);
  assert.deepEqual(calls.map(c => [c.kind, c.t.id]), [['started', 't1'], ['soon', 't2']]);
  assert.equal(new Set(calls.map(c => c.key)).size, 2);
  // At its table: no call. Not yet a member: no calls.
  const seated = {code: 'ABCD-EFGH', table: 'tourney:t1'};
  assert.deepEqual(tourneyCallsFor([member([running])], 'me', seated, soon, NOW), []);
  assert.deepEqual(tourneyCallsFor([{...member([running]), status: 'pending'}], 'me', null, soon, NOW), []);
});

test('lobby: format, payouts, who is registered and the blinds', () => {
  const h = memberTourneysHtml(member([tourney()]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /<details class="cl-tdetails" data-keep="tl:ABCD-EFGH:t1">/);
  assert.match(h, /starting stack 1,500 · 9 a table · at least 2 players · late registration until the end of level 2/);
  assert.match(h, /Payouts \(for the entries so far\)/);
  assert.match(h, /<th>1st<\/th><td>140<\/td>/);
  assert.match(h, /Registered \(2\)/);
  assert.match(h, /<b>Ann \(you\)<\/b>, Bo/);
  assert.match(h, /<td>1<\/td><td>25\/50<\/td><td>–<\/td><td>10<\/td>/);
  assert.match(h, /Break<\/td><td>5<\/td>/);
  assert.match(h, /<td>2<\/td><td>50\/100<\/td><td>10<\/td>/);
});

test('running: level, players left, average, places paid, your stack and rank', () => {
  const live = {
    level: 0, onBreak: false, stepEndsAt: NOW + 4 * 60_000, playersLeft: 3, handForHand: false, tables: [{id: 0, players: 3}],
    standings: [{id: 'bo', name: 'Bo', stack: 2000}, {id: 'me', name: 'Ann', stack: 1500}, {id: 'cy', name: 'Cy', stack: 1000}],
  };
  const t = tourney({status: 'running', entries: 3, live});
  const h = memberTourneysHtml(member([t]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /Level 1 · 25\/50 · next in 4 min · 3 left · average 1,500 · 2 paid/);
  assert.match(h, /You: <b>1,500<\/b>, 2nd of 3/);
  const bubble = memberTourneysHtml(member([{...t, live: {...live, playersLeft: 2}}]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(bubble, /in the money/);
});

test('cancelled: your buy-in is back', () => {
  const t = tourney({status: 'cancelled', why: 'fewer than 2 players'});
  const h = memberTourneysHtml(member([t]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /cancelled \(fewer than 2 players\)/);
  assert.match(h, /Your 100 buy-in is back in your balance/);
  assert.doesNotMatch(h, /cl-tdetails/);
  const other = memberTourneysHtml(member([t]), 'zed', {hostHere: true, playing: null}, NOW);
  assert.doesNotMatch(other, /buy-in is back/);
});

test('rake: shown with the buy-in, paid with it, and back with it (#477)', () => {
  const t = tourney({rake: 1000, players: [{id: 'bo', name: 'Bo'}], in: ['bo'], every: 'week'});
  const h = memberTourneysHtml(member([t]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(h, /buy-in 100 \+ 10 /);
  assert.match(h, /Register \(110\)/);
  assert.match(h, /rake 10/);
  assert.match(h, /weekly/);
  const back = memberTourneysHtml(member([{...t, status: 'cancelled', players: [{id: 'me', name: 'Ann'}]}]), 'me', {hostHere: true, playing: null}, NOW);
  assert.match(back, /Your 110 buy-in is back/);
});

test('past the last level the live blinds say what they are (#477)', () => {
  assert.equal(levelText(structure, {level: 2, blinds: {sb: 100, bb: 200, ante: 20}}), 'Level 3 · 100/200 (ante 20)');
  assert.equal(levelText(structure, {level: 1}), 'Level 2 · 50/100 (ante 10)');
});

// A form as the wizard's steps read it: elements by name, and checked days.
function form(values, days = []) {
  const elements = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, {value: String(v)}]));
  if (days) elements.days = {};
  return {elements, querySelectorAll: () => days.map(d => ({value: String(d)}))};
}

test('the wizard: five steps read into a draft, checked, then the settings (#477)', () => {
  const H = 3_600_000, DAY = 24 * H;
  const d = newDraft({stack: 5000, rake: 200}, NOW);
  assert.equal(d.when, 'once');
  assert.ok(d.startsAt > NOW);
  assert.equal(d.rake, 200, 'the last rake');
  // 1: game and buy-in.
  assert.match(readStep(form({name: ' Sunday ', game: 'plo4', buyIn: '20', rake: 'x', added: '0'}), d, 1), /amounts like 10/);
  assert.equal(readStep(form({name: ' Sunday ', game: 'plo4', buyIn: '20', rake: '2', added: '5'}), d, 1), '');
  assert.deepEqual([d.name, d.game, d.buyIn, d.rake, d.added], ['Sunday', 'plo4', 2000, 200, 500]);
  // 2: stack and structure.
  assert.match(readStep(form({stack: 10, tableSize: 9, minPlayers: 2, maxPlayers: 50, preset: 'turbo'}), d, 2), /at least 20/);
  assert.equal(readStep(form({stack: 3000, tableSize: 6, minPlayers: 4, maxPlayers: 30, preset: 'turbo'}), d, 2), '');
  assert.match(readStep(form({stack: 3000, tableSize: 6, minPlayers: 4, maxPlayers: 30, preset: 'custom'}), d, 2, {structureErrors: ['Step 2: bad']}), /Step 2/);
  d.preset = 'turbo';
  // 3: payouts.
  readStep(form({payoutTable: 'abc'}), d, 3);
  assert.equal(d.payoutTable, 'abc');
  // 4: schedule, weekly on Mon and Thu, 8 times, registration a day before.
  const start = NOW + 2 * DAY;
  const local = new Date(start - new Date(start).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const sched = {when: 'week', startsAt: local, end: 'count', count: 8, opensBefore: DAY, lateLevel: 4, reentries: 2};
  assert.match(readStep(form(sched, []), d, 4, {now: NOW}), /days of the week/);
  assert.equal(readStep(form(sched, [1, 4]), d, 4, {now: NOW}), '');
  assert.deepEqual([d.days, d.count, d.opensBefore, d.lateLevel, d.reentry, d.maxReentries], [[1, 4], 8, DAY, 4, true, 2]);
  assert.match(repeatText(d), /^Weekly on Mon, Thu, 8 times$/);
  assert.match(readStep(form({...sched, count: 1}, [1]), d, 4, {now: NOW}), /2 to 500/);
  readStep(form(sched, [1, 4]), d, 4, {now: NOW});
  assert.match(readStep(form({...sched, startsAt: '1970-01-02T10:00'}, [1]), d, 4, {now: NOW}), /later than now/);
  readStep(form(sched, [1, 4]), d, 4, {now: NOW});
  // The settings for the host.
  const s = draftSettings(d, [{sb: 10, bb: 20, ante: 0, minutes: 8}], {now: NOW});
  assert.equal(s.opensBefore, DAY);
  assert.equal(s.opensAt, undefined);
  assert.deepEqual({...s.repeat, offsetMin: 0}, {every: 'week', days: [1, 4], count: 8, offsetMin: 0});
  assert.equal(s.rake, 200);
  // Just this one of a series: no repeat. Once, opening now: opensAt.
  assert.equal(draftSettings(d, [], {repeat: false, now: NOW}).repeat, undefined);
  const once = draftSettings({...d, when: 'once', opensBefore: 0}, [], {now: NOW});
  assert.deepEqual([once.opensAt, once.opensBefore, once.repeat], [NOW, undefined, undefined]);
});

test('table sizes by game: short-handed and full; Omaha 6 is only short-handed', () => {
  assert.deepEqual(tableSizes('nlhe', 9), [[6, 'Short-handed'], [9, 'Full']]);
  assert.deepEqual(tableSizes('plo4', 8), [[6, 'Short-handed'], [8, 'Full']]);
  assert.deepEqual(tableSizes('plo5', 6), [[6, 'Short-handed'], [8, 'Full']]);
  assert.deepEqual(tableSizes('plo6', 6), [[6, 'Short-handed']]);
  // A tournament that already has another size keeps it as a choice.
  assert.deepEqual(tableSizes('nlhe', 7), [[6, 'Short-handed'], [7, '7-handed'], [9, 'Full']]);
});

test('the wizard’s pages: steps, Customize, schedule choices and the review (#477)', () => {
  const club = {payoutTables: [], members: {}};
  const editor = structureEditor({stack: 10000, presets: false});
  const d = newDraft({}, NOW);
  const page = (step, over = {}, edit = null) => hostTourneysHtml(club, {}, {wizard: {step, d: {...d, ...over}, editor, edit}}, NOW);
  let h = page(1);
  assert.match(h, /<h3>New tournament<\/h3>/);
  assert.match(h, /name="rake"/);
  assert.match(h, /form="tw-form">Next</);
  assert.doesNotMatch(h, /tw-back/);
  h = page(2);
  assert.match(h, /value="custom"[^>]*><span class="tw-tile-name">Customize/);
  assert.match(h, /min levels</, 'each preset says how long its levels are');
  assert.match(h, /name="tableSize" value="9" checked><span class="tw-tile-name">Full</);
  assert.match(h, /name="tableSize" value="6"><span class="tw-tile-name">Short-handed</);
  assert.doesNotMatch(h, /data-tseditor/, 'blind levels behind Customize');
  assert.doesNotMatch(h, /data-ts="preset"/);
  assert.match(page(2, {preset: 'custom'}), /data-tseditor/);
  h = page(4);
  assert.match(h, /value="once" checked/);
  assert.doesNotMatch(h, /name="days"/);
  assert.match(h, /<option value="0" selected>Now<\/option>/);
  h = page(4, {when: 'week', opensBefore: 2 * 3_600_000});
  assert.match(h, /name="days"/);
  assert.match(h, /name="count"/);
  assert.doesNotMatch(h, />Now</, 'a series opens before each start');
  assert.match(page(4, {when: 'day', end: 'until'}), /name="until" type="date"/);
  // Changing one of a series: no repeat choices.
  assert.doesNotMatch(page(4, {}, {id: 't1', series: false}), /name="when"/);
  h = page(5, {name: 'Nightly', buyIn: 1000, rake: 100, when: 'day', count: 5, opensBefore: 3_600_000});
  assert.match(h, /<dt>Buy-in<\/dt><dd>10 \+ 1 rake<\/dd>/);
  assert.match(h, /<dd>Daily, 5 times<\/dd>/);
  assert.match(h, /<dd>1 hour before<\/dd>/);
  assert.match(h, />Create</);
  assert.match(page(5, {}, {id: 't1', series: true}), />Save</);
});

test('the wizard’s ✕ asks Discard? only once something is entered (#544)', () => {
  const d = newDraft({reentry: false, maxReentries: 2}, NOW);
  const steps = [{sb: 10, bb: 20, ante: 0, minutes: 8}];
  const start = draftKey(d, steps);
  // Read back as it opened: nothing entered (re-entries off, whatever the last limit).
  readStep(form({name: '', game: d.game, buyIn: '0', rake: '0', added: '0'}), d, 1);
  readStep(form({reentries: -1}, null), d, 4, {strict: false});
  assert.equal(draftKey(d, steps), start);
  assert.notEqual(draftKey({...d, name: 'Sunday'}, steps), start);
  assert.notEqual(draftKey(d, [...steps, {sb: 20, bb: 40, ante: 0, minutes: 8}]), start);
  const club = {payoutTables: [], members: {}};
  const editor = structureEditor({stack: 10000, presets: false});
  const h = hostTourneysHtml(club, {}, {wizard: {step: 1, d, editor, discard: true}}, NOW);
  assert.match(h, /Discard\?<button[^>]*data-cl="tw-discard">Discard<\/button><button[^>]*data-cl="tw-keep">Keep editing</);
  assert.doesNotMatch(h, /cancel-tourney-form/);
});

test('presets with Other: picked, or typed in the box Other shows (#544)', () => {
  const h = pickHtml('stack', [5000, 10000], 10000, String, '<input name="stack">');
  assert.match(h, /name="stackPick" value="10000" checked>/);
  assert.match(h, /name="stackPick" value="other">Other/);
  assert.match(h, /data-other="stack" hidden><input name="stack">/);
  assert.match(pickHtml('stack', [5000, 10000], 7000, String, ''), /value="other" checked>Other<\/label><span class="pick-other" data-other="stack">/, 'a value not among them is Other');
  assert.equal(readPick({stackPick: {value: '5000'}, stack: {value: '7000'}}, 'stack'), 5000);
  assert.equal(readPick({stackPick: {value: 'other'}, stack: {value: '7000'}}, 'stack'), 7000);
  assert.equal(readPick({stack: {value: '7000'}}, 'stack'), 7000, 'no buttons: the box');
  // The wizard: buy-in and players picked; Other kept open once picked.
  const d = newDraft({}, NOW);
  assert.equal(readStep(form({name: '', game: 'nlhe', buyInPick: '5000', buyIn: '0', rakePick: 'other', rake: '3', added: '0'}), d, 1), '');
  assert.deepEqual([d.buyIn, d.rake, d.other], [5000, 300, ['rake']]);
  const editor = structureEditor({stack: 10000, presets: false});
  let page = hostTourneysHtml({payoutTables: [], members: {}}, {}, {wizard: {step: 1, d, editor}}, NOW);
  assert.match(page, /name="buyInPick" value="5000" checked><span class="tw-tile-name">50</);
  assert.match(page, /name="rakePick" value="other" checked>/);
  assert.equal(readStep(form({stackPick: '20000', stack: '10000', tableSize: 9, minPlayersPick: '4', minPlayers: '2', maxPlayersPick: 'other', maxPlayers: '30', preset: 'regular'}), d, 2), '');
  assert.deepEqual([d.stack, d.minPlayers, d.maxPlayers], [20000, 4, 30]);
  page = hostTourneysHtml({payoutTables: [], members: {}}, {}, {wizard: {step: 2, d, editor}}, NOW);
  assert.match(page, /name="stackPick" value="20000" checked>/);
  assert.match(page, /name="maxPlayersPick" value="other" checked>/);
  assert.equal(draftKey({...d, other: []}, []), draftKey(d, []), 'Other open is not something entered');
});

test('the Tournaments page: a repeating series is one card with its next start (#477)', () => {
  const t = (id, over) => ({id, name: 'Nightly', game: 'nlhe', buyIn: 1000, rake: 100, added: 0, stack: 1500, structure,
    opensAt: NOW - 1000, startsAt: NOW + 3_600_000, minPlayers: 2, maxPlayers: 20, tableSize: 9, lateLevel: 0,
    status: 'scheduled', entries: [], series: 's1', ...over});
  const se = {id: 's1', every: 'day', next: NOW + 3 * 86_400_000, opensBefore: 3_600_000, count: 10, made: 3, settings: {name: 'Nightly', buyIn: 1000, rake: 100, stack: 1500}};
  const club = {members: {}, payoutTables: [], tourneySeries: [se],
    tourneys: [t('a', {status: 'finished', startsAt: NOW - 86_400_000, paid: []}), t('b', {}), t('c', {startsAt: NOW + 86_400_000})]};
  assert.deepEqual(tourneyCards(club).map(c => c.t?.id || c.series.id), ['b', 'a']);
  let h = hostTourneysHtml(club, {}, {}, NOW);
  assert.equal(h.match(/class="cl-tourney"/g).length, 2);
  assert.match(h, /cl-badge">Daily</);
  assert.match(h, /buy-in 10 \+ 1/);
  assert.match(h, /data-cl="t-ask" data-act="edit" data-id="b"/);
  // Edit asks: this one or the whole series.
  h = hostTourneysHtml(club, {}, {ask: {id: 'b', act: 'edit'}}, NOW);
  assert.match(h, /data-cl="t-edit" data-id="b" data-series="0">This one</);
  assert.match(h, /data-cl="t-edit" data-id="b" data-series="1">Whole series</);
  // None waiting to start: the series' own card, its next start.
  const between = {...club, tourneys: [club.tourneys[0]]};
  assert.deepEqual(tourneyCards(between).map(c => c.t?.id || c.series.id), ['s1', 'a']);
  h = hostTourneysHtml(between, {}, {}, NOW);
  assert.match(h, /data-cl="series-edit" data-id="s1"/);
  assert.match(h, /Next /);
  // The buttons that refund buy-ins say what they cancel (#544).
  assert.match(hostTourneysHtml(club, {}, {}, NOW), /data-cl="t-ask" data-act="cancel" data-id="b">Cancel tournament</);
  assert.match(hostTourneysHtml(between, {}, {}, NOW), /data-cl="series-stop" data-id="s1">Cancel series</);
  // A running one's payouts ask before they change; one to come doesn't.
  const running = {...club, payoutTables: [{id: 'p1', name: 'Flat', rows: []}], tourneys: [t('r', {status: 'running', series: null})]};
  assert.match(hostTourneysHtml(running, {}, {}, NOW), /data-paypick="r" data-running="1"/);
  assert.doesNotMatch(hostTourneysHtml(club, {}, {}, NOW), /data-running/);
  h = hostTourneysHtml(running, {}, {payAsk: {id: 'r', table: 'p1'}}, NOW);
  assert.match(h, /<option value="p1" selected>Flat/);
  assert.match(h, /Change payouts mid-tournament\?<button[^>]*data-cl="pay-yes" data-id="r" data-table="p1">Change<\/button><button[^>]*data-cl="pay-no">Keep</);
  // Stopped: no card.
  assert.deepEqual(tourneyCards({...between, tourneySeries: [{...se, stopped: true}]}).map(c => c.t.id), ['a']);
});

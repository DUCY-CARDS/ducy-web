// The Bankroll Challenge's generic players (#302, #305), reads (#306) and
// stats (#304).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILIES, botIdOf, familyFor, isGeneric, isReg, lookFor, nameFor, parseBotId, personOf, roster, tourist, touristShare,
} from '../src/quest-people.js';
import { CRUSHERS, LINEUP_SEATS, POOLS, STRONG, buyInFor, lineupFor, lineupStacks, replacementPool, roomLineups } from '../src/quest-lineup.js';
import { ROOMS, STAKES } from '../src/quest-rooms.js';
import { READ_HANDS, accuracyText, reviewReads, suggestFamily, tagOf, tagPlayer, thinkMs } from '../src/quest-reads.js';
import { MILESTONES, START_BANKROLL, checkMilestones, leave, newQuest, newRun, recordHand, sitDown } from '../src/quest.js';
import { bankrollChart, bankrollSeries, biggestPots, byStakes, durationText, hallOfRecords, withRegulars } from '../src/quest-stats.js';
import { personaOf } from '../src/bot-chat.js';
import { BASES, GEARS, NAMES } from '../src/quest-faces.js';

const T0 = Date.UTC(2026, 9, 17);
// Game minutes: day 0 is a Monday.
const at = (day, hour) => day * 1440 + hour * 60;
const FRI_9PM = at(4, 21), TUE_2PM = at(1, 14);

test('a person is the same from the same seed, with a look and a name that fit', () => {
  const id = botIdOf('maniac', 12345);
  assert.deepEqual(parseBotId(id), {family: 'maniac', seed: 12345});
  assert.deepEqual(personOf(id), personOf(id));
  assert.equal(personOf('doug_poker'), null);
  assert.ok(isGeneric(id) && !isGeneric('milk_king'));
  const p = personOf(id);
  assert.match(p.name, /^[A-Z][a-z]+ [A-Z]\.$/);
  assert.ok(NAMES[p.look.pool][p.look.gender][p.look.age].includes(p.name.split(' ')[0]), 'a name for the look’s pool, gender and age');
  assert.ok(p.avatar.startsWith('data:image/svg+xml'), 'a drawn face');
  assert.ok(BASES[p.look.base], 'from one of the bases');
});

test('style leans: older looks are rocks more often, every family shows every gear and age', () => {
  const seen = new Set();
  let olderRocks = 0, older = 0, rocks = 0, all = 0;
  for (let s = 1; s <= 4000; s++) {
    const family = familyFor(s % 2 ? 'reg' : 'tourist', (s % 5) / 4, (s * 0.6180339887) % 1);
    const look = lookFor(family, s);
    seen.add(`${family}|${look.gear}`).add(`${family}|${look.age}`);
    all++;
    if (family === 'rock') rocks++;
    if (look.age === 'older') { older++; if (family === 'rock') olderRocks++; }
  }
  assert.ok(olderRocks / older > 1.3 * (rocks / all), `older rocks ${olderRocks}/${older} vs ${rocks}/${all}`);
  for (const f of FAMILIES) {
    for (const gear of GEARS) assert.ok(seen.has(`${f}|${gear}`), `${f} with ${gear || 'no gear'}`);
    for (const age of ['young', 'middle', 'older']) assert.ok(seen.has(`${f}|${age}`), `${f} ${age}`);
  }
  // Tourists lean loose, regs tight; a wild night runs wilder.
  const share = (kind, wild, fam) => Array.from({length: 1000}, (_, i) => familyFor(kind, wild, (i + 0.5) / 1000)).filter(f => fam.includes(f)).length / 1000;
  assert.ok(share('tourist', 0, ['station', 'maniac']) > share('reg', 0, ['station', 'maniac']) + 0.3);
  assert.ok(share('tourist', 1, ['maniac']) > share('tourist', 0, ['maniac']));
});

test('low and mid stakes seat regs and tourists; no one sits at two tables, no shared names', () => {
  let checked = 0;
  for (let hour = 0; hour < 24 * 7; hour += 5) {
    const minutes = hour * 60;
    for (const room of ROOMS) {
      const tables = roomLineups(9, room.id, minutes);
      const everyone = [];
      for (const [id, t] of tables) {
        const stakes = id.split('-')[1];
        assert.equal(t.seats.length, LINEUP_SEATS, id);
        everyone.push(...t.seats);
        const names = t.seats.map(s => personOf(s)?.name).filter(Boolean);
        assert.equal(new Set(names).size, names.length, `names at ${id}`);
        const regulars = t.seats.filter(s => !isGeneric(s));
        for (const r of regulars) assert.ok(POOLS.low.includes(r) || POOLS.mid.includes(r) || CRUSHERS.includes(r) || STRONG.includes(r));
        assert.ok(t.bench.length > 0 && t.bench.every(b => !t.seats.includes(b)));
        checked++;
      }
      assert.equal(new Set(everyone).size, everyone.length, `no one at two tables in ${room.id} at ${hour}`);
    }
  }
  assert.ok(checked > 100);
  // lineupFor gives the same seats as the room's line-up; big games stay Regulars.
  const minutes = FRI_9PM;
  const [id, t] = [...roomLineups(9, 'deuce', minutes)][0];
  assert.deepEqual(lineupFor(9, id, id.split('-')[1], minutes, null, {generic: true}), t.seats);
  assert.ok(lineupFor(9, 'ivory-50/100-1', '50/100', minutes, null, {generic: true}).every(s => !isGeneric(s)));
  assert.deepEqual(replacementPool('1/2', null, {seed: 9, tableId: id, minutes, generic: true}), t.bench);
  // Without generic players, the old line-ups.
  assert.ok(lineupFor(9, id, '1/2', minutes).every(s => POOLS.low.includes(s)));
  // Generic players buy in by habit within the room's range, and have
  // running-game stacks like the Regulars.
  const room = ROOMS.find(r => r.id === 'deuce');
  const blinds = STAKES['1/2'];
  for (const s of t.seats.filter(isGeneric)) {
    const b = buyInFor(9, id, s, blinds, room, minutes);
    assert.equal(b, Math.max(40, Math.min(200, personOf(s).buyInBb)) * blinds[1], s);
  }
  const stacks = lineupStacks(9, id, t.seats, blinds, room, minutes);
  assert.equal(stacks.length, t.seats.length);
  assert.ok(stacks.every(x => x.stack > 0 && x.stack % blinds[1] === 0));
});

test('more tourists on a weekend evening than a weekday afternoon', () => {
  assert.ok(touristShare(FRI_9PM) > touristShare(TUE_2PM) + 0.3);
  const regIds = new Set(ROOMS.flatMap(r => roster(9, r.id).map(p => p.id)));
  const share = minutes => {
    let t = 0, n = 0;
    for (let w = 0; w < 6; w++) {
      const m = minutes + w * 7 * 1440;
      for (const [id, tb] of roomLineups(9, 'deuce', m)) {
        if (!id.includes('-1/2-') && !id.includes('-2/5-')) continue;
        for (const s of tb.seats.filter(isGeneric)) { n++; if (!regIds.has(s)) t++; }
      }
    }
    return t / n;
  };
  assert.ok(share(FRI_9PM) > share(TUE_2PM) + 0.2, `${share(FRI_9PM)} vs ${share(TUE_2PM)}`);
});

test('a reg mostly plays their home room and keeps their style; a tourist is gone after their day', () => {
  const reg = roster(9, 'deuce')[0];
  assert.ok(isReg(9, ['deuce'], reg.id) && !isReg(9, ['harbor'], reg.id));
  assert.deepEqual(roster(9, 'deuce'), roster(9, 'deuce'), 'the same regs on every load');
  let home = 0, away = 0;
  for (let h = 0; h < 24 * 28; h += 2) {
    for (const room of ROOMS) {
      for (const [, t] of roomLineups(9, room.id, h * 60)) {
        for (const s of t.seats) if (roster(9, 'deuce').some(r => r.id === s)) room.id === 'deuce' ? home++ : away++;
      }
    }
  }
  assert.ok(home > 3 * away, `deuce regs: ${home} at home, ${away} away`);
  // A tourist is made for a day: the same slot another day is someone else.
  assert.equal(tourist(9, 'deuce', 4, 3, FRI_9PM), tourist(9, 'deuce', 4, 3, FRI_9PM));
  assert.notEqual(tourist(9, 'deuce', 4, 3, FRI_9PM), tourist(9, 'deuce', 5, 3, FRI_9PM + 1440));
  // Tourists seated at 1/2 one day don't come back over the next weeks.
  const day0 = new Set([...roomLineups(9, 'deuce', FRI_9PM).values()].flatMap(t => t.seats).filter(s => isGeneric(s) && !isReg(9, ROOMS.map(r => r.id), s)));
  assert.ok(day0.size > 0);
  for (let d = 1; d < 21; d++) {
    for (const [, t] of roomLineups(9, 'deuce', FRI_9PM + d * 1440)) for (const s of t.seats) assert.ok(!day0.has(s), `${s} back on day ${d}`);
  }
});

test('reads: tags save, first reads count before 20 hands, the review shows the true style', () => {
  const rock = botIdOf('rock', 77), maniac = botIdOf('maniac', 78), station = botIdOf('station', 79);
  let q = newQuest(T0, 4);
  q = tagPlayer(q, rock, 'rock', 5);
  q = tagPlayer(q, maniac, 'station', 3);
  q = tagPlayer(q, maniac, 'maniac', READ_HANDS + 10);
  assert.equal(tagOf(q, rock), 'rock');
  assert.equal(q.reads[maniac].first, 'station', 'the first read stays');
  assert.equal(tagOf(JSON.parse(JSON.stringify(q)), maniac), 'maniac', 'saves and loads');
  assert.equal(tagPlayer(q, 'doug_poker', 'rock'), q, 'only generic players');
  const r = (vpip, pfr, hands = 40) => ({hands, vpip: {v: vpip, d: hands}, pfr: {v: pfr, d: hands}, af: {v: 1, d: 1}});
  const {rows, q: after} = reviewReads(q, [
    {id: rock, hands: 30, rates: r(0.1, 0.05)},
    {id: maniac, hands: 40, rates: r(0.5, 0.35)},
    {id: station, hands: 40, rates: r(0.55, 0.05)},
  ]);
  assert.deepEqual(rows.map(x => [x.family, x.tag, x.right]), [['rock', 'rock', true], ['maniac', 'maniac', true], ['station', null, null]]);
  assert.equal(rows[2].guess.family, 'station');
  assert.deepEqual(after.readStats, {first: {n: 2, right: 1}, later: {n: 2, right: 2}});
  assert.equal(accuracyText(after.readStats.first), '1 of 2 (50%)');
  assert.equal(after.reads[maniac].first, undefined, 'a new first read next session');
  // What the hands suggest.
  assert.equal(suggestFamily(r(0.12, 0.08)).family, 'rock');
  assert.equal(suggestFamily(r(0.45, 0.3)).family, 'maniac');
  assert.equal(suggestFamily(r(0.22, 0.17)).family, 'grinder');
  assert.equal(suggestFamily(r(0.5, 0.05, 5)), null, 'too few hands');
});

test('timing and table talk lean by style, with exceptions', () => {
  let x = 0;
  const rng = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const avg = f => Array.from({length: 2000}, () => thinkMs(f, rng)).reduce((a, b) => a + b, 0) / 2000;
  assert.ok(avg('maniac') < avg('station') && avg('station') < avg('grinder') && avg('grinder') < avg('rock'));
  const times = Array.from({length: 2000}, () => thinkMs('rock', rng));
  assert.ok(times.some(t => t < 900), 'a rock sometimes acts fast');
  assert.equal(personaOf(botIdOf('maniac', 1)).tone, 'needle');
  assert.ok(personaOf(botIdOf('rock', 1)).talk < personaOf(botIdOf('station', 1)).talk);
  assert.equal(personaOf('doug_poker').tone, 'cool');
});

test('stats: hands and big pots by session, milestones once, the run’s records', () => {
  let q = newQuest(T0, 2);
  const table = {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2'], with: ['rampart']};
  q = sitDown(q, table, 20000);
  q = recordHand(q, 26000); // +60
  q = recordHand(q, 23000); // −30
  q = recordHand(q, 23000);
  assert.deepEqual([q.seat.hands, q.seat.bigWin, q.seat.bigLoss], [3, 6000, -3000]);
  q = leave(q, T0);
  const s = q.history[0];
  assert.deepEqual([s.hands, s.net, s.bigWin, s.with[0], s.bankroll], [3, 3000, 6000, 'rampart', START_BANKROLL + 3000]);
  assert.equal(q.hands, 3);
  assert.deepEqual(byStakes(q.history).map(r => [r.stakes, r.hands, r.net]), [['1/2', 3, 3000]]);
  assert.ok(Math.abs(byStakes(q.history)[0].bb100 - 500) < 1e-9, '15 big blinds over 3 hands');
  assert.deepEqual(biggestPots(q.history), {won: 6000, lost: -3000});
  assert.deepEqual(withRegulars(q.history), [{id: 'rampart', sessions: 1, net: 3000}]);
  assert.deepEqual(bankrollSeries(q.history).map(p => p.bankroll), [START_BANKROLL, START_BANKROLL + 3000]);
  assert.match(bankrollChart(bankrollSeries(q.history)), /^<svg[^>]*class="qs-chart"/);
  // Milestones fire once.
  let m = checkMilestones({...q, bankroll: MILESTONES[1].at});
  assert.deepEqual(m.reached.map(x => x.at), [MILESTONES[0].at, MILESTONES[1].at]);
  m = checkMilestones({...m.q, bankroll: MILESTONES[1].at + 1});
  assert.equal(m.reached.length, 0);
  // A new run keeps what you know about the players.
  const reads = {[botIdOf('rock', 5)]: {tag: 'rock'}};
  const next = newRun({...q, reads}, T0, 'broke');
  assert.deepEqual(next.reads, reads);
  assert.equal(next.runs[0].hands, 3);
  assert.deepEqual(hallOfRecords([{result: 'broke', peak: 5}, {result: 'won', minutes: 900}, {result: 'won', minutes: 300}, {result: 'broke', peak: 9}]).map(r => r.minutes ?? r.peak), [300, 900, 9, 5]);
  assert.equal(durationText(60 * 52), '2 days 4 hours');
  assert.equal(durationText(60 * 5), '5 hours');
});

test('the lobby shows generic players’ faces and names, and the run’s stats', async () => {
  const { questLobbyHtml } = await import('../src/quest-ui.js');
  let q = {...newQuest(T0, 9), room: 'deuce'};
  // At the table your name is called to, the generic players show by name.
  const html = questLobbyHtml(q, T0, {generic: true, open: 'deuce-1/2-1'});
  assert.match(html, /class="qt-seat-name">[A-Z][a-z]+ [A-Z]\./);
  q = leave(recordHand(sitDown(q, {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']}, 20000), 25000), T0);
  const after = questLobbyHtml(q, T0, {generic: true, review: [{id: botIdOf('rock', 3), name: 'Dave R.', family: 'rock', tag: 'maniac', right: false, guess: null}]});
  assert.match(after, /class="qs-chart"/);
  assert.match(after, /You read Dave R\. as a maniac\. Dave R\. is a rock\./);
});

test('the mix: mostly ABC players at low stakes, a rare crusher; fewer ABC and more crushers higher up', () => {
  const share = {low: {}, mid: {}};
  for (const seed of [1, 2]) for (let h = 0; h < 24 * 7; h += 6) for (const room of ROOMS) {
    for (const [id, t] of roomLineups(seed, room.id, h * 60)) {
      const level = ['1/2', '2/5'].includes(id.split('-')[1]) ? 'low' : 'mid';
      for (const s of t.seats) {
        const k = personOf(s)?.family || (CRUSHERS.includes(s) ? 'crusher' : 'character');
        share[level][k] = (share[level][k] || 0) + 1;
      }
    }
  }
  const pct = (l, k) => (share[l][k] || 0) / Object.values(share[l]).reduce((a, b) => a + b, 0);
  assert.ok(pct('low', 'grinder') > 0.55, `low ABC ${pct('low', 'grinder')}`);
  for (const k of ['maniac', 'rock']) assert.ok(pct('low', k) > 0.04 && pct('low', k) < 0.2, `low ${k} ${pct('low', k)}`);
  assert.ok(pct('low', 'crusher') > 0 && pct('low', 'crusher') < 0.06, `low crushers ${pct('low', 'crusher')}`);
  assert.ok(pct('mid', 'crusher') > 2 * pct('low', 'crusher'), 'more crushers at 5/10 and 10/20');
  assert.ok(pct('mid', 'grinder') < pct('low', 'grinder') - 0.1, 'fewer ABC players at 5/10 and 10/20');
});

test('10/20: four strong players, or three and a rock, and an ABC player or now and then a bad one', () => {
  let tables = 0, bad = 0;
  for (const seed of [1, 2]) for (let h = 0; h < 24 * 7; h += 4) for (const room of ROOMS) {
    for (const [id, t] of roomLineups(seed, room.id, h * 60)) {
      if (!id.includes('-10/20-')) continue;
      tables++;
      const strong = t.seats.filter(s => STRONG.includes(s)).length;
      const fam = f => t.seats.filter(s => personOf(s)?.family === f).length;
      assert.ok(strong >= 3, `${id}: ${strong} strong`);
      assert.ok(strong === 4 || fam('rock') >= 1 || fam('grinder') === 2, `${id}: three strong and a rock`);
      if (fam('station') || fam('maniac')) bad++;
    }
  }
  assert.ok(tables > 20);
  assert.ok(bad > 0 && bad / tables < 0.35, `bad players at ${bad} of ${tables} tables`);
});


test('people match the area: Texas mostly white and Hispanic, LA more mixed, Miami heavily Hispanic', async () => {
  const { backgroundOf, baseFor } = await import('../src/quest-faces.js');
  const { regionOf } = await import('../src/quest-rooms.js');
  const share = {};
  for (const seed of [1, 2]) for (const room of ROOMS) {
    const reg = regionOf(room).id;
    share[reg] ||= {};
    const ids = [...roster(seed, room.id).map(r => r.id), ...Array.from({length: 40}, (_, i) => tourist(seed, room.id, 2, i, 2 * 1440 + 600))];
    for (const id of ids) {
      const p = parseBotId(id);
      const b = backgroundOf(baseFor(p.family, p.seed));
      share[reg][b] = (share[reg][b] || 0) + 1;
    }
  }
  const pct = (r, b) => (share[r][b] || 0) / Object.values(share[r]).reduce((a, x) => a + x, 0);
  assert.ok(pct('tx', 'white') + pct('tx', 'hispanic') > 0.7, 'Texas: mostly white and Hispanic');
  assert.ok(pct('tx', 'black') > 0.06 && pct('tx', 'eastasian') < 0.1 && pct('tx', 'southasian') < 0.1);
  assert.ok(pct('la', 'eastasian') > 2 * pct('tx', 'eastasian'), 'LA more mixed');
  assert.ok(pct('la', 'white') < pct('tx', 'white'));
  assert.ok(pct('fl', 'hispanic') > pct('fl', 'white'), 'Miami heavily Hispanic');
});

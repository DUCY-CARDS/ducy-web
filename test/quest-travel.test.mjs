// Bankroll challenge: regions and small towns, trips that take real time,
// waitlists you wait in, and study while you travel or wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_MINUTES, arrive, dropMissed, gameMinutes, joinList, leaveList, listStatus, newQuest, newRun, recordStudy, sitDown, startIn, travel } from '../src/quest.js';
import { REGIONS, ROOMS, STAKES, TRAVEL, cityOf, regionOf, roomById, startRoom, travelMinutes } from '../src/quest-rooms.js';
import { listKey, listsNow, seatGap, waitingAt } from '../src/quest-waitlist.js';
import { question } from '../src/quest-study.js';
import { clock, questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);
const later = gm => T0 + (gm / 4) * 60000; // real time after `gm` game minutes

test('every room is in a city of a region; each region starts in a small town with small games', () => {
  for (const room of ROOMS) {
    assert.ok(cityOf(room), `${room.id} has a city`);
    assert.ok(!room.id.includes('-'), 'room ids have no dashes');
  }
  for (const r of REGIONS) {
    const start = startRoom(r.id);
    assert.ok(start && cityOf(start).small, `${r.name} starts in a small town`);
    assert.ok(start.games.every(g => ['1/2', '2/5'].includes(g.stakes)), `${start.name}: only small games`);
    assert.ok(ROOMS.some(x => regionOf(x)?.id === r.id && !cityOf(x).small), `${r.name} has a bigger city`);
  }
});

test('trips: across town, to another city, to another region, in real time', () => {
  assert.equal(travelMinutes(roomById('ivory'), roomById('sunset')), TRAVEL.town);
  assert.equal(travelMinutes(roomById('mesquite'), roomById('deuce')), TRAVEL.region);
  assert.equal(travelMinutes(roomById('mesquite'), roomById('harbor')), TRAVEL.far);
  assert.equal(travelMinutes(roomById('deuce'), roomById('deuce')), 0);
  // Across town is 1½ real minutes; another city costs 2 game hours, another
  // region 6 (30 and 90 real minutes).
  assert.equal((TRAVEL.town / 4) * 60, 90);
  assert.equal(TRAVEL.region, 120);
  assert.equal(TRAVEL.far, 360);
  assert.equal(clock(90 * 60000), '1:30:00');
  assert.equal(clock(65000), '1:05');
  let q = startIn(newQuest(T0, 1), 'tx', 'mesquite');
  assert.equal(q.room, 'mesquite');
  assert.equal(q.home, 'tx');
  q = travel(q, 'deuce', TRAVEL.region, T0);
  assert.equal(arrive(q, later(TRAVEL.region - 1)).room, 'mesquite');
  assert.equal(arrive(q, later(TRAVEL.region)).room, 'deuce');
  // On the road the lobby is the trip: where to, a countdown, and study.
  const html = questLobbyHtml(q, later(4));
  assert.match(html, /Deuce Street Card Room/);
  assert.match(html, /data-qcount="\d+"/);
  assert.match(html, /data-qans="0"/);
  assert.doesNotMatch(html, /data-qlist|data-qgo/);
  // A long trip says it runs without you.
  assert.match(html, /goes on without you watching/);
  // A new run after a trip starts where it was going.
  assert.equal(newRun(q, later(4)).room, 'deuce');
});

test('waitlists: busier small games have more names; the list is the same for a world and a time', () => {
  const room = roomById('sunset');
  const small = room.games.find(g => g.stakes === '1/2');
  let total = 0;
  for (let m = 0; m < 7 * 1440; m += 37) {
    const w = waitingAt(4, room.id, small, m);
    assert.ok(w.length <= 5);
    assert.equal(new Set(w).size, w.length, 'no name twice');
    total += w.length;
  }
  assert.ok(total > 0);
  assert.deepEqual(waitingAt(4, room.id, small, 1000), waitingAt(4, room.id, small, 1000));
  assert.ok(seatGap(1) > seatGap(5));
  assert.equal(listKey({stakes: '2/5', game: 'plo4'}), 'plo4 2/5');
  const rooms = listsNow(4, 4 * 1440 + 20 * 60);
  assert.equal(rooms.length, ROOMS.length);
  for (const r of rooms) for (const g of r.games) {
    assert.ok(Array.isArray(g.waiting) && g.gap > 0);
    // Even a full list calls you in under a game minute (~15 real seconds).
    assert.ok((5 + 1) * g.gap < 1, `${r.room.id} ${g.key} waits ${(5 + 1) * g.gap} game min`);
  }
});

test('joining a list: called once those ahead are seated, then a short time to take the seat', () => {
  let q = startIn(newQuest(T0, 2), 'tx', 'mesquite');
  const game = {key: 'nlhe 1/2', stakes: '1/2', game: 'nlhe'};
  q = joinList(q, game, 2, 3, T0);
  assert.equal(joinList(q, game, 2, 3, T0), q, 'once a game');
  let [s] = listStatus(q, T0);
  assert.equal(s.ahead, 2);
  assert.equal(s.called, false);
  assert.equal(s.wait, 9, 'three seats to open, three game minutes apart');
  [s] = listStatus(q, later(4));
  assert.equal(s.ahead, 1);
  [s] = listStatus(q, later(9));
  assert.ok(s.called);
  // Not taken in time: the seat goes to the next name.
  assert.equal(listStatus(q, later(9 + CALL_MINUTES)).length, 0);
  assert.equal(dropMissed(q, later(9 + CALL_MINUTES)).lists.length, 0);
  // Leaving the list, travelling or sitting down takes your name off.
  assert.equal(leaveList(q, 'nlhe 1/2').lists.length, 0);
  assert.equal(travel(q, 'deuce', 12, T0).lists.length, 0);
  assert.equal(sitDown(q, {id: 'mesquite-1/2-1', room: 'mesquite', stakes: STAKES['1/2']}, 20000).lists.length, 0);
  // The lobby shows your place, with a countdown, and study while you wait.
  const html = questLobbyHtml(q, T0);
  assert.match(html, /You’re 3rd on the list/);
  assert.match(html, /data-qunlist="nlhe 1\/2"/);
  assert.match(html, /Study while you wait/);
  // Called: take the seat (it opens the table) or pass.
  const called = questLobbyHtml(q, later(9));
  assert.match(called, /Your seat is ready/);
  assert.match(called, /data-qopen="mesquite-1\/2-1"/);
  assert.match(called, /data-qpass="nlhe 1\/2"/);
});

test('study questions: the same for a world, one right answer, four choices', () => {
  const kinds = new Set();
  for (let n = 0; n < 200; n++) {
    const a = question(7, n);
    assert.deepEqual(a, question(7, n));
    kinds.add(a.kind);
    assert.ok(a.choices.length >= 3 && a.choices.length <= 4, `${a.kind}: ${a.choices}`);
    assert.equal(new Set(a.choices).size, a.choices.length, 'different choices');
    assert.ok(a.answer >= 0 && a.answer < a.choices.length);
    assert.ok(a.why.length > 10);
  }
  assert.equal(kinds.size, 4);
  // Pot odds: a pot-sized bet needs a third.
  for (let n = 0; n < 500; n++) {
    const a = question(3, n);
    if (a.kind === 'odds' && /\(the pot\)/.test(a.text)) { assert.equal(a.choices[a.answer], '33%'); break; }
  }
  let q = newQuest(T0, 1);
  q = recordStudy(recordStudy(q, true), false);
  assert.deepEqual(q.study, {n: 2, right: 1});
});

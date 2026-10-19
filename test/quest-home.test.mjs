// Bankroll Quest's home (#299): one home, a small club in the small town a
// run starts in; the badge when you're there; a way home from anywhere at
// any time; and more games at each place up the road. Times in the lobby
// are game time, ticking as fast as its clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEST_SPEED, arrive, newQuest, startIn, travel } from '../src/quest.js';
import { REGIONS, ROOMS, homeRoomOf, knownRoom, roomById, startRoom, travelMinutes } from '../src/quest-rooms.js';
import { gameClock, questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);
const tables = room => room.games.reduce((n, g) => n + g.tables, 0);

test('each region’s small town has a home club, and a run starts there', () => {
  for (const region of REGIONS) {
    const town = region.cities.find(c => c.small);
    const club = startRoom(region.id);
    assert.ok(club.local, `${region.name} starts at a club`);
    assert.equal(club.city, town.id);
    assert.ok(club.games.some(g => g.stakes === '1/2' && !g.game && g.chance == null), `${club.name} runs $1/$2 Hold’em`);
  }
  // No clubs anywhere else.
  for (const r of ROOMS.filter(x => x.local)) assert.ok(REGIONS.some(g => g.cities.find(c => c.small)?.id === r.city), r.id);
});

test('each place up the road has more games: the club, the town room, the cities', () => {
  for (const region of REGIONS) {
    const town = region.cities.find(c => c.small);
    const club = startRoom(region.id);
    const townRoom = ROOMS.find(r => r.city === town.id && !r.local);
    const cityRooms = ROOMS.filter(r => r.city !== town.id && region.cities.some(c => c.id === r.city));
    assert.ok(tables(townRoom) > tables(club), `${townRoom.name} has more than ${club.name}`);
    for (const r of cityRooms) assert.ok(tables(r) > tables(townRoom), `${r.name} has more than ${townRoom.name}`);
  }
});

test('home is the town’s club, which only you know; the lobby says when you’re home', () => {
  const q = startIn(newQuest(T0, 4), 'tx', 'clubmesquite', 'mesquite');
  assert.equal(homeRoomOf(q).id, 'clubmesquite');
  assert.equal(knownRoom(q, roomById('clubmesquite')), true);
  assert.equal(knownRoom(q, roomById('clubcactus')), false);
  const atHome = questLobbyHtml(q, T0);
  assert.match(atHome, /class="qw-home-badge">Home · Mesquite Flats</);
  assert.doesNotMatch(atHome, /data-qgohome="go"/);
  // In town but at the card room: still home, and the club's a step away.
  const inTown = questLobbyHtml({...q, room: 'mesquite'}, T0);
  assert.match(inTown, /qw-home-badge/);
  assert.match(inTown, /Back to Dot’s Back Room/);
  // Away: no badge, and the way home.
  const away = questLobbyHtml({...q, room: 'deuce'}, T0);
  assert.doesNotMatch(away, /qw-home-badge/);
  assert.match(away, /data-qgohome="go"[^>]*>Go home to Dot’s Back Room · 2:00:00 · \$40</);
  assert.doesNotMatch(away, /data-qgo="clubcactus"/);
});

test('going home lands at the club, awake', () => {
  const q = {...startIn(newQuest(T0, 4), 'tx', 'clubmesquite', 'mesquite'), room: 'deuce'};
  const minutes = travelMinutes(roomById('deuce'), homeRoomOf(q));
  const going = travel(q, 'clubmesquite', minutes, T0, 4000, null);
  const home = arrive(going, T0 + (minutes / QUEST_SPEED) * 60000 + 1000);
  assert.equal(home.room, 'clubmesquite');
  assert.equal(home.rest, null);
});

test('countdowns show game time: 30 real seconds is 2 game minutes', () => {
  assert.equal(QUEST_SPEED, 4);
  assert.equal(gameClock(30 * 1000), '2:00');
  // A 2-hour drive takes 30 real minutes and reads 2:00:00 at the start.
  assert.equal(gameClock(30 * 60 * 1000), '2:00:00');
});

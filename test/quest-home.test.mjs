// Bankroll Quest's home (#299): a small local club in every city, known
// only where you live, and a way home from anywhere at any time. Times in
// the lobby are game time, ticking as fast as its clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrive, newQuest, startIn, travel } from '../src/quest.js';
import { QUEST_SPEED } from '../src/quest.js';
import { REGIONS, ROOMS, homeRoomOf, knownRoom, roomById, travelMinutes } from '../src/quest-rooms.js';
import { gameClock, questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);

test('every city has a small local club with a $1/$2 game', () => {
  for (const region of REGIONS) {
    for (const city of region.cities) {
      const club = ROOMS.find(r => r.local && r.city === city.id);
      assert.ok(club, `${city.name} has a club`);
      assert.ok(club.games.some(g => g.stakes === '1/2' && !g.game && g.chance == null), `${club.name} runs $1/$2 Hold’em`);
      assert.doesNotMatch(club.id, /-/, 'room ids have no dashes');
    }
  }
});

test('your home is your city’s club; only your own city’s club is known', () => {
  const q = startIn(newQuest(T0, 4), 'tx', 'mesquite', 'mesquite');
  assert.equal(homeRoomOf(q).id, 'clubmesquite');
  assert.equal(knownRoom(q, roomById('clubmesquite')), true);
  assert.equal(knownRoom(q, roomById('clubaustin')), false);
  assert.equal(knownRoom(q, roomById('deuce')), true);
  // Moved to Austin: its club is home now.
  const moved = {...q, homeCity: 'austin'};
  assert.equal(homeRoomOf(moved).id, 'clubaustin');
  assert.equal(knownRoom(moved, roomById('clubmesquite')), false);
});

test('away from home, the lobby offers the way home; going home lands at the club, awake', () => {
  const q = {...startIn(newQuest(T0, 4), 'tx', 'mesquite', 'mesquite'), room: 'deuce'};
  const html = questLobbyHtml(q, T0);
  assert.match(html, /data-qgohome="go"/);
  // Another city's club isn't listed, but yours is.
  assert.match(html, /data-qgo="clubmesquite"/);
  assert.doesNotMatch(html, /data-qgo="clubaustin"/);
  const minutes = travelMinutes(roomById('deuce'), homeRoomOf(q));
  const going = travel(q, 'clubmesquite', minutes, T0, 4000, null);
  assert.equal(going.trip.to, 'clubmesquite');
  const home = arrive(going, T0 + (minutes / QUEST_SPEED) * 60000 + 1000);
  assert.equal(home.room, 'clubmesquite');
  assert.equal(home.rest, null);
  // At the club itself there's nowhere to go home to.
  assert.doesNotMatch(questLobbyHtml(home, T0 + (minutes / QUEST_SPEED) * 60000 + 2000), /data-qgohome="go"/);
});

test('countdowns show game time: 30 real seconds is 2 game minutes', () => {
  assert.equal(QUEST_SPEED, 4);
  assert.equal(gameClock(30 * 1000), '2:00');
  // A 2-hour drive takes 30 real minutes and reads 2:00:00 at the start.
  assert.equal(gameClock(30 * 60 * 1000), '2:00:00');
});

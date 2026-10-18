// The Bankroll Challenge's life on the road (#351): what trips, moving and
// hotels cost, twelve hours at the tables at most, and sleep.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TABLE_MINUTES, SLEEP_MINUTES, START_BANKROLL, arrive, exhausted, gameMinutes, joinList, leave, moveHome, newQuest, sitDown, sleep, startIn,
  tableMinutes, travel, wake,
} from '../src/quest.js';
import { HOTEL, MOVE_COST, STAKES, TRIP_COST, homeCityOf, hotelCost, moveCost, roomById, travelMinutes, tripCost } from '../src/quest-rooms.js';
import { questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);
// Real time after `m` game minutes (the clock runs four times real time).
const later = m => T0 + (m / 4) * 60000;

test('trips cost gas or airfare; moving costs more; a hotel night by the size of the place', () => {
  const mesquite = roomById('mesquite'), deuce = roomById('deuce'), harbor = roomById('harbor'), ivory = roomById('ivory'), sunset = roomById('sunset');
  assert.equal(tripCost(ivory, sunset), TRIP_COST.town, 'across town');
  assert.equal(tripCost(mesquite, deuce), TRIP_COST.region, 'another city: gas');
  assert.equal(tripCost(mesquite, harbor), TRIP_COST.far, 'another region: airfare');
  assert.ok(TRIP_COST.far > TRIP_COST.region && TRIP_COST.region > TRIP_COST.town);
  assert.equal(moveCost(mesquite.city, deuce), MOVE_COST.region);
  assert.equal(moveCost(mesquite.city, harbor), MOVE_COST.far);
  assert.equal(moveCost(deuce.city, deuce), 0, 'already home');
  assert.equal(hotelCost(mesquite), HOTEL.small);
  assert.equal(hotelCost(deuce), HOTEL.city);
  // A trip takes its fare from the bankroll, and isn't taken if it can't be paid.
  let q = startIn(newQuest(T0, 1), 'tx', 'mesquite', mesquite.city);
  assert.equal(homeCityOf(q), mesquite.city);
  const t = travel(q, 'deuce', travelMinutes(mesquite, deuce), T0, tripCost(mesquite, deuce));
  assert.equal(t.bankroll, START_BANKROLL - TRIP_COST.region);
  const poor = {...q, bankroll: 1000};
  assert.equal(travel(poor, 'harbor', travelMinutes(mesquite, harbor), T0, tripCost(mesquite, harbor)), poor);
  // Moving home: pay, and this city is home.
  q = {...arrive(t, later(travelMinutes(mesquite, deuce))), clock: t.clock};
  assert.equal(q.room, 'deuce');
  const moved = moveHome(q, deuce.city, moveCost(mesquite.city, deuce));
  assert.equal(moved.homeCity, deuce.city);
  assert.equal(moved.bankroll, q.bankroll - MOVE_COST.region);
});

test('twelve hours at the tables at most, then sleep: at home free, in a hotel for a night', () => {
  let q = startIn(newQuest(T0, 2), 'tx', 'deuce', roomById('deuce').city);
  const table = {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']};
  q = sitDown(q, table, 20000, roomById('deuce'), T0);
  assert.ok(q.seat);
  assert.equal(tableMinutes(q, later(90)), 90);
  assert.ok(!exhausted(q, later(MAX_TABLE_MINUTES - 1)));
  assert.ok(exhausted(q, later(MAX_TABLE_MINUTES)));
  // Leaving keeps the hours; played out, no list and no seat until you sleep.
  q = leave(q, later(MAX_TABLE_MINUTES));
  assert.equal(q.tableMinutes, MAX_TABLE_MINUTES);
  const now = later(MAX_TABLE_MINUTES);
  assert.equal(sitDown(q, table, 20000, roomById('deuce'), now), null);
  assert.equal(joinList(q, {key: 'k', stakes: '1/2'}, 0, 4, now), q);
  // Sleep at home: no cost, six game hours on the clock, then rested.
  const asleep = sleep(q, 'home', 0, now);
  assert.equal(asleep.rest.end - asleep.rest.start, SLEEP_MINUTES);
  assert.equal(asleep.bankroll, q.bankroll);
  assert.equal(wake(asleep, later(MAX_TABLE_MINUTES + SLEEP_MINUTES - 1)), asleep, 'still asleep');
  const up = wake(asleep, later(MAX_TABLE_MINUTES + SLEEP_MINUTES));
  assert.equal(up.rest, null);
  assert.equal(up.tableMinutes, 0);
  // A hotel night costs; no trips while asleep.
  const hotel = sleep(q, 'hotel', HOTEL.city, now);
  assert.equal(hotel.bankroll, q.bankroll - HOTEL.city);
  assert.equal(travel(hotel, 'harbor', 360, now, 0), hotel);
});

test('going home to sleep: the trip, then bed on arrival', () => {
  const deuce = roomById('deuce'), mesquite = roomById('mesquite');
  let q = startIn(newQuest(T0, 3), 'tx', 'mesquite', mesquite.city);
  q = {...q, room: 'deuce', tableMinutes: MAX_TABLE_MINUTES};
  const mins = travelMinutes(deuce, mesquite);
  const t = travel(q, 'mesquite', mins, T0, tripCost(deuce, mesquite), 'sleep');
  const home = arrive(t, later(mins));
  assert.equal(home.room, 'mesquite');
  assert.equal(home.rest.where, 'home');
  assert.equal(home.rest.end, gameMinutes(t, T0) + mins + SLEEP_MINUTES);
  const rested = arrive(t, later(mins + SLEEP_MINUTES));
  assert.equal(rested.rest, null, 'long after: home and rested');
  assert.equal(rested.tableMinutes, 0);
});

test('the lobby shows home, hours at the tables, fares, rest and moving', () => {
  const mesquite = roomById('mesquite');
  let q = startIn(newQuest(T0, 4), 'tx', 'mesquite', mesquite.city);
  q = {...q, room: 'deuce'};
  const html = questLobbyHtml(q, T0);
  assert.match(html, /Home<\/span><b>[^<]+<\/b>/);
  assert.match(html, /At the tables<\/span><b[^>]*>0m of 12h/);
  assert.match(html, /data-qsleep="hotel"/);
  assert.match(html, /data-qgohome="1"/);
  assert.match(html, /data-qmovehome="1"/);
  assert.match(html, /Go there · [\d:]+ · \$300/);
  // Played out: the rest card says so, and no names go down.
  const tired = questLobbyHtml({...q, tableMinutes: MAX_TABLE_MINUTES}, T0);
  assert.match(tired, /You’re exhausted/);
  assert.doesNotMatch(tired, /data-qlist=/);
  // Asleep: the night, with a countdown.
  const asleep = questLobbyHtml(sleep(q, 'hotel', HOTEL.city, T0), T0);
  assert.match(asleep, /Asleep/);
  assert.match(asleep, /data-qcount="\d+"/);
  // At home: sleep there, no hotel.
  const home = questLobbyHtml({...q, room: 'mesquite'}, T0);
  assert.match(home, /data-qsleep="home"/);
  assert.doesNotMatch(home, /data-qsleep="hotel"|data-qmovehome/);
});

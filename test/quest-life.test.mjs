// The Bankroll Challenge's life on the road (#351): what trips, moving and
// hotels cost, twelve hours at the tables at most, and sleep.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TABLE_MINUTES, SLEEP_MINUTES, START_BANKROLL, arrive, exhausted, gameMinutes, joinList, leave, moveHome, newQuest, resume, sitDown, sleep, startIn, syncClock,
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
  // Hands every half minute keep the clock running (each moves its anchor).
  const play = (from, to) => { for (let m = from + 2; m <= to; m += 2) q = syncClock(q, later(m)); };
  play(0, 90);
  assert.equal(tableMinutes(q, later(90)), 90);
  play(90, MAX_TABLE_MINUTES - 2);
  assert.ok(!exhausted(q, later(MAX_TABLE_MINUTES - 2)));
  play(MAX_TABLE_MINUTES - 2, MAX_TABLE_MINUTES);
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

test('time away stops the clock, except to finish a trip or a night', () => {
  const deuce = roomById('deuce');
  const q = startIn(newQuest(T0, 5), 'tx', 'deuce', deuce.city);
  const start = gameMinutes(q, T0);
  const DAY_MS = 24 * 3600000;
  // A day away in the lobby: the clock hasn't moved.
  assert.equal(resume(q, T0 + DAY_MS).clock.game, start);
  // A minute away (a reload) is just time passing.
  assert.equal(resume(q, T0 + 60000).clock.game, start + 4);
  // Away on a trip: the clock runs to the end of it, then stops.
  const t = travel(q, 'harbor', 360, T0, 0);
  const back = resume(t, T0 + DAY_MS);
  assert.equal(back.clock.game, t.trip.end);
  assert.equal(arrive(back, T0 + DAY_MS).room, 'harbor');
  // Away asleep: up at the end of the night, not a minute later.
  const night = sleep(q, 'home', 0, T0);
  const up = resume(night, T0 + DAY_MS);
  assert.equal(up.clock.game, night.rest.end);
  assert.equal(wake(up, T0 + DAY_MS).rest, null);
  // Away part-way through a night: the clock moves only as far as the time away.
  assert.equal(resume(night, T0 + 30 * 60000).clock.game, start + 120);
  // Going home to sleep: the trip and the night both finish while away.
  const homeward = travel({...q, room: 'mesquite'}, 'deuce', 120, T0, 0, 'sleep');
  assert.equal(resume(homeward, T0 + DAY_MS).clock.game, homeward.trip.end + SLEEP_MINUTES);
});

test('at a table the clock waits when no hand is played for a minute', () => {
  let q = startIn(newQuest(T0, 6), 'tx', 'deuce', roomById('deuce').city);
  q = sitDown(q, {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']}, 20000, roomById('deuce'), T0);
  const start = gameMinutes(q, T0);
  assert.equal(gameMinutes(q, T0 + 30000), start + 2, 'half a minute of play is two game minutes');
  assert.equal(gameMinutes(q, T0 + 60000), start + 4);
  assert.equal(gameMinutes(q, T0 + 10 * 60000), start + 4, 'ten minutes with no hand: stopped at a minute');
  // Leaving then keeps that time: no jump for the idle minutes.
  const left = leave(q, T0 + 10 * 60000);
  assert.equal(gameMinutes(left, T0 + 10 * 60000), start + 4);
  assert.equal(left.tableMinutes, 4);
});

test('the lobby shows home, hours at the tables, fares, rest and moving', () => {
  const mesquite = roomById('mesquite');
  let q = startIn(newQuest(T0, 4), 'tx', 'mesquite', mesquite.city);
  q = {...q, room: 'deuce'};
  const html = questLobbyHtml(q, T0);
  assert.match(html, /Home<\/span><b>[^<]+<\/b>/);
  assert.match(html, /At the tables<\/span><b[^>]*>0m of 12h/);
  assert.match(html, /data-qsleep="hotel"/);
  assert.match(html, /data-qgohome="sleep"/);
  assert.match(html, /data-qmovehome="1"/);
  // Times are game time, like the clock: another region is 6 hours away.
  assert.match(html, /Go there · 6:00:00 · \$300/);
  // Away from home, you can go home any time, to your local club.
  assert.match(html, /data-qgohome="go"[^>]*>Go home to Dot’s Back Room · 2:00:00 · \$40</);
  // Played out: the rest card says so, and no names go down.
  const tired = questLobbyHtml({...q, tableMinutes: MAX_TABLE_MINUTES}, T0);
  assert.match(tired, /You’re exhausted/);
  assert.doesNotMatch(tired, /data-qlist=/);
  // Asleep: the night, with a countdown.
  const asleep = questLobbyHtml(sleep(q, 'hotel', HOTEL.city, T0), T0);
  assert.match(asleep, /Asleep/);
  assert.match(asleep, /data-qcount="\d+"/);
  assert.match(asleep, /Come back at [^<]+ and you’ll be rested/);
  assert.match(html, /The clock stops while you’re away/);
  // At home: sleep there, no hotel.
  const home = questLobbyHtml({...q, room: 'mesquite'}, T0);
  assert.match(home, /data-qsleep="home"/);
  assert.doesNotMatch(home, /data-qsleep="hotel"|data-qmovehome/);
});

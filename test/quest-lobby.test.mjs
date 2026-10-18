// Bankroll quest's lobby (#303) and line-ups (#302): who sits where, travel,
// runs ending, and the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { START_BANKROLL, newQuest, newRun, sitDown, leave, travel, gameMinutes } from '../src/quest.js';
import { ROOMS, STAKES, TRAVEL_MINUTES, lobby } from '../src/quest-rooms.js';
import { LINEUP_SEATS, POOLS, WHALES, lineupFor, poolFor, replacementPool } from '../src/quest-lineup.js';
import { buyInChoices, currentRoom, goalProgress, questLobbyHtml } from '../src/quest-ui.js';

const T0 = Date.UTC(2026, 9, 17);

test('line-ups come from the stakes’ pool, whales only in big games', () => {
  for (const stakes of Object.keys(STAKES)) {
    let whales = 0;
    for (let block = 0; block < 200; block++) {
      const who = lineupFor(7, `t-${stakes}`, stakes, block * 120);
      assert.equal(who.length, LINEUP_SEATS);
      assert.equal(new Set(who).size, LINEUP_SEATS, 'five different Regulars');
      for (const id of who) assert.ok(POOLS[poolFor(stakes)].includes(id) || WHALES.includes(id), `${id} at ${stakes}`);
      if (who.some(id => WHALES.includes(id))) whales++;
    }
    if (poolFor(stakes) === 'high') assert.ok(whales > 30 && whales < 120, `${stakes}: whales in ${whales} of 200`);
    else assert.equal(whales, 0, `${stakes} never has a whale`);
  }
  // The softest Regulars play small, the toughest big.
  assert.ok(POOLS.low.includes('rampart') && !POOLS.high.includes('rampart'));
  assert.ok(POOLS.high.includes('doug_poker') && !POOLS.low.includes('doug_poker'));
  // The same table keeps its line-up through a block, and changes after.
  assert.deepEqual(lineupFor(7, 'x', '1/2', 10), lineupFor(7, 'x', '1/2', 100));
  assert.notDeepEqual(lineupFor(7, 'x', '1/2', 10), lineupFor(7, 'x', '1/2', 10 + 600));
  // Only Regulars this engine has.
  assert.deepEqual(lineupFor(7, 'x', '1/2', 0, ['rampart', 'jen_silly']).sort(), ['jen_silly', 'rampart']);
  assert.ok(replacementPool('50/100').every(id => POOLS.high.includes(id)));
});

test('travelling takes game time; a run that ends starts again at $1,000 and is remembered', () => {
  let q = newQuest(T0, 3);
  const t = travel(q, 'harbor', TRAVEL_MINUTES, T0);
  assert.equal(t.room, 'harbor');
  assert.equal(gameMinutes(t, T0), gameMinutes(q, T0) + TRAVEL_MINUTES);
  // Not while seated.
  const seated = sitDown(q, {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']}, 20000);
  assert.equal(travel(seated, 'harbor', TRAVEL_MINUTES, T0), seated);
  q = leave({...seated, seat: {...seated.seat, stack: 0}}, T0);
  assert.equal(q.bankroll, START_BANKROLL - 20000);
  const next = newRun({...q, best: 150000}, T0, 'broke');
  assert.equal(next.bankroll, START_BANKROLL);
  assert.equal(next.history.length, 0);
  assert.equal(next.seed, q.seed, 'the same world');
  assert.deepEqual(next.runs.map(r => [r.result, r.peak, r.sessions]), [['broke', 150000, 1]]);
});

test('the lobby: bankroll, clock, goal; affordable tables and buy-ins; other rooms', () => {
  const q = newQuest(T0, 5);
  assert.equal(goalProgress(START_BANKROLL), 0);
  assert.ok(Math.abs(goalProgress(START_BANKROLL * 1000) - 1) < 1e-9);
  assert.ok(Math.abs(goalProgress(START_BANKROLL * Math.sqrt(1000)) - 0.5) < 1e-9, 'halfway at $31,623');
  assert.equal(currentRoom(q).id, ROOMS[0].id);
  const html = questLobbyHtml(q, T0);
  assert.match(html, /\$1,000/);
  assert.match(html, /Fri 6:00 pm/);
  assert.match(html, new RegExp(ROOMS[0].name));
  for (const r of ROOMS.slice(1)) assert.match(html, new RegExp(`data-qgo="${r.id}"`));
  // A table you can't afford has no buy-ins; one you can lists them.
  const room = ROOMS[0];
  // $1,000 covers 200 BB at 2/5 ($1,000) but not at 5/10 ($2,000).
  assert.deepEqual(buyInChoices(q, '2/5', room).map(c => [c.bb, c.ok]), [[40, true], [100, true], [200, true]]);
  assert.deepEqual(buyInChoices(q, '5/10', room).map(c => [c.bb, c.ok]), [[40, true], [100, true], [200, false]]);
  const poor = {...q, bankroll: 5000};
  const poorHtml = questLobbyHtml(poor, T0);
  assert.ok(!/data-qsit/.test(poorHtml) || /Broke/.test(poorHtml));
  // Broke: the run is over, with a way to start again.
  assert.match(questLobbyHtml({...q, bankroll: 100}, T0), /data-qnew="broke"/);
  // The lobby reflects the schedule: what lobby() runs is what's listed here.
  const here = lobby(q.seed, gameMinutes(q, T0)).find(r => r.room.id === room.id);
  for (const g of here.games) for (const id of g.ids) assert.match(html, new RegExp(`data-qsit="${id}"`));
});

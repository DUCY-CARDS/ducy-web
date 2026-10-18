// Bankroll quest's lobby (#303) and line-ups (#302): who sits where, travel,
// runs ending, and the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { START_BANKROLL, newQuest, newRun, sitDown, leave, travel, gameMinutes } from '../src/quest.js';
import { ROOMS, STAKES, TRAVEL_MINUTES, lobby } from '../src/quest-rooms.js';
import { LINEUP_SEATS, POOLS, WHALES, buyInFor, lineupFor, poolFor, replacementPool, stacksAt } from '../src/quest-lineup.js';
import { buyInAsk, currentRoom, goalProgress, questLobbyHtml } from '../src/quest-ui.js';
import { betweenHands, startBank } from '../src/regulars.js';

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
  // The buy-in you're asked for: the room's range, as far as the bankroll
  // goes, starting at 100 BB. $1,000 covers 200 BB at 2/5 but not at 5/10.
  const room = ROOMS[0];
  assert.deepEqual(buyInAsk(q, STAKES['2/5'], room), {min: 20000, max: 100000, most: 100000, start: 50000});
  assert.deepEqual(buyInAsk(q, STAKES['5/10'], room), {min: 40000, max: 200000, most: 100000, start: 100000});
  assert.equal(buyInAsk({...q, bankroll: 5000}, STAKES['1/2'], room), null);
  // Broke: the run is over, with a way to start again.
  assert.match(questLobbyHtml({...q, bankroll: 100}, T0), /data-qnew="broke"/);
  // The lobby reflects the schedule: every table running is listed, to open.
  const here = lobby(q.seed, gameMinutes(q, T0)).find(r => r.room.id === room.id);
  for (const g of here.games) for (const id of g.ids) assert.match(html, new RegExp(`data-qopen="${id}"`));
  // No buy-in is chosen on the card: you open the table and say how much.
  assert.doesNotMatch(html, /data-qsit/);
  const g = here.games[0], id = g.ids[0];
  const open = questLobbyHtml(q, T0, {open: id});
  assert.match(open, /How much do you want to buy in for\?/);
  assert.match(open, new RegExp(`data-qsit="${id}"`));
  assert.match(open, /id="qt-amt"[^>]*value="200"/, '100 BB at 1/2 to start');
  // Each Regular there shows the chips in front of them.
  const who = lineupFor(q.seed, id, g.stakes, gameMinutes(q, T0));
  for (const s of stacksAt(q.seed, id, who, g.blinds, room, gameMinutes(q, T0))) assert.ok(open.includes(`$${(s / 100).toLocaleString('en-US')}`));
  // A typed amount survives a redraw, kept within what you can take.
  assert.match(questLobbyHtml(q, T0, {open: id, amount: 31400}), /id="qt-amt"[^>]*value="314"/);
  assert.match(questLobbyHtml(q, T0, {open: id, amount: 10 ** 9}), /id="qt-amt"[^>]*value="400"/);
});

test('Regulars buy in for different amounts, and top up to their own', () => {
  const room = ROOMS[0];
  const blinds = STAKES['1/2'];
  const {min, max} = {min: 40 * blinds[1], max: 200 * blinds[1]};
  const seen = new Set();
  for (let t = 0; t < 40; t++) {
    const who = lineupFor(11, `t${t}`, '1/2', 0);
    for (const id of who) {
      const b = buyInFor(11, `t${t}`, id, blinds, room, 0);
      assert.ok(b >= min && b <= max, `${id}: ${b}`);
      assert.equal(b, buyInFor(11, `t${t}`, id, blinds, room, 100), 'the same through a block');
      seen.add(b);
    }
    for (const s of stacksAt(11, `t${t}`, who, blinds, room, 0)) assert.ok(s > 0 && s % blinds[1] === 0);
  }
  assert.ok(seen.size >= 4, `buy-ins vary: ${[...seen]}`);
  // Whales buy in for the most.
  assert.equal(buyInFor(11, 'x', 'milk_king', STAKES['25/50'], room, 0), 200 * STAKES['25/50'][1]);
  // Between hands each tops up to their own buy-in; a newcomer brings theirs.
  const r = betweenHands({
    stacks: [0, 3000, 30000, 0], bank: [0, 99999, 99999, 0], bots: ['a', 'b', 'c'], buyIn: 20000, all: ['a', 'b', 'c', 'd'],
    buyIns: [0, 8000, 40000, 20000], buyInOf: () => 12000, rng: () => 0.99, leaveChance: 0,
  });
  assert.deepEqual(r.sets, [{seat: 1, chips: 8000}], 'seat 1 under half of $80 tops up to $80; seat 2 is over half of $400');
  assert.deepEqual(r.swaps.map(s => [s.seat, s.chips]), [[3, 12000]]);
  assert.deepEqual(r.buyIns, [0, 8000, 40000, 12000]);
  assert.deepEqual(startBank(['a', 'b'], 20000, [0, 8000, 40000]), [0, 16000, 80000]);
});

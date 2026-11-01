// Bankroll quest's lobby (#303) and line-ups (#302): who sits where, travel,
// runs ending, and the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { START_BANKROLL, newQuest, newRun, sitDown, leave, travel, arrive, gameMinutes } from '../src/quest.js';
import { REGIONS, ROOMS, STAKES, TRAVEL, lobby, roomById, travelMinutes } from '../src/quest-rooms.js';
import { LINEUP_SEATS, POOLS, WHALES, buyInFor, lineupFor, lineupStacks, poolFor, replacementPool, seatedHours, stacksAt } from '../src/quest-lineup.js';
import { buyInAsk, currentRoom, goalProgress, questLobbyHtml } from '../src/quest-ui.js';
import { betweenHands, startBank } from '../src/regulars.js';

const T0 = Date.UTC(2026, 9, 17);

test('a running game’s stacks are uneven: short buyers, deep winners', () => {
  const stakes = STAKES['1/2'];
  const room = ROOMS[0];
  const range = {min: 40 * stakes[1], max: 200 * stakes[1]};
  let over = 0, under = 0, all = 0;
  const weak = [], strong = [];
  for (let t = 0; t < 400; t++) {
    const bots = lineupFor(3, `s${t}`, '1/2', 500);
    const stacks = lineupStacks(3, `s${t}`, bots, stakes, room, 500);
    assert.equal(stacks.length, bots.length);
    assert.ok(new Set(stacks.map(s => s.stack)).size > 1, 'not all the same');
    stacks.forEach(({stack, buyIn}, i) => {
      assert.ok(stack > 0 && stack % 1 === 0, `stack ${stack}`);
      assert.ok(buyIn >= range.min && buyIn <= range.max, `buy-in ${buyIn}`);
      all++;
      if (stack > range.max) over++;
      if (stack < 100 * stakes[1]) under++;
      (['rampart', 'bungleman', 'jonny_slow'].includes(bots[i]) ? weak : ['phil_bigmouth', 'tom_collins', 'brad_owned'].includes(bots[i]) ? strong : []).push(buyIn);
    });
  }
  // Some winners sit over the maximum buy-in, plenty are under 100 BB.
  assert.ok(over > all * 0.03 && over < all * 0.4, `${over} of ${all} over the maximum`);
  assert.ok(under > all * 0.15, `${under} of ${all} under 100 BB`);
  // Weaker Regulars buy in for less, on average.
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(weak) < mean(strong), `weak ${mean(weak)} v strong ${mean(strong)}`);
  // The same through the block.
  const bots = lineupFor(3, 'k', '1/2', 10);
  assert.deepEqual(lineupStacks(3, 'k', bots, stakes, room, 10).map(s => s.buyIn), lineupStacks(3, 'k', bots, stakes, room, 100).map(s => s.buyIn));
});

test('now and then a player who has been there a while sits on 2-3x, even 5-10x, the max buy-in', () => {
  // The shares a hand-by-hand simulation of live tables gave (quest-lineup.js).
  const stakes = STAKES['25/50'];
  const room = ROOMS[0];
  const max = 200 * stakes[1];
  const marks = {1: 0, 2: 0, 3: 0, 5: 0, 10: 0};
  let all = 0, cap = 0;
  for (let t = 0; t < 4000; t++) {
    const bots = lineupFor(5, `deep${t}`, '25/50', 120 * t);
    for (const {stack} of lineupStacks(5, `deep${t}`, bots, stakes, room, 120 * t + 30)) {
      all++;
      for (const m of Object.keys(marks)) if (stack > m * max) marks[m]++;
      cap = Math.max(cap, stack);
    }
  }
  const share = m => marks[m] / all;
  assert.ok(share(1) > 0.25 && share(1) < 0.55, `over 1x: ${share(1)}`);
  assert.ok(share(2) > 0.04 && share(2) < 0.14, `over 2x: ${share(2)}`);
  assert.ok(share(3) > 0.01 && share(3) < 0.05, `over 3x: ${share(3)}`);
  assert.ok(share(5) > 0.001 && share(5) < 0.012, `over 5x: ${share(5)}`);
  assert.ok(share(10) < 0.002, `over 10x: ${share(10)}`);
  // Never past 12 max buy-ins.
  assert.ok(cap <= 12 * max, `deepest ${cap}`);
});

test('how long players have been sitting: mostly a few hours, some all day', () => {
  const hours = [];
  for (let i = 0; i < 2000; i++) hours.push(seatedHours((i + 0.5) / 2000, ((i * 7919) % 2000 + 0.5) / 2000));
  const share = f => hours.filter(f).length / hours.length;
  assert.ok(Math.abs(share(h => h < 2) - 0.29) < 0.01);
  assert.ok(Math.abs(share(h => h >= 12) - 0.178) < 0.01);
  assert.ok(Math.max(...hours) <= 36 && Math.min(...hours) >= 0);
});

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

test('a trip takes real time: you are on the road until it ends; a run that ends starts again', () => {
  let q = {...newQuest(T0, 3), room: 'deuce'};
  const mins = travelMinutes(roomById('deuce'), roomById('harbor'));
  assert.equal(mins, TRAVEL.far, 'Austin to Miami is another region');
  const t = travel(q, 'harbor', mins, T0);
  // The clock doesn't jump: you're on the road, still not there.
  assert.equal(gameMinutes(t, T0), gameMinutes(q, T0));
  assert.equal(t.room, 'deuce');
  assert.equal(arrive(t, T0 + 60000).room, 'deuce', 'a minute in, still on the road');
  // At four times real time, 6 game hours is 90 real minutes.
  const there = arrive(t, T0 + (mins / 4) * 60000);
  assert.equal(there.room, 'harbor');
  assert.equal(there.trip, null);
  // No second trip while on the road.
  assert.equal(travel(t, 'ivory', 24, T0), t);
  // Not while seated.
  const seated = sitDown(q, {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']}, 20000);
  assert.equal(travel(seated, 'harbor', mins, T0), seated);
  q = leave({...seated, seat: {...seated.seat, stack: 0}}, T0);
  assert.equal(q.bankroll, START_BANKROLL - 20000);
  const next = newRun({...q, best: 150000}, T0, 'broke');
  assert.equal(next.bankroll, START_BANKROLL);
  assert.equal(next.history.length, 0);
  assert.equal(next.seed, q.seed, 'the same world');
  assert.deepEqual(next.runs.map(r => [r.result, r.peak, r.sessions]), [['broke', 150000, 1]]);
});

test('the lobby: bankroll, clock, goal; games and their lists; buy-ins; other rooms', () => {
  // A new run starts by choosing where to put down roots.
  const fresh = newQuest(T0, 5);
  const pick = questLobbyHtml(fresh, T0);
  for (const r of REGIONS) assert.match(pick, new RegExp(`data-qstart="${r.id}"`));
  const q = {...fresh, room: 'deuce'};
  assert.equal(goalProgress(START_BANKROLL), 0);
  assert.ok(Math.abs(goalProgress(START_BANKROLL * 1000) - 1) < 1e-9);
  assert.ok(Math.abs(goalProgress(START_BANKROLL * Math.sqrt(1000)) - 0.5) < 1e-9, 'halfway at $31,623');
  assert.equal(currentRoom(q).id, 'deuce');
  const html = questLobbyHtml(q, T0);
  assert.match(html, /\$1,000/);
  assert.match(html, /Fri 6:00 pm/);
  assert.match(html, new RegExp(ROOMS[0].name));
  assert.match(html, /Austin, Texas/);
  // Every other room is listed, but not the cities' local clubs: this quest
  // has no home yet, so it knows none of them.
  for (const r of ROOMS.slice(1)) {
    if (r.local) assert.doesNotMatch(html, new RegExp(`data-qgo="${r.id}"`), r.id);
    else assert.match(html, new RegExp(`data-qgo="${r.id}"`), r.id);
  }
  // The buy-in you're asked for: the room's range, as far as the bankroll
  // goes, starting at 100 BB. $1,000 covers 200 BB at 2/5 but not at 5/10.
  const room = ROOMS[0];
  assert.deepEqual(buyInAsk(q, STAKES['2/5'], room), {min: 20000, max: 100000, most: 100000, start: 50000});
  assert.deepEqual(buyInAsk(q, STAKES['5/10'], room), {min: 40000, max: 200000, most: 100000, start: 100000});
  assert.equal(buyInAsk({...q, bankroll: 5000}, STAKES['1/2'], room), null);
  // Broke: the run is over, with a way to start again.
  assert.match(questLobbyHtml({...q, bankroll: 100}, T0), /data-qnew="broke"/);
  // The lobby lists the games running, each with its waitlist to join; no
  // table opens until your name is called.
  const here = lobby(q.seed, gameMinutes(q, T0)).find(r => r.room.id === room.id);
  for (const g of here.games) assert.match(html, new RegExp(`data-qlist="${g.game} ${g.stakes}"`));
  assert.doesNotMatch(html, /data-qopen|data-qsit/);
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

test('rooms spread pot-limit Omaha tables too, with their own ids', () => {
  const plo = ROOMS.flatMap(r => r.games.filter(g => g.game === 'plo4').map(g => `${r.id} ${g.stakes}`));
  assert.ok(plo.length >= 3, `Omaha games: ${plo.join(', ')}`);
  // Over a game week some Omaha tables run, ids apart from Hold'em's.
  const ids = new Set();
  let omaha = 0;
  for (let m = 0; m < 7 * 1440; m += 60) {
    for (const r of lobby(11, m)) {
      for (const g of r.games) {
        for (const id of g.ids) {
          assert.ok(!ids.has(`${m} ${id}`), `${id} twice`);
          ids.add(`${m} ${id}`);
        }
        if (g.game === 'plo4') {
          omaha++;
          assert.ok(g.ids.every(id => id.includes('-plo4-')), g.ids.join());
        } else {
          assert.equal(g.game, 'nlhe');
          assert.ok(g.ids.every(id => id === `${r.room.id}-${g.stakes}-${id.split('-').pop()}`), g.ids.join());
        }
      }
    }
  }
  assert.ok(omaha > 50, `Omaha tables ran in ${omaha} room-hours`);
});

test('an Omaha seat and its session remember the game', () => {
  const q = newQuest(T0, 3);
  const seated = sitDown(q, {id: 'harbor-plo4-2/5-1', room: 'harbor', stakes: STAKES['2/5'], game: 'plo4'}, 50000);
  assert.equal(seated.seat.game, 'plo4');
  assert.equal(leave(seated, T0).history.at(-1).game, 'plo4');
  // Hold'em by default.
  assert.equal(sitDown(q, {id: 'deuce-1/2-1', room: 'deuce', stakes: STAKES['1/2']}, 20000).seat.game, 'nlhe');
});

test('the lobby names an Omaha table’s game', () => {
  const q = {...newQuest(T0, 5), room: 'harbor'};
  // Find a time the Copper Harbor's 2/5 PLO runs.
  let at = null;
  for (let m = q.clock.game; m < q.clock.game + 7 * 1440 && at == null; m += 60) {
    if (lobby(q.seed, m).find(r => r.room.id === 'harbor').games.some(g => g.game === 'plo4')) at = m;
  }
  assert.ok(at != null);
  const html = questLobbyHtml(q, T0 + (at - q.clock.game) / 4 * 60000);
  assert.match(html, /Pot-limit Omaha · \d+ tables?/);
  assert.match(html, /data-qlist="plo4 2\/5"/);
});

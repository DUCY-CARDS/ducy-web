// The bots' table talk, from ducy-bot-games (#465): its own tests check every
// tone's and Regular's lines; these check what the page gets.
import './wasm.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { callShape, forgetRecent, handMoments, lineFor, linesFor, personaOf, replyMoment, speaks } from '../src/bot-chat.js';
import { CHAMPION, ORDER } from '../src/ladder.js';

const MOMENTS = ['greet', 'wonFromYou', 'lostToYou', 'bigWin', 'bigLoss', 'stakes', 'gameWon', 'gameLost', 'idle', 'hello', 'luck', 'nice', 'thanks', 'laugh', 'gg', 'other'];
const BOTS = [...ORDER, CHAMPION];

test('every bot has something to say at every moment, and no line repeats in a pool', () => {
  for (const id of BOTS) {
    for (const m of MOMENTS) {
      assert.ok(linesFor(id, m).length, `${id} ${m}`);
      for (const how of [null, 'youCalled', 'theyCalled']) {
        const pool = linesFor(id, m, how);
        assert.equal(new Set(pool).size, pool.length, `${id} ${m} ${how}: a repeated line`);
      }
    }
  }
});

test('a bot doesn’t repeat itself, or what the table just heard', () => {
  forgetRecent();
  let r = 0;
  const rng = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  const said = [];
  for (let i = 0; i < 8; i++) said.push(lineFor('jen_silly', 'greet', rng));
  assert.equal(new Set(said).size, said.length, said.join(' | '));
  // Two friendly bots don't echo each other.
  forgetRecent();
  const a = lineFor('jen_silly', 'lostToYou', () => 0);
  const b = lineFor('andrew_favorable', 'lostToYou', () => 0);
  assert.notEqual(a, b);
  forgetRecent();
  assert.equal(lineFor('jen_silly', 'no such moment', () => 0), null);
});

test('some Regulars are nice and some trash talk', () => {
  const tones = new Set(ORDER.map(id => personaOf(id).tone));
  assert.ok(tones.has('friendly') && tones.has('needle'));
  assert.equal(personaOf('phil_bigmouth').tone, 'needle');
  assert.equal(personaOf('jen_silly').tone, 'friendly');
  assert.equal(personaOf('milk_king').tone, 'friendly');
  // Every GTO bot is the robot; an unknown bot talks like a friendly one.
  assert.equal(personaOf('gto-plo6').tone, 'robot');
  assert.equal(personaOf('someone_new').tone, 'friendly');
  // The Bankroll Challenge's generic players talk by family.
  assert.equal(personaOf('g-maniac-17').tone, 'needle');
});

test('Danny and Tommy tilt when they lose a pot, and nobody else does', () => {
  forgetRecent();
  for (const m of ['lostToYou', 'bigLoss', 'gameLost']) {
    const danny = linesFor('danny_smallball', m);
    assert.ok(!danny.some(l => linesFor('andrew_favorable', m).includes(l)), `${m}: not the friendly lines`);
    assert.ok(danny.includes(lineFor('danny_smallball', m, () => 0)), m);
    for (const line of linesFor('tommy_sweeden', m)) assert.match(line, /Kuksugare/, m);
  }
  // Friendly while winning.
  assert.ok(linesFor('danny_smallball', 'greet').some(l => linesFor('andrew_favorable', 'greet').includes(l)));
});

test('a bot’s own lines are its own', () => {
  const kings = linesFor('milk_king', 'greet');
  assert.ok(kings.includes('Let’s gamble! The King is here!'));
  assert.ok(!linesFor('jen_silly', 'greet').includes('Let’s gamble! The King is here!'));
});

test('they talk more heads-up, and always at the end of a challenge game', () => {
  const rate = (id, headsUp) => {
    let n = 0;
    for (let i = 0; i < 1000; i++) if (speaks(id, 'wonFromYou', {headsUp, rng: () => i / 1000})) n++;
    return n / 1000;
  };
  assert.ok(rate('tommy_sweeden', true) > rate('tommy_sweeden', false) * 2);
  assert.ok(rate('phil_bigmouth', false) > rate('tommy_sweeden', false));
  assert.ok(speaks('tommy_sweeden', 'gameWon', {rng: () => 0.999}));
  assert.ok(speaks('tommy_sweeden', 'greet', {ladder: true, rng: () => 0.999}));
});

test('your chat is read for a reply', () => {
  assert.equal(replyMoment('gl hf'), 'luck');
  assert.equal(replyMoment('Nice hand!'), 'nice');
  assert.equal(replyMoment('gg wp'), 'gg');
  assert.equal(replyMoment('hey there'), 'hello');
  assert.equal(replyMoment('hey, nice to meet you'), 'hello');
  assert.equal(replyMoment('ok nice one'), 'nice');
  assert.equal(replyMoment('lol'), 'laugh');
  assert.equal(replyMoment('what time is it'), 'other');
});

test('a hand gives the bot it concerned something to say', () => {
  const seats = nets => nets.map(net => ({net}));
  assert.deepEqual(handMoments(seats([-6000, -200, 6200]), 200), [{seat: 2, moment: 'wonFromYou'}]);
  assert.deepEqual(handMoments(seats([4000, -4000, 0]), 200), [{seat: 1, moment: 'lostToYou'}]);
  assert.deepEqual(handMoments(seats([0, 8000, -8000]), 200), [{seat: 1, moment: 'bigWin'}]);
  assert.deepEqual(handMoments(seats([-200, 300, -100]), 200), []);
});

test('a bot never says "good call" about its own call', () => {
  const seats = nets => nets.map(net => ({net}));
  const youBet = [{type: 'bet', seat: 1, to: 400}, {type: 'call', seat: 0}, {type: 'board'}, {type: 'bet', seat: 0, to: 2000}, {type: 'call', seat: 1}];
  assert.equal(callShape(youBet, 1), 'theyCalled');
  assert.deepEqual(handMoments(seats([4000, -4000, 0]), 200, youBet), [{seat: 1, moment: 'lostToYou', how: 'theyCalled'}]);
  const theyBet = [{type: 'bet', seat: 1, to: 2000}, {type: 'call', seat: 0}];
  assert.equal(callShape(theyBet, 1), 'youCalled');
  assert.equal(callShape([{type: 'check', seat: 0}, {type: 'check', seat: 1}], 1), null);
  assert.equal(callShape(null, 1), null);
  for (const id of BOTS) {
    for (const moment of ['lostToYou', 'wonFromYou']) {
      for (const line of linesFor(id, moment, 'theyCalled')) {
        assert.ok(!/good call|nice call|correct call|hero call\. I|you called|keep calling|you can fold|paid me off|paying me off|thanks for the call|learn to fold|for the call|appreciate the call/i.test(line), `${id} ${moment}: ${line}`);
      }
      for (const plain of linesFor(id, moment)) assert.ok(!/\bcall/i.test(plain), `${id} ${moment} without how: ${plain}`);
    }
  }
  assert.ok(linesFor('jen_silly', 'lostToYou', 'youCalled').includes('Good call.'));
});

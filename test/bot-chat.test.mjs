import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINES, OWN, PERSONAS, SWEDISH_TILT_LINES, TILT_LINES, callShape, forgetRecent, handMoments, lineFor, linesFor, personaOf, replyMoment, speaks,
} from '../src/bot-chat.js';

const MOMENTS = ['greet', 'wonFromYou', 'lostToYou', 'bigWin', 'bigLoss', 'stakes', 'gameWon', 'gameLost', 'idle', 'hello', 'luck', 'nice', 'thanks', 'laugh', 'gg', 'other'];
// The moments that come up most: each tone has plenty to say at them.
const OFTEN = ['greet', 'wonFromYou', 'lostToYou', 'bigWin', 'bigLoss', 'idle', 'other'];

test('every tone has lines for every moment, and plenty for the common ones', () => {
  for (const [tone, lines] of Object.entries(LINES)) {
    for (const m of MOMENTS) assert.ok(lines[m]?.length, `${tone} ${m}`);
    for (const m of OFTEN) assert.ok(lines[m].length >= 6, `${tone} ${m}: ${lines[m].length}`);
  }
  for (const p of Object.values(PERSONAS)) assert.ok(LINES[p.tone], p.tone);
});

test('every Regular has lines of their own, and no line repeats in a pool', () => {
  for (const id of Object.keys(PERSONAS).filter(id => id !== 'gto')) {
    assert.ok(OWN[id], id);
    for (const m of ['greet', 'idle', 'other']) assert.ok(OWN[id][m]?.length, `${id} ${m}`);
  }
  for (const id of Object.keys(PERSONAS)) {
    for (const m of MOMENTS) {
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
});

test('some Regulars are nice and some trash talk', () => {
  const tones = new Set(Object.values(PERSONAS).map(p => p.tone));
  assert.ok(tones.has('friendly') && tones.has('needle'));
  assert.equal(personaOf('phil_bigmouth').tone, 'needle');
  assert.equal(personaOf('jen_silly').tone, 'friendly');
  assert.equal(personaOf('bungleman').tone, 'needle');
  assert.equal(personaOf('milk_king').tone, 'friendly');
  assert.equal(personaOf('andrew_favorable').tone, 'friendly');
  // Every GTO bot is the robot; an unknown bot talks like a friendly one.
  assert.equal(personaOf('gto-plo6').tone, 'robot');
  assert.equal(personaOf('someone_new').tone, 'friendly');
});

test('Danny is friendly, until he loses a pot', () => {
  forgetRecent();
  assert.ok(LINES.friendly.greet.includes(lineFor('danny_smallball', 'greet', () => 0)));
  assert.ok(LINES.friendly.wonFromYou.includes(lineFor('danny_smallball', 'wonFromYou', () => 0)));
  for (const m of ['lostToYou', 'bigLoss', 'gameLost']) {
    assert.deepEqual(linesFor('danny_smallball', m), TILT_LINES[m], m);
    assert.ok(TILT_LINES[m].includes(lineFor('danny_smallball', m, () => 0)), m);
  }
  // Nobody else tilts.
  assert.ok(LINES.friendly.lostToYou.includes(lineFor('jen_silly', 'lostToYou', () => 0)));
});

test('Tommy is cool, until he loses a pot: then Kuksugare', () => {
  forgetRecent();
  assert.ok(LINES.cool.greet.includes(lineFor('tommy_sweeden', 'greet', () => 0)));
  assert.ok(LINES.cool.wonFromYou.includes(lineFor('tommy_sweeden', 'wonFromYou', () => 0)));
  for (const m of ['lostToYou', 'bigLoss', 'gameLost']) {
    for (const line of SWEDISH_TILT_LINES[m]) assert.match(line, /Kuksugare/, m);
    for (let i = 0; i < 4; i++) {
      assert.match(lineFor('tommy_sweeden', m, () => i / 4), /Kuksugare/, m);
    }
  }
});

test('lines come from the bot’s own tone and its own lines', () => {
  forgetRecent();
  assert.ok(LINES.needle.lostToYou.includes(lineFor('nik_airbag', 'lostToYou', () => 0)));
  assert.ok(OWN.jen_silly.lostToYou.includes(lineFor('jen_silly', 'lostToYou', () => 0.99)));
  for (const id of ['phil_bigmouth', 'jen_silly', 'milk_king']) {
    for (const m of MOMENTS) {
      const pool = linesFor(id, m);
      for (const line of [...(LINES[personaOf(id).tone][m] || []), ...(OWN[id][m] || [])]) assert.ok(pool.includes(line), `${id} ${m}: ${line}`);
    }
  }
  // Another bot's own lines aren't in the pool.
  assert.ok(!linesFor('jen_silly', 'greet').includes(OWN.milk_king.greet[0]));
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
  // You lost 30 BB to seat 2.
  assert.deepEqual(handMoments(seats([-6000, -200, 6200]), 200), [{seat: 2, moment: 'wonFromYou'}]);
  // You took 20 BB from seat 1.
  assert.deepEqual(handMoments(seats([4000, -4000, 0]), 200), [{seat: 1, moment: 'lostToYou'}]);
  // A big pot between bots.
  assert.deepEqual(handMoments(seats([0, 8000, -8000]), 200), [{seat: 1, moment: 'bigWin'}]);
  // A small pot: nothing to say.
  assert.deepEqual(handMoments(seats([-200, 300, -100]), 200), []);
});

test('a bot never says "good call" about its own call', () => {
  const seats = nets => nets.map(net => ({net}));
  // You bet the river, seat 1 called and lost: the bot called.
  const youBet = [{type: 'bet', seat: 1, to: 400}, {type: 'call', seat: 0}, {type: 'board'}, {type: 'bet', seat: 0, to: 2000}, {type: 'call', seat: 1}];
  assert.equal(callShape(youBet, 1), 'theyCalled');
  assert.deepEqual(handMoments(seats([4000, -4000, 0]), 200, youBet), [{seat: 1, moment: 'lostToYou', how: 'theyCalled'}]);
  // Seat 1 bet, you called and won: you called.
  const theyBet = [{type: 'bet', seat: 1, to: 2000}, {type: 'call', seat: 0}];
  assert.equal(callShape(theyBet, 1), 'youCalled');
  // Checked down, or no events: nothing about calls.
  assert.equal(callShape([{type: 'check', seat: 0}, {type: 'check', seat: 1}], 1), null);
  assert.equal(callShape(null, 1), null);
  // No line about a call fits the wrong way round, for any persona: every
  // line it could say.
  for (const id of Object.keys(PERSONAS)) {
    for (const moment of ['lostToYou', 'wonFromYou']) {
      for (const line of linesFor(id, moment, 'theyCalled')) {
        assert.ok(!/good call|nice call|correct call|hero call\. I|you called|keep calling|you can fold|paid me off|paying me off|thanks for the call|learn to fold|for the call|appreciate the call/i.test(line), `${id} ${moment}: ${line}`);
      }
      for (const plain of linesFor(id, moment)) assert.ok(!/\bcall/i.test(plain), `${id} ${moment} without how: ${plain}`);
    }
  }
  // When you called, the right lines can come up.
  assert.ok(linesFor('jen_silly', 'lostToYou', 'youCalled').includes('Good call.'));
});

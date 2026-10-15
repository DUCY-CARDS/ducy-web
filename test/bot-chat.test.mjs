import test from 'node:test';
import assert from 'node:assert/strict';
import { LINES, PERSONAS, TILT_LINES, handMoments, lineFor, personaOf, replyMoment, speaks } from '../src/bot-chat.js';

const MOMENTS = ['greet', 'wonFromYou', 'lostToYou', 'bigWin', 'bigLoss', 'stakes', 'gameWon', 'gameLost', 'idle', 'hello', 'luck', 'nice', 'thanks', 'laugh', 'gg', 'other'];

test('every tone has lines for every moment', () => {
  for (const [tone, lines] of Object.entries(LINES)) {
    for (const m of MOMENTS) assert.ok(lines[m]?.length, `${tone} ${m}`);
  }
  for (const p of Object.values(PERSONAS)) assert.ok(LINES[p.tone], p.tone);
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
  assert.ok(LINES.friendly.greet.includes(lineFor('danny_smallball', 'greet', () => 0)));
  assert.ok(LINES.friendly.wonFromYou.includes(lineFor('danny_smallball', 'wonFromYou', () => 0)));
  for (const m of ['lostToYou', 'bigLoss', 'gameLost']) {
    assert.ok(TILT_LINES[m].includes(lineFor('danny_smallball', m, () => 0)), m);
  }
  // Nobody else tilts.
  assert.ok(LINES.friendly.lostToYou.includes(lineFor('jen_silly', 'lostToYou', () => 0)));
});

test('lines come from the bot’s own tone', () => {
  assert.ok(LINES.needle.lostToYou.includes(lineFor('nik_airbag', 'lostToYou', () => 0)));
  assert.ok(LINES.friendly.lostToYou.includes(lineFor('jen_silly', 'lostToYou', () => 0.99)));
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

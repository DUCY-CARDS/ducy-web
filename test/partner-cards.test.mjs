// Playing as if a partner's cards were known (#600, relay/src/partner-cards.js
// and collusion.js): made-up river spots (test/partner-sim.mjs). Honest
// players fit nobody's folded cards; a cheat who knows one partner's cards
// is flagged with that partner only, with counts and hand numbers, no cards.
// Needs the wasm build in wasm/.
// Run with: node --test test/partner-cards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { cardId, handValue, partnerSpots, winChances } from '../relay/src/partner-cards.js';
import { collusionReport } from '../relay/src/collusion.js';
import { flagText } from '../src/club-fair-play.js';
import { NAMES, opts, riverHands } from './partner-sim.mjs';

const hv = s => handValue(s.split(' ').map(cardId));

test('a hand’s value: the best five of seven', () => {
  assert.ok(hv('As Ks Qs Js Ts 2d 3c') > hv('9s 8s 7s 6s 5s 2d 3c'), 'royal over a lower straight flush');
  assert.ok(hv('Ah 2d 3c 4s 5h Kd Qc') < hv('2h 3d 4c 5s 6h Kd Qc'), 'the wheel is the lowest straight');
  assert.ok(hv('Ks 9s 5s 3s 2s Ad Ac') > hv('Ah Kd Qc Js Th 2d 3c'), 'a flush over a straight');
  assert.ok(hv('Ah Ad Kc Ks Qh 3d 2c') > hv('Ah Ad Kc Ks Jh 3d 2c'), 'two pair, the kicker');
  assert.ok(hv('Ah Ad Ac Ks Kh 3d 2c') > hv('Kh Kd Kc As Ah 3d 2c'), 'full houses by their trips');
  assert.equal(hv('Ah Kd 9c 7s 5h 3d 2c'), hv('As Kc 9d 7h 5s 3c 2h'), 'suits don’t count');
});

test('the user’s example: the folded A♠ makes a king-high spade flush the nuts', () => {
  // Ava: K♠ Q♠ on 9♠ 6♠ 2♠ J♦ 4♥; Bo folded the A♠.
  const ids = s => s.split(' ').map(cardId);
  const [alone, knowing] = winChances(ids('Ks Qs'), ids('9s 6s 2s Jd 4h'), [ids('As 2c')], opts());
  assert.ok(alone < 0.99, `${alone}`);
  assert.ok(Math.abs(knowing - 1) < 1e-9, 'nothing beats her once the A♠ is out');
});

test('a spot counts when the other player’s cards flip the right answer', () => {
  // Made-up river spots; for each that counts, the player's chance without
  // and with those cards sits on either side of the pot odds.
  const recs = riverHands({hands: 300, seed: 11});
  const spots = partnerSpots(recs, opts());
  assert.ok(spots.length > 0);
  for (const sp of spots.slice(0, 20)) {
    const rec = recs.find(r => r.hand === sp.ref.hand);
    const me = rec.seats.find(x => x.id === sp.who), other = rec.seats.find(x => x.id === sp.partner);
    const ids = cs => cs.map(cardId);
    const [alone, knowing] = winChances(ids(me.cards), ids(rec.board), [ids(other.cards)], opts());
    const bet = rec.actions.find(e => e.type === 'bet').to;
    const need = bet / (rec.pot - (me.folded ? 0 : bet) + bet);
    assert.notEqual(alone >= need, knowing >= need, `hand ${rec.hand}`);
    assert.ok(Math.abs(knowing - alone) >= opts().minMove);
    assert.equal(sp.fits, !me.folded === knowing >= need);
  }
});

// Each made-up run: 6,000 river spots, about a busy month of the turn and
// river calls that can count. With the thresholds in LIMITS, 20 honest runs
// gave no flag; a cheat was caught in 4 of 10 (slow to fire, on purpose).
// PARTNER_SEEDS=20 tries more honest runs.
test('honest players fit nobody’s cards', () => {
  for (let seed = 100; seed < 100 + (Number(process.env.PARTNER_SEEDS) || 2); seed++) {
    const r = collusionReport(riverHands({hands: 6000, seed}));
    const partner = r.flagged.flatMap(e => e.flags).filter(f => f.kind === 'partner');
    assert.deepEqual(partner, [], `seed ${seed}`);
  }
});

test('a player who knows a partner’s cards is flagged with that partner only', () => {
  const r = collusionReport(riverHands({hands: 6000, seed: 205, cheat: [0, 1]}));
  const partner = r.flagged.flatMap(e => e.flags).filter(f => f.kind === 'partner');
  assert.equal(partner.length, 1, JSON.stringify(partner.map(f => [f.who, f.other, f.with, f.elsewhere])));
  const f = partner[0];
  assert.equal(f.who, 'id-Ava');
  assert.equal(f.other, 'id-Bo');
  assert.ok(f.with.n >= 30 && f.elsewhere.n >= 30);
  for (const h of f.hands) assert.deepEqual(Object.keys(h).sort(), ['hand', 'table']);
  const text = JSON.stringify(r);
  assert.ok(!/cards|board/.test(text));
  assert.match(flagText(f, Object.fromEntries(NAMES.map(n => [`id-${n}`, n]))), /^Ava played as if they knew Bo’s cards: \d+ of \d+ spots where it mattered, others \d+ of \d+$/);
});

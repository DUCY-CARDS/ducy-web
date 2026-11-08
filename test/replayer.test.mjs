// The shared hand replayer (#592): the equity calculator's address at each
// step, the hand as text, and the dialog's controls. ducy replays the hand,
// so this needs the wasm build in wasm/.
// Run with: node --test test/replayer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { handRecord, replayFrames, streetStarts } from '../src/hand-replay.js';
import { equityHash, handText, knownCards, Replayer } from '../src/replayer.js';

const full = v => ({
  street: null, pot: 0, current_bet: 0, hero: 0, seat: 0, pot_limit: false, to_act: null, legal: null, complete: true, ...v,
  pots: (v.pots || []).map(p => ({eligible: [], awards: [], winning_hand: null, ...p})),
  seats: v.seats.map(s => ({id: '', human: true, away: false, street_bet: 0, all_in: false, empty: false, sitting_out: false, ...s})),
});

// Three-way, no showdown: Cy (seat 2) bets the turn and Ann (the viewer,
// seat 0) and Bob fold. `cards`: what the viewer's view held.
function threeWay({who = 'ann', game = 'nlhe', cards = [['As', 'Kd'], null, null], hand = 7, at = 1000} = {}) {
  const ev = [
    {type: 'small_blind', seat: 1, amount: 1}, {type: 'big_blind', seat: 2, amount: 2},
    {type: 'call', seat: 0, amount: 2, all_in: false}, {type: 'call', seat: 1, amount: 1, all_in: false}, {type: 'check', seat: 2},
    {type: 'board', street: 'flop', cards: ['Ah', '7c', '2d']},
    {type: 'check', seat: 1}, {type: 'bet', seat: 2, to: 4, all_in: false}, {type: 'call', seat: 0, amount: 4, all_in: false},
    {type: 'call', seat: 1, amount: 4, all_in: false},
    {type: 'board', street: 'turn', cards: ['Ks']},
    {type: 'check', seat: 1}, {type: 'bet', seat: 2, to: 10, all_in: false}, {type: 'fold', seat: 0}, {type: 'fold', seat: 1},
    {type: 'award', seat: 2, pot: 0, amount: 36},
  ];
  return handRecord({club: 'c', table: 't1', tableName: 'Main', game, who, view: full({
    hand_number: hand, small_blind: 1, big_blind: 2, button: 0, hole_cards: 2, board: ['Ah', '7c', '2d', 'Ks'],
    showdown: false, pots: [{amount: 36}], events: ev,
    seats: [
      {name: 'Ann', stack: 194, net: -6, won: 0, folded: true, cards: cards[0]},
      {name: 'Bob', stack: 194, net: -6, won: 0, folded: true, cards: cards[1]},
      {name: 'Cy', stack: 212, net: 12, won: 36, folded: false, cards: cards[2]},
    ],
  })}, at);
}

// Ann and Bob to a showdown; Cy folds the flop. Bob shows queens.
function showdown({who = 'ann', game = 'nlhe', hand = 8, at = 2000} = {}) {
  const ev = [
    {type: 'small_blind', seat: 1, amount: 1}, {type: 'big_blind', seat: 2, amount: 2},
    {type: 'call', seat: 0, amount: 2, all_in: false}, {type: 'call', seat: 1, amount: 1, all_in: false}, {type: 'check', seat: 2},
    {type: 'board', street: 'flop', cards: ['Ah', '7c', '2d']},
    {type: 'check', seat: 1}, {type: 'bet', seat: 2, to: 4, all_in: false}, {type: 'call', seat: 0, amount: 4, all_in: false},
    {type: 'call', seat: 1, amount: 4, all_in: false},
    {type: 'board', street: 'turn', cards: ['Ks']},
    {type: 'check', seat: 1}, {type: 'check', seat: 2}, {type: 'check', seat: 0},
    {type: 'board', street: 'river', cards: ['3h']},
    {type: 'check', seat: 1}, {type: 'bet', seat: 2, to: 6, all_in: false}, {type: 'call', seat: 0, amount: 6, all_in: false},
    {type: 'call', seat: 1, amount: 6, all_in: false},
    {type: 'award', seat: 0, pot: 0, amount: 36},
  ];
  return handRecord({club: 'c', table: 't1', tableName: 'Main', game, who, view: full({
    hand_number: hand, small_blind: 1, big_blind: 2, button: 0, hole_cards: 2, board: ['Ah', '7c', '2d', 'Ks', '3h'],
    showdown: true, pots: [{amount: 36}], events: ev,
    seats: [
      {name: 'Ann', stack: 224, net: 24, won: 36, folded: false, cards: ['As', 'Kd']},
      {name: 'Bob', stack: 188, net: -12, won: 0, folded: false, cards: ['Qs', 'Qd']},
      {name: 'Cy', stack: 188, net: -12, won: 0, folded: false, cards: null},
    ],
  })}, at);
}

const params = hash => Object.fromEntries(hash.slice(1).split('&').map(p => p.split('=')));

test('Equity at a step: the board then, your cards, cards shown down, the rest random', () => {
  const rec = showdown();
  const f = replayFrames(rec);
  const starts = streetStarts(f);
  // Preflop: nothing on the board, Ann's cards, Bob's (shown down at the end), Cy random.
  assert.deepEqual(params(equityHash(rec, f, 0)), {g: 'nlhe', p0: 'As.Kd', p1: 'Qs.Qd', p2: 'random'});
  // On the flop.
  assert.deepEqual(params(equityHash(rec, f, starts.flop)), {g: 'nlhe', p0: 'As.Kd', p1: 'Qs.Qd', p2: 'random', b: 'Ah.7c.2d'});
  // The turn: four cards.
  assert.equal(params(equityHash(rec, f, starts.turn)).b, 'Ah.7c.2d.Ks');
  // Out of range goes to the ends.
  assert.equal(params(equityHash(rec, f, 999)).b, 'Ah.7c.2d.Ks.3h');
});

test('Equity leaves out folded hands, and never fills in a folded hand’s cards', () => {
  const rec = threeWay();
  // Defensive: even if a record held a folded player's cards, they stay unknown.
  rec.seats[1].cards = ['Qs', 'Qd'];
  const f = replayFrames(rec);
  const afterBobFolds = f.length - 2;
  assert.ok(f[afterBobFolds].seats[1].folded);
  const p = params(equityHash(rec, f, afterBobFolds));
  // Ann folded too: her own cards stay, Cy is random, Bob is gone.
  assert.deepEqual(p, {g: 'nlhe', p0: 'As.Kd', p1: 'random', b: 'Ah.7c.2d.Ks'});
  // Before anyone folds, Bob is in but his cards are never known.
  assert.deepEqual(params(equityHash(rec, f, 0)), {g: 'nlhe', p0: 'As.Kd', p1: 'random', p2: 'random'});
  assert.equal(knownCards(rec, f, 1), null);
  assert.deepEqual(knownCards(rec, f, 0), ['As', 'Kd']);
});

test('Equity for the host: no cards of their own, only what was shown down', () => {
  const rec = showdown({who: 'host'});
  rec.seats[0].cards = null;
  const f = replayFrames(rec);
  assert.deepEqual(params(equityHash(rec, f, 0)), {g: 'nlhe', p0: 'random', p1: 'Qs.Qd', p2: 'random'});
});

test('Equity picks the calculator’s game', () => {
  for (const [game, g] of [['plo4', 'omaha'], ['plo5', 'omaha5'], ['plo6', 'omaha6'], ['nlhe', 'nlhe']]) {
    const rec = showdown({game});
    assert.equal(params(equityHash(rec, replayFrames(rec), 0)).g, g);
  }
});

test('the hand as text: seats, your cards, streets, what was shown and the result', () => {
  const rec = showdown();
  const t = handText(rec);
  const lines = t.split('\n');
  assert.match(lines[0], /^Main · hand #8 · Hold’em 0\.01\/0\.02 · 1970-01-01 00:00 UTC$/);
  assert.equal(lines[1], 'Seat 1: Ann (2) [button]');
  assert.ok(t.includes('*** Hole cards ***\nDealt to Ann [As Kd]'));
  assert.ok(t.includes('*** Flop *** [Ah 7c 2d]'));
  assert.ok(t.includes('*** River *** [Ah 7c 2d Ks 3h]'));
  assert.ok(t.includes('Total pot 0.36'));
  assert.ok(t.includes('Ann [As Kd]: +0.24'));
  assert.ok(t.includes('Bob [Qs Qd]: -0.12'));
  assert.ok(t.includes('Cy: -0.12'));
  // The blinds come before the deal.
  assert.ok(t.indexOf('posts the big blind') < t.indexOf('*** Hole cards ***'));
});

test('the hand as text never shows a folded hand but yours', () => {
  const rec = threeWay();
  rec.seats[1].cards = ['Qs', 'Qd'];
  const t = handText(rec);
  assert.ok(!t.includes('Qs'), t);
  assert.ok(t.includes('Dealt to Ann [As Kd]'));
});

test('the replayer steps, plays by keys, and moves between hands', () => {
  let draws = 0;
  const r = new Replayer({onChange: () => draws++});
  const a = threeWay({hand: 7, at: 1000}), b = showdown({hand: 8, at: 2000});
  b.id = 'b';
  a.id = 'a';
  // A list newest first, as pages list them: previous and next go by time.
  r.open(b, [b, a]);
  assert.ok(r.isOpen && draws > 0);
  assert.equal(r.state.rec.id, 'b');
  const key = (k, shiftKey = false) => r.key({key: k, shiftKey, target: null, preventDefault() {}});
  assert.ok(key('ArrowRight'));
  assert.equal(r.state.i, 1);
  key('ArrowLeft'); key('ArrowLeft');
  assert.equal(r.state.i, 0, 'not before the start');
  let html = r.html();
  assert.match(html, /data-rp="prev"(?![^>]*disabled)/);
  assert.match(html, /data-rp="next"[^>]*disabled/);
  assert.match(html, /href="#g=nlhe&amp;p0=As\.Kd&amp;p1=Qs\.Qd&amp;p2=random"/);
  assert.ok(html.includes('Copy hand'));
  // Bob's queens show only at the end.
  assert.ok(!html.includes('Q♠'));
  r.step(999);
  assert.ok(r.html().includes('Q♠'));
  // The previous hand (by time), from the start.
  assert.ok(key('ArrowLeft', true));
  assert.equal(r.state.rec.id, 'a');
  assert.equal(r.state.i, 0);
  r.click({dataset: {rp: 'next'}});
  assert.equal(r.state.rec.id, 'b');
  // A folded hand that isn't yours never shows, even at the end.
  a.seats[1].cards = ['Qs', 'Qd'];
  r.click({dataset: {rp: 'prev'}});
  r.step(999);
  html = r.html();
  assert.ok(!html.includes('Q♠') && html.includes('A♠'));
  // Keys in a text box are the box's.
  assert.equal(r.key({key: 'ArrowRight', target: {closest: () => ({})}}), false);
  assert.ok(key('Escape'));
  assert.equal(r.isOpen, false);
  assert.equal(r.html(), '');
});

test('the Equity link can open from another page in a new tab', () => {
  const r = new Replayer({equityLink: hash => ({href: `index.html${hash}`, target: '_blank'})});
  r.open(showdown());
  assert.match(r.html(), /href="index\.html#g=nlhe[^"]*" target="_blank" rel="noopener"/);
});

test('Copy hand writes the text to the clipboard, or shows it to copy by hand', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const rec = showdown();
  try {
    let wrote = null;
    Object.defineProperty(globalThis, 'navigator', {value: {clipboard: {writeText: async t => { wrote = t; }}}, configurable: true});
    const r = new Replayer();
    r.open(rec);
    r.click({dataset: {rp: 'copy'}});
    await new Promise(res => setTimeout(res, 0));
    assert.equal(wrote, handText(rec));
    assert.ok(r.html().includes('Copied ✓'));
    assert.ok(!r.html().includes('<textarea'));

    Object.defineProperty(globalThis, 'navigator', {value: {clipboard: {writeText: () => Promise.reject(new Error('denied'))}}, configurable: true});
    const r2 = new Replayer();
    r2.open(rec);
    r2.click({dataset: {rp: 'copy'}});
    await new Promise(res => setTimeout(res, 0));
    assert.match(r2.html(), /<textarea class="pl-text cl-replay-copytext" readonly[^>]*>Main · hand #8/);

    // No clipboard at all (an insecure page): the text shows at once.
    Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true});
    const r3 = new Replayer();
    r3.open(rec);
    r3.click({dataset: {rp: 'copy'}});
    assert.ok(r3.html().includes('<textarea'));
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator;
  }
});

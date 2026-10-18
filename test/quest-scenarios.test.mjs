// Bankroll Challenge scenarios (#355): the inbox, the ledger, and staking players.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newQuest } from '../src/quest.js';
import { botIdOf } from '../src/quest-people.js';
import {
  SCENARIOS, skillOf, honestyOf, post, markRead, unread, openOffers, maybeAskStake, answerStake,
  stakeOutcome, resolveStakes, stakingTotals, owedBy, confront,
} from '../src/quest-scenarios.js';

const DAY = 1440;
const T0 = 4 * DAY + 22 * 60; // a Friday, 10 pm
const ids = (family, n, from = 1000) => Array.from({length: n}, (_, i) => botIdOf(family, from + i));
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const quest = (seed = 7, bankroll = 500000) => ({...newQuest(0, seed), bankroll});

test('hidden traits lean by style and kind, and stay the same for a player', () => {
  const g = mean(ids('grinder', 300).map(skillOf)), r = mean(ids('rock', 300).map(skillOf));
  const s = mean(ids('station', 300).map(skillOf)), m = mean(ids('maniac', 300).map(skillOf));
  assert.ok(g > r && r > s && r > m, `grinder ${g}, rock ${r}, station ${s}, maniac ${m}`);
  assert.ok(g > 0 && s < 0);
  const who = ids('rock', 300);
  assert.ok(mean(who.map(id => honestyOf(id, true))) > mean(who.map(id => honestyOf(id, false))) + 0.15);
  assert.equal(skillOf(who[0]), skillOf(who[0]));
  assert.equal(skillOf('doug_poker'), 0);
});

test('the inbox: newest first, unread count, marking read', () => {
  let q = quest();
  q = post(q, {kind: 'x', at: 1, text: 'one'});
  q = post(q, {kind: 'x', at: 2, text: 'two'});
  assert.deepEqual(q.inbox.map(m => m.text), ['two', 'one']);
  assert.equal(unread(q), 2);
  assert.equal(unread(markRead(q)), 0);
});

test('a stake is asked for by someone you played enough hands with, sized to your bankroll', () => {
  const people = [{id: ids('grinder', 1)[0], hands: 30}];
  let asks = 0, q0 = quest();
  for (let n = 0; n < 200; n++) {
    const q = maybeAskStake(q0, people, [100, 200], T0, () => true, n);
    if (q === q0) continue;
    asks++;
    const o = q.inbox[0].offer;
    assert.equal(o.id, people[0].id);
    assert.ok(o.amount >= 20000 && o.amount <= q0.bankroll * SCENARIOS.stake.maxShare, `${o.amount}`);
    assert.ok(o.share >= 0.4 && o.share <= 0.6);
    assert.match(q.inbox[0].text, /stake me \$[\d,]+ for a week at 1\/2/);
  }
  // Late on a weekend at low stakes it's common, but not every time.
  assert.ok(asks > 60 && asks < 200, `${asks} asks in 200`);
  // Too few hands together, a Regular, or a bankroll too small to stake a buy-in: no ask.
  for (let n = 0; n < 50; n++) {
    assert.equal(maybeAskStake(q0, [{id: people[0].id, hands: 5}], [100, 200], T0, () => true, n), q0);
    assert.equal(maybeAskStake(q0, [{id: 'doug_poker', hands: 50}], [100, 200], T0, () => true, n), q0);
    const poor = quest(7, 30000);
    assert.equal(maybeAskStake(poor, people, [100, 200], T0, () => true, n), poor);
  }
});

// An ask in the inbox, for the tests that answer one.
function asked(q = quest(), id = ids('grinder', 1)[0]) {
  for (let n = 0; ; n++) {
    const out = maybeAskStake(q, [{id, hands: 30}], [100, 200], T0, () => true, n);
    if (out !== q) return out;
  }
}

test('accepting moves the money into the stake; declining doesn\'t; a stale offer can\'t be taken', () => {
  const q = asked();
  const msg = q.inbox[0];
  const yes = answerStake(q, msg.id, 'accept', T0 + 10);
  assert.equal(yes.bankroll, q.bankroll - msg.offer.amount);
  assert.equal(yes.stakes.length, 1);
  assert.equal(yes.stakes[0].amount, msg.offer.amount);
  assert.ok(yes.stakes[0].end >= T0 + 5 * DAY && yes.stakes[0].end <= T0 + 9 * DAY + 10);
  assert.equal(yes.ledger.at(-1).amount, -msg.offer.amount);
  assert.equal(openOffers(yes, T0 + 20).length, 0);
  // Answering twice does nothing more.
  assert.equal(answerStake(yes, msg.id, 'accept', T0 + 20).bankroll, yes.bankroll);
  const no = answerStake(q, msg.id, 'decline', T0 + 10);
  assert.equal(no.bankroll, q.bankroll);
  assert.ok(!no.stakes?.length);
  const late = answerStake(q, msg.id, 'accept', T0 + SCENARIOS.stake.offerHours * 60 + 1);
  assert.equal(late, q);
});

test('a counter is taken some of the time: more of the profit, or half the money', () => {
  let more = 0, less = 0, walked = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const q = asked(quest(seed));
    const m = q.inbox[0];
    const a = answerStake(q, m.id, seed % 2 ? 'more' : 'less', T0 + 5);
    if (!a.stakes?.length) { walked++; assert.match(a.inbox[0].text, /found someone else/); continue; }
    if (seed % 2) { more++; assert.ok(a.stakes[0].share > m.offer.share); }
    else { less++; assert.ok(a.stakes[0].amount <= m.offer.amount / 2 + 2500, 'about half, in whole $50s'); }
  }
  assert.ok(walked > 20 && more + less > 20, `walked ${walked}, more ${more}, less ${less}`);
});

test('a stake settles after its week: the money comes back as the result says, with a message', () => {
  const q0 = asked();
  const q = answerStake(q0, q0.inbox[0].id, 'accept', T0);
  const s = q.stakes[0];
  assert.equal(resolveStakes(q, s.end - 1), q, 'not before its week is up');
  const r = resolveStakes(q, s.end + 60);
  const done = r.stakes[0];
  assert.ok(['busted', 'down', 'small', 'big', 'stiffed'].includes(done.result));
  assert.equal(r.bankroll, q.bankroll + (done.returned || 0));
  assert.equal(r.inbox[0].kind, 'stake-result');
  assert.equal(r.ledger.at(-1).amount, done.returned || 0);
  // Settled once only.
  assert.equal(resolveStakes(r, s.end + 10 * DAY), r);
  const t = stakingTotals(r);
  assert.equal(t.count, 1);
  assert.equal(t.staked, s.amount);
  assert.equal(t.net, (done.returned || 0) - s.amount);
});

test('outcomes lean on skill and honesty, with every result possible', () => {
  const run = (family, reg) => ids(family, 400, 5000).map((id, i) => stakeOutcome(11, {id, stakes: [100, 200], amount: 100000, share: 0.5, reg, start: 0, end: 7 * DAY, n: i}));
  const good = run('grinder', true), bad = run('station', false);
  const back = xs => mean(xs.map(o => o.returned));
  assert.ok(back(good) > back(bad) + 20000, `grinder regs return ${back(good)}, station tourists ${back(bad)}`);
  const kinds = new Set([...good, ...bad].map(o => o.result));
  for (const k of ['busted', 'down', 'small', 'big', 'stiffed']) assert.ok(kinds.has(k), `${k} happens`);
  const stiffRate = xs => xs.filter(o => o.result === 'stiffed').length / xs.length;
  assert.ok(stiffRate(bad) > stiffRate(good), 'tourists stiff more often');
  // What comes back is never more than the stake plus your share of their profit.
  for (const o of good) if (o.result === 'small' || o.result === 'big') assert.ok(o.returned <= 100000 + Math.round(o.profit * 0.5) + 1);
});

test('someone who stiffed you can be confronted: they pay all, some or none of it', () => {
  // Find stakes that were stiffed, then confront.
  let paidAll = 0, paidSome = 0, paidNone = 0;
  for (let seed = 1; paidAll + paidSome + paidNone < 60 && seed < 3000; seed++) {
    const id = botIdOf('station', 7000 + seed);
    const s = {id, stakes: [100, 200], amount: 50000, share: 0.5, reg: false, start: 0, end: 7 * DAY, n: 0};
    const o = stakeOutcome(seed, s);
    if (o.result !== 'stiffed') continue;
    const q = {...quest(seed), stakes: [{...s, ...o, settled: s.end}]};
    const owed = owedBy(q, id);
    assert.ok(owed >= 0);
    if (!owed) continue;
    const c = confront(q, id, 8 * DAY);
    const got = c.bankroll - q.bankroll;
    if (got === owed) paidAll++; else if (got > 0) paidSome++; else paidNone++;
    assert.equal(owedBy(c, id), 0, 'settled either way');
    assert.equal(confront(c, id, 9 * DAY), c, 'only once');
  }
  assert.ok(paidAll && paidNone, `all ${paidAll}, some ${paidSome}, none ${paidNone}`);
});

test('the lobby shows the inbox: an offer with its answers, then the news', async () => {
  const { questLobbyHtml } = await import('../src/quest-ui.js');
  const { REGIONS, startRoom } = await import('../src/quest-rooms.js');
  const room = startRoom(REGIONS[0].id);
  let q = {...asked(), room: room.id, home: REGIONS[0].id, homeCity: room.city, clock: {real: 0, game: T0}};
  q = post(q, {kind: 'stake-result', at: T0 - 600, text: 'An old result.'});
  const h = questLobbyHtml(q, 0);
  const offer = q.inbox.find(m => m.offer);
  assert.match(h, /class="qs-inbox"/);
  assert.match(h, /2 new/);
  for (const a of ['accept', 'more', 'less', 'decline']) assert.match(h, new RegExp(`data-qsc="${offer.id}:${a}"`));
  assert.match(h, /An old result\./);
  // Answered, the offer leaves the top; the news of it shows.
  const after = questLobbyHtml(answerStake(q, offer.id, 'accept', T0 + 1), 0);
  assert.doesNotMatch(after, /data-qsc=/);
  assert.match(after, /You staked/);
  assert.match(after, /Staking: \$[\d,]+ still out/);
});

test('scenarios survive a save and load', async () => {
  const { loadQuest, saveQuest } = await import('../src/quest.js');
  const q0 = asked();
  const q = answerStake(q0, q0.inbox[0].id, 'accept', T0);
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)};
  saveQuest({...q, clock: {real: 1000, game: T0}}, storage);
  const back = loadQuest(storage, 1000);
  assert.deepEqual(back.stakes, q.stakes);
  assert.equal(back.inbox.length, q.inbox.length);
});

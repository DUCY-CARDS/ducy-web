// Usage counts for the admin site (#601, relay/src/stats.js): totals per
// day, active players from a per-day set of hashes that goes once the day
// is counted, new players, games and players per game, hands, and the
// admins left out. No relay needed.
// Run with: node --test test/stats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_DAYS, dayOf, liveGames, stats } from '../relay/src/stats.js';
import { cfAnalytics, scriptFor } from '../relay/src/cf-analytics.js';

const mem = () => {
  const m = new Map();
  return {m, get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
};
const D1 = Date.parse('2026-11-01T12:00:00Z'), D2 = D1 + 864e5, D3 = D2 + 864e5;

test('a day: active and new players, games, players per game, hands, clubs', async () => {
  const s = mem();
  const st = stats(s, {admins: new Set(['admin1'])});
  for (const id of ['ann', 'bob', 'ann', 'admin1']) await st.note({kind: 'player', id, code: 'AAAA-BBBB'}, D1);
  await st.note({kind: 'player', id: 'cy', code: 'CCCC-DDDD'}, D1);
  await st.note({kind: 'game'}, D1);
  await st.note({kind: 'gamePlayer'}, D1);
  await st.note({kind: 'gamePlayer'}, D1);
  await st.note({kind: 'game'}, D1);
  await st.note({kind: 'hand'}, D1);
  await st.note({kind: 'clubHand', code: 'AAAA-BBBB', ids: ['ann', 'bob']}, D1);
  // Only the admins: not counted.
  await st.note({kind: 'clubHand', code: 'EEEE-FFFF', ids: ['admin1']}, D1);
  await st.note({kind: 'nonsense'}, D1);
  const [day] = await st.days(1, D1);
  assert.deepEqual(day, {day: '2026-11-01', active: 3, newPlayers: 3, games: 2, playersPerGame: 2, hands: 2, clubsActive: 2, clubHands: 1});
  // No player ID is stored as it is.
  for (const v of s.m.values()) for (const id of ['ann', 'bob', 'cy', 'admin1']) assert.ok(!JSON.stringify(v).includes(`"${id}"`));
});

test('the next day: the old day is counted and its set deleted; returning players aren\'t new', async () => {
  const s = mem();
  const st = stats(s);
  await st.note({kind: 'player', id: 'ann', code: 'AAAA-BBBB'}, D1);
  await st.note({kind: 'player', id: 'bob', code: 'AAAA-BBBB'}, D1);
  assert.ok(s.m.has('statsSeen:2026-11-01'));
  await st.note({kind: 'player', id: 'ann', code: 'AAAA-BBBB'}, D2);
  await st.note({kind: 'player', id: 'dan', code: 'AAAA-BBBB'}, D2);
  assert.ok(!s.m.has('statsSeen:2026-11-01'), 'the day\'s set is gone once counted');
  assert.ok(!s.m.has('statsClubs:2026-11-01'));
  assert.equal(s.m.get('statsDay:2026-11-01').active, 2);
  const days = await st.days(3, D3);
  assert.deepEqual(days.map(d => [d.day, d.active, d.newPlayers, d.clubsActive]), [
    ['2026-11-01', 2, 2, 1], ['2026-11-02', 2, 1, 1], ['2026-11-03', 0, 0, 0],
  ]);
  assert.equal(days[2].playersPerGame, null, 'no games: no players per game');
  assert.ok(!s.m.has('statsSeen:2026-11-02'), 'reading counts finished days too');
  // A new stats object on the same storage (the relay restarted) still knows who's been seen.
  const again = stats(s);
  await again.note({kind: 'player', id: 'bob', code: 'AAAA-BBBB'}, D3);
  assert.equal((await again.days(1, D3))[0].newPlayers, 0);
});

test(`days older than ${STATS_DAYS} are dropped`, async () => {
  const s = mem();
  const st = stats(s);
  await st.note({kind: 'hand'}, D1);
  await st.note({kind: 'hand'}, D1 + (STATS_DAYS + 1) * 864e5);
  assert.ok(!s.m.has('statsDay:2026-11-01'));
  assert.deepEqual(s.m.get('statsDays'), [dayOf(D1 + (STATS_DAYS + 1) * 864e5)]);
});

test('counts made at once all land', async () => {
  const st = stats(mem());
  await Promise.all(Array.from({length: 40}, (_, i) => st.note({kind: i % 2 ? 'hand' : 'player', id: `p${i}`}, D1)));
  const [d] = await st.days(1, D1);
  assert.equal(d.hands, 20);
  assert.equal(d.active, 20);
  assert.equal(d.newPlayers, 20);
});

test('live games: stale ones are left out', () => {
  const now = D1;
  assert.deepEqual(liveGames({a: {players: 3, at: now - 1000}, b: {players: 2, at: now - 2 * 864e5}}, now), [{players: 3, at: now - 1000}]);
});

test('Cloudflare\'s numbers: only with the token, which goes to Cloudflare alone', async () => {
  assert.deepEqual(await cfAnalytics({}), {enabled: false});
  assert.match((await cfAnalytics({CF_ANALYTICS_TOKEN: 't'})).errors[0], /CF_ACCOUNT_ID/);
  assert.equal(scriptFor({ENVIRONMENT: 'staging'}), 'ducy-relay-staging');
  assert.equal(scriptFor({}), 'ducy-relay');
  const calls = [];
  const fake = async (url, init) => {
    calls.push({url, init});
    const q = JSON.parse(init.body).query;
    const data = q.includes('workersInvocationsAdaptive')
      ? {workersInvocationsAdaptive: [{dimensions: {date: '2026-11-03'}, sum: {requests: 10, errors: 1, subrequests: 4}, quantiles: {cpuTimeP50: 900, cpuTimeP99: 4000}}]}
      : {durableObjectsInvocationsAdaptiveGroups: [{dimensions: {date: '2026-11-03'}, sum: {requests: 7}}]};
    return new Response(JSON.stringify({data: {viewer: {accounts: [data]}}}));
  };
  const out = await cfAnalytics({CF_ANALYTICS_TOKEN: 'secret-token', CF_ACCOUNT_ID: 'acct', ENVIRONMENT: 'sandbox'}, {days: 3, now: D3, fetch: fake});
  assert.equal(out.script, 'ducy-relay-sandbox');
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.days.map(d => d.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.deepEqual(out.days[2], {day: '2026-11-03', requests: 10, errors: 1, subrequests: 4, cpuP50: 900, cpuP99: 4000, doRequests: 7});
  assert.ok(calls.every(c => c.url === 'https://api.cloudflare.com/client/v4/graphql' && c.init.headers.authorization === 'Bearer secret-token'));
  assert.ok(!JSON.stringify(out).includes('secret-token'));
  // An error from Cloudflare is reported, not thrown.
  const bad = await cfAnalytics({CF_ANALYTICS_TOKEN: 't2', CF_ACCOUNT_ID: 'acct'}, {days: 2, now: D3, fetch: async () => new Response(JSON.stringify({errors: [{message: 'not authorized'}]}))});
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /not authorized/);
});

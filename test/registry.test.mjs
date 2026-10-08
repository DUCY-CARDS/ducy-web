// The relay's registry of always-on clubs (#98): limits on creating them,
// and usage against Cloudflare's free plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_GBS_PER_DAY, GBS_PER_CLUB_MINUTE, limitsFrom, registry } from '../relay/src/registry.js';

function memoryStorage() {
  const m = new Map();
  return {get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
}

test('limits come from the environment, with defaults of 3 per owner and 25 in all', () => {
  assert.deepEqual(limitsFrom({}), {perOwner: 3, total: 25, creators: []});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: '1', MAX_CLUBS: '2', CLUB_CREATORS: 'ann, bob ,'}), {perOwner: 1, total: 2, creators: ['ann', 'bob']});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: 'x', MAX_CLUBS: '-1'}), {perOwner: 3, total: 25, creators: []});
});

test('claiming clubs: per owner, in all, invite-only, and released when deleted', async () => {
  const reg = registry(memoryStorage(), {perOwner: 2, total: 3, creators: []});
  await reg.claim('ann', 'AAAA-AAAA');
  await reg.claim('ann', 'BBBB-BBBB');
  await assert.rejects(reg.claim('ann', 'CCCC-CCCC'), /already have 2/);
  await assert.rejects(reg.claim('bob', 'AAAA-AAAA'), /in use/);
  await reg.claim('bob', 'CCCC-CCCC');
  await assert.rejects(reg.claim('cy', 'DDDD-DDDD'), /full/);
  await reg.release('BBBB-BBBB');
  await reg.claim('cy', 'DDDD-DDDD');
  assert.equal((await reg.usage()).clubs, 3);

  const only = registry(memoryStorage(), {perOwner: 3, total: 25, creators: ['ann']});
  await assert.rejects(only.claim('bob', 'EEEE-EEEE'), /invite-only/);
  await only.claim('ann', 'EEEE-EEEE');
});

test('usage: club-minutes of play a day, as club-hours and a share of the free plan', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const now = Date.UTC(2026, 9, 8, 12);
  await reg.used(90, now);
  await reg.used(30, now);
  await reg.used(60, now - 864e5);
  await reg.used(-5, now);
  const u = await reg.usage(3, now);
  assert.deepEqual(u.days.map(d => [d.day, d.clubHours]), [['2026-10-08', 2], ['2026-10-07', 1], ['2026-10-06', 0]]);
  assert.equal(u.days[0].gbs, Math.round(120 * GBS_PER_CLUB_MINUTE));
  assert.equal(u.days[0].share, Math.round((u.days[0].gbs / FREE_GBS_PER_DAY) * 1000) / 10);
  assert.ok(u.days[0].share > 5 && u.days[0].share < 10, '2 club-hours is about 7% of the free plan');
});

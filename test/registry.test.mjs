// The relay's registry of always-on clubs (#98, #265): permission, trial
// clubs, limits, pausing, temporary clubs (#395), and usage against
// Cloudflare's free plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, cleanLimits, FREE_GBS_PER_DAY, FREE_LIMITS, GBS_PER_CLUB_MINUTE, limitsFrom, registry, removesAt, TEMP_DAYS, TRIAL_DAYS } from '../relay/src/registry.js';

function memoryStorage() {
  const m = new Map();
  return {get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }};
}

test('limits come from the environment, with defaults of 3 per owner and 25 in all', () => {
  assert.deepEqual(limitsFrom({}), {perOwner: 3, total: 25, creators: []});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: '1', MAX_CLUBS: '2', CLUB_CREATORS: 'ann, bob ,'}), {perOwner: 1, total: 2, creators: ['ann', 'bob']});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: 'x', MAX_CLUBS: '-1'}), {perOwner: 3, total: 25, creators: []});
});

test('without permission, a player gets one trial club, once, with the free limits', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const now = Date.UTC(2026, 9, 14);
  const rec = await reg.claim('ann', 'AAAA-AAAA', now, 'Ann’s club');
  assert.equal(rec.plan, 'trial');
  assert.equal(rec.expires, now + TRIAL_DAYS * 864e5);
  assert.deepEqual(rec.limits, FREE_LIMITS);
  assert.equal(rec.name, 'Ann’s club');
  await assert.rejects(reg.claim('ann', 'BBBB-BBBB', now), /already had your free trial/);
  // Deleting the trial club doesn't give another.
  await reg.release('AAAA-AAAA');
  await assert.rejects(reg.claim('ann', 'BBBB-BBBB', now), /free trial/);
  await assert.rejects(reg.claim('bob', 'CCCC-CCCC', now).then(() => reg.claim('cy', 'CCCC-CCCC', now)), /in use/);
});

test('a trial ends after its days; a paused club is blocked; the owner learns why', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const now = Date.UTC(2026, 9, 14);
  await reg.claim('ann', 'AAAA-AAAA', now);
  assert.equal((await reg.status('AAAA-AAAA', now + 864e5)).blocked, '');
  assert.match((await reg.status('AAAA-AAAA', now + (TRIAL_DAYS + 1) * 864e5)).blocked, /trial has ended/);
  // The super admin keeps it going: a club, no end date.
  await reg.setClub('AAAA-AAAA', {plan: 'club'});
  assert.equal((await reg.status('AAAA-AAAA', now + 100 * 864e5)).blocked, '');
  await reg.setClub('AAAA-AAAA', {suspended: true});
  assert.match((await reg.status('AAAA-AAAA', now)).blocked, /paused/);
  await reg.setClub('AAAA-AAAA', {suspended: false});
  assert.equal((await reg.status('AAAA-AAAA', now)).blocked, '');
  assert.match(blockedReason(null), /isn’t on ducy’s server/);
  await assert.rejects(reg.setClub('ZZZZ-ZZZZ', {suspended: true}), /No such club/);
});

test('with permission: clubs (no end), up to the grant’s number, with its limits', async () => {
  const reg = registry(memoryStorage(), {perOwner: 2, total: 4, creators: ['env-id']});
  await reg.grant('ann', {note: 'Thursday game', maxClubs: 1, limits: {tables: 5, tourneysPerDay: 3}});
  const rec = await reg.claim('ann', 'AAAA-AAAA');
  assert.equal(rec.plan, 'club');
  assert.equal(rec.expires, undefined);
  assert.deepEqual(rec.limits, {tables: 5, tourneysPerDay: 3});
  await assert.rejects(reg.claim('ann', 'BBBB-BBBB'), /already have 1 club/);
  // Granted in the environment (CLUB_CREATORS): perOwner clubs, free limits.
  await reg.claim('env-id', 'CCCC-CCCC');
  await reg.claim('env-id', 'DDDD-DDDD');
  await assert.rejects(reg.claim('env-id', 'EEEE-EEEE'), /already have 2/);
  await reg.release('DDDD-DDDD');
  await reg.claim('bob', 'DDDD-DDDD'); // trials
  await reg.claim('cy', 'EEEE-EEEE');
  await assert.rejects(reg.claim('env-id', 'FFFF-FFFF'), /full/);
  // Revoked: the next club is a trial (if they haven't had one).
  await reg.revoke('ann');
  await reg.release('AAAA-AAAA');
  assert.equal((await reg.claim('ann', 'AAAA-AAAA')).plan, 'trial');
  await assert.rejects(reg.grant('not an id!'), /player ID/);
  const list = await reg.list();
  assert.deepEqual(Object.keys(list.grants).sort(), ['env-id']);
  assert.equal(list.grants['env-id'].fromEnv, true);
  assert.deepEqual(Object.keys(list.trials).sort(), ['ann', 'bob', 'cy']);
  assert.equal(list.clubs.length, 4);
});

test('a new club is temporary until its owner proves a backup; unused for a week, it goes', async () => {
  const storage = memoryStorage();
  const reg = registry(storage, limitsFrom({CLUB_CREATORS: 'ann'}));
  const now = Date.UTC(2026, 9, 25);
  const rec = await reg.claim('ann', 'AAAA-AAAA', now);
  assert.equal(rec.temporary, true);
  assert.equal(removesAt(rec), now + TEMP_DAYS * 864e5);
  await reg.claim('ann', 'BBBB-BBBB', now);
  // A club moving here from a browser already existed: not temporary.
  assert.equal((await reg.claim('ann', 'CCCC-CCCC', now, '', {temporary: false})).temporary, false);
  // A club from before temporary clubs has no flag: kept as it was.
  const all = await storage.get('clubs');
  all['DDDD-DDDD'] = {owner: 'bob', at: now - 100 * 864e5, plan: 'club'};
  await storage.put('clubs', all);
  assert.equal((await reg.status('DDDD-DDDD')).record.temporary, false);

  // Only the owner proves it.
  await assert.rejects(reg.proved('AAAA-AAAA', 'bob', now), /owner/);
  await assert.rejects(reg.proved('ZZZZ-ZZZZ', 'ann', now), /No such club/);
  const proved = await reg.proved('AAAA-AAAA', 'ann', now + 1000);
  assert.equal(proved.temporary, false);
  assert.equal(proved.provedAt, now + 1000);

  // A week on, only the unproved one is due to go; using it puts that off.
  assert.deepEqual(await reg.expired(now + 6 * 864e5), []);
  assert.deepEqual(await reg.expired(now + TEMP_DAYS * 864e5), ['BBBB-BBBB']);
  await reg.used(0, now + 5 * 864e5, 'BBBB-BBBB');
  assert.deepEqual(await reg.expired(now + TEMP_DAYS * 864e5), []);
  assert.deepEqual(await reg.expired(now + 12 * 864e5), ['BBBB-BBBB']);
  const list = await reg.list(now);
  assert.equal(list.clubs.find(c => c.code === 'BBBB-BBBB').removesAt, now + 12 * 864e5);
  assert.equal(list.clubs.find(c => c.code === 'AAAA-AAAA').removesAt, null);
  assert.equal(list.limits.tempDays, TEMP_DAYS);
});

test('limits from the admin are whole numbers in range, else unchanged', () => {
  assert.deepEqual(cleanLimits({tables: 4}), {tables: 4, tourneysPerDay: 1});
  assert.deepEqual(cleanLimits({tables: -1, tourneysPerDay: 2.5}, {tables: 3, tourneysPerDay: 2}), {tables: 3, tourneysPerDay: 2});
  assert.deepEqual(cleanLimits({tables: 0, tourneysPerDay: 51}), {tables: 0, tourneysPerDay: 1});
});

test('usage: club-minutes of play a day, in all and per club', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const now = Date.UTC(2026, 9, 8, 12);
  await reg.claim('ann', 'AAAA-AAAA', now - 3 * 864e5);
  await reg.used(90, now, 'AAAA-AAAA');
  await reg.used(30, now);
  await reg.used(60, now - 864e5, 'AAAA-AAAA');
  await reg.used(-5, now);
  const u = await reg.usage(3, now);
  assert.deepEqual(u.days.map(d => [d.day, d.clubHours]), [['2026-10-08', 2], ['2026-10-07', 1], ['2026-10-06', 0]]);
  assert.equal(u.days[0].gbs, Math.round(120 * GBS_PER_CLUB_MINUTE));
  assert.equal(u.days[0].share, Math.round((u.days[0].gbs / FREE_GBS_PER_DAY) * 1000) / 10);
  assert.ok(u.days[0].share > 5 && u.days[0].share < 10, '2 club-hours is about 7% of the free plan');
  const {record} = await reg.status('AAAA-AAAA', now);
  assert.equal(record.minutes, 150);
  assert.deepEqual(record.days, {'2026-10-08': 90, '2026-10-07': 60});
  assert.equal(record.lastActive, now);
  // Someone connecting marks it active without minutes.
  await reg.used(0, now + 5000, 'AAAA-AAAA');
  assert.equal((await reg.status('AAAA-AAAA')).record.lastActive, now + 5000);
});

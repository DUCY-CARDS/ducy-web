// The relay's registry of always-on clubs (#98, #265): grants and their
// one-time links (#636), limits, pausing, temporary clubs (#395), Wipe all
// clubs, and usage against Cloudflare's free plan. The rules are ducy-play's
// club_registry (#463).
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { blockedReason, cleanLimits, FREE_GBS_PER_DAY, FREE_LIMITS, GBS_PER_CLUB_MINUTE, grantHash, limitsFrom, newGrantToken, NOT_YOUR_LINK, registry, removesAt, TEMP_DAYS } from '../relay/src/registry.js';

function memoryStorage() {
  const m = new Map();
  return {get: async k => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }, dump: () => JSON.stringify([...m])};
}

// Grants `id` a club and claims it in room `code` with the link's token.
async function granted(reg, id, code, now = Date.now(), name = '', opts = {}) {
  const {token} = await reg.grant(id, opts.grant || {}, now);
  return reg.claim(id, code, now, name, {...opts, grant: token});
}

test('limits come from the environment, with defaults of 3 per owner and 25 in all; no creators or trials (#636)', () => {
  assert.deepEqual(limitsFrom({}), {perOwner: 3, total: 25, creators: [], noTrials: true});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: '1', MAX_CLUBS: '2', CLUB_CREATORS: 'ann, bob ,', TRIALS: ''}), {perOwner: 1, total: 2, creators: [], noTrials: true});
  assert.deepEqual(limitsFrom({MAX_CLUBS_PER_OWNER: 'x', MAX_CLUBS: '-1'}), {perOwner: 3, total: 25, creators: [], noTrials: true});
});

test('a grant link’s token: 32 random bytes, kept only as its hash', async () => {
  const a = newGrantToken(), b = newGrantToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(await grantHash(a), /^[0-9a-f]{64}$/);
  assert.equal(await grantHash(a), await grantHash(a));
  for (const bad of ['', 'x', a + 'x', a.slice(1) + '!', null, 42, {}]) assert.equal(await grantHash(bad), '');
});

test('a club takes a grant’s link, from the player it’s for, once (#636)', async () => {
  const storage = memoryStorage();
  // CLUB_CREATORS is ignored: env-id gets nothing from it.
  const reg = registry(storage, limitsFrom({CLUB_CREATORS: 'env-id', TRIALS: ''}));
  const now = Date.UTC(2026, 10, 10);
  // No grant: no club, no trial.
  for (const who of ['ann', 'env-id']) await assert.rejects(reg.claim(who, 'AAAA-BBBB', now, 'Owls'), {message: NOT_YOUR_LINK});
  const g = await reg.grant('ann', {note: 'Thursday game', limits: {tables: 5, tourneysPerDay: 3}}, now);
  assert.equal(g.note, 'Thursday game');
  assert.deepEqual(g.limits, {tables: 5, tourneysPerDay: 3});
  // The token isn't stored, only its hash.
  assert.equal(storage.dump().includes(g.token), false);
  assert.equal((await storage.get('invites')).ann.hash, await grantHash(g.token));
  // Forwarded: no one else can use it; nor a wrong or missing token.
  await assert.rejects(reg.claim('bob', 'AAAA-BBBB', now, 'Owls', {grant: g.token}), {message: NOT_YOUR_LINK});
  await assert.rejects(reg.claim('ann', 'AAAA-BBBB', now, 'Owls', {grant: newGrantToken()}), {message: NOT_YOUR_LINK});
  await assert.rejects(reg.claim('ann', 'AAAA-BBBB', now, 'Owls'), {message: NOT_YOUR_LINK});
  const rec = await reg.claim('ann', 'AAAA-BBBB', now, 'Owls', {grant: g.token});
  assert.equal(rec.plan, 'club');
  assert.equal(rec.expires, undefined);
  assert.deepEqual(rec.limits, {tables: 5, tourneysPerDay: 3});
  // Used up: not again, in this room or another.
  await assert.rejects(reg.claim('ann', 'CCCC-DDDD', now, 'Again', {grant: g.token}), {message: NOT_YOUR_LINK});
  const list = await reg.list(now);
  assert.deepEqual(list.grants, {});
  assert.deepEqual(list.trials, {});
  assert.deepEqual(list.invites.ann, {at: now, note: 'Thursday game', limits: {tables: 5, tourneysPerDay: 3}, usedAt: now, code: 'AAAA-BBBB', used: true});
  assert.equal(JSON.stringify(list).includes(g.token), false);
  // A second grant is a second club, on a new link.
  const g2 = await reg.grant('ann', {}, now);
  assert.equal((await reg.claim('ann', 'CCCC-DDDD', now, '', {grant: g2.token})).limits.tables, FREE_LIMITS.tables);
});

test('a claim that fails leaves the grant unused; two at once make one club', async () => {
  const reg = registry(memoryStorage(), {perOwner: 1, total: 2});
  const {token} = await reg.grant('ann');
  await granted(reg, 'bob', 'AAAA-AAAA');
  await granted(reg, 'cy', 'BBBB-BBBB');
  // Full: refused, and the link still works once there's room.
  await assert.rejects(reg.claim('ann', 'CCCC-CCCC', Date.now(), '', {grant: token}), /full/);
  assert.equal((await reg.list()).invites.ann.used, false);
  await reg.release('BBBB-BBBB');
  const both = await Promise.allSettled([
    reg.claim('ann', 'CCCC-CCCC', Date.now(), '', {grant: token}),
    reg.claim('ann', 'DDDD-DDDD', Date.now(), '', {grant: token}),
  ]);
  assert.deepEqual(both.map(r => r.status), ['fulfilled', 'rejected']);
  assert.equal(both[1].reason.message, NOT_YOUR_LINK);
  // The relay's per-owner limit still holds.
  await reg.release('AAAA-AAAA');
  const again = await reg.grant('ann');
  await assert.rejects(reg.claim('ann', 'EEEE-EEEE', Date.now(), '', {grant: again.token}), /already have 1 club/);
});

test('granting again, or revoking, kills the unused link', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const first = await reg.grant('ann');
  const second = await reg.grant('ann');
  await assert.rejects(reg.claim('ann', 'AAAA-AAAA', Date.now(), '', {grant: first.token}), {message: NOT_YOUR_LINK});
  await reg.revoke('ann');
  await assert.rejects(reg.claim('ann', 'AAAA-AAAA', Date.now(), '', {grant: second.token}), {message: NOT_YOUR_LINK});
  const list = await reg.list();
  assert.deepEqual([list.grants, list.invites], [{}, {}]);
  await assert.rejects(reg.grant('not an id!'), /player ID/);
  assert.deepEqual((await reg.list()).invites, {});
  // A grant that moved to a new device's ID (#575) has no link there.
  const g = await reg.grant('ann');
  await granted(reg, 'own', 'BBBB-BBBB');
  await reg.moveOwner('BBBB-BBBB', 'own', 'own2');
  await assert.rejects(reg.claim('own2', 'CCCC-CCCC', Date.now(), '', {grant: g.token}), {message: NOT_YOUR_LINK});
});

test('Wipe all clubs: every club, grant and link goes; the admin log stays (#636)', async () => {
  const storage = memoryStorage();
  const reg = registry(storage, limitsFrom({}));
  await granted(reg, 'ann', 'AAAA-AAAA');
  await granted(reg, 'bob', 'BBBB-BBBB');
  const unused = await reg.grant('cy');
  await storage.put('trials', {old: 'CCCC-CCCC'});
  await reg.adminLog({at: 1, action: 'grant'});
  assert.deepEqual((await reg.clubCodes()).sort(), ['AAAA-AAAA', 'BBBB-BBBB']);
  await reg.wipe();
  assert.deepEqual(await reg.clubCodes(), []);
  const list = await reg.list();
  assert.deepEqual([list.clubs, list.grants, list.invites, list.trials], [[], {}, {}, {}]);
  await assert.rejects(reg.claim('cy', 'DDDD-DDDD', Date.now(), '', {grant: unused.token}), {message: NOT_YOUR_LINK});
  assert.equal((await reg.adminLogList()).length, 1);
});

test('a paused club is blocked; the owner learns why', async () => {
  const reg = registry(memoryStorage(), limitsFrom({}));
  const now = Date.UTC(2026, 9, 14);
  await granted(reg, 'ann', 'AAAA-AAAA', now);
  assert.equal((await reg.status('AAAA-AAAA', now + 100 * 864e5)).blocked, '');
  await reg.setClub('AAAA-AAAA', {suspended: true});
  assert.match((await reg.status('AAAA-AAAA', now)).blocked, /paused/);
  await reg.setClub('AAAA-AAAA', {suspended: false});
  assert.equal((await reg.status('AAAA-AAAA', now)).blocked, '');
  assert.match(blockedReason(null), /isn’t on ducy’s server/);
  await assert.rejects(reg.setClub('ZZZZ-ZZZZ', {suspended: true}), /No such club/);
});

test('a new club is temporary until its owner proves a backup; unused for a week, it goes', async () => {
  const storage = memoryStorage();
  const reg = registry(storage, limitsFrom({}));
  const now = Date.UTC(2026, 9, 25);
  const rec = await granted(reg, 'ann', 'AAAA-AAAA', now);
  assert.equal(rec.temporary, true);
  assert.equal(removesAt(rec), now + TEMP_DAYS * 864e5);
  await granted(reg, 'ann', 'BBBB-BBBB', now);

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
  await granted(reg, 'ann', 'AAAA-AAAA', now - 3 * 864e5);
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

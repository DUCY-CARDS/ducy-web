// Who has always-on clubs, what each may do, and how much they're used (#98,
// #265). One registry for the whole relay (a Durable Object in worker.js; in
// memory in dev-server.mjs). The rules are ducy-play's club_registry
// (clubRegistry, #463); this keeps them in storage.
//
// Creating a club takes the super admin's permission (a grant), except for
// each player's one trial club: free for TRIAL_DAYS, with the free limits.
// The admin API (admin.js, for the keys in admins.json) grants and revokes
// permission, suspends clubs and changes their plan and limits.
//
// storage: {get(key), put(key, value), delete(key)}, async.
//   clubs         {code: Record}
//   grants        {playerId: {at, note, maxClubs, limits}}: who may create clubs
//   trials        {playerId: code}: each player's trial club, used once
//   day:<date>    {minutes: club-minutes of play that day (UTC)}
//   adminSeq      {adminId: {seq: at}}: admin requests seen lately (#401)
//   adminLog      [{at, by, name, action, target, detail}]: admin actions (#401)
//
// A Record: {owner, at, name, plan: 'trial' | 'club', expires (trials; ms),
//   limits: {tables, tourneysPerDay}, suspended, lastActive, minutes (all
//   time), days: {date: minutes} (the last DAYS_KEPT days), temporary,
//   provedAt}
//
// Temporary clubs (#395): a new club is temporary until its owner proves a
// backup of it works (provedAt, signed by the owner through the club's
// room). One with no activity for TEMP_DAYS is deleted (expired()). Clubs
// made before this have no `temporary` and are kept, as they always were.
//
// limits: {perOwner, total, creators}: at most perOwner clubs for each owner
// and total in all; creators: player IDs granted from the environment
// (CLUB_CREATORS), as well as the stored grants.

import { clubRegistry } from '../../wasm/ducy_wasm.js';

// About what a club costs while its tables run (#93): its object awake at
// 128 MB, so 0.128 GB-s a second; Workers Free allows 13,000 GB-s a day.
export const GBS_PER_CLUB_MINUTE = 0.128 * 60;
export const FREE_GBS_PER_DAY = 13_000;

// The free limits: a trial club's, and a granted club's unless raised.
export const FREE_LIMITS = Object.freeze({tables: 2, tourneysPerDay: 1});
export const TRIAL_DAYS = 14;
const DAYS_KEPT = 30;
// A temporary club this long without activity is deleted (#395).
export const TEMP_DAYS = 7;
// Admin actions kept in the admin log (#401): about 150 KB, in one value.
export const ADMIN_LOG = 1000;

// When temporary club `rec` will be deleted if no one uses it, or null.
export const removesAt = rec => (rec?.temporary ? (rec.lastActive || rec.at || 0) + TEMP_DAYS * 864e5 : null);

export function limitsFrom(env = {}) {
  const n = (v, d) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    perOwner: n(env.MAX_CLUBS_PER_OWNER, 3),
    total: n(env.MAX_CLUBS, 25),
    creators: String(env.CLUB_CREATORS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

// Runs registry op `op` on `parts` ({clubs, grants, trials}): {value,
// registry} (the parts after it, when it changed them). Throws why not.
function run(parts, limits, op, now = Date.now()) {
  const r = clubRegistry(JSON.stringify(parts), JSON.stringify(limits || {}), op, now);
  if (!r.ok) throw new Error(r.message);
  return r;
}

// An op that needs no stored parts.
const pure = (op, now) => run({}, null, op, now).value;
const today = (now = Date.now()) => pure({op: 'dayOf', at: now});

// A club's limits from an admin's input: whole numbers from 0 (0 tables
// means none may open) up to a sane ceiling; anything missing keeps `base`.
export const cleanLimits = (input = {}, base = FREE_LIMITS) => pure({op: 'cleanLimits', input, base});

// Whether a club may run now, and why not: '' when it may.
export function blockedReason(rec, now = Date.now()) {
  if (!rec) return 'This club isn’t on ducy’s server.';
  return run({clubs: {x: rec}}, null, {op: 'status', code: 'x'}, now).value.blocked;
}

export function registry(storage, limits) {
  const parts = async () => ({
    clubs: (await storage.get('clubs')) || {},
    grants: (await storage.get('grants')) || {},
    trials: (await storage.get('trials')) || {},
  });
  // Runs `op`, and keeps the parts it changed.
  async function op(o, now = Date.now()) {
    const before = await parts();
    const r = run(before, limits, o, now);
    if (r.registry) {
      for (const k of ['clubs', 'grants', 'trials']) {
        if (JSON.stringify(r.registry[k]) !== JSON.stringify(before[k])) await storage.put(k, r.registry[k]);
      }
    }
    return r.value;
  }

  // Usage was seated time until #421, which one seat held for two weeks
  // made nonsense: it starts again from then, once (usageV2).
  let usageFresh = null;
  const freshUsage = () => (usageFresh ||= (async () => {
    const now = Date.now();
    if (await storage.get('usageV2')) return;
    for (let i = 0; i <= DAYS_KEPT * 2; i++) await storage.delete(`day:${today(now - i * 864e5)}`);
    const all = (await storage.get('clubs')) || {};
    for (const rec of Object.values(all)) { rec.minutes = 0; rec.days = {}; }
    await storage.put('clubs', all);
    await storage.put('usageV2', now);
  })().catch(e => { usageFresh = null; throw e; }));

  return {
    // `owner` may have a club in room `code`, called `name`: with permission,
    // a club; without, their one trial club. Throws why not. Resolves to the
    // record. `temporary` (#395): false for a club that already existed,
    // moving here from a browser.
    claim: (owner, code, now = Date.now(), name = '', {temporary = true} = {}) => op({op: 'claim', owner, code, name, temporary: !!temporary}, now),
    // The owner proved a backup of club `code` works (#395): it isn't
    // temporary any more. `owner` is who signed the request (the room
    // checked); it must be the club's owner.
    proved: (code, owner, now = Date.now()) => op({op: 'proved', code, owner}, now),
    // Temporary clubs with no activity for TEMP_DAYS (#395): the codes to
    // delete.
    expired: (now = Date.now()) => op({op: 'expired'}, now),
    // Is there an always-on club in room `code`? (A room that should hold one
    // but finds its storage empty rebuilds it from a backup, #97.)
    has: code => op({op: 'has', code}),
    // The club's record, and whether it may run now ('' or why not).
    status: (code, now = Date.now()) => op({op: 'status', code}, now),
    release: code => op({op: 'release', code}),
    // A club's tables were in play for `minutes` (`code`: which club, when
    // known); someone used it (`active`, no minutes).
    async used(minutes, now = Date.now(), code = null) {
      await freshUsage();
      if (code) await op({op: 'used', code, minutes: minutes > 0 ? minutes : 0}, now);
      if (!(minutes > 0)) return;
      const key = `day:${today(now)}`;
      const d = (await storage.get(key)) || {minutes: 0};
      d.minutes += minutes;
      await storage.put(key, d);
    },
    // Clubs, and the last `days` days of use against the free plan.
    async usage(days = 7, now = Date.now()) {
      await freshUsage();
      const all = (await storage.get('clubs')) || {};
      const out = [];
      for (let i = 0; i < days; i++) {
        const day = today(now - i * 864e5);
        const minutes = ((await storage.get(`day:${day}`)) || {minutes: 0}).minutes;
        out.push(pure({op: 'usageDay', day, minutes}));
      }
      const list = run(await parts(), limits, {op: 'list'}, now).value;
      return {clubs: Object.keys(all).length, limits: {perOwner: limits.perOwner, total: limits.total, inviteOnly: true, trialDays: TRIAL_DAYS, free: list.limits.free}, freeGBsPerDay: FREE_GBS_PER_DAY, days: out};
    },

    // ---- the super admin's (admin.js: signed by a key in admins.json) ----

    // Admin `id`'s request numbered `seq` (the time it was signed): throws if
    // it was seen before, so a copied request can't be sent again (#401).
    // Each admin's seqs are kept for twice the window they're accepted in.
    async adminSeen(id, seq, now = Date.now(), windowMs = 5 * 60_000) {
      const all = (await storage.get('adminSeq')) || {};
      all[id] = pure({op: 'adminSeen', seen: all[id] || {}, seq: String(seq), windowMs}, now);
      await storage.put('adminSeq', all);
    },
    // The admin log (#401): {at, by, name, action, target, detail}, newest
    // last, the last ADMIN_LOG kept.
    async adminLog(entry) {
      const log = (await storage.get('adminLog')) || [];
      log.push(entry);
      if (log.length > ADMIN_LOG) log.splice(0, log.length - ADMIN_LOG);
      await storage.put('adminLog', log);
    },
    async adminLogList() {
      return (await storage.get('adminLog')) || [];
    },

    // Every club with its record, who has permission, and who used a trial.
    async list(now = Date.now()) {
      await freshUsage();
      return op({op: 'list'}, now);
    },
    // Lets `id` create clubs: up to `maxClubs` (default perOwner), each with
    // `limits` (default the free ones).
    grant: (id, {note = '', maxClubs = 0, limits: l = null} = {}, now = Date.now()) =>
      op({op: 'grant', id: String(id), note: String(note), maxClubs: Number.isSafeInteger(maxClubs) && maxClubs > 0 ? maxClubs : 0, limits: l}, now),
    // Takes permission away; their clubs carry on until suspended.
    revoke: id => op({op: 'revoke', id: String(id)}),
    // Changes a club: {suspended, limits, plan ('trial' | 'club'), expires
    // (ms, for a trial)}.
    setClub: (code, change = {}, now = Date.now()) => op({op: 'setClub', code, change}, now),
  };
}

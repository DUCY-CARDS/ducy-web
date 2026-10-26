// Who has always-on clubs, what each may do, and how much they're used (#98,
// #265). One registry for the whole relay (a Durable Object in worker.js; in
// memory in dev-server.mjs).
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

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const ID = /^[\w-]{1,64}$/;

// A club's limits from an admin's input: whole numbers from 0 (0 tables
// means none may open) up to a sane ceiling; anything missing keeps `base`.
export function cleanLimits(input = {}, base = FREE_LIMITS) {
  const ok = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
  return {
    tables: ok(input.tables, 50) ? input.tables : base.tables,
    tourneysPerDay: ok(input.tourneysPerDay, 50) ? input.tourneysPerDay : base.tourneysPerDay,
  };
}

// Whether a club may run now, and why not: '' when it may.
export function blockedReason(rec, now = Date.now()) {
  if (!rec) return 'This club isn’t on ducy’s server.';
  if (rec.suspended) return 'ducy has paused this club. Its owner can ask ducy why.';
  if (rec.plan === 'trial' && rec.expires && now >= rec.expires) return 'This club’s free trial has ended. Its owner can ask ducy to keep it going.';
  return '';
}

export function registry(storage, limits) {
  const clubs = async () => (await storage.get('clubs')) || {};
  const grants = async () => (await storage.get('grants')) || {};
  const trials = async () => (await storage.get('trials')) || {};
  const granted = async owner => limits.creators.includes(owner) ? {} : (await grants())[owner] || null;
  // Records gain fields over time: fill in what an older one lacks. An
  // older club isn't temporary (#395).
  const full = rec => ({plan: 'club', limits: {...FREE_LIMITS}, suspended: false, lastActive: rec.at, minutes: 0, days: {}, name: '', temporary: false, ...rec});

  // Usage was seated time until #421, which one seat held for two weeks
  // made nonsense: it starts again from then, once (usageV2).
  let usageFresh = null;
  const freshUsage = () => (usageFresh ||= (async () => {
    const now = Date.now();
    if (await storage.get('usageV2')) return;
    for (let i = 0; i <= DAYS_KEPT * 2; i++) await storage.delete(`day:${today(now - i * 864e5)}`);
    const all = await clubs();
    for (const rec of Object.values(all)) { rec.minutes = 0; rec.days = {}; }
    await storage.put('clubs', all);
    await storage.put('usageV2', now);
  })().catch(e => { usageFresh = null; throw e; }));

  async function update(code, fn) {
    const all = await clubs();
    if (!all[code]) throw new Error('No such club.');
    all[code] = full(all[code]);
    fn(all[code]);
    await storage.put('clubs', all);
    return all[code];
  }

  return {
    // `owner` may have a club in room `code`, called `name`: with permission,
    // a club; without, their one trial club. Throws why not. Resolves to the
    // record. `temporary` (#395): false for a club that already existed,
    // moving here from a browser.
    async claim(owner, code, now = Date.now(), name = '', {temporary = true} = {}) {
      const all = await clubs();
      if (all[code]) throw new Error('That club code is in use.');
      if (Object.keys(all).length >= limits.total) throw new Error('ducy’s server is full of clubs for now. Try again later.');
      const grant = await granted(owner);
      let rec;
      if (grant) {
        const most = grant.maxClubs || limits.perOwner;
        if (Object.values(all).filter(c => c.owner === owner).length >= most) throw new Error(`You already have ${most} ${most === 1 ? 'club' : 'clubs'}, the most ducy has allowed you.`);
        rec = {owner, at: now, name, plan: 'club', limits: cleanLimits(grant.limits || {})};
      } else {
        const t = await trials();
        if (t[owner]) throw new Error('You’ve already had your free trial club. To run a club, ask ducy for permission.');
        t[owner] = code;
        await storage.put('trials', t);
        rec = {owner, at: now, name, plan: 'trial', expires: now + TRIAL_DAYS * 864e5, limits: {...FREE_LIMITS}};
      }
      // Temporary until a backup of it is proved (#395).
      all[code] = full({...rec, temporary: !!temporary});
      await storage.put('clubs', all);
      return all[code];
    },
    // The owner proved a backup of club `code` works (#395): it isn't
    // temporary any more. `owner` is who signed the request (the room
    // checked); it must be the club's owner.
    async proved(code, owner, now = Date.now()) {
      const rec = (await clubs())[code];
      if (!rec) throw new Error('No such club.');
      if (rec.owner !== owner) throw new Error('Only the club’s owner can do that.');
      return update(code, r => { r.temporary = false; r.provedAt = now; });
    },
    // Temporary clubs with no activity for TEMP_DAYS (#395): the codes to
    // delete.
    async expired(now = Date.now()) {
      return Object.entries(await clubs()).filter(([, rec]) => { const at = removesAt(full(rec)); return at != null && at <= now; }).map(([code]) => code);
    },
    // Is there an always-on club in room `code`? (A room that should hold one
    // but finds its storage empty rebuilds it from a backup, #97.)
    async has(code) {
      return !!(await clubs())[code];
    },
    // The club's record, and whether it may run now ('' or why not).
    async status(code, now = Date.now()) {
      const rec = (await clubs())[code];
      return {record: rec ? full(rec) : null, blocked: blockedReason(rec && full(rec), now)};
    },
    async release(code) {
      const all = await clubs();
      if (!all[code]) return;
      delete all[code];
      await storage.put('clubs', all);
    },
    // A club's tables were in play for `minutes` (`code`: which club, when
    // known); someone used it (`active`, no minutes).
    async used(minutes, now = Date.now(), code = null) {
      await freshUsage();
      if (code) {
        const all = await clubs();
        if (all[code]) {
          const rec = (all[code] = full(all[code]));
          rec.lastActive = Math.max(rec.lastActive || 0, now);
          if (minutes > 0) {
            rec.minutes += minutes;
            const day = today(now);
            rec.days[day] = (rec.days[day] || 0) + minutes;
            const keep = today(now - DAYS_KEPT * 864e5);
            for (const d of Object.keys(rec.days)) if (d < keep) delete rec.days[d];
          }
          await storage.put('clubs', all);
        }
      }
      if (!(minutes > 0)) return;
      const key = `day:${today(now)}`;
      const d = (await storage.get(key)) || {minutes: 0};
      d.minutes += minutes;
      await storage.put(key, d);
    },
    // Clubs, and the last `days` days of use against the free plan.
    async usage(days = 7, now = Date.now()) {
      await freshUsage();
      const all = await clubs();
      const out = [];
      for (let i = 0; i < days; i++) {
        const day = today(now - i * 864e5);
        const minutes = ((await storage.get(`day:${day}`)) || {minutes: 0}).minutes;
        const gbs = Math.round(minutes * GBS_PER_CLUB_MINUTE);
        out.push({day, clubHours: Math.round(minutes / 6) / 10, gbs, share: Math.round((gbs / FREE_GBS_PER_DAY) * 1000) / 10});
      }
      return {clubs: Object.keys(all).length, limits: {perOwner: limits.perOwner, total: limits.total, inviteOnly: true, trialDays: TRIAL_DAYS, free: FREE_LIMITS}, freeGBsPerDay: FREE_GBS_PER_DAY, days: out};
    },

    // ---- the super admin's (admin.js: signed by a key in admins.json) ----

    // Admin `id`'s request numbered `seq` (the time it was signed): throws if
    // it was seen before, so a copied request can't be sent again (#401).
    // Each admin's seqs are kept for twice the window they're accepted in.
    async adminSeen(id, seq, now = Date.now(), windowMs = 5 * 60_000) {
      const all = (await storage.get('adminSeq')) || {};
      const mine = all[id] || {};
      for (const [k, at] of Object.entries(mine)) if (now - at > 2 * windowMs) delete mine[k];
      if (mine[seq]) throw new Error('This request was already received.');
      mine[seq] = now;
      all[id] = mine;
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
      const all = await clubs();
      const env = Object.fromEntries(limits.creators.map(id => [id, {fromEnv: true}]));
      return {
        clubs: Object.entries(all).map(([code, rec]) => ({code, ...full(rec), blocked: blockedReason(full(rec), now), removesAt: removesAt(full(rec))})),
        grants: {...env, ...(await grants())},
        trials: await trials(),
        limits: {perOwner: limits.perOwner, total: limits.total, trialDays: TRIAL_DAYS, free: FREE_LIMITS, tempDays: TEMP_DAYS},
      };
    },
    // Lets `id` create clubs: up to `maxClubs` (default perOwner), each with
    // `limits` (default the free ones).
    async grant(id, {note = '', maxClubs = 0, limits: l = null} = {}, now = Date.now()) {
      if (!ID.test(id)) throw new Error('That isn’t a player ID.');
      const g = await grants();
      g[id] = {at: now, note: String(note).slice(0, 200), maxClubs: Number.isSafeInteger(maxClubs) && maxClubs > 0 ? maxClubs : 0, ...(l ? {limits: cleanLimits(l)} : {})};
      await storage.put('grants', g);
      return g[id];
    },
    // Takes permission away; their clubs carry on until suspended.
    async revoke(id) {
      const g = await grants();
      delete g[id];
      await storage.put('grants', g);
    },
    // Changes a club: {suspended, limits, plan ('trial' | 'club'), expires
    // (ms, for a trial), name}.
    async setClub(code, change = {}) {
      return update(code, rec => {
        if (typeof change.suspended === 'boolean') rec.suspended = change.suspended;
        if (change.limits) rec.limits = cleanLimits(change.limits, rec.limits);
        if (change.plan === 'club') { rec.plan = 'club'; delete rec.expires; }
        if (change.plan === 'trial') { rec.plan = 'trial'; rec.expires ??= Date.now() + TRIAL_DAYS * 864e5; }
        if (Number.isSafeInteger(change.expires) && rec.plan === 'trial') rec.expires = change.expires;
      });
    },
  };
}

// Who has always-on clubs, what each may do, and how much they're used (#98,
// #265). One registry for the whole relay (a Durable Object in worker.js; in
// memory in dev-server.mjs). The rules are ducy-play's club_registry
// (clubRegistry, #463); this keeps them in storage.
//
// Creating a club takes the super admin's grant (#636), and nothing else: no
// trial clubs, and CLUB_CREATORS isn't read any more. A grant is for one
// player ID and one club. The admin API (admin.js, for the keys in
// admins.json) makes it and gets back a one-time link with a secret token
// (only its hash is kept here). The player opens the link and signs a
// create_club carrying the token; claim() takes it only from that player,
// only once. Granting again gives a new link (the old one stops working);
// revoking an unused grant kills its link. wipe() deletes every club and
// grant (the admin site's Wipe all clubs).
//
// storage: {get(key), put(key, value), delete(key)}, async.
//   clubs         {code: Record}
//   grants        {playerId: {at, note, maxClubs, limits}}: unused grants, as
//                 ducy-play's rules read them
//   invites       {playerId: {hash, at, note, limits, usedAt, code}}: each
//                 grant's link: its token's SHA-256 (null once used), and
//                 the club it made
//   trials        {playerId: code}: trial clubs from before #636
//   day:<date>    {minutes: club-minutes of play that day (UTC)}
//   adminSeq      {adminId: {seq: at}}: admin requests seen lately (#401)
//   adminLog      [{at, by, name, action, target, detail}]: admin actions (#401)
//   errors        {key: row}: what pages reported going wrong (#552, error-log.js)
//
// A Record: {owner, at, name, plan: 'trial' | 'club', expires (trials; ms),
//   limits: {tables, tourneysPerDay}, suspended, lastActive, minutes (all
//   time), days: {date: minutes} (the last DAYS_KEPT days), temporary,
//   provedAt}
//
// Temporary clubs (#395): a new club is temporary until its owner proves a
// backup of it works (provedAt, signed by the owner through the club's
// room). One with no activity for TEMP_DAYS is deleted (expired()).
//
// limits: {perOwner, total}: at most perOwner clubs for each owner and total
// in all.

import { clubRegistry } from '../../wasm/ducy_wasm.js';
import { addReport, cleanReport, reportLimiter } from './error-log.js';

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

// Only a grant makes a club (#636): no creators from the environment, no trials.
export function limitsFrom(env = {}) {
  const n = (v, d) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {perOwner: n(env.MAX_CLUBS_PER_OWNER, 3), total: n(env.MAX_CLUBS, 25), creators: [], noTrials: true};
}

// A grant's link token (#636): 32 random bytes, base64url.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function newGrantToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Its SHA-256, hex; '' for anything that isn't a token.
export async function grantHash(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join('');
}
// The one answer for every link that won't do, so a link tells no one anything.
export const NOT_YOUR_LINK = 'This link isn’t for this player ID, or it was used or taken back.';

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

  const takeReport = reportLimiter();

  // Grants are checked and used up one at a time: nothing else that touches
  // them runs between the check and the use.
  let chain = Promise.resolve();
  const serial = fn => {
    const out = chain.then(fn);
    chain = out.catch(() => {});
    return out;
  };
  const invites = async () => (await storage.get('invites')) || {};
  // An invite as the admin site sees it: never its hash.
  const shown = ({hash: _h, ...rest}) => ({...rest, used: !!rest.usedAt});

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
    // `owner` may have a club in room `code`, called `name`, with `grant`,
    // the token from their link (#636): it must be their unused grant's.
    // Throws why not; else the grant is used up, and this resolves to the
    // club's record. A new club is temporary (#395).
    async claim(owner, code, now = Date.now(), name = '', {grant = ''} = {}) {
      // Hashed first: once in serial(), only storage is awaited.
      const hash = await grantHash(grant);
      return serial(async () => {
        const all = await invites();
        const inv = Object.hasOwn(all, owner) ? all[owner] : null;
        if (!hash || !inv || inv.usedAt || inv.hash !== hash) throw new Error(NOT_YOUR_LINK);
        const rec = await op({op: 'claim', owner, code, name, temporary: true}, now);
        await op({op: 'revoke', id: owner});
        all[owner] = {...inv, hash: null, usedAt: now, code};
        await storage.put('invites', all);
        return rec;
      });
    },
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

    // A page's error report (#552): junk, and any over the minute's limit, are dropped.
    async report(raw, now = Date.now()) {
      const report = cleanReport(raw);
      if (!report || !takeReport(now)) return;
      await storage.put('errors', addReport((await storage.get('errors')) || {}, report, now));
    },

    // ---- the super admin's (admin.js: signed by a key in admins.json) ----

    // What's gone wrong, most recent first.
    async errors() {
      return Object.values((await storage.get('errors')) || {}).sort((a, b) => b.last - a.last);
    },

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

    // Every club with its record, the unused grants, every grant's link
    // (`invites`: used or not, never its token), and who had a trial.
    async list(now = Date.now()) {
      await freshUsage();
      const out = await op({op: 'list'}, now);
      out.invites = Object.fromEntries(Object.entries(await invites()).map(([id, v]) => [id, shown(v)]));
      return out;
    },
    // Lets `id` create one club (#636), with `limits` (default the free
    // ones): {...grant, token}, the token for their link, shown this once.
    // A grant already there, used or not, is replaced: its link stops working.
    grant: (id, {note = '', limits: l = null} = {}, now = Date.now()) => serial(async () => {
      const g = await op({op: 'grant', id: String(id), note: String(note), maxClubs: 0, limits: l}, now);
      const token = newGrantToken();
      const all = await invites();
      all[String(id)] = {hash: await grantHash(token), at: now, note: g.note, limits: g.limits || null, usedAt: null, code: null};
      await storage.put('invites', all);
      return {...g, token};
    }),
    // The relay vouched that `to` is the owner of club `code`, `from`, on a
    // new device (#575): the club's record, and any permission, follow.
    async moveOwner(code, from, to) {
      const clubs = (await storage.get('clubs')) || {};
      if (clubs[code]?.owner !== from) return;
      clubs[code].owner = to;
      await storage.put('clubs', clubs);
      const grants = (await storage.get('grants')) || {};
      if (grants[from] && !grants[to]) { grants[to] = grants[from]; await storage.put('grants', grants); }
    },
    // Takes a grant away, and its link with it; a club it made carries on
    // until suspended.
    revoke: id => serial(async () => {
      await op({op: 'revoke', id: String(id)});
      const all = await invites();
      if (Object.hasOwn(all, String(id))) { delete all[String(id)]; await storage.put('invites', all); }
    }),
    // Every club's code (#636): what Wipe all clubs deletes, room by room.
    clubCodes: async () => Object.keys((await storage.get('clubs')) || {}),
    // Wipe all clubs (#636), once each room's data is gone: every club's
    // record, every grant and link, and the trials.
    wipe: () => serial(async () => {
      for (const k of ['clubs', 'grants', 'invites', 'trials']) await storage.delete(k);
    }),
    // Changes a club: {suspended, limits, plan ('trial' | 'club'), expires
    // (ms, for a trial)}.
    setClub: (code, change = {}, now = Date.now()) => op({op: 'setClub', code, change}, now),
  };
}

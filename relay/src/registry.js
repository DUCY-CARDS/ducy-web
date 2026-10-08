// Who has always-on clubs, and how much they're used (#98). One registry for
// the whole relay (a Durable Object in worker.js; in memory in
// dev-server.mjs), so creating clubs can be limited while ducy is on
// Cloudflare's free plan, and usage watched against it.
//
// storage: {get(key), put(key, value), delete(key)}, async.
//   clubs         {code: {owner, at}}
//   day:<date>    {minutes: club-minutes of play that day (UTC)}
//
// limits: {perOwner, total, creators}: at most perOwner clubs for each owner
// and total in all; creators, if not empty, the only player IDs that may
// create one.

// About what a club costs while its tables run (#93): its object awake at
// 128 MB, so 0.128 GB-s a second; Workers Free allows 13,000 GB-s a day.
export const GBS_PER_CLUB_MINUTE = 0.128 * 60;
export const FREE_GBS_PER_DAY = 13_000;

export function limitsFrom(env = {}) {
  const n = (v, d) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    perOwner: n(env.MAX_CLUBS_PER_OWNER, 3),
    total: n(env.MAX_CLUBS, 25),
    creators: String(env.CLUB_CREATORS || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function registry(storage, limits) {
  const clubs = async () => (await storage.get('clubs')) || {};
  return {
    // `owner` may have one more club, in room `code`; throws why not.
    async claim(owner, code, now = Date.now()) {
      const all = await clubs();
      if (all[code]) throw new Error('That club code is in use.');
      if (limits.creators.length && !limits.creators.includes(owner)) throw new Error('Always-on clubs are invite-only for now. Ask ducy for access, or run your club in this browser.');
      if (Object.values(all).filter(c => c.owner === owner).length >= limits.perOwner) throw new Error(`You already have ${limits.perOwner} always-on clubs, the most for now.`);
      if (Object.keys(all).length >= limits.total) throw new Error('ducy’s server is full of always-on clubs for now. Run your club in this browser, or try again later.');
      all[code] = {owner, at: now};
      await storage.put('clubs', all);
    },
    // Is there an always-on club in room `code`? (A room that should hold one
    // but finds its storage empty rebuilds it from a backup, #97.)
    async has(code) {
      return !!(await clubs())[code];
    },
    async release(code) {
      const all = await clubs();
      if (!all[code]) return;
      delete all[code];
      await storage.put('clubs', all);
    },
    // A club's tables were in play for `minutes`.
    async used(minutes, now = Date.now()) {
      if (!(minutes > 0)) return;
      const key = `day:${today(now)}`;
      const d = (await storage.get(key)) || {minutes: 0};
      d.minutes += minutes;
      await storage.put(key, d);
    },
    // Clubs, and the last `days` days of use against the free plan.
    async usage(days = 7, now = Date.now()) {
      const all = await clubs();
      const out = [];
      for (let i = 0; i < days; i++) {
        const day = today(now - i * 864e5);
        const minutes = ((await storage.get(`day:${day}`)) || {minutes: 0}).minutes;
        const gbs = Math.round(minutes * GBS_PER_CLUB_MINUTE);
        out.push({day, clubHours: Math.round(minutes / 6) / 10, gbs, share: Math.round((gbs / FREE_GBS_PER_DAY) * 1000) / 10});
      }
      return {clubs: Object.keys(all).length, limits: {perOwner: limits.perOwner, total: limits.total, inviteOnly: limits.creators.length > 0}, freeGBsPerDay: FREE_GBS_PER_DAY, days: out};
    },
  };
}

// Usage counts for the admin site (#601): totals per day (UTC), counted by
// the registry (registry.js) as rooms tell it what happened. Counts only: no
// list of who played, no IPs, no places.
//
// Events, note(ev):
//   {kind: 'player', id, code}   a player connected to club `code` (proven)
//   {kind: 'game'}               a friends game began (its host counts as a player)
//   {kind: 'gamePlayer'}         another player joined that game
//   {kind: 'hand'}               a friends game's hand finished (its host says so)
//   {kind: 'clubHand', code, ids} a club hand finished, with these seats
// The admins' own player IDs (`admins`, admins.json) aren't counted, and a
// club hand only they played isn't either.
//
// Active players: each day, a set of the players' IDs hashed with a salt
// only this relay has. Once the day is over it's counted and deleted.
// New players: a Bloom filter of the same hashes, so whether an ID was seen
// before can be asked, but no one can list who was.
//
// storage: {get, put, delete}, async.
//   statsSalt          the salt (hex)
//   statsKnown         the Bloom filter (Uint8Array)
//   statsDays          the dates with a record, oldest first
//   statsDay:<date>    {newPlayers, games, gamePlayers, hands, clubHands,
//                       active, clubsActive (once the day is counted)}
//   statsSeen:<date>   {hash: 1}: the day's players, until it's counted
//   statsClubs:<date>  {code: 1}: the day's clubs, until it's counted

export const STATS_DAYS = 90; // days kept
const BLOOM_BYTES = 1 << 16, BLOOM_K = 5; // 512K bits: few false "seen before" below 50,000 players

export const dayOf = t => new Date(t).toISOString().slice(0, 10);
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const empty = () => ({newPlayers: 0, games: 0, gamePlayers: 0, hands: 0, clubHands: 0});

// The bits a hash sets in the Bloom filter.
function bloomBits(h) {
  const out = [];
  for (let i = 0; i < BLOOM_K; i++) out.push(((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0 & (BLOOM_BYTES * 8 - 1));
  return out;
}

export function stats(storage, {admins = new Set()} = {}) {
  const isAdmin = id => admins.has(id);
  let salt = null;
  async function hash(id) {
    if (!salt) {
      salt = await storage.get('statsSalt');
      if (!salt) {
        salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        await storage.put('statsSalt', salt);
      }
    }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${id}`)));
  }

  // One change at a time, so no count is lost between a read and a write.
  let chain = Promise.resolve();
  const serial = fn => (chain = chain.then(fn, fn));

  const dayRec = async d => ({...empty(), ...((await storage.get(`statsDay:${d}`)) || {})});

  // A record for `d`, listed; days older than STATS_DAYS go.
  async function listed(d) {
    const days = (await storage.get('statsDays')) || [];
    if (days.includes(d)) return;
    days.push(d);
    days.sort();
    const cut = dayOf(Date.parse(d) - STATS_DAYS * 864e5);
    const old = days.filter(x => x < cut);
    for (const x of old) {
      await storage.delete(`statsDay:${x}`);
      await storage.delete(`statsSeen:${x}`);
      await storage.delete(`statsClubs:${x}`);
    }
    await storage.put('statsDays', days.filter(x => x >= cut));
  }

  // Days before today still holding their sets: counted, and the sets deleted.
  let rolled = null; // the day roll() last ran on
  async function roll(now) {
    const today = dayOf(now);
    if (rolled === today) return;
    rolled = today;
    for (const d of (await storage.get('statsDays')) || []) {
      if (d >= today) continue;
      const rec = await dayRec(d);
      if (rec.active != null) continue;
      rec.active = Object.keys((await storage.get(`statsSeen:${d}`)) || {}).length;
      rec.clubsActive = Object.keys((await storage.get(`statsClubs:${d}`)) || {}).length;
      await storage.put(`statsDay:${d}`, rec);
      await storage.delete(`statsSeen:${d}`);
      await storage.delete(`statsClubs:${d}`);
    }
  }

  async function addTo(d, set, key) {
    const k = `${set}:${d}`;
    const s = (await storage.get(k)) || {};
    if (s[key]) return false;
    s[key] = 1;
    await storage.put(k, s);
    return true;
  }

  async function note(ev, now) {
    const d = dayOf(now);
    await roll(now);
    await listed(d);
    const rec = await dayRec(d);
    const code = typeof ev.code === 'string' ? ev.code.slice(0, 16) : '';
    if (ev.kind === 'player') {
      const id = String(ev.id || '');
      if (!id || isAdmin(id)) return;
      const h = await hash(id);
      if (code) await addTo(d, 'statsClubs', code);
      if (!(await addTo(d, 'statsSeen', hex(h.slice(0, 12))))) return;
      // First time today: seen ever before?
      const known = (await storage.get('statsKnown')) || new Uint8Array(BLOOM_BYTES);
      const bits = bloomBits(h);
      if (bits.every(b => known[b >> 3] & (1 << (b & 7)))) return;
      for (const b of bits) known[b >> 3] |= 1 << (b & 7);
      await storage.put('statsKnown', known);
      rec.newPlayers++;
    } else if (ev.kind === 'game') {
      rec.games++;
      rec.gamePlayers++;
    } else if (ev.kind === 'gamePlayer') {
      rec.gamePlayers++;
    } else if (ev.kind === 'hand') {
      rec.hands++;
    } else if (ev.kind === 'clubHand') {
      const ids = Array.isArray(ev.ids) ? ev.ids.map(String) : [];
      if (ids.length && ids.every(isAdmin)) return;
      rec.hands++;
      rec.clubHands++;
      if (code) await addTo(d, 'statsClubs', code);
    } else return;
    await storage.put(`statsDay:${d}`, rec);
  }

  return {
    note: (ev, now = Date.now()) => serial(() => note(ev || {}, now)),
    // The last `n` days, oldest first: {day, active, newPlayers, games,
    // playersPerGame, hands, clubsActive, clubHands}. Today's active players
    // and clubs are so far.
    days: (n = 30, now = Date.now()) => serial(async () => {
      await roll(now);
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = dayOf(now - i * 864e5);
        const rec = await dayRec(d);
        const active = rec.active ?? Object.keys((await storage.get(`statsSeen:${d}`)) || {}).length;
        const clubsActive = rec.clubsActive ?? Object.keys((await storage.get(`statsClubs:${d}`)) || {}).length;
        out.push({
          day: d, active, newPlayers: rec.newPlayers, games: rec.games,
          playersPerGame: rec.games ? Math.round((rec.gamePlayers / rec.games) * 10) / 10 : null,
          hands: rec.hands, clubsActive, clubHands: rec.clubHands,
        });
      }
      return out;
    }),
  };
}

// Friends games live now (#601), as their rooms report them: {code: {players,
// at}}. One not heard from in a day is taken as gone (its room was reset).
export const LIVE_STALE_MS = 864e5;
export function liveGames(all, now = Date.now()) {
  return Object.values(all || {}).filter(g => now - g.at < LIVE_STALE_MS);
}

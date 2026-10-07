// Stored club hands (#71), in this browser's IndexedDB: localStorage is too
// small (about 5 MB) and blocks the page. One store, 'hands', keyed by the
// record's id (hand-replay.js handRecord), with indexes on club and time.
// Hands are kept for a limited time only: the host keeps the last N days,
// a player their last N hands (decided on #71).

const DB = 'ducy-hands', STORE = 'hands';
export const HOST_KEEP_DAYS = 7, PLAYER_KEEP_HANDS = 500;

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, {keyPath: 'id'});
      s.createIndex('club', 'club');
      s.createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function done(t) {
  return new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });
}

export async function saveHand(rec) {
  const t = (await db()).transaction(STORE, 'readwrite');
  t.objectStore(STORE).put(rec);
  return done(t);
}

// A club's hands seen by `who` ('host' or a player id), newest first.
export async function listHands(club, who, limit = 200) {
  const t = (await db()).transaction(STORE, 'readonly');
  const req = t.objectStore(STORE).index('club').getAll(IDBKeyRange.only(club));
  await done(t);
  return req.result.filter(r => r.who === who).sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function getHand(id) {
  const t = (await db()).transaction(STORE, 'readonly');
  const req = t.objectStore(STORE).get(id);
  await done(t);
  return req.result || null;
}

// Deletes a club's hands seen by `who` beyond the retention: older than
// `days` days (the host), or beyond the newest `keep` (a player).
export async function prune(club, who, {days = 0, keep = 0} = {}) {
  const all = await listHands(club, who, Infinity);
  const cutoff = days ? Date.now() - days * 864e5 : -Infinity;
  const gone = all.filter((r, i) => r.at < cutoff || (keep && i >= keep));
  if (!gone.length) return 0;
  const t = (await db()).transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  for (const r of gone) s.delete(r.id);
  await done(t);
  return gone.length;
}

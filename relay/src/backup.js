// Off-Cloudflare backups of always-on clubs (#97): a club's room sends a
// snapshot of its storage to a small endpoint on ducy.cards' host
// (relay/hostrocket/backup.php, MySQL), and a room that should hold a club
// but finds its storage empty rebuilds it from the latest one.
//
// Snapshots hold the club's signing key, so they're encrypted here
// (AES-256-GCM with BACKUP_KEY) before they leave: the endpoint and its
// database only ever see ciphertext. Requests are authenticated with an
// HMAC-SHA-256 (BACKUP_SECRET) over the time, the club code and a hash of
// the body, and refused more than 5 minutes off.
//
// config: {url, secret, key}: the endpoint, the HMAC secret and the AES key
// (base64, 32 bytes). Backups are off unless all three are set.
//
// Protocol (backup.php implements the other side):
//   POST   url?club=CODE  body: ciphertext JSON   saves a snapshot
//   GET    url?club=CODE                          the latest one, or 404
//   DELETE url?club=CODE                          drops them all
// with headers X-Ducy-Time (ms) and X-Ducy-Sig, the hex HMAC of
// `${time}\n${method}\n${club}\n${hex sha-256 of the body ('' for none)}`.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// In chunks: a whole club's ciphertext is too big to spread into one call.
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// The room's storage keys that make up a club (club-room.js), besides tables.
export const SNAPSHOT_KEYS = ['club', 'identity', 'hostKey', 'verifier', 'memberPubs', 'handoff'];
// At most one backup per club this often, plus one after the last change.
export const BACKUP_EVERY_MS = 5 * 60_000;

export function backupConfig(env = {}) {
  const c = {url: env.BACKUP_URL || '', secret: env.BACKUP_SECRET || '', key: env.BACKUP_KEY || ''};
  return c.url && c.secret && c.key ? c : null;
}

// The club's storage as one value. Tables saved mid-hand aren't included: a
// club rebuilt from a backup starts its tables afresh, with everyone's
// chips as the ledger last had them.
export async function snapshot(storage, code) {
  const s = {v: 1, code, at: Date.now()};
  for (const k of SNAPSHOT_KEYS) {
    const v = await storage.get(k);
    if (v !== undefined) s[k] = v;
  }
  return s;
}

export async function restore(storage, snap) {
  if (snap?.v !== 1 || !snap.club) throw new Error('not a club snapshot');
  for (const k of SNAPSHOT_KEYS) if (snap[k] !== undefined) await storage.put(k, snap[k]);
}

async function aesKey(key, usage) {
  return subtle().importKey('raw', unb64(key), 'AES-GCM', false, [usage]);
}

export async function encrypt(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({name: 'AES-GCM', iv}, await aesKey(key, 'encrypt'), enc.encode(JSON.stringify(value)));
  return {v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct))};
}

export async function decrypt(key, box) {
  const pt = await subtle().decrypt({name: 'AES-GCM', iv: unb64(box.iv)}, await aesKey(key, 'decrypt'), unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// The X-Ducy-Sig for a request.
export async function signature(secret, time, method, club, body = '') {
  const hmac = await subtle().importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const bodyHash = body ? hex(await subtle().digest('SHA-256', enc.encode(body))) : '';
  return hex(await subtle().sign('HMAC', hmac, enc.encode(`${time}\n${method}\n${club}\n${bodyHash}`)));
}

async function request(config, method, club, body = '') {
  const time = String(Date.now());
  const u = new URL(config.url);
  u.searchParams.set('club', club);
  return fetch(u, {
    method,
    headers: {'x-ducy-time': time, 'x-ducy-sig': await signature(config.secret, time, method, club, body), ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body} : {}),
  });
}

// Sends the club's snapshot; throws if the endpoint didn't take it.
export async function pushBackup(config, storage, code) {
  const body = JSON.stringify(await encrypt(config.key, await snapshot(storage, code)));
  const res = await request(config, 'POST', code, body);
  if (!res.ok) throw new Error(`backup refused: ${res.status} ${await res.text()}`);
}

// Rebuilds the club from its latest snapshot. Resolves to whether there was one.
export async function pullBackup(config, storage, code) {
  const res = await request(config, 'GET', code);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`backup not read: ${res.status} ${await res.text()}`);
  const snap = await decrypt(config.key, await res.json());
  if (snap.code !== code) throw new Error('that backup is for another club');
  await restore(storage, snap);
  return true;
}

export async function dropBackups(config, code) {
  const res = await request(config, 'DELETE', code);
  if (!res.ok && res.status !== 404) throw new Error(`backups not dropped: ${res.status}`);
}

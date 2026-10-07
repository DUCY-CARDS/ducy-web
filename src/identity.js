// A player's identity for clubs (#65): a signing key pair kept in this
// browser, a short player ID derived from its public key, and signed messages
// that a host can check.
//
// The keys are Ed25519 where the browser has it, otherwise ECDSA P-256. They
// live in IndexedDB (loadIdentity) and can be exported to a file and imported
// on another browser (exportIdentity / importIdentity), which keeps the same
// player ID. Everything except loadIdentity / saveIdentity works without a
// browser, so the tests run it in Node.
//
// A signed message is an envelope {v, from, alg, pub, seq, body, sig}:
//   from  the sender's player ID       pub  their public key (base64url, raw)
//   seq   a number that only goes up   sig  signature (base64url) over the rest
// A host keeps a Verifier, which rejects bad signatures, an ID that doesn't
// match its key, a known ID with a different key, and replays (seq not above
// the last one seen from that sender).

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const ID_LENGTH = 8;

const KEY_ALGS = {
  ed25519: {gen: {name: 'Ed25519'}, sign: {name: 'Ed25519'}},
  p256: {gen: {name: 'ECDSA', namedCurve: 'P-256'}, sign: {name: 'ECDSA', hash: 'SHA-256'}},
};

const subtle = () => globalThis.crypto.subtle;

// ---- encoding ----

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, c => c.charCodeAt(0));
}

// ID_LENGTH Base58 digits from a hash, all about equally likely: the hash as
// a number mod 58^8, written with exactly 8 digits ('1' is zero).
function base58Id(hash) {
  let n = 0n;
  for (const b of new Uint8Array(hash)) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < ID_LENGTH; i++) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
}

export function isPlayerId(s) {
  return typeof s === 'string' && s.length === ID_LENGTH && [...s].every(c => B58.includes(c));
}

// JSON with object keys sorted at every level, so the signer and the verifier
// sign the same bytes whatever order the fields were built in.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---- keys ----

export async function playerIdFor(rawPublicKey) {
  return base58Id(await subtle().digest('SHA-256', rawPublicKey));
}

async function fromKeys(alg, privateKey, publicKey, seq = 0) {
  const raw = new Uint8Array(await subtle().exportKey('raw', publicKey));
  return {alg, privateKey, publicKey, pub: b64url(raw), id: await playerIdFor(raw), seq};
}

// A new identity. The private key is extractable so it can be backed up.
export async function createIdentity() {
  for (const alg of ['ed25519', 'p256']) {
    let keys;
    try {
      keys = await subtle().generateKey(KEY_ALGS[alg].gen, true, ['sign', 'verify']);
    } catch {
      continue; // no Ed25519 in this browser
    }
    return fromKeys(alg, keys.privateKey, keys.publicKey);
  }
  throw new Error('This browser can’t create signing keys.');
}

// The identity as a backup file's JSON. It holds the private key: whoever has
// the file can act as this player.
export async function exportIdentity(ident) {
  const key = await subtle().exportKey('jwk', ident.privateKey);
  return JSON.stringify({type: 'ducy-identity', v: 1, id: ident.id, alg: ident.alg, seq: ident.seq, key});
}

export async function importIdentity(text) {
  let f;
  try { f = JSON.parse(text); } catch { throw new Error('That isn’t a ducy identity file.'); }
  if (!f || f.type !== 'ducy-identity' || f.v !== 1 || !KEY_ALGS[f.alg] || !f.key) throw new Error('That isn’t a ducy identity file.');
  const gen = KEY_ALGS[f.alg].gen;
  const privateKey = await subtle().importKey('jwk', f.key, gen, true, ['sign']);
  const {d, key_ops, ...pubJwk} = f.key;
  const publicKey = await subtle().importKey('jwk', {...pubJwk, key_ops: ['verify']}, gen, true, ['verify']);
  const ident = await fromKeys(f.alg, privateKey, publicKey, Number(f.seq) || 0);
  if (f.id && f.id !== ident.id) throw new Error('The identity file is damaged.');
  return ident;
}

// ---- messages ----

// The next sequence number: above the last one used, and at least the time in
// ms, so it still goes up after a restore from an older backup.
function nextSeq(ident) {
  ident.seq = Math.max(ident.seq + 1, Date.now());
  return ident.seq;
}

export async function signMessage(ident, body) {
  const env = {v: 1, from: ident.id, alg: ident.alg, pub: ident.pub, seq: nextSeq(ident), body};
  const sig = await subtle().sign(KEY_ALGS[ident.alg].sign, ident.privateKey, new TextEncoder().encode(canonical(env)));
  return {...env, sig: b64url(sig)};
}

// Checks an envelope's signature and that its ID matches its key. Doesn't
// know about other senders or replays; use a Verifier for that.
export async function checkSignature(env) {
  if (!env || env.v !== 1 || !KEY_ALGS[env.alg] || !isPlayerId(env.from) || typeof env.pub !== 'string'
      || !Number.isSafeInteger(env.seq) || typeof env.sig !== 'string') return 'malformed';
  let raw, key, sig;
  try {
    raw = fromB64url(env.pub);
    sig = fromB64url(env.sig);
    key = await subtle().importKey('raw', raw, KEY_ALGS[env.alg].gen, false, ['verify']);
  } catch {
    return 'malformed';
  }
  if (await playerIdFor(raw) !== env.from) return 'id does not match key';
  const {sig: _, ...signed} = env;
  const ok = await subtle().verify(KEY_ALGS[env.alg].sign, key, sig, new TextEncoder().encode(canonical(signed)));
  return ok ? '' : 'bad signature';
}

// A host's record of who it has heard from: each player ID's key and the last
// sequence number accepted. Save it with toJSON() and pass that back in.
export class Verifier {
  constructor(saved = {}) {
    this.senders = new Map(Object.entries(saved));
  }

  // {ok: true, from, body} for a valid new message, otherwise {ok: false, reason}.
  // Senders are remembered on their first valid message; a different key for
  // a known ID is refused ('id in use'), which also covers two players whose
  // IDs collide.
  async verify(env) {
    const reason = await checkSignature(env);
    if (reason) return {ok: false, reason};
    const known = this.senders.get(env.from);
    if (known && (known.pub !== env.pub || known.alg !== env.alg)) return {ok: false, reason: 'id in use'};
    if (known && env.seq <= known.seq) return {ok: false, reason: 'replayed'};
    this.senders.set(env.from, {pub: env.pub, alg: env.alg, seq: env.seq});
    return {ok: true, from: env.from, body: env.body};
  }

  toJSON() {
    return Object.fromEntries(this.senders);
  }
}

// ---- storage (browser only) ----

const DB = 'ducy', STORE = 'identity', KEY = 'me';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, run) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); resolve(req.result); };
    t.onerror = t.onabort = () => { d.close(); reject(t.error); };
  }));
}

const record = i => ({alg: i.alg, privateKey: i.privateKey, publicKey: i.publicKey, seq: i.seq});

// This browser's identity, created on first use. Two tabs opening at once
// agree on one: the second add() fails and both read the stored one.
export async function loadIdentity() {
  let r = await tx('readonly', s => s.get(KEY));
  if (!r) {
    const fresh = await createIdentity();
    try { await tx('readwrite', s => s.add(record(fresh), KEY)); } catch {}
    r = await tx('readonly', s => s.get(KEY));
  }
  return fromKeys(r.alg, r.privateKey, r.publicKey, r.seq || 0);
}

// Stores `ident` as this browser's identity (after an import, or to keep its
// sequence number).
export function saveIdentity(ident) {
  return tx('readwrite', s => s.put(record(ident), KEY));
}

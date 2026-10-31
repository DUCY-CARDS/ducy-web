// A player's identity for clubs (#65): a signing key pair kept in this
// browser, a short player ID derived from its public key, and signed messages
// that a host can check.
//
// The keys are Ed25519 where the browser has it, otherwise ECDSA P-256. They
// live in IndexedDB (loadIdentity) and can be saved to a backup file locked
// with a password (exportLockedIdentity) and restored on another browser
// (importIdentity), which keeps the same player ID. Everything except
// loadIdentity / saveIdentity works without a browser, so the tests run it
// in Node.
//
// A signed message is an envelope {v, from, alg, pub, seq, body, sig}:
//   from  the sender's player ID       pub  their public key (base64url, raw)
//   seq   a number that only goes up   sig  signature (base64url) over the rest
// A host keeps a Verifier, which rejects bad signatures, an ID that doesn't
// match its key, a known ID with a different key, and replays (seq not above
// the last one seen from that sender).
//
// ducy-identity (from ducy-wasm, #460) checks envelopes, makes the canonical
// JSON they're signed over, and the player IDs; the keys stay in WebCrypto,
// which signs. Needs ducy's wasm loaded (the pages, the relay, tests:
// ./wasm.mjs).

import * as ducy from '../wasm/ducy_wasm.js';

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

export function isPlayerId(s) {
  return typeof s === 'string' && s.length === ID_LENGTH && [...s].every(c => B58.includes(c));
}

// How people see a player ID: the same number in capitals and digits with
// no I, L, O, 0 or 1, as 10 characters in two groups ("7KQ2M-XR4TA"), so it
// reads aloud and compares the same whatever case it's written in. The ID
// itself (8 Base58 characters) stays what's stored, signed and sent.
export const showId = id => (isPlayerId(id) ? ducy.showId(id) : String(id ?? ''));

// A player ID from what someone wrote: the shown form in any case, with or
// without the dash or spaces, or the stored 8-character form. null otherwise.
export const parseShownId = text => ducy.parseShownId(String(text ?? '')) ?? null;

// JSON with object keys sorted at every level, so the signer and the verifier
// sign the same bytes whatever order the fields were built in.
export const canonical = v => ducy.canonicalJson(JSON.stringify(v ?? null));

// ---- keys ----

// The player ID for a raw public key: 8 Base58 digits from its SHA-256.
export async function playerIdFor(rawPublicKey) {
  return ducy.playerIdFor(new Uint8Array(rawPublicKey));
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

// Backups are locked with a password: the private key (the part that lets
// someone act as this player) is encrypted with AES-256-GCM under a key
// derived from the password by PBKDF2-SHA-256. The file says which ID it is
// without the password.
// A file opens with whatever password it was saved with (older ones: at
// least MIN_PASSWORD characters); a new backup needs a strong one (#436).
export const MIN_PASSWORD = 8;
export const MIN_NEW_PASSWORD = 12;
const PBKDF2_ITERATIONS = 600_000;

// Passwords too common to lock a backup with, as core() makes them: digits
// and symbols on the end, or in place of letters, don't help them.
const COMMON_PASSWORDS = new Set([
  'password', 'passwort', 'motdepasse', 'contraseña', 'secret', 'letmein', 'welcome', 'iloveyou',
  'admin', 'administrator', 'login', 'qwerty', 'qwertz', 'azerty', 'asdf', 'zxcv', 'abc', 'abcd', 'monkey', 'dragon',
  'football', 'baseball', 'basketball', 'soccer', 'hockey', 'sunshine', 'princess', 'trustno', 'starwars', 'whatever',
  'superman', 'batman', 'master', 'shadow', 'freedom', 'changeme', 'default', 'computer', 'internet', 'hello', 'hellohello',
  'loveyou', 'iloveyouiloveyou', 'mypassword', 'yourpassword', 'thepassword', 'newpassword', 'backup', 'mybackup',
  'correcthorsebatterystaple', 'poker', 'pokerface', 'pokerclub', 'mypokerclub', 'holdem', 'texasholdem', 'allin',
  'acesfull', 'royalflush', 'ducy', 'ducycards', 'ducypoker', 'ducyclub',
]);
// Lower case, letters and digits only.
const plain = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// As plain, without what's after the last letter, and with look-alikes
// (P@ssw0rd) as the letters they stand for.
const LOOKALIKE = {'@': 'a', 4: 'a', 0: 'o', 1: 'i', '!': 'i', 3: 'e', 5: 's', $: 's', 7: 't'};
const core = s => plain(String(s ?? '').toLowerCase().replace(/[^\p{L}]+$/u, '').replace(/[@4013!5$7]/g, c => LOOKALIKE[c]));
// Runs along the digits, the alphabet and the keyboard's rows.
const RUNS = ['01234567890123456789', '98765432109876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiopasdfghjklzxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm'];

// Why `password` won't do for a new backup, in one line, or '' if it will:
// too short, very common, just the club's `name`, or a pattern.
export function passwordProblem(password, {name = ''} = {}) {
  const pw = String(password ?? '');
  if ([...pw].length < MIN_NEW_PASSWORD) return `Use a password of at least ${MIN_NEW_PASSWORD} characters.`;
  const p = plain(pw), k = core(pw);
  const club = plain(name);
  if (club && (p === club || k === core(name) || p.replace(/\d+$/, '') === club || p === club + club)) return 'Don’t use the club’s name as its password.';
  if (COMMON_PASSWORDS.has(p) || COMMON_PASSWORDS.has(k)) return 'That password is too common.';
  if (/^(.{1,4})\1+.{0,3}$/su.test(pw.toLowerCase()) || new Set(pw.toLowerCase()).size <= 2) return 'That password is just repeated characters.';
  if (p.length >= 4 && RUNS.some(r => r.includes(p))) return 'That password is just a run of keys.';
  return '';
}
const enc = new TextEncoder(), dec = new TextDecoder();

async function passwordKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

// The identity as unlocked JSON (version 1), holding the private key: for
// storage only the holder reads, such as an always-on club's own identity
// on the relay. A player's backup file uses exportLockedIdentity.
export async function exportIdentity(ident) {
  const key = await subtle().exportKey('jwk', ident.privateKey);
  return JSON.stringify({type: 'ducy-identity', v: 1, id: ident.id, alg: ident.alg, seq: ident.seq, key});
}

// The identity as a backup file's JSON, locked with `password`. Version 2:
// {type, v: 2, id, alg, seq, lock: {kdf, iterations, salt, iv, ct}}, where
// ct is the private key (JWK) encrypted. The ID, algorithm and seq are
// bound to it as associated data, so they can't be changed either.
// The password must pass passwordProblem (with the club's `name`, if any).
export async function exportLockedIdentity(ident, password, {name = ''} = {}) {
  const problem = typeof password === 'string' ? passwordProblem(password, {name}) : 'Choose a password.';
  if (problem) throw new Error(problem);
  const jwk = await subtle().exportKey('jwk', ident.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const head = {type: 'ducy-identity', v: 2, id: ident.id, alg: ident.alg, seq: ident.seq};
  const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
  const ct = await subtle().encrypt({name: 'AES-GCM', iv, additionalData: enc.encode(canonical(head))}, key, enc.encode(JSON.stringify(jwk)));
  return JSON.stringify({...head, lock: {kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64url(salt), iv: b64url(iv), ct: b64url(ct)}});
}

// Whether a backup file's text needs a password to open (a version 2 file).
export function backupNeedsPassword(text) {
  try { const f = JSON.parse(text); return f?.type === 'ducy-identity' && f.v === 2; } catch { return false; }
}

// Opens a backup: a password-locked one (version 2) with `password`, or an
// older unlocked one (version 1), which needs none.
export async function importIdentity(text, password = '') {
  let f;
  try { f = JSON.parse(text); } catch { throw new Error('That isn’t a ducy identity file.'); }
  if (f?.type === 'ducy-identity' && f.v === 2) f = await unlock(f, password);
  if (!f || f.type !== 'ducy-identity' || f.v !== 1 || !KEY_ALGS[f.alg] || !f.key) throw new Error('That isn’t a ducy identity file.');
  const gen = KEY_ALGS[f.alg].gen;
  const privateKey = await subtle().importKey('jwk', f.key, gen, true, ['sign']);
  const {d, key_ops, ...pubJwk} = f.key;
  const publicKey = await subtle().importKey('jwk', {...pubJwk, key_ops: ['verify']}, gen, true, ['verify']);
  const ident = await fromKeys(f.alg, privateKey, publicKey, Number(f.seq) || 0);
  if (f.id && f.id !== ident.id) throw new Error('The identity file is damaged.');
  return ident;
}

// A locked (version 2) backup's contents as a version 1 one, or throws.
async function unlock(f, password) {
  const l = f.lock;
  if (!l || l.kdf !== 'PBKDF2-SHA256' || !Number.isSafeInteger(l.iterations) || l.iterations < 1 || l.iterations > 10_000_000) throw new Error('That isn’t a ducy identity file.');
  if (!password) throw new Error('This backup is locked with a password. Enter it to restore.');
  const head = {type: 'ducy-identity', v: 2, id: f.id, alg: f.alg, seq: f.seq};
  let jwk;
  try {
    const key = await passwordKey(password, fromB64url(l.salt), l.iterations);
    jwk = JSON.parse(dec.decode(await subtle().decrypt({name: 'AES-GCM', iv: fromB64url(l.iv), additionalData: enc.encode(canonical(head))}, key, fromB64url(l.ct))));
  } catch {
    throw new Error('Wrong password, or the backup is damaged.');
  }
  return {type: 'ducy-identity', v: 1, id: f.id, alg: f.alg, seq: f.seq, key: jwk};
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
// '' when it checks out, else why: 'malformed', 'id does not match key' or
// 'bad signature'. ducy-identity checks it, Ed25519 in every browser.
export async function checkSignature(env) {
  if (!env || typeof env !== 'object') return 'malformed';
  return ducy.checkSignature(JSON.stringify(env));
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
  // ducy-identity decides; the senders are kept here.
  async verify(env) {
    if (!env || typeof env !== 'object') return {ok: false, reason: 'malformed'};
    const known = typeof env.from === 'string' ? this.senders.get(env.from) : null;
    const r = ducy.verifyEnvelope(JSON.stringify(known ?? null), JSON.stringify(env));
    if (r.reason) return {ok: false, reason: r.reason};
    this.senders.set(env.from, r.sender);
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

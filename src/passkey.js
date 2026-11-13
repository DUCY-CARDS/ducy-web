// Passkeys for clubs (#575): this page's side of relay/src/passkeys.js.
//
// Clubs need one. The first time a player joins or opens a club they make
// a passkey (WebAuthn: a resident key, with user verification, for
// ducy.cards and every subdomain), and each visit starts with a passkey
// unlock: a session the page gives each club connection (clubs.js,
// club-owner.js). Moving chips needs an unlock from the last few minutes
// (FRESH_MS), and so does exporting the player's key (a backup).
//
// Recovery: with the PRF extension, the passkey can make a key only it can
// make again. A copy of the player's key, locked with it, is kept on the
// relay, and once it is, this browser keeps the key unexportable. On a new
// device, signing in with the passkey brings that copy back and opens it:
// the same player ID. Without PRF, the relay vouches instead: it links
// this device's own player ID to the old one, and the clubs move the
// member over (vouch).
//
// A session: {token, id, credId, at (the sign-in, this page's clock), used},
// in sessionStorage, so it's this tab's visit.

import { exportIdentity, importIdentity, loadIdentity, saveIdentity, showId, signMessage } from './identity.js';
import { relayUrl } from './play-net.js';
import { isSubsite } from './sites.js';

export const FRESH_MS = 5 * 60_000;
export const IDLE_MS = 4 * 3600e3;
const SESSION_KEY = 'ducyPasskey';
const enc = new TextEncoder(), dec = new TextDecoder();
// What the passkey's PRF is asked for: the same every time, so it gives the
// same key back.
const PRF_SALT = enc.encode('ducy player key copy, v1');

const b64 = bytes => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// This browser can make and use passkeys.
export const supported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create;

// The WebAuthn relying party: ducy.cards for it and its subdomains (so a
// passkey works on staging.ducy.cards too), else this host (localhost).
export function rpId(host = location.hostname) {
  return host === 'ducy.cards' || host.endsWith('.ducy.cards') ? 'ducy.cards' : host;
}

// A name for this device's passkey, for the list of them.
export function deviceName(ua = navigator.userAgent) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

async function call(op, body = {}) {
  const base = relayUrl().replace(/^ws/, 'http');
  let r;
  try {
    r = await fetch(`${base}/passkey/${op}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  } catch {
    throw new Error('Can’t reach ducy’s server. Check your connection.');
  }
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error || 'ducy’s server didn’t answer.');
  return v;
}

// A challenge kept ready, so the passkey prompt follows a click at once
// (Safari wants it to): fetched ahead, and used once.
let ready = null;
export function prepare() {
  if (!ready || Date.now() - ready.at > 4 * 60_000) {
    const p = call('challenge').then(v => v.challenge);
    ready = {at: Date.now(), p};
    p.catch(() => { if (ready?.p === p) ready = null; });
  }
  return ready.p;
}
async function takeChallenge() {
  const c = await prepare();
  ready = null;
  prepare().catch(() => {});
  return c;
}

// ---- the session ----

const load = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null; } catch { return null; } };
const keep = s => { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch {} };

// Player `id`'s live session in this tab, or null.
export function session(id) {
  const s = load();
  return s && s.id === id && Date.now() - s.used < IDLE_MS ? s : null;
}
// One from the last FRESH_MS: chips may move, the key may be exported.
export const fresh = id => {
  const s = session(id);
  return !!s && Date.now() - s.at < FRESH_MS;
};
// The session was used (a club connection acted on it).
export function touch() {
  const s = load();
  if (s) { s.used = Date.now(); keep(s); }
}
export const forget = () => keep(null);

// ---- the relay ----

// Whether player `id` has a passkey: {enrolled, creds, copy, movedTo}
// (`copy`: the relay keeps a locked copy of their key, so signing in on a
// new device brings them back, #654). Remembered for the page, unless
// `again`.
const statuses = new Map();
export function status(id, again = false) {
  if (again || !statuses.has(id)) {
    const p = call('status', {id});
    statuses.set(id, p);
    p.catch(() => statuses.delete(id));
  }
  return statuses.get(id);
}

// ---- PRF: the locked copy of the player's key ----

const prfOf = cred => {
  const r = cred.getClientExtensionResults?.()?.prf?.results?.first;
  return r ? new Uint8Array(r) : null;
};
async function copyKey(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('ducy player key copy')}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function lockCopy(ident, prf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await copyKey(prf), enc.encode(await exportIdentity(ident)));
  return {iv: b64(iv), ct: b64(ct)};
}
// The player's identity from `copy`, opened with the passkey's `prf`.
export async function openCopy(copy, prf) {
  let text;
  try {
    text = dec.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(copy.iv)}, await copyKey(prf), unb64(copy.ct)));
  } catch {
    throw new Error('This passkey couldn’t open your account’s copy.');
  }
  return importIdentity(text);
}

// Once the relay keeps a copy, this browser keeps the key unexportable:
// someone who gets at the device can't copy it out, only use it here, and
// clubs need the passkey anyway. Resolves to the identity to use.
async function lockDown(ident) {
  if (!ident.privateKey.extractable) return ident;
  const jwk = await crypto.subtle.exportKey('jwk', ident.privateKey);
  const gen = ident.alg === 'ed25519' ? {name: 'Ed25519'} : {name: 'ECDSA', namedCurve: 'P-256'};
  const privateKey = await crypto.subtle.importKey('jwk', jwk, gen, false, ['sign']);
  const out = {...ident, privateKey};
  await saveIdentity(out);
  return out;
}

// Keeps the PRF-locked copy of `ident` on the relay for passkey `credId`,
// then locks the key down here.
async function saveCopy(ident, s, prf) {
  if (!ident.privateKey.extractable) return ident;
  const env = await signMessage(ident, {type: 'passkey_copy', challenge: await takeChallenge(), token: s.token, credId: s.credId, copy: await lockCopy(ident, prf)});
  await call('copy', {env});
  statuses.delete(ident.id);
  return lockDown(ident);
}

// ---- enrol, unlock, recover ----

const started = (id, credId, token) => {
  const now = Date.now();
  const s = {token, id, credId, at: now, used: now};
  keep(s);
  return s;
};

// Makes a passkey for `ident` (named `who` in the passkey manager) and
// attaches it on the relay. Another one after the first needs a fresh
// session (unlock first). Resolves to the new session.
export async function enrol(ident, who = '') {
  const challenge = await takeChallenge();
  const label = who ? `${who} (${showId(ident.id)})` : showId(ident.id);
  let cred;
  try {
    cred = await navigator.credentials.create({publicKey: {
      rp: {id: rpId(), name: 'ducy'},
      user: {id: enc.encode(ident.id), name: label, displayName: label},
      challenge: unb64(challenge),
      pubKeyCredParams: [-8, -7, -257].map(alg => ({type: 'public-key', alg})),
      authenticatorSelection: {residentKey: 'required', requireResidentKey: true, userVerification: 'required'},
      attestation: 'none',
      timeout: 120_000,
      extensions: {prf: {eval: {first: PRF_SALT}}},
    }});
  } catch (e) {
    throw new Error(e?.name === 'NotAllowedError' ? 'No passkey was made.' : `No passkey was made: ${e?.message || e}`);
  }
  const r = cred.response;
  const spki = r.getPublicKey?.();
  if (!spki) throw new Error('This browser can’t make a passkey ducy can use. Try another browser.');
  const old = session(ident.id);
  const env = await signMessage(ident, {type: 'passkey_enrol', challenge, credId: cred.id, spki: b64(spki), alg: r.getPublicKeyAlgorithm(), name: deviceName(), token: old?.token || ''});
  const v = await call('enrol', {env});
  statuses.delete(ident.id);
  const s = started(ident.id, cred.id, v.token);
  // Some passkeys give PRF's key as they're made; the rest at the next unlock.
  const prf = prfOf(cred);
  if (prf) await saveCopy(ident, s, prf).catch(e => console.warn('passkey: no copy yet:', e));
  return s;
}

// Signs in with a passkey: one of `creds` (credential ids), or any of this
// site's when none are given (recovery). Resolves to {token, id, credId,
// copy, clubs, movedTo, prf}, with the session kept for `id`.
async function signIn(creds = null) {
  const challenge = await takeChallenge();
  let a;
  try {
    a = await navigator.credentials.get({publicKey: {
      challenge: unb64(challenge),
      rpId: rpId(),
      userVerification: 'required',
      timeout: 120_000,
      ...(creds?.length ? {allowCredentials: creds.map(id => ({type: 'public-key', id: unb64(id)}))} : {}),
      extensions: {prf: {eval: {first: PRF_SALT}}},
    }});
  } catch (e) {
    throw new Error(e?.name === 'NotAllowedError' ? 'Not unlocked.' : `Not unlocked: ${e?.message || e}`);
  }
  const r = a.response;
  const v = await call('unlock', {credId: a.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature)});
  return {...v, credId: a.id, prf: prfOf(a)};
}

// Unlocks player `ident`'s clubs with their passkey. Resolves to the
// session; and, the first time PRF answers, keeps the locked copy.
export async function unlock(ident) {
  const st = await status(ident.id);
  const v = await signIn(st.creds);
  const id = v.movedTo || v.id;
  if (id !== ident.id) throw new Error('That passkey is for another account.');
  const s = started(id, v.credId, v.token);
  if (!v.copy && v.prf) await saveCopy(ident, s, v.prf).catch(e => console.warn('passkey: no copy:', e));
  last = v;
  return s;
}
// The last unlock's answer (its copy and PRF), for an export straight after.
let last = null;

// `ident` as one whose key can be exported (a backup), after a fresh
// unlock when they have a passkey: from the copy on the relay, opened with
// the passkey, if this browser keeps the key unexportable. Throws why not.
export async function exportable(ident) {
  const st = await status(ident.id).catch(() => null);
  if (!st?.enrolled) return ident;
  if (!fresh(ident.id) || (!ident.privateKey.extractable && !last?.prf)) await unlock(ident);
  if (ident.privateKey.extractable) return ident;
  if (!last?.copy || !last?.prf) throw new Error('This passkey can’t open your account’s copy here.');
  return openCopy(last.copy, last.prf);
}

// Recovery on a new device: signs in with any passkey of this site's.
// With a copy it can open, that player ID comes back to this browser (the
// page should reload). Without, the relay vouches: this browser's own ID
// takes over the old one's clubs. Resolves to {id, clubs, vouched}.
//
// On a subdomain site (club.ducy.cards, sites.js isSubsite, #637) the relay
// never vouches: opening another of ducy's sites isn't losing a device, and
// a vouch there would move the player's clubs to that site's fresh ID. Only
// the copy brings the player over; without one it throws NO_COPY.
export const NO_COPY = 'This passkey can’t bring your account here yet. Unlock a club with it once on ducy.cards, then try again.';
export async function recover({vouch = !isSubsite()} = {}) {
  const v = await signIn();
  if (v.copy && v.prf) {
    const ident = await lockDown(await openCopy(v.copy, v.prf).then(async i => { await saveIdentity(i); return i; }));
    started(ident.id, v.credId, v.token);
    return {id: ident.id, clubs: v.clubs || {}, vouched: false};
  }
  if (!vouch) throw new Error(NO_COPY);
  const me = await loadIdentity();
  if (me.id === v.id) { started(me.id, v.credId, v.token); return {id: me.id, clubs: v.clubs || {}, vouched: false}; }
  const env = await signMessage(me, {type: 'passkey_vouch', challenge: await takeChallenge(), token: v.token});
  await call('vouch', {env});
  statuses.clear();
  started(me.id, v.credId, v.token);
  return {id: me.id, clubs: v.clubs || {}, vouched: true, from: v.id};
}

// This player's passkeys, from a live session: [{credId, name, at, copy, current}].
export const list = id => call('list', {token: session(id)?.token || ''}).then(v => v.creds);
// Removes passkey `credId` (a lost device), after a fresh unlock.
export async function remove(ident, credId) {
  if (!fresh(ident.id)) await unlock(ident);
  await call('remove', {token: session(ident.id).token, credId});
  statuses.delete(ident.id);
}

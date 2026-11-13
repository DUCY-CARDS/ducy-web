// Passkeys (#575): clubs need one. A player's passkey (WebAuthn, a resident
// key with user verification) unlocks their clubs, and can bring their
// player ID back on a new device.
//
// The relay keeps, per player ID, each passkey's public key (attached by a
// request signed with the player's own key, so nobody else can attach one
// to their ID), and hands out short-lived challenges. A passkey sign-in (an
// assertion) that checks out starts a session: a random token the page
// gives each club connection, which the room checks here before it lets
// the connection act (unlock.js). Sessions end after IDLE_MS unused; chip
// moves need one whose sign-in is under FRESH_MS old.
//
// Recovery:
//   - With the PRF extension, the page keeps a copy of the player's key
//     here, locked with a key only that passkey can produce. Signing in with
//     the passkey on a new device fetches it and opens it there: the same
//     player ID comes back. The relay can't open it.
//   - Without PRF, "the relay vouches": after a checked passkey sign-in, the
//     relay links the new device's own player ID to the old one, and each
//     club the old ID was in moves the member over (the club's move_member,
//     run by its room). This trusts ducy's operator, who runs the relay.
//
// storage: {get(key), put(key, value), delete(key)}, async (the registry's).
//   pk:<id>          {creds: [{credId, spki, alg, count, name, at, copy?}],
//                     clubs: {code: {hostId, name, owner}}, movedTo?, movedFrom?}
//   pkcred:<credId>  the player ID it belongs to
//   pkChallenges     {challenge: issued at}
//   pkSessions       {token: {id, credId, at (the sign-in), used}}

import { checkSignature } from '../../src/identity.js';

export const CHALLENGE_MS = 5 * 60_000;
// An unlock this recent may move chips, add or remove a passkey, or export
// the player's key (a backup).
export const FRESH_MS = 5 * 60_000;
// A session no club connection has used for this long has ended.
export const IDLE_MS = 4 * 3600e3;
// Passkeys a player may have, and clubs remembered for their recovery.
const MAX_CREDS = 10, MAX_CLUBS = 50;
const ALGS = {
  [-8]: {imp: {name: 'Ed25519'}, sig: {name: 'Ed25519'}},
  [-7]: {imp: {name: 'ECDSA', namedCurve: 'P-256'}, sig: {name: 'ECDSA', hash: 'SHA-256'}, der: true},
  [-257]: {imp: {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, sig: {name: 'RSASSA-PKCS1-v1_5'}},
};

const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(s) {
  if (typeof s !== 'string' || !/^[\w-]*$/.test(s)) throw new Error('bad encoding');
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, c => c.charCodeAt(0));
}
const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async bytes => new Uint8Array(await subtle().digest('SHA-256', bytes));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The WebAuthn relying party for a page's origin: ducy.cards for it and
// every subdomain (staging.ducy.cards too), else the host itself (localhost).
export function rpIdFor(origin) {
  let host;
  try { host = new URL(origin).hostname; } catch { return ''; }
  return host === 'ducy.cards' || host.endsWith('.ducy.cards') ? 'ducy.cards' : host;
}

// Whether passkeys made on `origin` count: one of `origins` (the relay's
// ALLOWED_ORIGINS), or, when it has none (a local relay), a local page.
export function originOk(origin, origins = []) {
  if (origins.length) return origins.includes(origin);
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname); } catch { return false; }
}

// An ECDSA signature in DER, as WebAuthn gives it, as the r||s WebCrypto takes.
function derToRaw(der) {
  let i = 2;
  if (der[0] !== 0x30) throw new Error('bad signature');
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const part = () => {
    if (der[i] !== 0x02) throw new Error('bad signature');
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('bad signature');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part(), s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

// Checks passkey sign-in `a` ({clientDataJSON, authenticatorData,
// signature}, base64url) against `cred` ({spki, alg, count}). `challengeOk`
// takes the challenge and says whether it's one of ours, unused (and uses
// it). Resolves to the authenticator's new count; throws why not.
export async function checkAssertion(cred, a, {challengeOk, origins = []}) {
  const cdBytes = unb64url(a?.clientDataJSON);
  const ad = unb64url(a?.authenticatorData);
  const sig = unb64url(a?.signature);
  let cd;
  try { cd = JSON.parse(dec.decode(cdBytes)); } catch { throw new Error('bad client data'); }
  if (cd?.type !== 'webauthn.get') throw new Error('not a sign-in');
  if (!originOk(cd.origin, origins)) throw new Error('not from ducy');
  if (!(await challengeOk(String(cd.challenge || '')))) throw new Error('stale or unknown challenge');
  if (ad.length < 37) throw new Error('bad authenticator data');
  if (!same(ad.slice(0, 32), await sha256(enc.encode(rpIdFor(cd.origin))))) throw new Error('wrong site');
  const flags = ad[32];
  // User present and verified (a fingerprint, face or PIN).
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('not verified');
  const count = ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36];
  const alg = ALGS[cred.alg];
  if (!alg) throw new Error('unknown key type');
  const key = await subtle().importKey('spki', unb64url(cred.spki), alg.imp, false, ['verify']);
  const signed = new Uint8Array(ad.length + 32);
  signed.set(ad);
  signed.set(await sha256(cdBytes), ad.length);
  const ok = await subtle().verify(alg.sig, key, alg.der ? derToRaw(sig) : sig, signed);
  if (!ok) throw new Error('bad signature');
  // A count that doesn't go up means a copied authenticator; most passkeys
  // keep it at 0.
  if (count && cred.count && count <= cred.count) throw new Error('This passkey looks like a copy, so it was refused.');
  return count;
}

// The page origin passkey sign-in `a` was made on (its client data, which
// the authenticator signs), or ''.
export function assertionOrigin(a) {
  try { return String(JSON.parse(dec.decode(unb64url(a?.clientDataJSON))).origin || ''); } catch { return ''; }
}

// The passkeys of the relay: `origins` as for originOk. `clubOrigins` (the
// relay's CLUB_ORIGINS, #637): the club sites. Each session keeps the
// origin it was made on (a sign-in's signed client data; an enrolment's
// request), so a room can tell a club site's session from the player
// app's; and the relay never vouches for a page on a club site, so opening
// it never moves someone's clubs to its fresh player ID.
export function passkeys(storage, {origins = [], clubOrigins = [], now: clock = () => Date.now()} = {}) {
  const get = async id => (await storage.get(`pk:${id}`)) || {creds: [], clubs: {}};
  const put = (id, rec) => storage.put(`pk:${id}`, rec);

  async function challenge() {
    const all = (await storage.get('pkChallenges')) || {};
    const now = clock();
    for (const [c, at] of Object.entries(all)) if (now - at > CHALLENGE_MS) delete all[c];
    const c = random(32);
    all[c] = now;
    await storage.put('pkChallenges', all);
    return c;
  }
  async function useChallenge(c) {
    const all = (await storage.get('pkChallenges')) || {};
    const at = all[c];
    if (at == null) return false;
    delete all[c];
    await storage.put('pkChallenges', all);
    return clock() - at <= CHALLENGE_MS;
  }

  async function sessions() {
    const all = (await storage.get('pkSessions')) || {};
    const now = clock();
    for (const [t, s] of Object.entries(all)) if (now - s.used > IDLE_MS) delete all[t];
    return all;
  }
  // Session `token`, if it's live: {id, credId, at, used}.
  async function live(token) {
    if (typeof token !== 'string' || !token) return null;
    const s = (await sessions())[token];
    if (!s) return null;
    // A passkey removed since: its sessions end.
    const rec = await get(s.id);
    if (rec.movedTo || !rec.creds.some(c => c.credId === s.credId)) return null;
    return s;
  }
  const fresh = s => !!s && clock() - s.at <= FRESH_MS;
  async function startSession(id, credId, origin = '') {
    const all = await sessions();
    const token = random(32);
    const now = clock();
    all[token] = {id, credId, at: now, used: now, origin: String(origin || '')};
    await storage.put('pkSessions', all);
    return token;
  }

  // A request signed by the player (identity.js signMessage) with one of
  // our challenges in it: its body; throws why not.
  async function signed(env, type) {
    if (await checkSignature(env)) throw new Error('The request isn’t signed properly.');
    if (env.body?.type !== type) throw new Error('Wrong request.');
    if (!(await useChallenge(String(env.body.challenge || '')))) throw new Error('That took too long. Try again.');
    return env.body;
  }

  return {
    challenge: async () => ({challenge: await challenge()}),

    // Whether player `id` has a passkey: {enrolled, creds (their ids, for
    // the browser to ask for), copy (one of them keeps a locked copy of the
    // key: a new device gets the account back, #654), movedTo}.
    async status(id) {
      const rec = await get(String(id));
      return {enrolled: rec.creds.length > 0, creds: rec.creds.map(c => c.credId), copy: rec.creds.some(c => !!c.copy), movedTo: rec.movedTo || null};
    },

    // Attaches a passkey to the signer's player ID: {type: 'passkey_enrol',
    // challenge, credId, spki, alg, name}. Another one after the first
    // needs a session of theirs from the last FRESH_MS (`token`). `origin`:
    // the page's, from its request.
    async enrol(env, origin = '') {
      const b = await signed(env, 'passkey_enrol');
      const id = env.from;
      const rec = await get(id);
      if (rec.movedTo) throw new Error('This player ID moved to another.');
      if (rec.creds.length) {
        const s = await live(b.token);
        if (s?.id !== id || !fresh(s)) throw new Error('Unlock with your passkey first.');
      }
      if (rec.creds.length >= MAX_CREDS) throw new Error('That’s as many passkeys as an account can have. Remove one first.');
      const credId = String(b.credId || '');
      if (!/^[\w-]{16,1400}$/.test(credId)) throw new Error('Not a passkey.');
      if (await storage.get(`pkcred:${credId}`)) throw new Error('That passkey is in use.');
      if (!ALGS[b.alg]) throw new Error('This passkey’s key type isn’t supported.');
      // The key must import, so its sign-ins can be checked.
      await subtle().importKey('spki', unb64url(String(b.spki || '')), ALGS[b.alg].imp, false, ['verify']).catch(() => { throw new Error('Not a passkey.'); });
      rec.creds.push({credId, spki: String(b.spki), alg: b.alg, count: 0, name: String(b.name || 'Passkey').slice(0, 60), at: clock()});
      await put(id, rec);
      await storage.put(`pkcred:${credId}`, id);
      // Made just now, with the player's key: a session, as a sign-in starts.
      return {ok: true, token: await startSession(id, credId, origin)};
    },

    // A passkey sign-in {credId, clientDataJSON, authenticatorData,
    // signature}: a session for its player ID. {token, id, at, copy (the
    // locked key copy for this passkey, or null), clubs}.
    async unlock(a) {
      const credId = String(a?.credId || '');
      const id = await storage.get(`pkcred:${credId}`);
      if (!id) throw new Error('This passkey isn’t known here. It may have been removed.');
      const rec = await get(id);
      const cred = rec.creds.find(c => c.credId === credId);
      if (!cred) throw new Error('This passkey isn’t known here. It may have been removed.');
      cred.count = await checkAssertion(cred, a, {challengeOk: useChallenge, origins});
      await put(id, rec);
      const token = await startSession(id, credId, assertionOrigin(a));
      return {token, id, at: clock(), copy: cred.copy || null, movedTo: rec.movedTo || null, clubs: rec.clubs || {}};
    },

    // Keeps the PRF-locked copy of the signer's key for their passkey
    // `credId`: {type: 'passkey_copy', challenge, token, credId, copy: {iv, ct}}.
    async saveCopy(env) {
      const b = await signed(env, 'passkey_copy');
      const s = await live(b.token);
      if (s?.id !== env.from || s.credId !== b.credId) throw new Error('Unlock with your passkey first.');
      const rec = await get(env.from);
      const cred = rec.creds.find(c => c.credId === b.credId);
      const copy = b.copy;
      if (!cred || typeof copy?.iv !== 'string' || typeof copy?.ct !== 'string' || copy.ct.length > 8192) throw new Error('Bad copy.');
      cred.copy = {iv: copy.iv, ct: copy.ct};
      await put(env.from, rec);
      return {ok: true};
    },

    // The passkeys of session `token`'s player: [{credId, name, at, copy}].
    async list(token) {
      const s = await live(token);
      if (!s) throw new Error('Unlock with your passkey first.');
      const rec = await get(s.id);
      return {creds: rec.creds.map(c => ({credId: c.credId, name: c.name, at: c.at, copy: !!c.copy, current: c.credId === s.credId}))};
    },

    // Removes passkey `credId` (a lost device), with a session from the
    // last FRESH_MS: its sign-ins are refused from now on, and its sessions
    // end. A player's last passkey stays.
    async remove(token, credId) {
      const s = await live(token);
      if (!fresh(s)) throw new Error('Unlock with your passkey first.');
      const rec = await get(s.id);
      if (!rec.creds.some(c => c.credId === credId)) throw new Error('No such passkey.');
      if (rec.creds.length === 1) throw new Error('That’s your only passkey. Add another first.');
      rec.creds = rec.creds.filter(c => c.credId !== credId);
      await put(s.id, rec);
      await storage.delete(`pkcred:${credId}`);
      const all = await sessions();
      for (const [t, x] of Object.entries(all)) if (x.credId === credId) delete all[t];
      await storage.put('pkSessions', all);
      return {ok: true};
    },

    // The relay vouches (no PRF): the signer, a new device's player ID,
    // takes over from the player of session `token` (a passkey sign-in from
    // the last FRESH_MS): {type: 'passkey_vouch', challenge, token}. Their
    // passkeys and clubs move to the new ID; the old one can't unlock again.
    // Never for a page on a club site (#637), nor with a session made on one.
    async vouch(env, origin = '') {
      if (clubOrigins.includes(origin)) throw new Error('Clubs move to a new device only on ducy.cards.');
      const b = await signed(env, 'passkey_vouch');
      const s = await live(b.token);
      if (!fresh(s)) throw new Error('Sign in with your passkey first.');
      if (clubOrigins.includes(s.origin)) throw new Error('Clubs move to a new device only on ducy.cards.');
      const from = s.id, to = env.from;
      if (from === to) throw new Error('That’s this player ID already.');
      const old = await get(from), now = await get(to);
      if (now.creds.length) throw new Error('This device’s player ID has a passkey of its own.');
      now.creds = old.creds;
      now.clubs = {...old.clubs};
      now.movedFrom = from;
      old.movedTo = to;
      old.creds = [];
      await put(to, now);
      await put(from, old);
      for (const c of now.creds) await storage.put(`pkcred:${c.credId}`, to);
      const all = await sessions();
      for (const x of Object.values(all)) if (x.id === from) x.id = to;
      await storage.put('pkSessions', all);
      return {ok: true, from, to};
    },

    // For a room: session `token`, if it's live, as {id, at, movedFrom,
    // origin}. It counts as used now,
    // and club `club` ({code, hostId, name, owner}) is remembered for the
    // player's recovery.
    async session(token, club = null) {
      const s = await live(token);
      if (!s) return null;
      const all = await sessions();
      all[token].used = clock();
      await storage.put('pkSessions', all);
      const rec = await get(s.id);
      if (club?.code) {
        const was = rec.clubs[club.code];
        const now = {hostId: String(club.hostId || ''), name: String(club.name || '').slice(0, 60), owner: !!club.owner};
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          rec.clubs[club.code] = now;
          const codes = Object.keys(rec.clubs);
          if (codes.length > MAX_CLUBS) delete rec.clubs[codes[0]];
          await put(s.id, rec);
        }
      }
      return {id: s.id, at: s.at, movedFrom: rec.movedFrom || null, origin: s.origin || ''};
    },

    // Answers POST /passkey/<op> with `body`, from a page on `origin`:
    // {status, body}.
    async http(op, body, origin = '') {
      try {
        let v;
        if (op === 'challenge') v = await this.challenge();
        else if (op === 'status') v = await this.status(String(body?.id || ''));
        else if (op === 'enrol') v = await this.enrol(body?.env, origin);
        else if (op === 'unlock') v = await this.unlock(body);
        else if (op === 'copy') v = await this.saveCopy(body?.env);
        else if (op === 'list') v = await this.list(body?.token);
        else if (op === 'remove') v = await this.remove(body?.token, String(body?.credId || ''));
        else if (op === 'vouch') v = await this.vouch(body?.env, origin);
        else return {status: 404, body: {error: 'not found'}};
        return {status: 200, body: v};
      } catch (e) {
        return {status: 400, body: {error: e.message || String(e)}};
      }
    },
  };
}

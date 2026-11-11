// Connecting to the dev relay as a player, for the relay tests: a club
// connection proves it holds the player's key (#577), and is unlocked with
// a passkey (#575). The passkey here is a software one: a P-256 key that
// makes WebAuthn sign-ins as a browser would hand them over.
import WebSocket from '../relay/node_modules/ws/index.js';
import { signMessage } from '../src/identity.js';

export const ORIGIN = 'http://localhost:4173';
const enc = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

// A raw r||s ECDSA signature as the DER WebAuthn sends.
function rawToDer(raw) {
  const int = b => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

// A passkey: {credId, spki, alg, sign(challenge, opts)} where sign makes
// a sign-in's {credId, clientDataJSON, authenticatorData, signature}.
// opts: origin, rpId, flags (0x05: present and verified), count, type.
export async function softPasskey() {
  const keys = await crypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign', 'verify']);
  const spki = b64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)));
  const credId = b64(crypto.getRandomValues(new Uint8Array(32)));
  let n = 0;
  return {
    credId, spki, alg: -7,
    async sign(challenge, {origin = ORIGIN, rpId = new URL(origin).hostname, flags = 0x05, count = ++n, type = 'webauthn.get'} = {}) {
      const cd = enc.encode(JSON.stringify({type, challenge, origin}));
      const ad = new Uint8Array(37);
      ad.set(await sha256(enc.encode(rpId)));
      ad[32] = flags;
      new DataView(ad.buffer).setUint32(33, count);
      const signed = new Uint8Array([...ad, ...(await sha256(cd))]);
      const raw = new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, keys.privateKey, signed));
      return {credId, clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(rawToDer(raw))};
    },
  };
}

// The dev relay on `port`: its passkey API, and player connections.
// `origin` (#637): the page it acts as, for its requests, connections and
// sign-ins; by default none, and sign-ins as a local page.
export function relayClient(port, {origin = ''} = {}) {
  const signAs = origin ? {origin, rpId: 'ducy.cards'} : {};
  const post = async (op, body) => {
    const r = await fetch(`http://localhost:${port}/passkey/${op}`, {method: 'POST', headers: {'content-type': 'application/json', ...(origin ? {origin} : {})}, body: JSON.stringify(body || {})});
    return {status: r.status, body: await r.json()};
  };
  const challenge = async () => (await post('challenge')).body.challenge;
  const passkeysOf = new Map(); // player id → their software passkey

  // Player `ident`'s passkey, made and attached the first time.
  async function passkeyOf(ident) {
    if (passkeysOf.has(ident.id)) return passkeysOf.get(ident.id);
    const p = await softPasskey();
    const env = await signMessage(ident, {type: 'passkey_enrol', challenge: await challenge(), credId: p.credId, spki: p.spki, alg: p.alg, name: 'Test'});
    const r = await post('enrol', {env});
    if (r.status !== 200) throw new Error(r.body.error);
    passkeysOf.set(ident.id, p);
    return p;
  }
  // A session for `ident`: a sign-in with their passkey (or `p`, another
  // of theirs).
  async function session(ident, p = null) {
    p ||= await passkeyOf(ident);
    const r = await post('unlock', await p.sign(await challenge(), signAs));
    if (r.status !== 200) throw new Error(r.body.error);
    return r.body.token;
  }
  // Another passkey for `ident` (another device of theirs), attached with
  // a fresh session of their first.
  async function addPasskey(ident) {
    const token = await session(ident);
    const p = await softPasskey();
    const env = await signMessage(ident, {type: 'passkey_enrol', challenge: await challenge(), token, credId: p.credId, spki: p.spki, alg: p.alg, name: 'Second'});
    const r = await post('enrol', {env});
    if (r.status !== 200) throw new Error(r.body.error);
    return p;
  }

  // Opens `path`. With `ident`, answers the relay's request to prove the
  // player's ID, and (`unlock`, the default) unlocks the connection with a
  // passkey session (of `passkey`, when given); `ready` resolves once
  // that's done (or once open).
  function open(path, ident = null, {unlock = true, passkey = null} = {}) {
    const ws = new WebSocket(`ws://localhost:${port}${path}`, origin ? {origin} : {});
    const inbox = [], waiting = [];
    let readyFn, failFn;
    const ready = new Promise((res, rej) => { readyFn = res; failFn = rej; });
    ready.catch(() => {}); // a test that only waits for it to close
    ws.on('error', e => failFn(e));
    ws.on('open', () => { if (!ident) readyFn(); });
    ws.on('message', async d => {
      const m = JSON.parse(d);
      if (ident && m.type === 'prove') { ws.send(JSON.stringify({type: 'prove', env: await signMessage(ident, {type: 'prove', room: decodeURIComponent(path.split('/')[2].split('?')[0]), challenge: m.challenge})})); return; }
      if (ident && m.type === 'proven') {
        if (!unlock) readyFn();
        else ws.send(JSON.stringify({type: 'unlock', token: await session(ident, passkey)}));
        return;
      }
      if (ident && unlock && m.type === 'unlocked') { readyFn(); return; }
      waiting.length ? waiting.shift()(m) : inbox.push(m);
    });
    const closedWith = new Promise(resolve => ws.on('close', (code, reason) => { failFn(new Error(`closed ${code}`)); resolve({code, reason: String(reason)}); }));
    const closed = closedWith.then(c => c.code);
    async function next(type) {
      for (;;) {
        const m = inbox.length ? inbox.shift() : await new Promise(r => waiting.push(r));
        if (!type || m.type === type || m.body?.type === type) return m;
      }
    }
    return {ws, closed, closedWith, next, ready, send: obj => ws.send(JSON.stringify(obj))};
  }

  // The same relay as a page on another origin, sharing these passkeys
  // (one passkey for every ducy.cards site, #637).
  const as = o => { const c = relayClient(port, {origin: o}); c.share(passkeysOf); return c; };
  const share = m => { for (const [k, v] of m) passkeysOf.set(k, v); };
  return {post, challenge, passkeyOf, session, addPasskey, open, as, share};
}

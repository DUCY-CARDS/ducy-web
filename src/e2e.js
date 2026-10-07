// End-to-end encryption of table updates between a host and each player, so
// the relay (which forwards every message) never sees anyone's hole cards.
//
// Each side makes a fresh ECDH P-256 key pair per session and sends the
// public half signed with its player identity (identity.js), so the relay
// can't swap in its own key. Both sides then derive the same AES-256-GCM key
// (ECDH shared secret through HKDF-SHA-256, bound to the club or table, both
// player IDs and both public keys) and every update is sealed with a fresh
// random 96-bit IV. GCM also authenticates, so the relay can't alter or
// forge sealed updates either.

import { b64url, fromB64url } from './identity.js';

const subtle = () => globalThis.crypto.subtle;
const ECDH = {name: 'ECDH', namedCurve: 'P-256'};
const enc = new TextEncoder(), dec = new TextDecoder();

// A session key pair, and its public half to send (base64url, raw).
export async function newKeyPair() {
  const kp = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const pub = b64url(await subtle().exportKey('raw', kp.publicKey));
  return {privateKey: kp.privateKey, pub};
}

// The shared AES-GCM key between this side's key pair and the other side's
// public key. `context` names the channel (e.g. 'club:ABCD-EFGH'), and
// `hostId`/`playerId` and both public keys are mixed in, so a key is good
// for one pairing only. Both sides must pass the same values.
export async function sharedKey(myKeys, theirPub, {context, hostId, playerId, hostPub, playerPub}) {
  const their = await subtle().importKey('raw', fromB64url(theirPub), ECDH, false, []);
  const secret = await subtle().deriveBits({name: 'ECDH', public: their}, myKeys.privateKey, 256);
  const hkdf = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const info = enc.encode(['ducy-e2e-v1', context, hostId, playerId, hostPub, playerPub].join('|'));
  return subtle().deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info},
    hkdf, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'],
  );
}

// Encrypts a JSON value: {iv, ct}, both base64url.
export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({name: 'AES-GCM', iv}, key, enc.encode(JSON.stringify(value)));
  return {iv: b64url(iv), ct: b64url(ct)};
}

// Decrypts what seal() made; throws if it was altered or sealed with another key.
export async function open(key, box) {
  const pt = await subtle().decrypt({name: 'AES-GCM', iv: fromB64url(box.iv)}, key, fromB64url(box.ct));
  return JSON.parse(dec.decode(pt));
}

// Is `s` a P-256 public key we can use (base64url, 65 bytes uncompressed)?
export function isPublicKey(s) {
  try { return typeof s === 'string' && fromB64url(s).length === 65; } catch { return false; }
}

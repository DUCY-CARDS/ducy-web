// Ed25519 signature checks in plain JavaScript (RFC 8032), for browsers whose
// WebCrypto has no Ed25519 (Safari before 17, #442). Such a browser makes
// P-256 keys of its own, but still has to check other players' Ed25519
// signatures. identity.js loads this only when WebCrypto refuses the key.
// Checking only: no secrets here, so it needn't be constant-time.

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function pow(b, e) {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) r = r * b % P;
  return r;
}
const inv = a => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

// Points in extended coordinates [X, Y, Z, T], x = X/Z, y = Y/Z, xy = T/Z.
const ZERO = [0n, 1n, 1n, 0n];
function add([x1, y1, z1, t1], [x2, y2, z2, t2]) {
  const a = mod((y1 - x1) * (y2 - x2)), b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2), d = mod(2n * z1 * z2);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function times(pt, n) {
  let r = ZERO;
  for (; n > 0n; n >>= 1n, pt = add(pt, pt)) if (n & 1n) r = add(r, pt);
  return r;
}
const BY = mod(4n * inv(5n));
const BASE = [15112221349535400772501151409588531511454012693041857206046113283949847762202n, BY, 1n,
  mod(15112221349535400772501151409588531511454012693041857206046113283949847762202n * BY)];

const littleEndian = bytes => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

// A point from its 32-byte encoding, or null if it isn't one.
function decode(bytes) {
  const sign = bytes[31] >> 7;
  const y = littleEndian(bytes) & (2n ** 255n - 1n);
  if (y >= P) return null;
  const y2 = y * y % P;
  const x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
  let x = pow(x2, (P + 3n) / 8n);
  if (x * x % P !== x2) x = x * SQRT_M1 % P;
  if (x * x % P !== x2) return null;
  if (x === 0n && sign) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, x * y % P];
}

const same = ([x1, y1, z1], [x2, y2, z2]) => mod(x1 * z2 - x2 * z1) === 0n && mod(y1 * z2 - y2 * z1) === 0n;

// Is `sig` (64 bytes) a valid signature of `message` by `publicKey` (32 bytes)?
export async function ed25519Verify(publicKey, sig, message) {
  publicKey = new Uint8Array(publicKey); sig = new Uint8Array(sig); message = new Uint8Array(message);
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  const a = decode(publicKey), r = decode(sig.subarray(0, 32));
  const s = littleEndian(sig.subarray(32));
  if (!a || !r || s >= L) return false;
  const data = new Uint8Array(64 + message.length);
  data.set(sig.subarray(0, 32)); data.set(publicKey, 32); data.set(message, 64);
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', data));
  const k = mod(littleEndian(h), L);
  // [s]B = R + [k]A
  return same(times(BASE, s), add(r, times(a, k)));
}

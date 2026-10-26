// Safari 15.4 as the oldest browser the site runs on (#442): the update
// screen for older ones (src/browser-check.js), checking other players'
// Ed25519 signatures where WebCrypto can't (src/ed25519.js), and guards
// against code or WebAssembly features newer than Safari 15.4.
// Run with: node --test test/browser-support.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { ed25519Verify } from '../src/ed25519.js';
import { checkSignature, createIdentity, signMessage } from '../src/identity.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const CHECK = read('src/browser-check.js');

// ---- the update screen ----

// A page's document, just enough for browser-check.js.
function fakeDocument(readyState = 'interactive') {
  const el = tag => ({
    tag, className: '', textContent: '', children: [],
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; },
  });
  const body = el('body');
  body.className = 'booting';
  body.appendChild(el('main'));
  body.appendChild(el('script'));
  const listeners = {};
  return {
    readyState, body, documentElement: {className: 'four-color'}, listeners,
    createElement: el,
    addEventListener(type, f) { listeners[type] = f; },
  };
}

// Runs browser-check.js in a fresh global with `stub` (code run first, to
// take features away) and returns the document afterwards.
function run(stub = '', readyState) {
  const document = fakeDocument(readyState);
  function HTMLScriptElement() {}
  HTMLScriptElement.prototype.noModule = false;
  const g = vm.createContext({document, HTMLScriptElement, structuredClone});
  vm.runInContext(stub, g);
  vm.runInContext(CHECK, g);
  return document;
}
const shown = d => d.body.children.length === 1 && d.body.children[0].className === 'browser-update';

test('a browser with everything the site needs: the page is left alone', () => {
  const d = run();
  assert.equal(d.body.children.length, 2);
  assert.equal(d.body.className, 'booting');
  assert.equal(d.documentElement.className, 'four-color');
  assert.deepEqual(Object.keys(d.listeners), [], 'no listener, nothing left running');
});

for (const [missing, stub] of [
  ['WebAssembly', 'delete globalThis.WebAssembly'],
  ['WebAssembly.instantiate', 'WebAssembly.instantiate = undefined'],
  ['Array.prototype.at', 'delete Array.prototype.at'],
  ['Array.prototype.findLast', 'delete Array.prototype.findLast'],
  ['structuredClone', 'delete globalThis.structuredClone'],
  ['module scripts', 'delete HTMLScriptElement.prototype.noModule'],
  ['HTMLScriptElement', 'delete globalThis.HTMLScriptElement'],
]) {
  test(`no ${missing}: the update screen replaces the page`, () => {
    const d = run(stub);
    assert.ok(shown(d), 'only the update screen is in the body');
    assert.equal(d.body.className, '', 'not booting (which hides the body)');
    assert.match(d.documentElement.className, /\bbrowser-old\b/);
    const [h, p] = d.body.children[0].children;
    assert.equal(h.tag, 'h1');
    assert.equal(h.textContent, 'Update your browser to use ducy');
    assert.equal(p.textContent, 'On iPhone or iPad: Settings → General → Software Update.');
  });
}

test('run before the page has loaded, it waits for it', () => {
  const d = run('delete Array.prototype.findLast', 'loading');
  assert.match(d.documentElement.className, /browser-old/, 'hides the page at once');
  assert.ok(!shown(d));
  d.listeners.DOMContentLoaded();
  assert.ok(shown(d));
});

test('browser-check.js is old JavaScript (ES5), so old browsers run it', () => {
  const code = CHECK.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const [what, re] of [['=>', /=>/], ['let/const', /\b(let|const)\b/], ['class', /\bclass\s+\w/], ['template literal', /`/],
    ['spread', /\.\.\./], ['?. or ??', /\?\.|\?\?/], ['async/await', /\b(async|await)\b/], ['for…of', /\bfor\s*\([^)]*\bof\b/]]) {
    assert.doesNotMatch(code, re, what);
  }
  assert.doesNotMatch(CHECK, /style\s*=|\.style\b/, 'no inline styles: style.css styles it');
});

test('style.css and admin.css style the update screen', () => {
  for (const f of ['src/style.css', 'src/admin.css']) {
    assert.match(read(f), /html\.browser-old body > :not\(\.browser-update\) \{ display: none !important; \}/, f);
    assert.match(read(f), /\.browser-update \{/, f);
  }
});

// ---- Ed25519 in JavaScript ----

const hex = s => Uint8Array.from(s.match(/../g) || [], b => parseInt(b, 16));

test('ed25519Verify: RFC 8032 test vectors', async () => {
  // Tests 1-3 of RFC 8032 section 7.1.
  const vectors = [
    ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82',
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
  ];
  for (const [pub, msg, sig] of vectors) {
    assert.equal(await ed25519Verify(hex(pub), hex(sig), hex(msg)), true);
    const bad = hex(sig); bad[5] ^= 1;
    assert.equal(await ed25519Verify(hex(pub), bad, hex(msg)), false, 'a changed signature');
    assert.equal(await ed25519Verify(hex(pub), hex(sig), new Uint8Array([...hex(msg), 0])), false, 'a changed message');
  }
});

test('ed25519Verify agrees with WebCrypto', async () => {
  const subtle = webcrypto.subtle;
  for (let i = 0; i < 12; i++) {
    const keys = await subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
    const pub = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
    const msg = webcrypto.getRandomValues(new Uint8Array(i * 37));
    const sig = new Uint8Array(await subtle.sign({name: 'Ed25519'}, keys.privateKey, msg));
    assert.equal(await ed25519Verify(pub, sig, msg), true);
    const other = new Uint8Array(sig); other[40] ^= 0x80;
    assert.equal(await ed25519Verify(pub, other, msg), false);
    const notKey = new Uint8Array(pub); notKey[3] ^= 4;
    assert.equal(await ed25519Verify(notKey, sig, msg), false);
  }
  assert.equal(await ed25519Verify(new Uint8Array(31), new Uint8Array(64), new Uint8Array(0)), false, 'wrong length');
  const tooBigS = new Uint8Array(64).fill(0xff);
  assert.equal(await ed25519Verify(hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), tooBigS, new Uint8Array(0)), false, 'S out of range');
});

test('checkSignature checks Ed25519 in JS where WebCrypto has none (Safari before 17)', async () => {
  const ident = await createIdentity();
  assert.equal(ident.alg, 'ed25519', 'Node makes Ed25519 keys');
  const env = await signMessage(ident, {hello: 'there'});
  const subtle = globalThis.crypto.subtle;
  const importKey = subtle.importKey;
  subtle.importKey = function (format, data, alg, ...rest) {
    if ((alg?.name || alg) === 'Ed25519') return Promise.reject(new DOMException('Unsupported', 'NotSupportedError'));
    return importKey.call(this, format, data, alg, ...rest);
  };
  try {
    assert.equal(await checkSignature(env), '');
    assert.equal(await checkSignature({...env, body: {hello: 'you'}}), 'bad signature');
    assert.equal(await checkSignature({...env, pub: env.pub.slice(0, 20)}), 'malformed');
  } finally {
    subtle.importKey = importKey;
  }
});

// ---- nothing newer than Safari 15.4 ----

const SHIPPED_JS = readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `src/${f}`)
  .concat(['relay/src/club-room.js', 'relay/src/registry.js']);

test('the shipped code uses nothing newer than Safari 15.4', () => {
  const NEWER = [
    ['toSorted/toReversed/toSpliced (Safari 16)', /\.(toSorted|toReversed|toSpliced)\(/],
    ['Object/Map.groupBy (17.4)', /\b(Object|Map)\.groupBy\b/],
    ['Promise.withResolvers (17.4)', /\bwithResolvers\b/],
    ['Array.fromAsync (16.4)', /\bArray\.fromAsync\b/],
    ['class static blocks (16.4)', /\bstatic\s*\{/],
    ['regex lookbehind (16.4)', /\(\?<[=!]/],
    ['Set methods (17)', /\.(union|intersection|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/],
    ['isWellFormed/toWellFormed (16.4)', /\b(is|to)WellFormed\b/],
    ['AbortSignal.timeout/any (16, 17.4)', /\bAbortSignal\.(timeout|any)\b/],
    ['requestIdleCallback (no Safari)', /\brequestIdleCallback\b/],
    ['OffscreenCanvas (16.4)', /\bOffscreenCanvas\b/],
    ['import attributes (17.2)', /^\s*import\b[^;]*\bwith\s*\{/m],
    ['import.meta.resolve (16.4)', /\bimport\.meta\.resolve\b/],
    ['Iterator helpers (18.4)', /\bIterator\.from\b|\.(keys|values|entries)\(\)\s*\.(map|filter|take|drop|toArray)\(/],
  ];
  for (const f of SHIPPED_JS) {
    const code = read(f);
    for (const [what, re] of NEWER) assert.doesNotMatch(code, re, `${f}: ${what}`);
  }
});

// The wasm's target_features custom section: [[prefix, name]].
function wasmFeatures(bytes) {
  let i = 8;
  const leb = () => { let n = 0, s = 0, b; do { b = bytes[i++]; n |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return n >>> 0; };
  const str = () => { const n = leb(); const t = new TextDecoder().decode(bytes.subarray(i, i + n)); i += n; return t; };
  while (i < bytes.length) {
    const id = bytes[i++], size = leb(), end = i + size;
    if (id === 0 && str() === 'target_features') {
      const out = [];
      for (let n = leb(); n > 0; n--) out.push([String.fromCharCode(bytes[i++]), str()]);
      return out;
    }
    i = end;
  }
  return null;
}

test('the engine uses only WebAssembly features Safari 15 has (no SIMD)', () => {
  const features = wasmFeatures(new Uint8Array(readFileSync(new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url))));
  assert.ok(features, 'the wasm lists its target features');
  // Safari 15: all of these. SIMD (simd128, relaxed-simd) came in 16.4; tail
  // calls, exception handling, GC and memory64 later still.
  const SAFARI_15 = ['mutable-globals', 'sign-ext', 'nontrapping-fptoint', 'bulk-memory', 'bulk-memory-opt', 'reference-types', 'multivalue', 'call-indirect-overlong'];
  for (const [prefix, name] of features) {
    if (prefix === '-') continue;
    assert.ok(SAFARI_15.includes(name), `the wasm uses ${name}, which Safari 15 doesn't have`);
  }
});

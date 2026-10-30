// The page imports its modules before the engine (wasm) has loaded: main.js
// awaits ducy's init only after its imports. So no module may call a binding
// while it loads; one that did left the site stuck on "Loading…" (the one-off
// tournament form's starter payout table). Imports each module without the
// wasm, with stand-ins for the browser's globals so each runs as far as it
// can: none may fail inside ducy_wasm.js. Run with: node --test test/boot-order.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Anything: every property, call and construction gives it back.
const any = new Proxy(function () {}, {
  get: (_, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : any),
  apply: () => any,
  construct: () => any,
});
const SITE = 'https://ducy.cards/';
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
// The modules' timers don't keep the test running.
const realTimeout = globalThis.setTimeout;
for (const t of ['setTimeout', 'setInterval']) {
  const real = globalThis[t];
  globalThis[t] = (...a) => real(...a).unref();
}
globalThis.location = new URL(SITE);
globalThis.document = new Proxy({baseURI: SITE}, {get: (t, k) => (k in t ? t[k] : any)});
globalThis.IDBFactory = class { open() {} deleteDatabase() {} };
for (const g of ['history', 'matchMedia', 'requestAnimationFrame', 'HTMLElement', 'customElements', 'sessionStorage', 'indexedDB']) {
  if (!(g in globalThis)) globalThis[g] = any;
}

const SRC = new URL('../src/', import.meta.url);
// Workers load the wasm themselves, by fetch, as they start; browser-check.js
// is a classic script, not a module.
const SKIP = new Set(['demo-bot-worker.js', 'mc-worker.js', 'play-worker.js', 'browser-check.js']);

test('no module calls the engine while it loads', async () => {
  const early = [];
  for (const f of readdirSync(SRC).filter(f => f.endsWith('.js') && !SKIP.has(f)).sort()) {
    try {
      // A module still awaiting a stand-in (storage that never answers) has
      // already run what it runs as it loads.
      await Promise.race([import(new URL(f, SRC).href), new Promise(r => realTimeout(r, 1000))]);
    } catch (e) {
      if (String(e.stack).includes('ducy_wasm.js')) early.push(`${f}: ${e.message}`);
    }
  }
  assert.deepEqual(early, []);
});

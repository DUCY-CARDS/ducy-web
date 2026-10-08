// Omaha hands as the trainer sees them, from ducy's omahaHand. Needs the
// wasm build in wasm/.
// Run with: node --test test/omaha-hand.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { omahaPercentile, omahaTags, omahaLabels, omahaModelVersion } from '../src/omaha-hand.js';

// The trainer's fingerprint (trainer.js).
function fingerprint(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

test('percentiles: strong hands near the top, junk near the bottom', () => {
  const aces = omahaPercentile(['As', 'Ad', 'Kh', 'Kc']);
  const junk = omahaPercentile(['9s', '6h', '3d', '2c']);
  assert.ok(aces >= 0 && aces < 2, `AAKK double-suited: ${aces}`);
  assert.ok(junk > 90 && junk <= 100, `9632 rainbow: ${junk}`);
  for (const h of [['As', 'Ad', 'Kh', 'Qh', 'Jc'], ['Js', 'Ts', '9d', '8d', '7c', '6c']]) {
    const p = omahaPercentile(h);
    assert.ok(p >= 0 && p <= 100, `${h}: ${p}`);
  }
});

test('every tag has a label', () => {
  const labels = omahaLabels();
  assert.ok(Object.keys(labels).length > 5);
  for (const h of [['As', 'Ad', 'Kh', 'Kc'], ['9s', '6h', '3d', '2c'], ['Js', 'Ts', '9d', '8d', '7c']]) {
    for (const t of omahaTags(h)) assert.equal(typeof labels[t], 'string', t);
  }
});

test('the model version is the shipped model\'s, so saved trainer scores are kept', () => {
  assert.equal(omahaModelVersion(4, fingerprint), '4qcpi0');
  assert.equal(omahaModelVersion(5, fingerprint), 'wbxw05');
  assert.equal(omahaModelVersion(6, fingerprint), '1cktmih');
});

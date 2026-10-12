// Relative times in lists (#193).
// Run with: node --test test/time-ago.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ago } from '../src/time-ago.js';

test('relative while recent, a date after a week', () => {
  const now = Date.UTC(2026, 9, 11, 12);
  assert.equal(ago(now - 20e3, now), 'just now');
  assert.equal(ago(now - 5 * 60e3, now), '5 min ago');
  assert.equal(ago(now - 3 * 3600e3, now), '3 h ago');
  assert.equal(ago(now - 30 * 3600e3, now), 'yesterday');
  assert.equal(ago(now - 4 * 86400e3, now), '4 days ago');
  assert.match(ago(now - 10 * 86400e3, now), /1|Oct/);
});

// The privacy policy page (#554): reachable from the pages players use, shipped
// by the site's build, and working without a script.
// Run with: node --test test/privacy-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the player app and the club manager link to the policy', () => {
  for (const page of ['index.html', 'manage.html']) {
    assert.match(read(page), /<footer class="site-foot"><a href="privacy\.html">Privacy<\/a><\/footer>/, page);
  }
});

test('the build ships the policy, pointed at the release', () => {
  const b = read('scripts/build-site.sh');
  assert.match(b, /privacy\.html > "\$OUT\/privacy\.html"/);
  assert.match(b, /for page in [^;]*privacy\.html; do/, 'with the checks every page gets');
});

test('the policy has no script and no unfilled placeholder', () => {
  const html = read('privacy.html');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /\[[A-Z ]+\]/);
});

test('the policy states the decisions behind it', () => {
  const html = read('privacy.html');
  assert.match(html, /We don’t remove the data we hold about players on request, except where the law requires it/);
  assert.match(html, /play money with no cash value/);
  assert.match(html, /Error reports/);
});

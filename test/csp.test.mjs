// The Content Security Policy (#436): .htaccess sends it, and each page
// carries the same one in a <meta> tag (all but frame-ancestors, which meta
// can't set, plus a local relay for testing that build-site.sh takes out).
// Run with: node --test test/csp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const PAGES = ['index.html', 'manage.html', 'admin.html'];
const LOCAL = ['ws://localhost:*', 'http://localhost:*'];

// A policy as {directive: [sources]}.
const parse = p => Object.fromEntries(p.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k, v]));

const header = () => {
  const m = read('.htaccess').match(/^\s*Header set Content-Security-Policy "([^"]+)"/m);
  assert.ok(m, '.htaccess sets a Content-Security-Policy');
  return parse(m[1]);
};
const meta = page => {
  const m = read(page).match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, `${page} has a Content-Security-Policy meta tag`);
  return parse(m[1]);
};

test('the header is strict: scripts only from the site, nothing framed, no plugins', () => {
  const p = header();
  assert.deepEqual(p['default-src'], ["'self'"]);
  assert.deepEqual(p['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(p['object-src'], ["'none'"]);
  assert.deepEqual(p['base-uri'], ["'self'"]);
  assert.deepEqual(p['form-action'], ["'self'"]);
  assert.deepEqual(p['frame-ancestors'], ["'none'"]);
  assert.deepEqual(p['style-src-elem'], ["'self'", 'https://fonts.googleapis.com'], 'no inline <style>');
  assert.ok(!p['connect-src'].some(s => s.includes('localhost')), 'the site never talks to a local relay');
  for (const sources of Object.values(p)) assert.ok(!sources.includes("'unsafe-eval'") && !sources.includes('*'));
});

test('each page carries the header’s policy, less frame-ancestors, plus a local relay', () => {
  const h = header();
  delete h['frame-ancestors'];
  h['connect-src'] = [...h['connect-src'], ...LOCAL];
  for (const page of PAGES) assert.deepEqual(meta(page), h, page);
});

test('the pages have no inline script, <style> or on…= handler', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, `${page}: inline <script>`);
    assert.doesNotMatch(html, /<style/, `${page}: <style>`);
    assert.doesNotMatch(html, /\son[a-z]+=/, `${page}: on…= handler`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: javascript: URL`);
  }
});

test('.htaccess sends the other security headers', () => {
  const h = read('.htaccess');
  assert.match(h, /Header set X-Content-Type-Options "nosniff"/);
  assert.match(h, /Header set Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(h, /Header set Strict-Transport-Security "max-age=31536000"/);
  assert.match(h, /Header set Permissions-Policy "[^"]*camera=\(\)[^"]*microphone=\(\)[^"]*"/);
});

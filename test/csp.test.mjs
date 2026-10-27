// The Content Security Policy (#436, #442). .htaccess sends it to every
// browser, except that Safari 15 (and every browser on iOS 15) gets
// 'unsafe-eval' in place of 'wasm-unsafe-eval', which it doesn't know. The
// source pages carry the strict one in a <meta> tag for local testing (all
// but frame-ancestors, which meta can't set, plus a local relay);
// build-site.sh takes the tag out of the site's pages, so the header is the
// only policy there.
// Run with: node --test test/csp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const PAGES = ['index.html', 'manage.html', 'admin.html'];
const LOCAL = ['ws://localhost:*', 'http://localhost:*'];
const ENV = 'ducy_safari15';

// A policy as {directive: [sources]}.
const parse = p => Object.fromEntries(p.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k, v]));

// .htaccess's two policies: {strict, safari15}, each by its env= condition.
const headers = () => {
  const lines = [...read('.htaccess').matchAll(/^\s*Header set Content-Security-Policy "([^"]+)"(.*)$/gm)];
  assert.equal(lines.length, 2, '.htaccess sets two Content-Security-Policy headers');
  const by = Object.fromEntries(lines.map(m => [m[2].trim(), parse(m[1])]));
  assert.ok(by[`env=!${ENV}`], `the strict policy is sent when ${ENV} isn't set`);
  assert.ok(by[`env=${ENV}`], `the Safari 15 policy is sent when ${ENV} is set`);
  assert.ok(lines[1][2].includes('!'), 'the strict policy comes last, so it wins if env= were ignored');
  return {strict: by[`env=!${ENV}`], safari15: by[`env=${ENV}`]};
};
const header = () => headers().strict;
const meta = page => {
  const m = read(page).match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, `${page} has a Content-Security-Policy meta tag`);
  return parse(m[1]);
};

// .htaccess's rewrite rules that set ENV, each with its user-agent conditions
// (all must hold): [{re, not}].
const rules = () => [...read('.htaccess').matchAll(/((?:^RewriteCond %\{HTTP_USER_AGENT\} \S+\n)+)^RewriteRule \^ - \[E=(\w+):1\]$/gm)]
  .filter(([, , name]) => name === ENV)
  .map(([, conds]) => conds.trim().split('\n').map(c => {
    const [, not, re] = c.match(/^RewriteCond %\{HTTP_USER_AGENT\} (!?)(\S+)$/);
    return {re: new RegExp(re), not: !!not};
  }));
const isSafari15 = ua => rules().some(conds => conds.every(c => c.re.test(ua) !== c.not));

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

test('Safari 15’s policy differs only in having \'unsafe-eval\' for \'wasm-unsafe-eval\'', () => {
  const {strict, safari15} = headers();
  assert.deepEqual(safari15['script-src'], ["'self'", "'unsafe-eval'"]);
  assert.deepEqual({...safari15, 'script-src': strict['script-src']}, strict);
});

test('the policy covers every file: not inside a <FilesMatch> or <Files>', () => {
  let depth = 0;
  for (const line of read('.htaccess').split('\n')) {
    if (/^\s*<Files(Match)?\b/.test(line)) depth++;
    if (/^\s*<\/Files(Match)?>/.test(line)) depth--;
    if (/Header set Content-Security-Policy|Header append Vary User-Agent/.test(line)) assert.equal(depth, 0, line.trim().slice(0, 60));
  }
  assert.match(read('.htaccess'), /^\s*Header append Vary User-Agent\s*$/m, 'caches keep one copy per browser');
});

const SAFARI_15 = {
  'iPhone, iOS 15.4': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
  'iPhone, iOS 15.8.3': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1',
  'iPad, iOS 15 (mobile UA)': 'Mozilla/5.0 (iPad; CPU OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.7 Mobile/15E148 Safari/604.1',
  'iPad, iOS 15 (desktop UA)': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
  'Chrome on iOS 15': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/104.0.5112.88 Mobile/15E148 Safari/604.1',
  'Firefox on iOS 15': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/101.0 Mobile/15E148 Safari/605.1.15',
  'iOS 15 home-screen app': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Safari 15.6 on a Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.1 Safari/605.1.15',
};
const OTHERS = {
  'Safari 16 on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Safari 17 on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Safari 18 on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  'Safari 16 on a Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
  'Safari 17 on a Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Safari 18 on a Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
  'Chrome on iOS 16': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  'Chrome on iOS 18': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  'Chrome on a Mac': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Edge on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  'Chrome on Android': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  'Firefox': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
};

test('Safari 15 and every browser on iOS 15 get the Safari 15 policy', () => {
  assert.ok(rules().length >= 2, '.htaccess has the rewrite rules');
  for (const [name, ua] of Object.entries(SAFARI_15)) assert.ok(isSafari15(ua), name);
});

test('newer Safari, Chrome, Edge and Firefox get the strict policy', () => {
  for (const [name, ua] of Object.entries(OTHERS)) assert.ok(!isSafari15(ua), name);
});

test('each source page carries the header’s policy, less frame-ancestors, plus a local relay', () => {
  const h = header();
  delete h['frame-ancestors'];
  h['connect-src'] = [...h['connect-src'], ...LOCAL];
  for (const page of PAGES) assert.deepEqual(meta(page), h, page);
});

test('build-site.sh takes the policy out of the site’s pages and checks it has', () => {
  const b = read('scripts/build-site.sh');
  assert.match(b, /\/<meta http-equiv="Content-Security-Policy"\/d/, 'deletes the meta tag');
  assert.match(b, /still has a policy of its own/, 'fails the build if a page keeps one');
  assert.equal(b.split('"${NO_META[@]}"').length - 1, PAGES.length, 'for every page');
});

test('every page loads the update screen first, as a file', () => {
  for (const page of PAGES) {
    const html = read(page);
    const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
    assert.equal(scripts[0], 'src/browser-check.js', `${page}: browser-check.js comes first`);
    assert.match(html, /<script defer src="src\/browser-check\.js"><\/script>/, `${page}: a deferred classic script`);
  }
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

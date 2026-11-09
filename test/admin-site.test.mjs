// The admin site, admin.ducy.cards (#601): its build, its deploy (never
// open, skipped while the subdomain's folder is missing, and the live
// deploy leaves that folder alone), admin.html sent there, and its charts.
// Run with: node --test test/admin-site.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chartHtml, fmt, geometry, linePath, niceMax } from '../src/admin-charts.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = f => readFileSync(join(ROOT, f), 'utf8');
const haveWasm = existsSync(join(ROOT, 'wasm/ducy_wasm_bg.wasm'));
const haveRsync = spawnSync('rsync', ['--version']).status === 0;

// A built admin site, once.
let built = null;
function build() {
  if (built) return built;
  built = join(mkdtempSync(join(tmpdir(), 'ducy-admin-')), 'site');
  execFileSync('scripts/build-admin.sh', ['test-1', built], {cwd: ROOT, stdio: 'pipe'});
  return built;
}

test('the build: one page pointed at its release, its own policy, no meta policy', {skip: !haveWasm && 'no wasm build'}, () => {
  const out = build();
  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(page, /href="v\/test-1\/src\/admin\.css"/);
  assert.match(page, /src="v\/test-1\/src\/admin\.js"/);
  assert.doesNotMatch(page, /Content-Security-Policy|localhost/);
  assert.match(readFileSync(join(out, '.htaccess'), 'utf8'), /Header set Content-Security-Policy/);
  assert.equal(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')).environment, 'admin');
  assert.ok(existsSync(join(out, 'v/test-1/wasm/ducy_wasm_bg.wasm')));
  assert.deepEqual(readdirSync(join(out, 'v/test-1/src')).sort(), ['admin-charts.js', 'admin.css', 'admin.js', 'browser-check.js', 'chip-format.js', 'identity.js', 'time-ago.js']);
});

// A host folder as rsync sees it: public_html, maybe with admin/ in it.
function host({folder = true, htaccess = null} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ducy-host-'));
  const html = join(dir, 'public_html');
  mkdirSync(html);
  writeFileSync(join(html, 'index.html'), 'live');
  if (folder) {
    mkdirSync(join(html, 'admin'));
    if (htaccess != null) writeFileSync(join(html, 'admin/.htaccess'), htaccess);
  }
  return html;
}
// deploy-admin.sh on a fresh copy of the build.
function deploy(target) {
  const site = join(mkdtempSync(join(tmpdir(), 'ducy-admin-copy-')), 'site');
  execFileSync('cp', ['-r', build(), site]);
  return spawnSync('scripts/deploy-admin.sh', [site, target], {cwd: ROOT, encoding: 'utf8'});
}
const AUTH = 'AuthUserFile "/home/x/.htpasswd/public_html/admin/.htpasswd"\nAuthName "Admin"\nAuthType Basic\nrequire valid-user\n';

test('deploy: no folder yet, so a warning saying what to make, and nothing uploaded', {skip: (!haveWasm || !haveRsync) && 'no wasm build or rsync'}, () => {
  const html = host({folder: false});
  const r = deploy(join(html, 'admin'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning/);
  assert.match(r.stderr, /create the subdomain admin\.ducy\.cards/);
  assert.ok(!existsSync(join(html, 'admin')));
});

test('deploy: a folder without a password is never uploaded to', {skip: (!haveWasm || !haveRsync) && 'no wasm build or rsync'}, () => {
  for (const htaccess of [null, '# nothing here\n', 'AuthType Basic\n']) {
    const html = host({htaccess});
    const r = deploy(join(html, 'admin'));
    assert.equal(r.status, 1, `exit 1 with .htaccess ${JSON.stringify(htaccess)}`);
    assert.match(r.stderr, /not deploying an unprotected admin site/);
    assert.deepEqual(readdirSync(join(html, 'admin')).filter(f => f !== '.htaccess'), []);
  }
});

test('deploy: the folder\'s password lines go on top of the new .htaccess', {skip: (!haveWasm || !haveRsync) && 'no wasm build or rsync'}, () => {
  const html = host({htaccess: `# DirectAdmin\n${AUTH}`});
  const r = deploy(join(html, 'admin'));
  assert.equal(r.status, 0, r.stderr);
  const h = readFileSync(join(html, 'admin/.htaccess'), 'utf8');
  assert.ok(h.indexOf('AuthUserFile') < h.indexOf('Content-Security-Policy'));
  for (const line of AUTH.trim().split('\n')) assert.ok(h.includes(line), line);
  assert.ok(existsSync(join(html, 'admin/index.html')));
  assert.ok(existsSync(join(html, 'admin/v/test-1/src/admin.js')));
  assert.equal(readFileSync(join(html, 'index.html'), 'utf8'), 'live', 'the live site is untouched');
});

test('the live deploy leaves the subdomains\' folders alone, admin/ too', () => {
  const d = read('scripts/deploy.sh');
  for (const f of ['staging', 'sandbox', 'admin']) assert.match(d, new RegExp(`--exclude '/${f}/'`));
});

test('the release deploys the admin site last, into admin/', () => {
  const y = read('.github/workflows/deploy.yml');
  assert.match(y, /scripts\/build-admin\.sh /);
  const at = y.indexOf('scripts/deploy-admin.sh _admin "${{ secrets.SSH_DEPLOY_TARGET }}/admin"');
  assert.ok(at > 0);
  assert.ok(at > y.indexOf('gh release create'), 'after everything else');
  // Built from the site's wasm, before the relay's clubs-only build replaces it.
  assert.ok(y.indexOf('scripts/build-admin.sh') < y.indexOf('--no-default-features'));
});

test('admin.html on the sites goes to the admin site; the player app never links there', () => {
  assert.match(read('.htaccess'), /^RewriteRule \^admin\\\.html\$ https:\/\/admin\.ducy\.cards\/ \[L,R=301\]$/m);
  assert.doesNotMatch(read('scripts/build-site.sh'), /> "\$OUT\/admin\.html"/);
  // Its version.json may be read by the admin site.
  assert.match(read('.htaccess'), /<Files "version\.json">\s*Header set Access-Control-Allow-Origin "https:\/\/admin\.ducy\.cards"/);
  for (const f of ['index.html', 'manage.html', 'privacy.html', ...readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.js') && !f.startsWith('admin')).map(f => `src/${f}`)]) {
    assert.doesNotMatch(read(f), /admin\.ducy\.cards|admin\.html/, f);
  }
});

test('each relay lets the admin site call its admin API', () => {
  const w = read('relay/wrangler.toml');
  assert.equal([...w.matchAll(/^ADMIN_ORIGINS = "https:\/\/admin\.ducy\.cards"$/gm)].length, 3, 'live, staging and sandbox');
});

test('charts: a clean top, gaps where there\'s no value, the latest value as the headline', () => {
  assert.deepEqual([0, 1, 3, 7, 12, 240, 2600].map(niceMax), [1, 1, 5, 10, 20, 250, 5000]);
  assert.equal(fmt(1234), '1,234');
  assert.equal(fmt(12900), '12.9K');
  assert.equal(fmt(2.25, 1), '2.3');
  assert.equal(fmt(null), '—');
  const g = geometry([1, null, 3]);
  assert.equal(g.top, 5);
  assert.equal(g.pts[1].y, null);
  assert.equal((linePath(g.pts).match(/M/g) || []).length, 2, 'the line breaks at the gap');
  const html = chartHtml({key: 'hands', label: 'Hands <b>', days: ['2026-11-01', '2026-11-02'], values: [4, 12900]});
  assert.match(html, /<span class="chart-value">12\.9K<\/span>/);
  assert.match(html, /Hands &lt;b&gt;/);
  assert.doesNotMatch(html, /Hands <b>/);
  assert.match(html, /aria-label="Hands &lt;b&gt;, last 2 days; today 12\.9K"/);
});

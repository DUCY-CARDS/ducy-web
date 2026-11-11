// The club site, club.ducy.cards (#637): the club manager on an origin of
// its own. Its build, its deploy (skipped while the subdomain's folder is
// missing, open on live, password-kept on staging and the sandbox, and the
// live deploy leaves its folders alone), manage.html sent there, and each
// relay allowing it.
// Run with: node --test test/club-site.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = f => readFileSync(join(ROOT, f), 'utf8');
const haveWasm = existsSync(join(ROOT, 'wasm/ducy_wasm_bg.wasm'));
const haveRsync = spawnSync('rsync', ['--version']).status === 0;

// A built club site per environment, once each.
const builds = {};
function build(env = 'production') {
  if (builds[env]) return builds[env];
  const out = join(mkdtempSync(join(tmpdir(), 'ducy-club-')), 'site');
  const vars = env === 'production' ? {} : {DUCY_ENV: env, RELAY_HOST: `ducy-relay-${env}.ducy.workers.dev`};
  execFileSync('scripts/build-club.sh', ['test-1', out], {cwd: ROOT, stdio: 'pipe', env: {...process.env, ...vars}});
  return (builds[env] = out);
}
const file = (dir, f) => readFileSync(join(dir, f), 'utf8');

test('the build: the club manager as the page, on the same release, with its own redirect', {skip: !haveWasm && 'no wasm build'}, () => {
  const out = build();
  const page = file(out, 'index.html');
  assert.match(page, /src="v\/test-1\/src\/manage\.js"/);
  assert.match(page, /href="v\/test-1\/src\/style\.css"/);
  assert.match(page, /<a class="wordmark" href="https:\/\/ducy\.cards\/"/, 'the player app is on ducy.cards');
  assert.doesNotMatch(page, /Content-Security-Policy|localhost|env-strip/);
  assert.ok(!existsSync(join(out, 'manage.html')));
  assert.ok(!existsSync(join(out, 'charts')), 'the player app\'s chart data isn\'t here');
  assert.ok(existsSync(join(out, 'privacy.html')));
  assert.ok(existsSync(join(out, 'v/test-1/src/clubs.js')));
  assert.ok(existsSync(join(out, 'v/test-1/wasm/ducy_wasm_bg.wasm')));
  const h = file(out, '.htaccess');
  assert.match(h, /Header set Content-Security-Policy "[^"]*connect-src 'self' wss:\/\/ducy-relay\.ducy\.workers\.dev/);
  assert.match(h, /^RewriteRule \^manage\\\.html\$ \/ \[L,R=302\]$/m, 'an old manage.html address comes to the page');
  assert.doesNotMatch(h, /https:\/\/club\.ducy\.cards/);
  assert.doesNotMatch(h, /AuthUserFile|Require/, 'never password-protected by the build');
  assert.match(h, /X-Robots-Tag "noindex, nofollow"/);
  const v = JSON.parse(file(out, 'version.json'));
  assert.equal(v.site, 'club');
  assert.equal(v.environment, 'production');
});

test('the build for staging: its relay, its strip, and its player app', {skip: !haveWasm && 'no wasm build'}, () => {
  const out = build('staging');
  const page = file(out, 'index.html');
  assert.match(page, /class="env-strip"/);
  assert.match(page, /<a class="wordmark" href="https:\/\/staging\.ducy\.cards\/"/);
  assert.match(file(out, '.htaccess'), /wss:\/\/ducy-relay-staging\.ducy\.workers\.dev/);
  assert.doesNotMatch(file(out, '.htaccess'), /club-staging\.ducy\.cards/);
  assert.equal(JSON.parse(file(out, 'version.json')).environment, 'staging');
});

test('the main site sends manage.html to its club site: live, staging, sandbox', {skip: !haveWasm && 'no wasm build'}, () => {
  assert.match(read('.htaccess'), /^RewriteRule \^manage\\\.html\$ https:\/\/club\.ducy\.cards\/ \[L,R=302\]$/m);
  for (const [env, host] of [['production', 'club.ducy.cards'], ['staging', 'club-staging.ducy.cards'], ['sandbox', 'club-sandbox.ducy.cards']]) {
    const out = join(mkdtempSync(join(tmpdir(), 'ducy-site-')), 'site');
    const vars = env === 'production' ? {} : {DUCY_ENV: env, RELAY_HOST: `ducy-relay-${env}.ducy.workers.dev`};
    execFileSync('scripts/build-site.sh', ['test-1', out], {cwd: ROOT, stdio: 'pipe', env: {...process.env, ...vars}});
    const h = file(out, '.htaccess');
    assert.ok(h.includes(`RewriteRule ^manage\\.html$ https://${host}/ [L,R=302]`), env);
    assert.equal((h.match(/RewriteRule \^manage/g) || []).length, 1, env);
  }
});

// A host folder as rsync sees it: public_html, maybe with the club's folder.
function host(name, {folder = true, htaccess = null} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ducy-host-'));
  const html = join(dir, 'public_html');
  mkdirSync(html);
  writeFileSync(join(html, 'index.html'), 'live');
  if (folder) {
    mkdirSync(join(html, name));
    if (htaccess != null) writeFileSync(join(html, name, '.htaccess'), htaccess);
  }
  return html;
}
function deploy(env, target) {
  const site = join(mkdtempSync(join(tmpdir(), 'ducy-club-copy-')), 'site');
  execFileSync('cp', ['-r', build(env), site]);
  return spawnSync('scripts/deploy-club.sh', [site, target], {cwd: ROOT, encoding: 'utf8', env: {...process.env, GITHUB_OUTPUT: ''}});
}
const AUTH = 'AuthUserFile "/home/x/.htpasswd/public_html/club-staging/.htpasswd"\nAuthName "Staging"\nAuthType Basic\nrequire valid-user\n';
const skipDeploy = (!haveWasm || !haveRsync) && 'no wasm build or rsync';

test('deploy: no folder yet, so a warning saying what to make, and nothing uploaded', {skip: skipDeploy}, () => {
  const html = host('club', {folder: false});
  const r = deploy('production', join(html, 'club'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning/);
  assert.match(r.stderr, /create the subdomain club\.ducy\.cards \(its folder is public_html\/club\)/);
  assert.ok(!existsSync(join(html, 'club')));
});

test('deploy: live goes up open, into club/, and leaves the live site alone', {skip: skipDeploy}, () => {
  const html = host('club');
  const r = deploy('production', join(html, 'club'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(file(join(html, 'club'), 'index.html'), /manage\.js/);
  assert.ok(existsSync(join(html, 'club/v/test-1/src/clubs.js')));
  assert.doesNotMatch(file(join(html, 'club'), '.htaccess'), /AuthUserFile/);
  assert.equal(file(html, 'index.html'), 'live');
});

test('deploy: a build goes only into its own environment\'s folder', {skip: skipDeploy}, () => {
  const html = host('club');
  const r = deploy('staging', join(html, 'club'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /folder named club-staging/);
  assert.deepEqual(readdirSync(join(html, 'club')), []);
});

test('deploy: staging\'s club site keeps its folder\'s password, and never goes up without one', {skip: skipDeploy}, () => {
  const open = host('club-staging', {htaccess: '# nothing\n'});
  const r1 = deploy('staging', join(open, 'club-staging'));
  assert.notEqual(r1.status, 0);
  assert.deepEqual(readdirSync(join(open, 'club-staging')), ['.htaccess']);
  const locked = host('club-staging', {htaccess: AUTH});
  const r2 = deploy('staging', join(locked, 'club-staging'));
  assert.equal(r2.status, 0, r2.stderr);
  const h = file(join(locked, 'club-staging'), '.htaccess');
  assert.ok(h.indexOf('AuthUserFile') < h.indexOf('Content-Security-Policy'));
  assert.match(file(join(locked, 'club-staging'), 'index.html'), /env-strip/);
});

test('the live deploy leaves the club sites\' folders alone', () => {
  const d = read('scripts/deploy.sh');
  for (const f of ['club', 'club-staging', 'club-sandbox']) assert.match(d, new RegExp(`--exclude '/${f}/'`));
});

test('the workflows build and deploy it: the release into club/, staging and sandbox into club-<environment>/', () => {
  const y = read('.github/workflows/deploy.yml');
  assert.ok(y.indexOf('scripts/build-club.sh') > 0 && y.indexOf('scripts/build-club.sh') < y.indexOf('--no-default-features'), 'built from the site\'s wasm');
  const at = y.indexOf('scripts/deploy-club.sh _club "${{ secrets.SSH_DEPLOY_TARGET }}/club"');
  assert.ok(at > y.indexOf('scripts/deploy.sh _site'), 'after the site');
  const e = read('.github/workflows/deploy-env.yml');
  assert.match(e, /scripts\/build-club\.sh /);
  assert.ok(e.includes('scripts/deploy-club.sh _club "${{ secrets.SSH_DEPLOY_TARGET }}/club-${{ inputs.environment }}"'));
  assert.match(read('.github/workflows/ci.yml'), /scripts\/build-club\.sh /);
});

test('each relay lets its club site connect', () => {
  const w = read('relay/wrangler.toml');
  const origins = [...w.matchAll(/^ALLOWED_ORIGINS = "([^"]*)"$/gm)].map(m => m[1].split(','));
  assert.equal(origins.length, 3);
  assert.ok(origins[0].includes('https://club.ducy.cards'));
  assert.ok(origins[1].includes('https://club-staging.ducy.cards'));
  assert.ok(origins[2].includes('https://club-sandbox.ducy.cards'));
});

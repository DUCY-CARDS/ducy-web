// The club site (#637) in real browsers: club.ducy.cards and ducy.cards
// are served from this checkout (the page's own hostname decides which site
// it is, src/sites.js), at 1280 and 375 px. Every test fails on an uncaught
// error, on anything logged as an error, and on a page wider than the screen.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { RELAY_PORT, SITE_PORT } from './playwright.config.js';
import { adminCall, grantAdmin, grantFor } from './grant.mjs';

// The live relay isn't reached from the tests: its requests are refused,
// and the browser logs each.
const EXPECTED = /Failed to load resource|WebSocket connection|access control checks/;
const LOCAL = `http://localhost:${SITE_PORT}`;
// Each site's paths, as build-club.sh and build-site.sh lay them out.
const PATHS = {
  'club.ducy.cards': p => (p === '/' ? '/manage.html' : p === '/app.html' ? '/index.html' : p),
  'ducy.cards': p => (p === '/' ? '/index.html' : p),
};

// Serves both sites to `page` from this checkout; its problems go in `problems`.
async function serveSites(page, problems) {
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) problems.push(`console: ${m.text()}`); });
  for (const [host, map] of Object.entries(PATHS)) {
    await page.route(`https://${host}/**`, async route => {
      const u = new URL(route.request().url());
      // A page that has already gone elsewhere (a redirect) drops its requests.
      try {
        const res = await route.fetch({url: `${LOCAL}${map(u.pathname)}${u.search}`});
        await route.fulfill({response: res});
      } catch {}
    });
  }
  await page.route(/ducy-relay\.ducy\.workers\.dev/, route => route.abort());
  return page;
}

const test = base.extend({
  page: async ({page}, use) => {
    const problems = [];
    await serveSites(page, problems);
    await use(page);
    expect(problems).toEqual([]);
  },
});
// The sites here are https://…ducy.cards and a test's relay is on localhost:
// Chromium would keep a public site from reaching it (local network access).
test.use({launchOptions: {args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults']}});

const fitsTheScreen = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('a browser without passkeys goes straight on to the manager', async ({page}) => {
  await page.addInitScript(() => { delete window.PublicKeyCredential; });
  await page.goto('https://club.ducy.cards/#clubs');
  await expect(page.locator('#clubs .cl-pass, #clubs .pl-head').first()).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Sign in'})).toHaveCount(0);
  await fitsTheScreen(page);
});

test('a first visit asks for the passkey before making a new player; someone new goes on to the manager', async ({page, browserName}) => {
  // Playwright's WebKit has no passkeys (as for play.spec.js's passkey tests).
  test.skip(browserName === 'webkit', 'no passkeys in Playwright’s WebKit');
  await page.goto('https://club.ducy.cards/#clubs');
  await expect(page.getByRole('heading', {name: 'Sign in'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Use your passkey'})).toBeVisible();
  await fitsTheScreen(page);
  // Nothing was made yet.
  expect(await page.evaluate(() => new Promise(r => { const q = indexedDB.open('ducy', 1); q.onupgradeneeded = () => q.result.createObjectStore('identity'); q.onsuccess = () => { const g = q.result.transaction('identity').objectStore('identity').get('me'); g.onsuccess = () => r(!!g.result); }; }))).toBe(false);
  await page.getByRole('button', {name: 'I’m new to ducy'}).click();
  await expect(page.getByRole('heading', {name: 'Sign in'})).toHaveCount(0);
  await expect(page.locator('.mg-badge')).toHaveText('Club manager');
  await expect(page.locator('#clubs .cl-pass, #clubs .pl-head').first()).toBeVisible();
  await fitsTheScreen(page);
  // Next time, straight in.
  await page.reload();
  await expect(page.locator('#clubs .cl-pass, #clubs .pl-head').first()).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Sign in'})).toHaveCount(0);
});

test('the wordmark goes to the player app on ducy.cards', async ({page}) => {
  await page.goto('https://club.ducy.cards/#clubs');
  await expect(page.locator('a.wordmark')).toHaveAttribute('href', 'https://ducy.cards/');
});

test('the player app on the club site is only for demos: anyone else goes to ducy.cards', async ({page}) => {
  await page.goto('https://club.ducy.cards/app.html#welcome');
  await expect(page).toHaveURL('https://ducy.cards/#welcome');
});

test('the player app makes no fuss on its own site, and asks for no sign-in first', async ({page}) => {
  await page.goto('https://ducy.cards/');
  await expect(page.getByRole('heading', {name: 'Sign in'})).toHaveCount(0);
  await fitsTheScreen(page);
});

// A virtual passkey authenticator (Chromium only).
async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', {enableUI: false});
  await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  }});
}

// A dev relay of its own that takes clubs from the club site only
// (CLUB_ORIGINS), with a test admin to grant them (#636).
async function clubRelay(port, admin) {
  const relay = spawn(process.execPath, ['relay/dev-server.mjs', String(port)], {cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore', env: {...process.env, ADMINS_FILE: admin.file, CLUB_ORIGINS: 'https://club.ducy.cards'}});
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://localhost:${port}/code/ZZZZ-ZZZZ`).then(() => true, () => false)) return relay;
    await new Promise(r => setTimeout(r, 100));
  }
  relay.kill();
  throw new Error('the club relay didn’t start');
}

test.describe('a grant link (#636)', () => {
  test.skip(({browserName}) => browserName !== 'chromium', 'only Chromium has a virtual passkey authenticator');
  let relay, url, admin, port;
  test.beforeAll(async ({browserName}, info) => {
    if (browserName !== 'chromium') return;
    port = RELAY_PORT + 90 + info.parallelIndex;
    admin = await grantAdmin();
    relay = await clubRelay(port, admin);
    url = `ws://localhost:${port}`;
  });
  test.afterAll(() => relay?.kill());

  // Someone new on the club site, with the test relay: their player ID.
  async function newcomer(page) {
    await authenticator(page);
    await page.goto(`https://club.ducy.cards/?relay=${url}#clubs`);
    await page.getByRole('button', {name: 'I’m new to ducy'}).click();
    await expect(page.locator('.mg-badge')).toHaveText('Club manager');
    return page.evaluate(() => import('/src/identity.js').then(m => m.loadIdentity()).then(i => i.id));
  }
  const createWith = async (page, link) => {
    await page.goto(link);
    await expect(page.locator('.cl-act-title')).toHaveText('Start a club');
    await fitsTheScreen(page);
    await page.locator('#cl-clubname').fill('Night Owls');
    await page.locator('[data-cl="create"]').click();
    await page.locator('[data-cl="pass-enrol"]').click();
  };

  test('opens on the club site and makes the club there, once, for its player only', async ({page, browser}, info) => {
    test.setTimeout(120_000);
    const id = await newcomer(page);
    // As the admin site makes it: the club site, the token in the hash.
    const link = `https://club.ducy.cards/#clubs/start/${await grantFor(admin, port, id)}`;

    // Forwarded to someone else: nothing for them, and their ID to send ducy.
    const problems = [];
    const other = await serveSites(await (await browser.newContext()).newPage(), problems);
    const otherId = await newcomer(other);
    await createWith(other, link);
    await expect(other.getByText(/isn’t for this player ID, or it was used or taken back/)).toBeVisible();
    await expect(other.locator('code.cl-id')).toHaveText(otherId);
    await fitsTheScreen(other);
    await other.screenshot({path: info.outputPath('forwarded.png'), fullPage: true});
    expect(problems).toEqual([]);

    // Its player: the club is made, owned by their own key, and the link is off the address.
    await createWith(page, link);
    await expect(page.locator('[data-cl="wiz-skip"]')).toBeVisible();
    await expect(page).toHaveURL(/#clubs$/);
    await fitsTheScreen(page);
    await page.screenshot({path: info.outputPath('made.png'), fullPage: true});
    const clubs = (await adminCall(admin, port, '/admin/clubs')).body;
    expect(clubs.clubs.map(c => [c.owner, c.name])).toEqual([[id, 'Night Owls']]);
    expect(clubs.invites[id].used).toBe(true);
  });
});

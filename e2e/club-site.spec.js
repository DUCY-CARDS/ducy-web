// The club site (#637) in real browsers: club.ducy.cards and ducy.cards
// are served from this checkout (the page's own hostname decides which site
// it is, src/sites.js), at 1280 and 375 px. Every test fails on an uncaught
// error, on anything logged as an error, and on a page wider than the screen.
import { test as base, expect } from '@playwright/test';
import { SITE_PORT } from './playwright.config.js';

// The live relay isn't reached from the tests: its requests are refused,
// and the browser logs each.
const EXPECTED = /Failed to load resource|WebSocket connection|access control checks/;
const LOCAL = `http://localhost:${SITE_PORT}`;
// Each site's paths, as build-club.sh and build-site.sh lay them out.
const PATHS = {
  'club.ducy.cards': p => (p === '/' ? '/manage.html' : p === '/app.html' ? '/index.html' : p),
  'ducy.cards': p => (p === '/' ? '/index.html' : p),
};

const test = base.extend({
  page: async ({page}, use) => {
    const problems = [];
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
    await use(page);
    expect(problems).toEqual([]);
  },
});

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

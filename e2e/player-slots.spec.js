// Player slots on staging (#671): each window its own player, by ?player=N,
// on staging's player app and club site, never on the live sites. The sites
// are served from this checkout under their real hostnames (as in
// club-site.spec.js), at 1280 and 375 px. Every test fails on an uncaught
// error, on anything logged as an error, and on a page wider than the screen.
// (The club game across slots, and #618's takeover, are in play.spec.js.)
import { test as base, expect } from '@playwright/test';
import { SITE_PORT } from './playwright.config.js';

// The live relay isn't reached from the tests: its requests are refused.
const EXPECTED = /Failed to load resource|WebSocket connection|access control checks/;
const LOCAL = `http://localhost:${SITE_PORT}`;
const PLAYER = p => (p === '/' ? '/index.html' : p);
const CLUB = p => (p === '/' ? '/manage.html' : p === '/app.html' ? '/index.html' : p);
const PATHS = {'staging.ducy.cards': PLAYER, 'club-staging.ducy.cards': CLUB, 'ducy.cards': PLAYER, 'club.ducy.cards': CLUB};

const test = base.extend({
  page: async ({page}, use) => {
    const problems = [];
    page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) problems.push(`console: ${m.text()}`); });
    await page.context().route(/^https:\/\/[a-z-]*\.?ducy\.cards\//, async route => {
      const u = new URL(route.request().url());
      const map = PATHS[u.hostname];
      if (!map) return route.abort();
      try {
        await route.fulfill({response: await route.fetch({url: `${LOCAL}${map(u.pathname)}${u.search}`})});
      } catch {}
    });
    await page.context().route(/ducy-relay(-staging)?\.ducy\.workers\.dev/, route => route.abort());
    await use(page);
    expect(problems).toEqual([]);
  },
});

const fitsTheScreen = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const idOf = page => page.evaluate(() => import('/src/identity.js').then(m => m.loadIdentity()).then(i => i.id));
const pill = page => page.locator('details.ps-slot');
// The page is up: its first screen drawn.
const ready = page => expect(page.locator('body')).not.toHaveClass(/booting/);

test('staging: each window is its own player, named in the switcher', async ({page}, info) => {
  await page.goto('https://staging.ducy.cards/');
  await ready(page);
  await expect(pill(page).locator('summary')).toHaveText('P1');
  const one = await idOf(page);

  // A second window as player 2: another player ID, its own name.
  const two = await page.context().newPage();
  await two.goto('https://staging.ducy.cards/?player=2');
  await ready(two);
  const twoId = await idOf(two);
  expect(twoId).not.toBe(one);
  await expect(two).toHaveTitle(/^\[P2\] /);
  await two.evaluate(() => localStorage.setItem('ducyClubName', 'Ava'));
  // Kept apart in this browser's storage: player 1's name is untouched.
  expect(await page.evaluate(() => localStorage.getItem('ducyClubName'))).toBe(null);
  expect(await page.evaluate(() => localStorage.getItem('slot#2:ducyClubName'))).toBe('Ava');
  // A reload stays player 2, without the address saying so.
  await two.goto('https://staging.ducy.cards/#clubs');
  await ready(two);
  expect(await idOf(two)).toBe(twoId);
  await expect(pill(two).locator('summary')).toHaveText('P2 Ava');

  // Player 1's switcher lists player 2 by name, and a new player.
  await page.reload();
  await ready(page);
  await pill(page).locator('summary').click();
  const rows = pill(page).locator('li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).toContainText('P2 Ava');
  await expect(rows.nth(2)).toContainText('New player');
  await fitsTheScreen(page);
  await page.screenshot({path: info.outputPath('switcher.png')});

  // New window as player 2: it opens on that player.
  const [popup] = await Promise.all([page.context().waitForEvent('page'), rows.nth(1).getByRole('button', {name: 'P2 in a new window'}).click()]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).searchParams.get('player')).toBe('2');
  await ready(popup);
  expect(await idOf(popup)).toBe(twoId);
  await popup.close();

  // Switch this window to a new player: player 3, a third ID.
  await pill(page).locator('summary').click();
  await rows.nth(2).getByRole('button', {name: 'Switch'}).click();
  await expect(page).toHaveURL(/\?player=3(#.*)?$/);
  await ready(page);
  await expect(pill(page).locator('summary')).toHaveText('P3');
  const three = await idOf(page);
  expect([one, twoId]).not.toContain(three);
  // And back to player 1: the first ID again.
  await pill(page).locator('summary').click();
  await pill(page).locator('li').nth(0).getByRole('button', {name: 'Switch'}).click();
  await ready(page);
  await expect(pill(page).locator('summary')).toHaveText('P1');
  expect(await idOf(page)).toBe(one);
});

test('staging’s club site: the window’s player, and links to the player app keep it', async ({page}, info) => {
  await page.addInitScript(() => { delete window.PublicKeyCredential; });
  await page.goto('https://club-staging.ducy.cards/?player=2#clubs');
  await expect(page.locator('#clubs .cl-pass, #clubs .pl-head').first()).toBeVisible();
  await expect(pill(page).locator('summary')).toHaveText('P2');
  await expect(page.locator('a.wordmark')).toHaveAttribute('href', 'https://staging.ducy.cards/?player=2');
  await fitsTheScreen(page);
  await page.screenshot({path: info.outputPath('club-site.png')});
});

test('the live sites: no switcher, and ?player changes nothing', async ({page}) => {
  for (const host of ['ducy.cards', 'club.ducy.cards']) {
    await page.addInitScript(() => { delete window.PublicKeyCredential; });
    await page.goto(`https://${host}/`);
    await ready(page);
    const id = await idOf(page);
    await page.goto(`https://${host}/?player=2`);
    await ready(page);
    expect(await idOf(page)).toBe(id);
    await expect(pill(page)).toHaveCount(0);
    await expect(page).not.toHaveTitle(/\[P/);
    expect(await page.evaluate(() => sessionStorage.getItem('ducyPlayerSlot'))).toBe(null);
  }
});

test('a local page has no switcher unless a window asks for a player; at a table it keeps out of the way', async ({page}, info) => {
  await page.goto('/');
  await ready(page);
  await expect(pill(page)).toHaveCount(0);
  await page.goto('/?player=2#practice');
  await ready(page);
  await expect(pill(page).locator('summary')).toHaveText('P2');
  await page.locator('[data-act="sitregulars"]').click();
  await expect(page.locator('[data-act="check"], [data-act="call"], [data-act="fold"], [data-act="next"]').first()).toBeVisible();
  await fitsTheScreen(page);
  await page.screenshot({path: info.outputPath('table.png')});
});

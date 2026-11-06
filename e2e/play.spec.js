// What the beta offers, in real browsers (#553): the front page, bots, a game
// with friends, and clubs. Every test fails on an uncaught error, on anything
// logged as an error, and on a page wider than the screen.
import { test as base, expect } from '@playwright/test';
import { RELAY_PORT } from './playwright.config.js';

const RELAY = `ws://localhost:${RELAY_PORT}`;
// The Ducybot models and chart data aren't served here, and the browser logs each miss.
const EXPECTED = /Failed to load resource/;

// `watch(page)` collects a page's problems, which are checked when the test ends.
const test = base.extend({
  watch: async ({}, use) => {
    const problems = [];
    await use(page => {
      page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) problems.push(`console: ${m.text()}`); });
      return page;
    });
    expect(problems).toEqual([]);
  },
});

const fitsTheScreen = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

// Plays your turns until the hand ends.
async function playOutAHand(page) {
  const act = page.locator('[data-act="check"], [data-act="call"], [data-act="fold"]').first();
  const over = page.locator('[data-act="next"], .pl-result').first();
  for (let i = 0; i < 40 && !(await over.isVisible()); i++) {
    if (await act.isVisible()) await act.click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await expect(over).toBeVisible();
}

test('the front page offers hosting, joining, clubs and bots, and nothing else', async ({page, watch}) => {
  await watch(page).goto('/');
  await expect(page.getByRole('heading', {name: 'Pull up a chair.'})).toBeVisible();
  await expect(page.getByLabel('Game or club code')).toBeVisible();
  for (const name of ['Start a game', 'Private clubs', 'Play the Regulars', 'Heads-up challenge', 'Omaha 6']) await expect(page.getByRole('link', {name})).toBeVisible();
  await expect(page.getByText('Chips are play money with no cash value')).toBeVisible();
  await expect(page.getByRole('link', {name: /Study|Quest/})).toHaveCount(0);
  await fitsTheScreen(page);
});

test('the full landing page is still at #welcome', async ({page, watch}) => {
  await watch(page).goto('/#welcome');
  await expect(page.getByRole('link', {name: /Study/})).toBeVisible();
  await fitsTheScreen(page);
});

test('a hand against the Regulars plays to its end, with no grades', async ({page, watch}) => {
  await watch(page).goto('/#practice');
  await page.locator('[data-act="sitregulars"]').click();
  await playOutAHand(page);
  await expect(page.getByText(/Hand review|Live feedback/)).toHaveCount(0);
  await fitsTheScreen(page);
});

test('the heads-up challenge deals a hand, with no review', async ({page, watch}) => {
  await watch(page).goto('/#ladder');
  await page.locator('[data-act="ladder-play"]').click();
  await playOutAHand(page);
  await expect(page.getByText('Loading the hand review')).toHaveCount(0);
  await fitsTheScreen(page);
});

test('a friend joins a hosted game by its code', async ({browser, watch}) => {
  const open = async () => watch(await (await browser.newContext()).newPage());
  const host = await open();
  await host.goto(`/?relay=${RELAY}#host`);
  await host.locator('#pl-name').fill('Hana');
  await host.locator('[data-act="host"]').click();
  await expect(host.locator('[data-act="copy"]')).toBeVisible();
  await fitsTheScreen(host);
  const code = (await host.locator('body').innerText()).match(/[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}/)[0];

  const guest = await open();
  await guest.goto(`/?table=${code}&relay=${RELAY}#join`);
  await guest.locator('form[data-joinform] input[name="name"]').fill('Gus');
  await guest.locator('form[data-joinform] button[type="submit"]').click();
  await expect(host.getByText('Gus').first()).toBeVisible();
  await expect(guest.getByText('Hana').first()).toBeVisible();
  await fitsTheScreen(guest);
});

test('starting a club without permission is refused, and says who to give ducy', async ({page, watch}) => {
  await watch(page).goto(`/manage.html?relay=${RELAY}#clubs`);
  await page.locator('#cl-clubname').fill('Night Owls');
  await page.locator('[data-cl="create"]').click();
  await expect(page.getByText(/takes permission from ducy/)).toBeVisible();
  await expect(page.locator('code.cl-id')).toBeVisible();
  await fitsTheScreen(page);
});

test('a demo club opens, and its main pages draw', async ({page, watch}) => {
  await watch(page).goto('/manage.html#clubs');
  await page.locator('[data-cl="demo"]').click();
  await page.locator('[data-demo-start="busy"]').click();
  await expect(page).toHaveURL(/#clubs\//);
  for (const part of ['cash', 'tourneys', 'members', 'chips', 'history']) {
    await page.evaluate(p => { location.hash = `clubs/${p}`; }, part);
    await expect(page.locator('.mg-page')).toBeVisible();
    await fitsTheScreen(page);
  }
});

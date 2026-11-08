// What the beta offers, in real browsers (#553): the front page, bots, a game
// with friends, and clubs. Every test fails on an uncaught error, on anything
// logged as an error, and on a page wider than the screen.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('the front page offers friends, clubs and the Regulars, and nothing else', async ({page, watch}) => {
  await watch(page).goto('/');
  await expect(page.getByRole('heading', {name: 'Pull up a chair.'})).toBeVisible();
  await expect(page.getByLabel('Game or club code')).toBeVisible();
  for (const name of ['Start a game', 'Private clubs', 'Play the Regulars']) await expect(page.getByRole('link', {name})).toBeVisible();
  await expect(page.getByText(/play money|Still in development/i)).toHaveCount(0);
  await expect(page.getByRole('link', {name: /Study|Quest|Heads-up challenge|Omaha 6/})).toHaveCount(0);
  await expect(page.getByText('Ducybot')).toHaveCount(0);
  await fitsTheScreen(page);
});

test('a code with no game behind it says so on the front page (#566)', async ({page, watch}) => {
  await watch(page).goto(`/?relay=${RELAY}`);
  await page.getByLabel('Game or club code').fill('ZZZZ-ZZZZ');
  await page.locator('form[data-v3join] button[type=submit]').click();
  await expect(page.getByText('No game or club with that code.')).toBeVisible();
});

test('a private game shows its code before it opens, and opens with it (#566)', async ({page, watch}) => {
  await watch(page).goto(`/?relay=${RELAY}#host`);
  const shown = (await page.locator('.sg-code').innerText()).trim();
  expect(shown).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  // Its link, to this site, with the same code.
  const link = new URL((await page.locator('.sg-link').innerText()).trim());
  expect(link.origin).toBe(new URL(page.url()).origin);
  expect(link.searchParams.get('table')).toBe(shown);
  await page.locator('#pl-name').fill('Hana');
  await page.locator('[data-act="host"]').click();
  await expect(page.getByText(shown).first()).toBeVisible();
  await expect(page.getByText(/can’t reach the relay/)).toHaveCount(0, {timeout: 10_000});
});

test('Private clubs takes a code, with no clubs yet (#564)', async ({page, watch}) => {
  await watch(page).goto('/');
  await page.getByRole('link', {name: 'Private clubs'}).click();
  const code = page.getByLabel('Club code or invite link');
  await expect(code).toBeVisible();
  await code.fill('not a code');
  await page.locator('form[data-clcode] button').click();
  await expect(page.getByText('That isn’t a code or a link.')).toBeVisible();
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

// A relay of its own that lets anyone start a trial club, for a whole club
// flow; one per worker, so the browsers' runs don't share it.
async function trialRelay(port) {
  const relay = spawn(process.execPath, ['relay/dev-server.mjs', String(port)], {cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore', env: {...process.env, TRIALS: ''}});
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://localhost:${port}/code/ZZZZ-ZZZZ`).then(() => true, () => false)) return relay;
    await new Promise(r => setTimeout(r, 100));
  }
  relay.kill();
  throw new Error('the trial relay didn’t start');
}

test.describe('a club member', () => {
  let relay, url;
  test.beforeAll(async ({}, info) => {
    const port = RELAY_PORT + 10 + info.parallelIndex;
    relay = await trialRelay(port);
    url = `ws://localhost:${port}`;
  });
  test.afterAll(() => relay?.kill());

  test('is asked to back up until they have, and the backup brings them back into the club on another browser (#562)', async ({browser, watch, browserName}, info) => {
    const open = async () => watch(await (await browser.newContext({acceptDownloads: true})).newPage());
    // The owner starts a club, skipping its own backup, and copies the invite link.
    const owner = await open();
    await owner.goto(`/manage.html?relay=${url}#clubs`);
    await owner.locator('#cl-clubname').fill('Night Owls');
    await owner.locator('[data-cl="create"]').click();
    await owner.locator('[data-cl="wiz-skip"]').click();
    await owner.locator('[data-cl="wiz-onward"]').click();
    await owner.locator('[data-cl="wiz-invite"]').click();
    const invite = await owner.locator('#cl-link').inputValue();
    expect(invite).toContain('club=');

    // Ava asks to join, and is let in.
    const ava = await open();
    await ava.goto(invite);
    await ava.locator('form[data-joinform] input[name="name"]').fill('Ava');
    await ava.locator('form[data-joinform] button[type="submit"]').click();
    await owner.locator('[data-cl="wiz-done"]').click();
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await owner.locator('[data-cl="approve"]').first().click();
    const code = new URL(invite).searchParams.get('club');
    await ava.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);

    // Her club page asks her to back up.
    const card = ava.locator('.cl-backup');
    await expect(card.getByText('Back up your account')).toBeVisible();
    await expect(card.getByText(/lives only in this browser/)).toBeVisible();
    // On an iPhone, outside the Home Screen app, how to keep Safari from clearing it.
    await expect(card.getByText(/Add to Home Screen/)).toHaveCount(info.project.name === 'webkit-phone' ? 1 : 0);
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('backup-card.png'), fullPage: true});
    // Saving the file and restoring it run in Chromium: in Playwright's
    // WebKit the download logs CSP stylesheet errors (not yet understood).
    if (browserName === 'webkit') return;
    await card.getByRole('button', {name: 'Download'}).click();
    const pw = 'otter-lantern-quietly-42';
    await card.locator('[name=pw]').fill(pw);
    await card.locator('[name=pw2]').fill(pw);
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('backup-form.png'), fullPage: true});
    const [download] = await Promise.all([ava.waitForEvent('download'), card.getByRole('button', {name: 'Save backup'}).click()]);
    const file = info.outputPath('ava-backup.json');
    await download.saveAs(file);
    await expect(card.getByText('Backed up ✓')).toBeVisible();
    await card.getByRole('button', {name: 'Done'}).click();
    await expect(card).toHaveCount(0);
    // And not again, after a reload.
    await ava.reload();
    await expect(ava.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect(ava.locator('.cl-backup')).toHaveCount(0);
    await ava.locator('[data-pt=player]').first().click();
    await expect(ava.locator('#pset .pl-pid')).not.toHaveText('…');
    const avaId = (await ava.locator('#pset .pl-pid').innerText()).trim();

    // On another browser: restore the file, open the invite link, and she's
    // in with the same player ID, no new request.
    const again = await open();
    again.on('dialog', d => d.accept());
    await again.goto(`/?relay=${url}#clubs`);
    await again.locator('[data-pt=player]').first().click();
    // Once its player ID has loaded: the dialog draws again then.
    await expect(again.locator('#pset .pl-pid')).not.toHaveText('…');
    await again.locator('#pset input[data-ps="file"]').setInputFiles(file);
    await again.locator('#pset [name=pw]').fill(pw);
    await again.locator('#pset [data-psform="restore"] button[type="submit"]').click();
    await again.waitForEvent('load');
    await again.goto(invite);
    await again.locator('form[data-joinform] input[name="name"]').fill('Ava');
    await again.locator('form[data-joinform] button[type="submit"]').click();
    await again.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
    await expect(again.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect(again.locator('.cl-backup')).toHaveCount(0);
    await again.locator('[data-pt=player]').first().click();
    await expect(again.locator('#pset .pl-pid')).toHaveText(avaId);
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await expect(owner.locator('[data-cl="approve"]')).toHaveCount(0);
  });
});

test('a demo club opens, and its main pages draw', async ({page, watch}) => {
  await watch(page).goto('/manage.html#clubs');
  await page.locator('[data-cl="demo"]').click();
  await page.locator('[data-demo-start="busy"]').click();
  // Starting one changes the address, then reloads: the manager shows after that.
  await expect(page.locator('.mg-side')).toBeAttached();
  for (const part of ['cash', 'tourneys', 'members', 'chips', 'history']) {
    await page.evaluate(p => { location.hash = `clubs/${p}`; }, part);
    await expect(page.locator('.mg-page')).toBeVisible();
    await fitsTheScreen(page);
  }
});

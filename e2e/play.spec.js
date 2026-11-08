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

// A virtual passkey authenticator for `page` (Chromium's, over CDP): built
// in, with user verification, and with PRF unless `prf` is false. WebKit
// has none, so the club tests that need a passkey run in Chromium.
async function authenticator(page, {prf = true} = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', {enableUI: false});
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: prf,
  }});
  return {
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', {authenticatorId})).credentials,
    // A passkey synced from another device.
    add: credential => cdp.send('WebAuthn.addCredential', {authenticatorId, credential}),
    // No passkeys: a prompt then fails, as when it's cancelled. (Chrome's
    // virtual authenticator keeps failing once user verification has, so
    // that isn't how.) Passkeys added back have no PRF.
    clear: () => cdp.send('WebAuthn.clearCredentials', {authenticatorId}),
  };
}
const needsPasskeys = browserName => test.skip(browserName !== 'chromium', 'only Chromium has a virtual passkey authenticator');

test('starting a club without permission is refused, and says who to give ducy', async ({page, watch, browserName}) => {
  needsPasskeys(browserName);
  await authenticator(page);
  await watch(page).goto(`/manage.html?relay=${RELAY}#clubs`);
  await page.locator('#cl-clubname').fill('Night Owls');
  await page.locator('[data-cl="create"]').click();
  // Clubs need a passkey first (#575).
  await page.locator('[data-cl="pass-enrol"]').click();
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

  // A new browser, with a passkey authenticator.
  const browserWith = async (browser, watch, opts) => {
    const page = watch(await (await browser.newContext({acceptDownloads: true})).newPage());
    return {page, auth: await authenticator(page, opts)};
  };
  // The owner starts a club (making a passkey first), skipping its own
  // backup; Ava asks to join (making hers) and is let in, and her club page
  // opens.
  async function clubWithAva(browser, watch, info = null) {
    const {page: owner} = await browserWith(browser, watch);
    await owner.goto(`/manage.html?relay=${url}#clubs`);
    await owner.locator('#cl-clubname').fill('Night Owls');
    await owner.locator('[data-cl="create"]').click();
    await expect(owner.getByText('Set up a passkey')).toBeVisible();
    await owner.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-skip"]').click();
    await owner.locator('[data-cl="wiz-onward"]').click();
    await owner.locator('[data-cl="wiz-invite"]').click();
    const invite = await owner.locator('#cl-link').inputValue();
    expect(invite).toContain('club=');

    const {page: ava, auth} = await browserWith(browser, watch);
    await ava.goto(invite);
    await ava.locator('form[data-joinform] input[name="name"]').fill('Ava');
    await ava.locator('form[data-joinform] button[type="submit"]').click();
    // Clubs need a passkey (#575): her request goes once she has one.
    await expect(ava.getByText('Set up a passkey')).toBeVisible();
    await fitsTheScreen(ava);
    if (info) await ava.screenshot({path: info.outputPath('enrol.png'), fullPage: true});
    await ava.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-done"]').click();
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await owner.locator('[data-cl="approve"]').first().click();
    const code = new URL(invite).searchParams.get('club');
    await ava.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
    await expect(ava.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    return {owner, ava, auth, invite, code};
  }
  const closeYou = page => page.locator('#pset .cl-replay-head [data-ps=close]').click();
  const idOf = async page => {
    await page.locator('[data-pt=player]').first().click();
    await expect(page.locator('#pset .pl-pid')).not.toHaveText('…');
    const id = (await page.locator('#pset .pl-pid').innerText()).trim();
    await closeYou(page);
    return id;
  };

  test('is asked to back up until they have, and the backup brings them back into the club on another browser (#562)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, ava, auth, invite, code} = await clubWithAva(browser, watch, info);

    // Her club page asks her to back up.
    const card = ava.locator('.cl-backup');
    await expect(card.getByText('Back up your account')).toBeVisible();
    await expect(card.getByText(/lives only in this browser/)).toBeVisible();
    // On an iPhone, outside the Home Screen app, how to keep Safari from clearing it.
    await expect(card.getByText(/Add to Home Screen/)).toHaveCount(info.project.name === 'webkit-phone' ? 1 : 0);
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('backup-card.png'), fullPage: true});
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

    // On another browser, where her passkey has synced: restore the file,
    // open the invite link, unlock, and she's in with the same player ID,
    // no new request.
    const {page: again, auth: againAuth} = await browserWith(browser, watch);
    for (const c of await auth.credentials()) await againAuth.add(c);
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
    await again.locator('[data-cl="pass-unlock"]').click();
    await again.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
    await expect(again.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect(again.locator('.cl-backup')).toHaveCount(0);
    await again.locator('[data-pt=player]').first().click();
    await expect(again.locator('#pset .pl-pid')).toHaveText(avaId);
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await expect(owner.locator('[data-cl="approve"]')).toHaveCount(0);
  });

  test('unlocks with a passkey, needs it again for chips, and gets the account back with it (#575)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, ava, auth, code} = await clubWithAva(browser, watch);
    const avaId = await idOf(ava);
    const ask = async n => {
      await ava.locator(`[data-ask-amt="${code}"]`).fill(String(n));
      await ava.locator('[data-cl="ask"]').click();
    };
    // Just unlocked: asking for chips goes straight out; the owner gives them.
    await ask(50);
    await expect(ava.getByText(/You asked for 50/)).toBeVisible();
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await owner.locator('[data-cl="grant"]').first().click();
    await expect(ava.getByText('Balance 50')).toBeVisible();

    // The browser clears ducy's data. Her passkey brings the same account back (PRF).
    await ava.evaluate(() => new Promise(r => { localStorage.clear(); sessionStorage.clear(); const q = indexedDB.deleteDatabase('ducy'); q.onsuccess = q.onerror = q.onblocked = r; }));
    await ava.goto(`/?relay=${url}#clubs`);
    await ava.locator('[data-pt=player]').first().click();
    await expect(ava.locator('#pset .pl-pid')).not.toHaveText(avaId);
    await ava.locator('#pset [data-ps="pk-recover"]').click();
    await ava.waitForEvent('load');
    await ava.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
    await expect(ava.getByText('Balance 50')).toBeVisible();
    expect(await idOf(ava)).toBe(avaId);
    // The key is unexportable here now, and a backup still works, from the copy.
    await ava.locator('[data-pt=player]').first().click();
    await ava.locator('#pset [data-ps="backup"]').click();
    await ava.locator('#pset [name=pw]').fill('otter-lantern-quietly-42');
    await ava.locator('#pset [name=pw2]').fill('otter-lantern-quietly-42');
    const [download] = await Promise.all([ava.waitForEvent('download'), ava.locator('#pset [data-psform="backup"] button[type=submit]').click()]);
    expect(await download.failure()).toBeNull();
    // Her passkeys, by device and date.
    await expect(ava.locator('#pset .ps-keys li')).toHaveCount(1);
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('passkeys.png'), fullPage: true});
    await closeYou(ava);

    // A new visit: locked until the passkey is used. With no passkey to
    // answer (the prompt cancelled), it stays locked. (Taken out and put
    // back as they were: its count must be the latest, or the relay takes
    // it for a copy.)
    const without = async () => { const c = await auth.credentials(); await auth.clear(); return c; };
    await ava.evaluate(() => sessionStorage.clear());
    await ava.reload();
    await expect(ava.getByText('Unlock your clubs')).toBeVisible();
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('unlock.png'), fullPage: true});
    let creds = await without();
    await ava.locator('[data-cl="pass-unlock"]').click();
    await expect(ava.getByText('Not unlocked.')).toBeVisible();
    for (const c of creds) await auth.add(c);
    await ava.locator('[data-cl="pass-unlock"]').click();
    await expect(ava.getByRole('heading', {name: 'Night Owls'})).toBeVisible();

    // Chips more than 5 minutes after the unlock: the passkey first. Refused, nothing goes.
    await ava.evaluate(() => { const s = JSON.parse(sessionStorage.ducyPasskey); s.at -= 6 * 60_000; sessionStorage.ducyPasskey = JSON.stringify(s); });
    creds = await without();
    await ask(20);
    await expect(ava.getByText('Not unlocked.')).toBeVisible();
    await expect(ava.getByText(/You asked for 20/)).toHaveCount(0);
    for (const c of creds) await auth.add(c);
    await ask(20);
    await expect(ava.getByText(/You asked for 20/)).toBeVisible();

    // A device whose passkeys have no PRF: the relay vouches, and the club
    // moves her onto that device's own player ID, chips and all.
    const {page: nova, auth: novaAuth} = await browserWith(browser, watch, {prf: false});
    for (const c of await auth.credentials()) await novaAuth.add(c);
    await nova.goto(`/?relay=${url}#clubs`);
    await nova.locator('[data-pt=player]').first().click();
    await expect(nova.locator('#pset .pl-pid')).not.toHaveText('…');
    const novaId = (await nova.locator('#pset .pl-pid').innerText()).trim();
    await nova.locator('#pset [data-ps="pk-recover"]').click();
    await expect(nova.locator('#pset').getByText('Signed in.')).toBeVisible();
    await closeYou(nova);
    await nova.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
    await expect(nova.getByText('Balance 50')).toBeVisible();
    expect(novaId).not.toBe(avaId);
    expect(await idOf(nova)).toBe(novaId);
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

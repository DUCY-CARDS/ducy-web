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
    // Settled after the reload, so leaving doesn't cut a download short.
    await expect(again.getByRole('heading', {name: 'Private clubs'})).toBeVisible();
    await again.waitForLoadState('networkidle');
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

  test('at a club table: players within 100 m are flagged on their seats, one who won’t share says so, and the owner’s hands show it (#581)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    // The owner starts a club with a table open.
    const {page: owner} = await browserWith(browser, watch);
    await owner.goto(`/manage.html?relay=${url}#clubs`);
    await owner.locator('#cl-clubname').fill('Night Owls');
    await owner.locator('[data-cl="create"]').click();
    await owner.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-skip"]').click();
    await owner.locator('[data-cl="wiz-onward"]').click();
    await owner.locator('form[data-tableform] button[type="submit"]').click();
    const invite = await owner.locator('#cl-link').inputValue();
    const code = new URL(invite).searchParams.get('club');
    await owner.locator('[data-cl="wiz-done"]').click();

    // Ava and Bo share their location, 40 m apart; Cy doesn't.
    const AT = {latitude: 30.2672, longitude: -97.7431, accuracy: 15};
    const join = async (name, geo) => {
      const context = await browser.newContext(geo ? {permissions: ['geolocation'], geolocation: geo} : {});
      const page = watch(await context.newPage());
      await authenticator(page);
      await page.goto(invite);
      await page.locator('form[data-joinform] input[name="name"]').fill(name);
      await page.locator('form[data-joinform] button[type="submit"]').click();
      await page.locator('[data-cl="pass-enrol"]').click();
      await owner.evaluate(() => { location.hash = 'clubs/requests'; });
      await owner.locator('[data-cl="approve"]').first().click();
      await page.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
      await expect(page.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
      await page.locator(`[data-ask-amt="${code}"]`).fill('200');
      await page.locator('[data-cl="ask"]').click();
      await owner.evaluate(() => { location.hash = 'clubs/requests'; });
      await owner.locator('[data-cl="grant"]').first().click();
      await expect(page.getByText('Balance 200')).toBeVisible();
      await page.locator('[data-cl="sit-open"]').first().click();
      await page.locator('form[data-sitform] button[type="submit"]').click();
      await expect(page.locator('.pl-felt')).toBeVisible();
      return page;
    };
    const ava = await join('Ava', AT);
    const bo = await join('Bo', {...AT, latitude: AT.latitude + 0.0003, longitude: AT.longitude + 0.0002});
    const cy = await join('Cy', null);
    const players = [ava, bo, cy];
    // Plays everyone's turns (check or call) until `ok()`.
    const playUntil = async ok => {
      for (let i = 0; i < 240 && !(await ok()); i++) {
        for (const p of players) {
          const act = p.locator('[data-act="check"], [data-act="call"]').first();
          if (await act.isVisible()) await act.click().catch(() => {});
        }
        await ava.waitForTimeout(250);
      }
    };
    // Someone who sits mid-hand is dealt in from the next one.
    await playUntil(async () => (await cy.locator('.pl-seat.hero').count()) > 0);

    // Each seat's flags, as each of them sees the table.
    const flagOf = (page, name) => page.locator('.pl-seat', {has: page.locator('.pl-plate b', {hasText: name})}).locator('.pl-flag');
    for (const page of [ava, bo, cy]) {
      await expect(flagOf(page, 'Ava')).toHaveText('within 100 m');
      await expect(flagOf(page, 'Bo')).toHaveText('within 100 m');
      await expect(flagOf(page, 'Cy')).toHaveText('location not shared');
    }
    // Never a place: no coordinates anywhere on the page.
    expect(await ava.locator('#app, body').first().innerText()).not.toMatch(/30\.26|97\.74/);
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('seat-flags.png'), fullPage: true});

    // A hand with all three played out: the owner's hands show who was flagged.
    const handNo = async () => Number((await cy.locator('.pl-meta', {hasText: /· hand \d+ ·/}).first().innerText().catch(() => '')).match(/hand (\d+)/)?.[1] || 0);
    const start = await handNo();
    await playUntil(async () => (await handNo()) > start);
    await owner.evaluate(() => { location.hash = 'clubs/history'; });
    await owner.locator('[data-cl="hands"]').first().click();
    const flagged = owner.locator('.cl-handflags', {hasText: 'Cy'}).first();
    await expect(flagged).toContainText(/(Ava and Bo|Bo and Ava): within 100 m/);
    await expect(flagged).toContainText('Cy: location not shared');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('owner-hand-flags.png'), fullPage: true});
  });
});

// Two hands in a member's history, made in the page as a club table makes
// them (hand-replay.js handRecord): hand 1, Ann folds to Bob's bet; hand 2,
// Ann and Bob check it down and Bob shows queens. Cy folds both preflop.
async function seedHands(page) {
  return page.evaluate(async () => {
    const {handRecord} = await import('/src/hand-replay.js');
    const {saveHand} = await import('/src/hand-store.js');
    const {loadIdentity} = await import('/src/identity.js');
    const me = await loadIdentity();
    const code = JSON.parse(localStorage.getItem('ducyClubs'))[0].code;
    const seat = s => ({id: '', human: true, away: false, street_bet: 0, all_in: false, empty: false, sitting_out: false, ...s});
    const view = (n, events, seats, board, showdown) => ({
      street: null, pot: 0, current_bet: 0, hero: 0, seat: 0, pot_limit: false, to_act: null, legal: null, complete: true,
      hand_number: n, small_blind: 100, big_blind: 200, button: 0, hole_cards: 2, board, showdown,
      pots: [{amount: 1200, eligible: [], awards: [], winning_hand: null}], events, seats: seats.map(seat),
    });
    const pre = [
      {type: 'small_blind', seat: 1, amount: 100}, {type: 'big_blind', seat: 2, amount: 200},
      {type: 'call', seat: 0, amount: 200, all_in: false}, {type: 'call', seat: 1, amount: 100, all_in: false}, {type: 'fold', seat: 2},
      {type: 'board', street: 'flop', cards: ['Ah', '7c', '2d']},
    ];
    const one = view(1, [...pre, {type: 'bet', seat: 1, to: 400, all_in: false}, {type: 'fold', seat: 0}, {type: 'award', seat: 1, pot: 0, amount: 1000}], [
      {name: 'Ann', stack: 9800, net: -200, won: 0, folded: true, cards: ['As', 'Kd']},
      {name: 'Bob', stack: 10400, net: 400, won: 1000, folded: false, cards: null},
      {name: 'Cy', stack: 9800, net: -200, won: 0, folded: true, cards: null},
    ], ['Ah', '7c', '2d'], false);
    const two = view(2, [...pre,
      {type: 'check', seat: 1}, {type: 'check', seat: 0}, {type: 'board', street: 'turn', cards: ['Ks']},
      {type: 'check', seat: 1}, {type: 'check', seat: 0}, {type: 'board', street: 'river', cards: ['3h']},
      {type: 'check', seat: 1}, {type: 'check', seat: 0}, {type: 'award', seat: 0, pot: 0, amount: 600},
    ], [
      {name: 'Ann', stack: 10400, net: 400, won: 600, folded: false, cards: ['As', 'Kd']},
      {name: 'Bob', stack: 9800, net: -200, won: 0, folded: false, cards: ['Qs', 'Qd']},
      {name: 'Cy', stack: 9800, net: -200, won: 0, folded: true, cards: null},
    ], ['Ah', '7c', '2d', 'Ks', '3h'], true);
    const now = Date.now();
    for (const [i, v] of [one, two].entries()) {
      await saveHand(handRecord({club: code, table: 't-main', tableName: 'Main 1/2', game: 'nlhe', view: v, who: me.id}, now - 60_000 + i * 30_000));
    }
  });
}

test('a member replays their hands, steps by keys, and takes a spot to the equity calculator (#592)', async ({page, watch, browserName}, info) => {
  await watch(page).goto('/manage.html#clubs');
  await page.locator('[data-cl="demo"]').click();
  // A small demo club, quick to set up.
  await page.locator('[data-demo-start="credit"]').click();
  await expect(page.locator('.mg-side')).toBeAttached();
  // Player 1, a member.
  await page.locator('.demo-who summary').click();
  await page.locator('[data-demo-as="p1"]').click();
  await expect(page.locator('[data-cl="mtab"][data-tab="history"]')).toBeVisible();
  await seedHands(page);
  await page.locator('[data-cl="mtab"][data-tab="history"]').click();
  await page.locator('[data-cl="hands"]').click();
  const replays = page.locator('[data-cl="replay"]');
  await expect(replays).toHaveCount(2);
  // The newest: hand 2.
  await replays.first().click();
  const dialog = page.getByRole('dialog', {name: 'Hand replay'});
  await expect(dialog.getByText('Main 1/2 · hand 2')).toBeVisible();
  await expect(dialog.getByText('2/2')).toBeVisible();
  await expect(dialog.getByRole('button', {name: 'Next hand ›'})).toBeDisabled();
  // → steps; Bob's queens show only at the end.
  await page.keyboard.press('ArrowRight');
  await expect(dialog.locator('.cl-replay-controls .pl-meta')).toHaveText(/^2\//);
  await expect(dialog.getByText('Q♠')).toHaveCount(0);
  await dialog.getByRole('button', {name: 'River'}).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByText('Q♠')).toBeVisible();
  await fitsTheScreen(page);
  if (browserName === 'chromium') await page.screenshot({path: info.outputPath('replayer.png')});
  // Copy hand: on the clipboard, or shown to copy by hand.
  await dialog.getByRole('button', {name: 'Copy hand'}).click();
  await expect(dialog.getByRole('button', {name: 'Copied ✓'}).or(dialog.getByLabel('Hand text'))).toBeVisible();
  if (await dialog.getByLabel('Hand text').count()) await expect(dialog.getByLabel('Hand text')).toHaveValue(/Dealt to Ann \[As Kd\]/);
  // The previous hand, by its button; Shift+→ comes back, and Shift+← goes again.
  await dialog.getByRole('button', {name: '‹ Previous hand'}).click();
  await expect(dialog.getByText('Main 1/2 · hand 1')).toBeVisible();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(dialog.getByText('Main 1/2 · hand 2')).toBeVisible();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(dialog.getByText('Main 1/2 · hand 1')).toBeVisible();
  // On the flop of hand 1, before Ann folds: Equity has the board, her
  // cards, and Bob random (Cy folded: left out).
  await dialog.getByRole('button', {name: 'Flop', exact: true}).click();
  const equity = dialog.getByRole('link', {name: 'Equity'});
  await expect(equity).toHaveAttribute('href', '#g=nlhe&p0=As.Kd&p1=random&b=Ah.7c.2d');
  await equity.click();
  // The calculator works it out, with Bob as any hand.
  await expect(page).toHaveURL(/#g=nlhe&p0=As\.Kd&p1=r:.*&b=Ah\.7c\.2d$/);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#timer')).toHaveText(/\d/);
  await expect(page.locator('#timer')).not.toHaveText(/Error|No valid/);
  if (browserName === 'chromium') await page.screenshot({path: info.outputPath('equity.png')});
  await fitsTheScreen(page);
  // Back: the replay is where it was.
  await page.goBack();
  await expect(page.getByRole('dialog', {name: 'Hand replay'}).getByText('Main 1/2 · hand 1')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', {name: 'Hand replay'})).toHaveCount(0);
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

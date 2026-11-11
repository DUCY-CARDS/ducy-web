// What the beta offers, in real browsers (#553): the front page, bots, and
// clubs. Every test fails on an uncaught error, on anything
// logged as an error, and on a page wider than the screen.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { RELAY_PORT } from './playwright.config.js';
import { grantAdmin, grantLink } from './grant.mjs';

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

test('the front page offers a club code, clubs and the Regulars, and nothing else', async ({page, watch}) => {
  await watch(page).goto('/');
  await expect(page.getByRole('heading', {name: 'Pull up a chair.'})).toBeVisible();
  await expect(page.getByLabel('Club code')).toBeVisible();
  await expect(page.getByRole('link', {name: 'Play the Regulars'})).toBeVisible();
  await expect(page.locator('form[data-v3join] button[type=submit]')).toBeVisible();
  // No Start a game (#635, #643).
  await expect(page.getByText('Start a game')).toHaveCount(0);
  await expect(page.locator('a[href="#host"]')).toHaveCount(0);
  // No clubs yet: no clubs tile, and no page of them (#611).
  await expect(page.getByText(/Private clubs|Start a club|Create your own club/)).toHaveCount(0);
  await expect(page.getByText(/play money|Still in development/i)).toHaveCount(0);
  await expect(page.getByRole('link', {name: /Study|Quest|Heads-up challenge|Omaha 6/})).toHaveCount(0);
  await expect(page.getByText('Ducybot')).toHaveCount(0);
  await fitsTheScreen(page);
});

test('#host is gone: no Start a game page, even with ?on=startGame (#643)', async ({page, watch}) => {
  watch(page);
  for (const width of [1280, 375]) {
    await page.setViewportSize({width, height: 800});
    await page.goto(`/?relay=${RELAY}&on=startGame#host`);
    await expect(page.locator('#pl-name, .sg-code, [data-act="host"]')).toHaveCount(0);
    await expect(page.getByText(/Start a (private )?game/)).toHaveCount(0);
    await fitsTheScreen(page);
  }
});

test('an old friends-table link opens no table (#643)', async ({page, watch}) => {
  await watch(page).goto(`/?table=ABCD-EFGH&relay=${RELAY}#join`);
  await expect(page.getByRole('heading', {name: 'Join a game'})).toBeVisible();
  await expect(page.locator('form[data-joinform]')).toHaveCount(0);
  await expect(page.locator('.pl-felt')).toHaveCount(0);
  await fitsTheScreen(page);
});

test('a code with no club behind it says so on the front page (#566, #643)', async ({page, watch}) => {
  await watch(page).goto(`/?relay=${RELAY}`);
  await page.getByLabel('Club code').fill('ZZZZ-ZZZZ');
  await page.locator('form[data-v3join] button[type=submit]').click();
  await expect(page.getByText('No club with that code.')).toBeVisible();
});

test('with no clubs, the front page takes a club code, and #clubs is the front page (#564, #611)', async ({page, watch}) => {
  await watch(page).goto('/#clubs');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', {name: 'Pull up a chair.'})).toBeVisible();
  await page.getByLabel('Club code').fill('not a code');
  await page.locator('form[data-v3join] button[type=submit]').click();
  await expect(page.getByText('That isn’t a code or a link.', {exact: false})).toBeVisible();
  await fitsTheScreen(page);
});

// Clubs in this browser (as storage keeps them), before the page loads.
const withClubs = (page, clubs) => page.addInitScript(c => { if (!sessionStorage.seeded) { localStorage.setItem('ducyClubs', JSON.stringify(c)); sessionStorage.seeded = '1'; } }, clubs);
const OWLS = {code: 'ABCD-EFGH', name: 'Night Owls', status: 'member', hostId: 'x', balance: 0};
const SUNDAY = {code: 'JKMN-PQRS', name: 'Sunday Game', status: 'member', hostId: 'y', balance: 0};

test('one club: the front page opens it, under Play (#611)', async ({page, watch}) => {
  await withClubs(page, [OWLS]);
  await watch(page).goto(`/?relay=${RELAY}`);
  await expect(page.getByText(/Private clubs/)).toHaveCount(0);
  await fitsTheScreen(page);
  await page.getByRole('link', {name: /Night Owls/}).click();
  await expect(page).toHaveURL(/#clubs\/c\/ABCD-EFGH$/);
  await expect(page.locator('#sub-tabs .v3-crumbs')).toHaveText(/^Play\s*›\s*Night Owls$/);
});

test('several clubs: the front page lists them, and #clubs goes there (#611)', async ({page, watch}) => {
  await withClubs(page, [OWLS, SUNDAY]);
  await watch(page).goto(`/?relay=${RELAY}#clubs`);
  await expect(page.getByRole('heading', {name: 'Pull up a chair.'})).toBeVisible();
  await expect(page.locator('.v3-clubs a')).toHaveText([/Night Owls/, /Sunday Game/]);
  await fitsTheScreen(page);
  await page.locator('.v3-clubs a', {hasText: 'Sunday Game'}).click();
  await expect(page).toHaveURL(/#clubs\/c\/JKMN-PQRS$/);
});

test('the club manager offers no way to start a club, and no demo club (#611, #636)', async ({page, watch}) => {
  watch(page);
  for (const hash of ['#clubs', '#clubs/new', '#clubs/start/not-a-token']) {
    await page.goto(`/manage.html${hash}`);
    await expect(page.locator('.pl-head h1')).toHaveText('Club manager');
    await expect(page.locator('[data-cl="demo"]')).toHaveCount(0);
    await expect(page.getByText(/Start a club|Create your own club|Try a demo club/)).toHaveCount(0);
    await expect(page.locator('#cl-clubname')).toHaveCount(0);
    await fitsTheScreen(page);
  }
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

// The seat stats and the stats table, and their switches in the ⋯ menu (#625).
const statsShownOn = async page => {
  await page.locator('.pl-menu summary').click();
  const items = await page.locator('.pl-menu-item', {hasText: /^Stats (on seats|table)/}).count();
  await page.locator('.pl-menu summary').click();
  return {hud: await page.locator('.pl-hud').count(), table: await page.locator('.pl-stats').count(), items};
};
// A screenshot in Chromium only: WebKit's CSP refuses the style a screenshot adds.
const shotIn = (browserName, info) => (target, name) => (browserName === 'chromium' ? target.screenshot({path: info.outputPath(name), fullPage: true}) : null);

test('the Regulars’ table keeps its stats on the seats and its stats table (#625)', async ({page, watch, browserName}, info) => {
  await watch(page).goto('/#practice');
  await page.locator('[data-act="sitregulars"]').click();
  await playOutAHand(page);
  await expect(page.locator('.pl-hud').first()).toBeVisible();
  // Shown at once on a desktop; on a phone, from the menu.
  await page.locator('.pl-menu summary').click();
  await expect(page.locator('.pl-menu-item', {hasText: 'Stats on seats'})).toBeVisible();
  if (!(await page.locator('.pl-stats').count())) await page.locator('.pl-menu-item', {hasText: 'Stats table'}).click();
  else await page.locator('.pl-menu summary').click();
  await expect(page.locator('.pl-stats-table')).toBeVisible();
  await shotIn(browserName, info)(page, 'stats-regulars.png');
  await fitsTheScreen(page);
});

test('the heads-up challenge deals a hand, with no review', async ({page, watch}) => {
  await watch(page).goto('/#ladder');
  await page.locator('[data-act="ladder-play"]').click();
  await playOutAHand(page);
  await expect(page.getByText('Loading the hand review')).toHaveCount(0);
  await fitsTheScreen(page);
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

// A first passkey from You (#646): no unlock, since there's none to unlock
// with; it then lists as this one.
test('a first passkey is added from You', async ({page, watch, browserName}, info) => {
  needsPasskeys(browserName);
  const auth = await authenticator(page);
  await watch(page).goto(`/?relay=${RELAY}`);
  await page.evaluate(async () => (await import('/src/player-settings.js')).openPlayerSettings());
  const add = page.locator('[data-ps="pk-first"]');
  await expect(add).toBeVisible();
  await expect(page.locator('[data-ps="pk-recover"]')).toBeVisible();
  await add.click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  await expect(page.locator('.ps-keys li')).toHaveCount(1);
  await expect(page.locator('.ps-keys')).toContainText('(this one)');
  await expect(page.locator('[data-ps="pk-first"], [data-ps="pk-recover"]')).toHaveCount(0);
  expect(await auth.credentials()).toHaveLength(1);
  await shotIn(browserName, info)(page.locator('.ps'), 'first-passkey.png');
  await fitsTheScreen(page);
  // Opened again: enrolled, so Unlock or the list, never a first Add.
  await page.evaluate(async () => (await import('/src/player-settings.js')).openPlayerSettings());
  await expect(page.locator('[data-ps="pk-add"], [data-ps="pk-show"]')).toHaveCount(1);
  await expect(page.locator('[data-ps="pk-first"]')).toHaveCount(0);
});

// Asking to join (#621): a name and who you are.
async function askToJoin(page, name, intro = `${name}, a friend of the owner`) {
  await page.locator('form[data-joinform] input[name="name"]').fill(name);
  await page.locator('form[data-joinform] textarea[name="intro"]').fill(intro);
  await page.locator('form[data-joinform] button[type="submit"]').click();
}
// Letting the first one asking in, from Requests (#621): as a Cash player,
// or a Credit one with `credit`.
async function letIn(owner, credit = 0) {
  await owner.evaluate(() => { location.hash = 'clubs/requests'; });
  await owner.locator('.cl-needs [data-cl="approve"]').first().click();
  const form = owner.locator('.cl-needs form[data-letin]');
  if (credit) {
    await form.locator('input[value="credit"]').check();
    await form.locator('[name=credit]').fill(String(credit));
  }
  await form.locator('button[type=submit]').click();
  await expect(form).toHaveCount(0);
}

test('a grant link that isn’t this player’s is refused, and says who to give ducy (#636)', async ({page, watch, browserName}, info) => {
  needsPasskeys(browserName);
  await authenticator(page);
  // Someone else's link, or a made-up one: the relay has no grant for this player.
  await watch(page).goto(`/manage.html?relay=${RELAY}#clubs/start/${'A'.repeat(43)}`);
  await expect(page.locator('.cl-act-title')).toHaveText('Start a club');
  await page.locator('#cl-clubname').fill('Night Owls');
  await page.locator('[data-cl="create"]').click();
  // Clubs need a passkey first (#575).
  await page.locator('[data-cl="pass-enrol"]').click();
  await expect(page.getByText(/isn’t for this player ID, or it was used or taken back/)).toBeVisible();
  await expect(page.locator('code.cl-id')).toBeVisible();
  await fitsTheScreen(page);
  await page.screenshot({path: info.outputPath('refused.png'), fullPage: true});
});

// A relay of its own with a test admin, who grants each owner their club
// (#636, grant.mjs), for a whole club flow; one per worker, so the browsers'
// runs don't share it. Its clock moves on when a test says (RELAY_TEST_CLOCK, #599).
async function trialRelay(port, admin) {
  const relay = spawn(process.execPath, ['relay/dev-server.mjs', String(port)], {cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore', env: {...process.env, ADMINS_FILE: admin.file, RELAY_TEST_CLOCK: '1'}});
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://localhost:${port}/code/ZZZZ-ZZZZ`).then(() => true, () => false)) return relay;
    await new Promise(r => setTimeout(r, 100));
  }
  relay.kill();
  throw new Error('the trial relay didn’t start');
}

test.describe('a club member', () => {
  let relay, url, admin;
  test.beforeAll(async ({}, info) => {
    const port = RELAY_PORT + 10 + info.parallelIndex;
    admin = await grantAdmin();
    relay = await trialRelay(port, admin);
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
    await owner.goto(await grantLink(owner, url, admin));
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
    await askToJoin(ava, 'Ava');
    // Clubs need a passkey (#575): her request goes once she has one.
    await expect(ava.getByText('Set up a passkey')).toBeVisible();
    await fitsTheScreen(ava);
    if (info) await ava.screenshot({path: info.outputPath('enrol.png'), fullPage: true});
    await ava.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-done"]').click();
    await letIn(owner);
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
    // A page with the gear (the front page has none).
    await again.goto(`/?relay=${url}#join`);
    await again.locator('[data-pt=player]').first().click();
    // Once its player ID has loaded: the dialog draws again then.
    await expect(again.locator('#pset .pl-pid')).not.toHaveText('…');
    // And once the relay has said this new ID has no passkey (#646): that
    // redraws the dialog, which would drop a file being chosen.
    await expect(again.locator('#pset [data-ps="pk-first"]')).toBeVisible();
    await again.locator('#pset input[data-ps="file"]').setInputFiles(file);
    await again.locator('#pset [name=pw]').fill(pw);
    await again.locator('#pset [data-psform="restore"] button[type="submit"]').click();
    await again.waitForEvent('load');
    // Settled after the reload, so leaving doesn't cut a download short.
    await expect(again.getByRole('heading', {name: 'Join a game'})).toBeVisible();
    await again.waitForLoadState('networkidle');
    await again.goto(invite);
    await askToJoin(again, 'Ava');
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
    await ava.goto(`/?relay=${url}#join`);
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
    await nova.goto(`/?relay=${url}#join`);
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
    // Three members and an owner, and hands to play: longer than most.
    test.setTimeout(240_000);
    // The owner starts a club with a table open.
    const {page: owner} = await browserWith(browser, watch);
    await owner.goto(await grantLink(owner, url, admin));
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
      // In Austin's time zone: a clock that doesn't fit the place is a sign of a faked location.
      const context = await browser.newContext({timezoneId: 'America/Chicago', ...(geo ? {permissions: ['geolocation'], geolocation: geo} : {})});
      const page = watch(await context.newPage());
      await authenticator(page);
      await page.goto(invite);
      await askToJoin(page, name);
      await page.locator('[data-cl="pass-enrol"]').click();
      await owner.evaluate(() => { location.hash = 'clubs/requests'; });
      await expect(owner.locator('.cl-needs [data-cl="approve"]')).toHaveCount(1);
      await letIn(owner);
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

    // Each seat's icons, as each of them sees the table. Cy sees Ava and Bo
    // as group A; Ava and Bo, who are in it, never see it. Cy's red flag
    // (location not shared) shows to everyone, Cy included.
    const seatOf = (page, name) => page.locator('.pl-seat', {has: page.locator('.pl-plate b', {hasText: name})});
    const badge = (page, name) => seatOf(page, name).locator('.pl-mark.l');
    const flag = (page, name) => seatOf(page, name).locator('.pl-mark.r.red');
    await expect(badge(cy, 'Ava')).toHaveText('A');
    await expect(badge(cy, 'Bo')).toHaveText('A');
    for (const page of [ava, bo, cy]) await expect(flag(page, 'Cy')).toBeVisible();
    for (const page of [ava, bo]) await expect(page.locator('.pl-mark.l')).toHaveCount(0);
    await expect(cy.locator('.pl-mark.r')).toHaveCount(1);
    // Tapped: what it means, in words; never a place.
    await badge(cy, 'Ava').click();
    await expect(cy.locator('.pl-fpop')).toHaveText('Within 100 m of Bo');
    await fitsTheScreen(cy);
    await cy.screenshot({path: info.outputPath('seat-icons-cy.png'), fullPage: true});
    await flag(ava, 'Cy').click();
    await expect(ava.locator('.pl-fpop')).toHaveText('Location not shared');
    await ava.screenshot({path: info.outputPath('seat-icons-ava.png'), fullPage: true});
    // Any other tap closes it.
    await ava.locator('.pl-meta', {hasText: /· hand \d+ ·/}).first().click();
    await expect(ava.locator('.pl-fpop')).toHaveCount(0);
    for (const page of [ava, cy]) expect(await page.locator('body').innerText()).not.toMatch(/30\.26|97\.74/);

    // A hand with all three played out: the owner's hands show who was flagged.
    const handNo = async () => Number((await cy.locator('.pl-meta', {hasText: /· hand \d+ ·/}).first().innerText().catch(() => '')).match(/hand (\d+)/)?.[1] || 0);
    const start = await handNo();
    await playUntil(async () => (await handNo()) > start);
    // No player stats at a club table, and none kept (#625).
    for (const page of players) {
      expect(await statsShownOn(page)).toEqual({hud: 0, table: 0, items: 0});
      expect(await page.evaluate(() => localStorage.getItem('ducyPlayStats'))).toBeNull();
    }
    await ava.screenshot({path: info.outputPath('stats-club.png'), fullPage: true});
    await owner.evaluate(() => { location.hash = 'clubs/history'; });
    await owner.locator('[data-cl="hands"]').first().click();
    const flagged = owner.locator('.cl-handflags', {hasText: 'Cy'}).first();
    await expect(flagged).toContainText(/(Ava and Bo|Bo and Ava): within 100 m/);
    await expect(flagged).toContainText('Cy: location not shared');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('owner-hand-flags.png'), fullPage: true});
  });

  test('a raked table: members see the rake before they sit, the hand log and replay show it, and the owner sees what each paid (#449)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    test.setTimeout(180_000);
    // The owner opens a 0.25/0.50 table taking 10%, capped at a big blind.
    const {page: owner} = await browserWith(browser, watch);
    await owner.goto(await grantLink(owner, url, admin));
    await owner.locator('#cl-clubname').fill('Night Owls');
    await owner.locator('[data-cl="create"]').click();
    await owner.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-skip"]').click();
    await owner.locator('[data-cl="wiz-onward"]').click();
    const form = owner.locator('form[data-tableform]');
    await expect(form).toBeVisible();
    // The new club's first messages redraw the page: let them land first.
    await owner.waitForTimeout(1500);
    await form.locator('input[name=blinds][value=other]').check({force: true});
    await form.locator('[name=blindsOther]').selectOption('25/50');
    await form.locator('.tf-more summary').click();
    // Off in the beta until club-beta.js turns it on.
    test.skip(!(await form.locator('[name=house]').count()), 'rake is off in the beta');
    await expect(form.locator('[name=rakePct]')).toBeHidden();
    // None by default; a typed percentage and a cap in big blinds.
    await expect(form.locator('[name=house]')).toHaveValue('none');
    await form.locator('[name=house]').selectOption('rake');
    await form.locator('[name=rakePct]').fill('12');
    await form.locator('button[type="submit"]').click();
    await expect(form.getByText('Rake is more than 0% and at most 10%.')).toBeVisible();
    await form.locator('[name=rakePct]').fill('10');
    await form.locator('[name=rakeCap]').fill('1');
    await expect(form.locator('[name=timeBB]')).toBeHidden();
    await expect(form.locator('input[name=blinds][value=other]')).toBeChecked();
    await expect(form.locator('[name=house]')).toHaveValue('rake');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('rake-form.png'), fullPage: true});
    await form.locator('button[type="submit"]').click();
    const invite = await owner.locator('#cl-link').inputValue();
    const code = new URL(invite).searchParams.get('club');
    await owner.locator('[data-cl="wiz-done"]').click();

    // Ava and Bo join, see the rake on the table, and sit.
    const join = async name => {
      const {page} = await browserWith(browser, watch);
      await page.goto(invite);
      await page.locator('form[data-joinform] input[name="name"]').fill(name);
      await page.locator('form[data-joinform] button[type="submit"]').click();
      await page.locator('[data-cl="pass-enrol"]').click();
      await owner.evaluate(() => { location.hash = 'clubs/requests'; });
      await owner.locator('[data-cl="approve"]').first().click();
      await page.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);
      await expect(page.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
      await page.locator(`[data-ask-amt="${code}"]`).fill('50');
      await page.locator('[data-cl="ask"]').click();
      await owner.evaluate(() => { location.hash = 'clubs/requests'; });
      await owner.locator('[data-cl="grant"]').first().click();
      await expect(page.getByText('Balance 50')).toBeVisible();
      await expect(page.locator('.cl-charge').first()).toHaveText('Rake 10% · cap 1 BB');
      await fitsTheScreen(page);
      await page.locator('[data-cl="sit-open"]').first().click();
      await page.locator('form[data-sitform] button[type="submit"]').click();
      await expect(page.locator('.pl-felt')).toBeVisible();
      return page;
    };
    const ava = await join('Ava');
    const bo = await join('Bo');
    // Both check and call to the river: a 1.00 pot, 0.10 of it the club's.
    const players = [ava, bo];
    const log = ava.locator('#pl-log');
    for (let i = 0; i < 240 && !(await log.getByText('Rake 0.10').count()); i++) {
      for (const p of players) {
        const act = p.locator('[data-act="check"], [data-act="call"]').first();
        if (await act.isVisible()) await act.click().catch(() => {});
      }
      await ava.waitForTimeout(250);
    }
    await expect(log.getByText('Rake 0.10')).toBeVisible();
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('rake-log.png'), fullPage: true});

    // The owner: each player's share on Chips, and the rake in the replay.
    await owner.evaluate(() => { location.hash = 'clubs/chips'; });
    const rake = owner.locator('.cl-rake');
    await expect(rake.getByRole('heading', {name: 'Rake and time'})).toBeVisible();
    await expect(rake.locator('tr', {hasText: 'Ava'})).toContainText('0.05');
    await expect(rake.locator('tr', {hasText: 'Bo'})).toContainText('0.05');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('rake-owner.png'), fullPage: true});
    await owner.evaluate(() => { location.hash = 'clubs/history'; });
    await owner.locator('[data-cl="hands"]').first().click();
    await owner.locator('[data-cl="replay"]').last().click();
    const dialog = owner.getByRole('dialog', {name: 'Hand replay'});
    for (let i = 0; i < 40 && !(await dialog.getByText('Rake 0.10').count()); i++) await owner.keyboard.press('ArrowRight');
    await expect(dialog.getByText('Rake 0.10')).toBeVisible();
    await fitsTheScreen(owner);
    await owner.keyboard.press('Escape');

    // The club's default on Rules: none, then 5% capped at 3 BB; time is
    // 0.05 to 0.25 BB. A new table starts from it.
    await owner.evaluate(() => { location.hash = 'clubs/rules'; });
    const rules = owner.locator('form[data-chargeform]');
    await expect(rules.locator('.cl-charge')).toHaveText('No rake');
    await rules.locator('[name=house]').selectOption('time');
    await rules.locator('[name=timeBB]').fill('1');
    await rules.locator('button[type="submit"]').click();
    await expect(rules.getByText(/0\.05 to 0\.25 of a big blind/)).toBeVisible();
    await rules.locator('[name=house]').selectOption('rake');
    await rules.locator('[name=rakePct]').fill('5');
    await rules.locator('[name=rakeCap]').fill('3');
    await rules.locator('button[type="submit"]').click();
    await expect(owner.locator('form[data-chargeform] .cl-charge')).toHaveText('Rake 5% · cap 3 BB');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('rake-rules.png'), fullPage: true});
    await owner.evaluate(() => { location.hash = 'clubs/cash'; });
    await owner.locator('[data-cl="new-table"]').click();
    const next = owner.locator('form[data-tableform]');
    await next.locator('.tf-more summary').click();
    await expect(next.locator('[name=house]')).toHaveValue('rake');
    await expect(next.locator('[name=rakePct]')).toHaveValue('5');
    await expect(next.locator('[name=rakeCap]')).toHaveValue('3');
    // The open table's terms on the owner's game page.
    await owner.locator('[data-cl="cancel-table"]').click();
    await owner.locator('[data-cl="game-open"]').first().click();
    await expect(owner.locator('.cl-tcard .cl-charge').first()).toHaveText('Rake 10% · cap 1 BB');
    await fitsTheScreen(owner);
  });

  test('the owner gives from a float and refills it; Ava keeps chips in her vault (#589, #579)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, ava, code} = await clubWithAva(browser, watch);
    // A new club's float, on Rules: full.
    await owner.evaluate(() => { location.hash = 'clubs/rules'; });
    await expect(owner.locator('.cl-float-now')).toHaveText('2,000 of 2,000');
    // Giving Ava 1,500 from it.
    await owner.evaluate(() => { location.hash = 'clubs/members'; });
    await owner.locator('.mg-members a', {hasText: 'Ava'}).click();
    await owner.locator('[data-cl="give"]').click();
    await expect(owner.locator('.cl-float-left')).toHaveText('Float 2,000');
    await owner.locator('#cl-amt').fill('1500');
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(ava.getByText('Balance 1,500')).toBeVisible();
    // The first refill of the day goes ahead; the next one would wait.
    await owner.evaluate(() => { location.hash = 'clubs/rules'; });
    await expect(owner.locator('.cl-float-now')).toHaveText('500 of 2,000');
    await owner.locator('[data-cl="refill"]').click();
    await expect(owner.locator('.cl-float-now')).toHaveText('2,000 of 2,000');
    await owner.evaluate(() => { location.hash = 'clubs/members'; });
    await owner.locator('.mg-members a', {hasText: 'Ava'}).click();
    await owner.locator('[data-cl="give"]').click();
    await owner.locator('#cl-amt').fill('100');
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(ava.getByText('Balance 1,600')).toBeVisible();
    await owner.evaluate(() => { location.hash = 'clubs/rules'; });
    await owner.getByRole('button', {name: 'Refill in 24 h'}).click();
    await expect(owner.locator('.cl-float-note').getByText(/Refill waiting until/)).toBeVisible();
    // This device can't approve it: it takes another device's passkey.
    await owner.locator('.cl-float-note [data-cl="refill-approve"]').click();
    await expect(owner.getByText(/another of your devices/)).toBeVisible();
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('float.png'), fullPage: true});
    // The owner hears of it, with Cancel.
    await owner.evaluate(() => { location.hash = 'clubs/overview'; });
    await expect(owner.locator('.mg-note', {hasText: 'Refill of 100 waiting'}).first()).toBeVisible();
    await owner.locator('.mg-note', {hasText: 'Refill of 100 waiting'}).first().locator('[data-cl="refill-cancel"]').click();
    await expect(owner.locator('.mg-note', {hasText: 'Refill of 100 waiting'})).toHaveCount(0);

    // Ava puts 1,000 in her vault, and asks to take 400 out: it waits.
    await ava.locator(`[data-cl="mtab"][data-tab="chips"]`).click();
    const vault = ava.locator('.cl-vault');
    await vault.locator('form[data-vaultform="in"] input').fill('1000');
    await vault.locator('form[data-vaultform="in"] button').click();
    await expect(vault.locator('.cl-vault-chips')).toHaveText('1,000');
    await expect(ava.getByText('Balance 600')).toBeVisible();
    await vault.locator('form[data-vaultform="out"] input').fill('400');
    await vault.locator('form[data-vaultform="out"] button').click();
    await expect(vault.locator('.cl-vault-out')).toHaveCount(1);
    await expect(vault.locator('.cl-vault-out')).toContainText('400');
    await vault.locator('[data-cl="vault-wait"][data-wait="604800000"]').click();
    await expect(vault.locator('[data-cl="vault-wait"][data-wait="604800000"]')).toHaveAttribute('aria-pressed', 'true');
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('vault.png'), fullPage: true});
    await vault.locator('[data-cl="vault-cancel"]').click();
    await expect(vault.locator('.cl-vault-out')).toHaveCount(0);
    // The owner sees her vault, not what she asked to take out.
    await owner.evaluate(() => { location.hash = 'clubs/members'; });
    await owner.locator('.mg-members a', {hasText: 'Ava'}).click();
    await expect(owner.locator('.mg-stat', {hasText: 'Vault'})).toContainText('1,000');
    expect(code).toBeTruthy();
  });

  test('signs up for a scheduled game, checks in when check-in opens, and is seated at the start (#599)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, ava} = await clubWithAva(browser, watch);
    const http = url.replace('ws:', 'http:');
    // The relay's clock, moved on by `ahead`; the pages' clocks with it.
    const clock = async (ms = 0) => (await (await fetch(`${http}/test/clock?ahead=${ms}`, {method: 'POST'})).json()).now;
    for (const p of [owner, ava]) await p.clock.install({time: await clock()});
    const ahead = async ms => {
      const now = await clock(ms);
      for (const p of [owner, ava]) await p.clock.setSystemTime(now);
    };

    // The owner offers Hold'em, then schedules it for two hours on, in
    // their own time zone, check-in an hour before.
    await owner.evaluate(() => { location.hash = 'clubs/cash'; });
    await owner.locator('[data-cl="offer-game"]').click();
    await owner.locator('form[data-tableform] button[type="submit"]').click();
    await owner.locator('[data-cl="sched-new"]').click();
    const form = owner.locator('form[data-schedform]');
    const at = await owner.evaluate(t => { const d = new Date(Math.ceil(t / 60e3) * 60e3); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }, (await clock()) + 2 * 3600e3);
    await form.locator('[name=at]').fill(at);
    await form.locator('[name=players]').fill('6');
    await fitsTheScreen(owner);
    await form.locator('button[type="submit"]').click();
    await expect(form).toHaveCount(0);
    const row = owner.locator('.cl-sched-list > li').first();
    await expect(row.locator('.pl-meta').first()).toHaveText(/^\w{3} \d{1,2}:\d{2} [AP]M \w+/);

    // Ava sees it under Upcoming, in her own time, and signs up.
    const up = ava.locator('.cl-sched li').first();
    await expect(up.locator('.cl-when')).toHaveText(/^\w{3} \d{1,2}:\d{2} [AP]M \w+/);
    await up.getByRole('button', {name: 'Sign up'}).click();
    await expect(up.getByText(/You’re in · Check-in in/)).toBeVisible();
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('upcoming.png'), fullPage: true});

    // An hour and a minute on: check-in opens, and she checks in.
    await ahead(61 * 60e3);
    await up.getByRole('button', {name: 'Check in'}).click();
    await expect(up.getByText(/Checked in/)).toBeVisible();
    await expect(row.getByText('Checked in')).toBeVisible();

    // The start, with one of the two it needs checked in: the owner is
    // asked, and starts it short. Ava's seat is hers to buy in to.
    await ahead(60 * 60e3);
    await expect(row.getByText(/Too few checked in/)).toBeVisible();
    await row.getByRole('button', {name: 'Start short'}).click();
    await expect(row.getByText(/Started/)).toBeVisible();
    await expect(ava.locator('form[data-sitform]')).toBeVisible();
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('seated.png'), fullPage: true});
  });
});

// Joining a club (#621): a passkey, a request with who you are, messages
// both ways while pending, let in as Cash or Credit, then chips or credit
// before sitting.
test.describe('joining a club', () => {
  let relay, url, admin;
  test.beforeAll(async ({}, info) => {
    const port = RELAY_PORT + 30 + info.parallelIndex;
    admin = await grantAdmin();
    relay = await trialRelay(port, admin);
    url = `ws://localhost:${port}`;
  });
  test.afterAll(() => relay?.kill());

  const browserWith = async (browser, watch) => {
    const page = watch(await (await browser.newContext()).newPage());
    await authenticator(page);
    return page;
  };
  // The owner starts a club with a table open; its invite link and code.
  async function ownerClub(browser, watch) {
    const owner = await browserWith(browser, watch);
    await owner.goto(await grantLink(owner, url, admin));
    await owner.locator('#cl-clubname').fill('Night Owls');
    await owner.locator('[data-cl="create"]').click();
    await owner.locator('[data-cl="pass-enrol"]').click();
    await owner.locator('[data-cl="wiz-skip"]').click();
    await owner.locator('[data-cl="wiz-onward"]').click();
    await owner.locator('form[data-tableform] button[type="submit"]').click();
    const invite = await owner.locator('#cl-link').inputValue();
    await owner.locator('[data-cl="wiz-done"]').click();
    return {owner, invite, code: new URL(invite).searchParams.get('club')};
  }
  // `who` asks to join with `link`, saying who they are, and makes a passkey.
  async function asks(browser, watch, link, name, intro) {
    const page = await browserWith(browser, watch);
    await page.goto(link);
    // No request without who you are.
    await page.locator('form[data-joinform] input[name="name"]').fill(name);
    await page.locator('form[data-joinform] button[type="submit"]').click();
    await expect(page.getByText('Set up a passkey')).toHaveCount(0);
    await page.locator('form[data-joinform] textarea[name="intro"]').fill(intro);
    await page.locator('form[data-joinform] button[type="submit"]').click();
    await page.locator('[data-cl="pass-enrol"]').click();
    await page.evaluate(() => { location.hash = 'join'; });
    await expect(page.getByText('Waiting for the manager to let you in')).toBeVisible();
    return page;
  }
  const shot = async (page, info, name) => { await fitsTheScreen(page); await page.screenshot({path: info.outputPath(name), fullPage: true}); };
  const say = async (page, form, text) => {
    await page.locator(`form[data-threadform="${form}"] [name=text]`).fill(text);
    await page.locator(`form[data-threadform="${form}"] button[type=submit]`).click();
  };
  const clubPage = (page, code) => page.evaluate(c => { location.hash = `clubs/c/${encodeURIComponent(c)}`; }, code);

  test('a new player asks with a message, gets a reply, is let in as Cash and given chips', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, invite, code} = await ownerClub(browser, watch);
    const gus = await asks(browser, watch, invite, 'Gus', 'Gus, Ann’s brother');
    // The owner sees who they are, in Needs you and on Requests, and replies.
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await expect(owner.locator('.cl-needs').getByText('Gus, Ann’s brother')).toBeVisible();
    const gusId = await owner.locator('[data-cl="approve"]').first().getAttribute('data-id');
    await say(owner, `o|${gusId}`, 'Welcome! Which Ann?');
    await shot(owner, info, 'owner-request.png');
    // Gus sees it while he waits, and answers.
    await expect(gus.getByText('Welcome! Which Ann?')).toBeVisible();
    await say(gus, `m|${code}`, 'Ann from Tuesdays');
    await shot(gus, info, 'pending-thread.png');
    await expect(owner.locator('.cl-needs').getByText('Ann from Tuesdays', {exact: true})).toBeVisible();
    // Let in as a Cash player: a member, with nothing to sit with.
    await letIn(owner);
    await clubPage(gus, code);
    await expect(gus.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect(gus.getByText('Balance 0')).toBeVisible();
    await expect(gus.locator('.cl-messages').getByText('Ann from Tuesdays')).toBeVisible();
    // New in the owner's Needs you until his first chips.
    await owner.evaluate(() => { location.hash = 'clubs/overview'; });
    await expect(owner.locator('.mg-note', {hasText: 'Gus'}).locator('.k-new').first()).toBeVisible();
    await shot(owner, info, 'owner-new.png');
    await owner.evaluate(id => { location.hash = `clubs/member/${id}`; }, gusId);
    await owner.locator('[data-cl="give"]').click();
    await owner.locator('#cl-amt').fill('200');
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(gus.getByText('Balance 200')).toBeVisible();
    await shot(gus, info, 'member-chips.png');
    await owner.evaluate(() => { location.hash = 'clubs/overview'; });
    await expect(owner.locator('.mg-note .k-new')).toHaveCount(0);
  });

  test('with Let everyone in on, a new player is in at once as Cash, New until the owner gives chips (#631)', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, invite, code} = await ownerClub(browser, watch);
    await owner.evaluate(() => { location.hash = 'clubs/rules'; });
    await owner.locator('[data-cl="let-all-in"][data-on="1"]').click();
    await expect(owner.locator('[data-cl="let-all-in"][data-on="1"]')).toHaveAttribute('aria-pressed', 'true');
    await shot(owner, info, 'rules-let-everyone-in.png');
    // Gus asks, makes his passkey, and lands on the club's page as a member.
    const gus = await browserWith(browser, watch);
    await gus.goto(invite);
    await askToJoin(gus, 'Gus', 'Gus, Ann’s brother');
    await gus.locator('[data-cl="pass-enrol"]').click();
    await expect(gus.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect(gus).toHaveURL(new RegExp(`#clubs/c/${code}$`));
    await expect(gus.getByText('Balance 0')).toBeVisible();
    await expect(gus.locator('.cl-messages').getByText('Gus, Ann’s brother')).toBeVisible();
    await shot(gus, info, 'let-in-at-once.png');
    // The owner: no request, Gus New with his message; a reply reaches him.
    await owner.evaluate(() => { location.hash = 'clubs/overview'; });
    const note = owner.locator('.mg-note', {hasText: 'Gus'}).first();
    await expect(note.locator('.k-new')).toBeVisible();
    await expect(note.getByText('Gus, Ann’s brother')).toBeVisible();
    await expect(owner.locator('.mg-note .k-join')).toHaveCount(0);
    await note.locator('[data-cl="note-open"]').click();
    await owner.locator(`.mg-note form[data-threadform] [name=text]`).first().fill('Welcome, Gus');
    await owner.locator(`.mg-note form[data-threadform] button[type=submit]`).first().click();
    await expect(gus.locator('.cl-messages').getByText('Welcome, Gus')).toBeVisible();
    await shot(owner, info, 'owner-new-at-once.png');
    // Chips are still the gate: given, he's no longer New.
    await note.getByRole('link', {name: 'Give chips'}).click();
    await owner.locator('[data-cl="give"]').click();
    await owner.locator('#cl-amt').fill('200');
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(gus.getByText('Balance 200')).toBeVisible();
    await owner.evaluate(() => { location.hash = 'clubs/overview'; });
    await expect(owner.locator('.mg-note .k-new')).toHaveCount(0);
  });

  test('a Credit player is let in with a credit line, and can sit with it', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, invite, code} = await ownerClub(browser, watch);
    const cy = await asks(browser, watch, invite, 'Cy', 'Cy from work');
    // Credit with no line isn't let in.
    await owner.evaluate(() => { location.hash = 'clubs/requests'; });
    await owner.locator('.cl-needs [data-cl="approve"]').first().click();
    await owner.locator('.cl-needs form[data-letin] input[value="credit"]').check();
    await owner.locator('.cl-needs form[data-letin] button[type=submit]').click();
    await expect(owner.getByText('Give a Credit player a credit line.')).toBeVisible();
    await owner.locator('.cl-needs form[data-letin] [name=credit]').fill('500');
    await shot(owner, info, 'let-in-credit.png');
    await owner.locator('.cl-needs form[data-letin] button[type=submit]').click();
    await clubPage(cy, code);
    await expect(cy.getByText('Credit limit 500')).toBeVisible();
    await cy.locator('[data-cl="sit-open"]').first().click();
    await expect(cy.locator('form[data-sitform] button[type="submit"]')).toBeEnabled();
    await shot(cy, info, 'credit-player.png');
  });

  test('through an agent’s link: the agent replies, lets them in and gives chips', async ({browser, watch, browserName}, info) => {
    needsPasskeys(browserName);
    const {owner, invite, code} = await ownerClub(browser, watch);
    // Ava joins, is given chips, and becomes an agent.
    const ava = await asks(browser, watch, invite, 'Ava', 'Ava, the owner’s sister');
    await letIn(owner);
    await clubPage(ava, code);
    await owner.evaluate(() => { location.hash = 'clubs/members'; });
    await owner.locator('.mg-members a', {hasText: 'Ava'}).click();
    await owner.locator('[data-cl="give"]').click();
    await owner.locator('#cl-amt').fill('1000');
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(ava.getByText('Balance 1,000')).toBeVisible();
    await owner.locator('summary[aria-label="More for Ava"]').click();
    await owner.locator('[data-cl="make-agent"]').click();
    await owner.locator('form[data-chipform="agent"] button[type=submit]').click();
    await ava.locator('[data-cl="agent-yes"]').click();
    await ava.locator('[data-cl="mtab"][data-tab="players"]').click();
    const link = await ava.locator(`[data-aglink="${code}"]`).inputValue();
    // Bo asks through Ava's link: the request is hers.
    const bo = await asks(browser, watch, link, 'Bo', 'Bo, Ava’s neighbour');
    const recruits = ava.locator('.cl-agent li', {hasText: 'Bo'});
    await expect(recruits.getByText('Bo, Ava’s neighbour')).toBeVisible();
    const boId = await recruits.locator('[data-cl="ag-approve"]').getAttribute('data-id');
    await say(ava, `a|${code}|${boId}`, 'Hi Bo!');
    await expect(bo.getByText('Hi Bo!')).toBeVisible();
    await shot(ava, info, 'agent-request.png');
    await recruits.locator('[data-cl="ag-approve"]').click();
    await ava.locator('form[data-letin] button[type=submit]').click();
    // Bo is her player, New until she gives him chips.
    const row = ava.locator('.cl-agent li', {hasText: 'Bo'});
    await expect(row.locator('.cl-new')).toBeVisible();
    await row.locator('[data-cl="ag-give"]').click();
    await ava.locator('#cl-gamt').fill('300');
    await ava.locator('form[data-agentform] button[type=submit]').click();
    await clubPage(bo, code);
    await expect(bo.getByText('Balance 300')).toBeVisible();
    await expect(row.locator('.cl-new')).toHaveCount(0);
    await shot(ava, info, 'agent-players.png');
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
  // Try a demo club is off for the beta (#636): its list, opened directly.
  await watch(page).goto('/manage.html#clubs');
  await page.evaluate(() => import('/src/demo.js').then(m => m.showDemoList()));
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
  await page.evaluate(() => import('/src/demo.js').then(m => m.showDemoList()));
  await page.locator('[data-demo-start="busy"]').click();
  // Starting one changes the address, then reloads: the manager shows after that.
  await expect(page.locator('.mg-side')).toBeAttached();
  for (const part of ['cash', 'tourneys', 'members', 'chips', 'history']) {
    await page.evaluate(p => { location.hash = `clubs/${p}`; }, part);
    await expect(page.locator('.mg-page')).toBeVisible();
    await fitsTheScreen(page);
  }
});

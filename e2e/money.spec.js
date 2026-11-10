// Credit, Balances (Settle) and tournament rake, back on for the beta (#623),
// in Chromium at desktop width and 375 px: the club tests need a passkey,
// and only Chromium has a virtual authenticator. Every test fails on an
// uncaught error, on anything logged as an error, and on a page wider than
// the screen.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { RELAY_PORT } from './playwright.config.js';

const EXPECTED = /Failed to load resource/;
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

async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', {enableUI: false});
  await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  }});
}

// A relay of its own that lets anyone start a trial club; one per worker.
// Ready once it says it's listening: a port another checkout's tests have
// taken fails here, rather than the test talking to their relay.
// E2E_RELAY_LOG: a path prefix to keep its errors at.
function trialRelay(port) {
  const log = process.env.E2E_RELAY_LOG ? openSync(`${process.env.E2E_RELAY_LOG}-${port}.log`, 'a') : 'ignore';
  const relay = spawn(process.execPath, ['relay/dev-server.mjs', String(port)], {cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', log], env: {...process.env, TRIALS: ''}});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { relay.kill(); reject(new Error('the trial relay didn’t start')); }, 15_000);
    let out = '';
    relay.stdout.on('data', d => {
      out += d;
      if (out.includes(`ws://localhost:${port}`)) { clearTimeout(timer); resolve(relay); }
    });
    relay.on('exit', () => { clearTimeout(timer); reject(new Error(`the trial relay on ${port} stopped`)); });
  });
}

// Chip amounts as the pages write them: "−1,234", "200".
const amount = String.raw`[−-]?[\d,]+(?:\.\d+)?`;
const num = t => Number(t.replace(/[−-]/, '-').replace(/,/g, ''));

test.describe('club money', () => {
  test.skip(({browserName}) => browserName !== 'chromium', 'only Chromium has a virtual passkey authenticator');
  test.setTimeout(240_000);
  let relay, url;
  test.beforeAll(async ({browserName}, info) => {
    if (browserName !== 'chromium') return;
    // Clear of play.spec.js's trial relays (+10 on).
    const port = RELAY_PORT + 70 + info.parallelIndex;
    relay = await trialRelay(port);
    url = `ws://localhost:${port}`;
  });
  test.afterAll(() => relay?.kill());

  const newPage = async (browser, watch) => {
    const page = watch(await (await browser.newContext()).newPage());
    await authenticator(page);
    return page;
  };
  const go = (page, hash) => page.evaluate(h => { location.hash = h; }, hash);

  // The owner starts a club with a table; returns the owner's page, the invite and the code.
  async function clubWithTable(browser, watch) {
    const owner = await newPage(browser, watch);
    await owner.goto(`/manage.html?relay=${url}#clubs/new`);
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

  // `name` asks to join by `link`, saying who they are (#621), makes a
  // passkey, and `approve` lets them in; their club page opens.
  async function join(browser, watch, link, code, name, approve) {
    const page = await newPage(browser, watch);
    await page.goto(link);
    await page.locator('form[data-joinform] input[name="name"]').fill(name);
    await page.locator('form[data-joinform] textarea[name="intro"]').fill(`${name}, a friend`);
    await page.locator('form[data-joinform] button[type="submit"]').click();
    await page.locator('[data-cl="pass-enrol"]').click();
    await approve();
    await go(page, `clubs/c/${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    return page;
  }
  // Let in as a Cash player; the credit line comes after, on their page.
  const ownerApproves = owner => async () => {
    await go(owner, 'clubs/requests');
    await owner.locator('.cl-needs [data-cl="approve"]').first().click();
    const form = owner.locator('.cl-needs form[data-letin]');
    await form.locator('button[type=submit]').click();
    await expect(form).toHaveCount(0);
  };

  // The owner on `name`'s member page.
  async function memberPage(owner, name) {
    await go(owner, 'clubs/members');
    await owner.locator('.mg-members a', {hasText: name}).click();
    await expect(owner.getByRole('heading', {name})).toBeVisible();
  }
  // The owner sets the credit limit on `name`'s page, under Other.
  async function setCredit(owner, name, limit) {
    await memberPage(owner, name);
    const form = owner.locator('form[data-creditform]');
    await form.locator('label', {has: owner.locator('input[value="other"]')}).click();
    await form.locator('input[name="amount"]').fill(String(limit));
    await form.locator('button[type="submit"]').click();
    await expect(owner.locator('.mg-stat', {hasText: 'Credit limit'})).toContainText(String(limit));
  }
  // The owner gives (or takes back) chips on `name`'s page, with a note.
  async function chipMove(owner, name, kind, n, note) {
    await memberPage(owner, name);
    await owner.locator(`[data-cl="${kind}"]`).click();
    await owner.locator('#cl-amt').fill(String(n));
    await owner.locator('form[data-chipform] input[name="note"]').fill(note);
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await expect(owner.locator('form[data-chipform]')).toHaveCount(0);
  }
  const balanceOf = async page => num((await page.locator('.cl-home-chips', {hasText: 'Balance'}).innerText()).match(new RegExp(amount))[0]);
  const sit = async page => {
    await page.locator('[data-cl="sit-open"]').first().click();
    await page.locator('form[data-sitform] button[type="submit"]').click();
    await expect(page.locator('.pl-felt')).toBeVisible();
  };
  const settleRow = (owner, name) => owner.locator('.cl-settle tr', {hasText: name});

  test('a credit player plays on credit and owes it; the owner records the payment, and pays out a winner, on Balances', async ({browser, watch}, info) => {
    const {owner, invite, code} = await clubWithTable(browser, watch);
    const ava = await join(browser, watch, invite, code, 'Ava', ownerApproves(owner));
    const bo = await join(browser, watch, invite, code, 'Bo', ownerApproves(owner));

    // Ava is a credit player: a 200 limit, no chips of her own.
    await setCredit(owner, 'Ava', 200);
    await expect(owner.locator('.pl-avail')).toContainText('200');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('owner-credit.png'), fullPage: true});
    await expect(ava.locator('.cl-home-chips', {hasText: 'Credit limit 200'})).toBeVisible();
    expect(await balanceOf(ava)).toBe(0);
    // Bo has chips from the float.
    await chipMove(owner, 'Bo', 'give', 200, 'buy-in');
    await expect(bo.getByText('Balance 200')).toBeVisible();

    // Both sit; Ava's 200 is all on credit.
    await sit(ava);
    await sit(bo);
    // Bo bets every turn, and Ava folds to it: she loses at least a blind.
    let folded = false;
    for (let i = 0; i < 160 && !folded; i++) {
      const fold = ava.locator('[data-act="fold"]');
      if (await fold.isVisible()) { await fold.click().catch(() => {}); folded = true; break; }
      const avaCheck = ava.locator('[data-act="check"], [data-act="call"]').first();
      if (await avaCheck.isVisible()) await avaCheck.click().catch(() => {});
      const bet = bo.locator('[data-act="raise"], [data-act="bet"]').first();
      if (await bet.isVisible()) await bet.click().catch(() => {});
      await ava.waitForTimeout(250);
    }
    expect(folded).toBe(true);
    await ava.locator('[data-act="leave"]').click();
    await go(ava, `clubs/c/${encodeURIComponent(code)}`);
    await expect(ava.getByRole('heading', {name: 'Night Owls'})).toBeVisible();
    await expect.poll(() => balanceOf(ava)).toBeLessThan(0);
    const owes = -(await balanceOf(ava));
    await expect(ava.locator('.cl-home-chips.owes')).toBeVisible();
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('ava-owes.png'), fullPage: true});
    // The owner hears she left owing, and Members' Owes filter lists her.
    await go(owner, 'clubs/overview');
    await expect(owner.locator('.mg-note', {hasText: /Ava\s+left .* owing/}).first()).toBeVisible();
    await go(owner, 'clubs/members?show=owes');
    await expect(owner.locator('.mg-members a', {hasText: 'Ava'})).toBeVisible();
    await expect(owner.locator('.mg-members a', {hasText: 'Bo'})).toHaveCount(0);

    // Balances: Ava owes the club; the books add up.
    await go(owner, 'clubs/settle');
    await expect(settleRow(owner, 'Ava')).toContainText('Owes the club');
    expect(num((await settleRow(owner, 'Ava').locator('td').last().innerText()))).toBe(owes);
    await expect(owner.getByText('Adds up ✓')).toBeVisible();
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('balances-owes.png'), fullPage: true});
    // Ava pays outside ducy; the owner records it as a give, with a note.
    await chipMove(owner, 'Ava', 'give', owes, 'paid cash');
    await expect.poll(() => balanceOf(ava)).toBe(0);
    await go(owner, 'clubs/settle');
    await expect(settleRow(owner, 'Ava')).toHaveCount(0);
    // She sees the payment in her chips, with its note.
    await ava.locator('[data-cl="mtab"][data-tab="chips"]').click();
    await expect(ava.getByText('paid cash')).toBeVisible();

    // Bo stands up ahead: the club owes him, and the owner pays him out with a take back.
    await bo.locator('[data-act="leave"]').click();
    await go(bo, `clubs/c/${encodeURIComponent(code)}`);
    await expect.poll(() => balanceOf(bo)).toBeGreaterThan(200);
    const won = await balanceOf(bo);
    await go(owner, 'clubs/settle');
    await expect(settleRow(owner, 'Bo')).toContainText('Club owes');
    expect(num((await settleRow(owner, 'Bo').locator('td').last().innerText()))).toBe(won);
    await chipMove(owner, 'Bo', 'take', won, 'paid out');
    await expect.poll(() => balanceOf(bo)).toBe(0);
    await go(owner, 'clubs/settle');
    await expect(owner.getByText('All at zero.')).toBeVisible();
    await expect(owner.getByText('Adds up ✓')).toBeVisible();
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('balances-settled.png'), fullPage: true});
  });

  test('an agent’s player on credit: the owner, the agent and the player each see it', async ({browser, watch}, info) => {
    const {owner, invite, code} = await clubWithTable(browser, watch);
    const ava = await join(browser, watch, invite, code, 'Ava', ownerApproves(owner));
    // Ava becomes an agent, with a 400 credit limit to back her players.
    await memberPage(owner, 'Ava');
    await owner.locator('.mg-acts summary').click();
    await owner.locator('[data-cl="make-agent"]').click();
    await owner.locator('form[data-chipform] button[type=submit]').click();
    await ava.locator('[data-cl="agent-yes"]').click();
    await setCredit(owner, 'Ava', 400);
    // More than a full buy-in at once: a notice, as a give that size would be.
    await go(owner, 'clubs/overview');
    await expect(owner.locator('.mg-note', {hasText: 'Ava’s credit limit is now 400'}).first()).toBeVisible();
    await ava.locator('[data-cl="mtab"][data-tab="players"]').click();
    const link = await ava.locator('input[data-aglink]').inputValue();

    // Bo joins through her link; she lets him in.
    const bo = await join(browser, watch, link, code, 'Bo', async () => {
      await ava.locator('[data-cl="ag-approve"]').click();
      await ava.locator('form[data-letin] button[type=submit]').click();
    });
    // Ava gives Bo a 200 line, on his link with her (#621).
    await ava.locator('.cl-agent li', {hasText: 'Bo'}).locator('[data-cl="ag-credit"]').click();
    await ava.locator('form[data-agentform="credit"] [name=amount]').fill('200');
    await ava.locator('form[data-agentform="credit"] button[type=submit]').click();
    await expect(bo.locator('.cl-home-chips', {hasText: 'Credit limit 200'})).toBeVisible();
    await sit(bo);
    await go(bo, `clubs/c/${encodeURIComponent(code)}`);
    await expect.poll(() => balanceOf(bo)).toBe(-200);
    await fitsTheScreen(bo);
    await bo.screenshot({path: info.outputPath('player-on-credit.png'), fullPage: true});

    // The owner: Ava's link carries Bo's buy-in.
    await go(owner, 'clubs/settle');
    await expect(settleRow(owner, 'Ava')).toContainText('Owes the club');
    await expect(settleRow(owner, 'Ava')).toContainText('200');
    await expect(settleRow(owner, 'Bo')).toHaveCount(0);
    await expect(owner.getByText('Adds up ✓')).toBeVisible();
    await owner.screenshot({path: info.outputPath('owner-agent-balances.png'), fullPage: true});
    // Ava: Bo at −200 with 200 on the table, nothing owed yet, 200 of her 400 left.
    const row = ava.locator('.cl-agent li', {hasText: 'Bo'});
    await expect(row.locator('.cl-chips')).toHaveText(/[−-]200/);
    await expect(row.locator('.cl-at')).toContainText('200');
    await expect(ava.locator('.mg-stat', {hasText: 'Available'})).toContainText('200');
    await expect(ava.locator('.mg-stat', {hasText: 'Credit limit'})).toContainText('400');
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('agent-players.png'), fullPage: true});
  });

  test('a tournament with a rake: the entry costs both, and unregistering gives both back', async ({browser, watch}, info) => {
    const {owner, invite, code} = await clubWithTable(browser, watch);
    const ava = await join(browser, watch, invite, code, 'Ava', ownerApproves(owner));
    await chipMove(owner, 'Ava', 'give', 100, '');
    await expect(ava.getByText('Balance 100')).toBeVisible();

    // A 20 buy-in with a 2 rake, through the wizard.
    await go(owner, 'clubs/tourneys');
    await owner.locator('[data-cl="new-tourney"]').click();
    await owner.locator('#tw-form input[name="name"]').fill('Sunday');
    await owner.locator('label.tw-tile', {has: owner.locator('input[name="buyInPick"][value="2000"]')}).click();
    await owner.locator('label.tw-tile', {has: owner.locator('input[name="rakePick"][value="200"]')}).click();
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('wizard-rake.png'), fullPage: true});
    for (let step = 1; step < 5; step++) await owner.locator('.tw-foot button[type="submit"]').click();
    await expect(owner.locator('.tw-review')).toContainText('20 + 2 rake');
    await owner.locator('.tw-foot button[type="submit"]').click();
    const card = owner.locator('.cl-tourney', {hasText: 'Sunday'});
    await expect(card).toContainText('buy-in 20 + 2');

    // Ava registers: 22 from her balance; the pool is the 20.
    await ava.locator('[data-cl="mtab"][data-tab="tourneys"]').click();
    const row = ava.locator('.cl-tourneys li', {hasText: 'Sunday'});
    await expect(row).toContainText('buy-in 20 + 2');
    await row.locator('[data-cl="t-register"]').click();
    await expect(ava.getByText('Balance 78')).toBeVisible();
    await expect(row).toContainText('pool 20');
    await fitsTheScreen(ava);
    await ava.screenshot({path: info.outputPath('tourney-registered.png'), fullPage: true});
    // The owner sees the rake it has taken so far, and where the chips are.
    await expect(card).toContainText('rake 2');
    await go(owner, 'clubs/chips');
    await expect(owner.locator('.cl-acct tr', {hasText: 'In tournaments'})).toContainText('22');
    await fitsTheScreen(owner);
    await owner.screenshot({path: info.outputPath('owner-tourney-chips.png'), fullPage: true});

    // Unregistering gives the buy-in and the rake back.
    await row.locator('[data-cl="t-unregister"]').click();
    await expect(ava.getByText('Balance 100')).toBeVisible();
  });
});

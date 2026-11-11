// The admin site's Fair play (#612), in real browsers: every club's flags,
// players, pairs and averages from the relay's /admin/fair-play, sorted by
// a column, one club picked, and a player's weeks. The relay's answers are
// stood in for here (the routes and their signing are unit tested in
// test/fair-play-admin.test.mjs); the page signs its requests as usual.
// ADMIN_SHOTS=<dir> saves a screenshot of each view, light and dark.
import { test, expect } from '@playwright/test';

// Nothing listens there: page.route answers. (Not a port browsers block.)
const RELAY = 'http://localhost:59999';
const a = (n, top, exp, off, extra = {}) => ({n, top, exp, off, mixed: 40, minority: 10, expMinority: 11, sized: 30, sizeOk: 20, clear: 2.1, hard: 4.8, nClear: 60, nHard: 50, median: 3.2, spread: 1.4, timed: 110, away: 4, awayKnown: 110, ...extra});
const p = (id, name, hands, as, pp = {}, flags = []) => ({id, name, hands, flags, a: as, p: {vpn: 0, relay: 0, fake: 0, hidden: 0, ...pp}});
const ref = (...hands) => hands.map(hand => ({table: 'Main', hand}));
const club = (code, at, extra) => ({code, at, since: at - 7 * 864e5, hands: 1800, decisions: 2400, ...extra});
const FAIR = {
  limits: {windowDays: 7, minShared: 100, odds: 4, partnerOdds: 2.5, flowBB: 1000, minDecisions: 300, offRate: 0.01, topSlack: 0.02, paceRatio: 1.2, evenSpread: 0.25, awayRate: 0.2},
  clubs: [
    club('AAAA-BBBB', Date.UTC(2026, 10, 9, 14), {
      name: 'Owls',
      flags: [
        {ids: ['id-ava'], names: {'id-ava': 'Ava'}, decisions: 620, flags: [
          {kind: 'gto-top', who: 'id-ava', with: {k: 560, n: 620}, solver: 0.88, club: 0.58, hands: ref(212, 215, 230)},
          {kind: 'gto-off', who: 'id-ava', with: {k: 2, n: 620}, club: 0.05},
          {kind: 'gto-even', who: 'id-ava', median: 5.9, spread: 0.8, n: 410},
        ]},
        {ids: ['id-bo', 'id-cy'], names: {'id-bo': 'Bo', 'id-cy': 'Cy'}, shared: 340, contested: 12, flow: 4200, flags: [
          {kind: 'folds', who: 'id-bo', other: 'id-cy', with: {k: 30, n: 40}, elsewhere: {k: 20, n: 80}, hands: ref(101, 140)},
          {kind: 'near', who: 'id-bo', other: 'id-cy', with: {k: 52, n: 340}, hands: ref(88)},
        ]},
        {ids: ['id-dee'], names: {'id-dee': 'Dee'}, flags: [{kind: 'vpn', who: 'id-dee', with: {k: 40, n: 300}, hands: ref(17)}]},
      ],
      players: [
        p('id-ava', 'Ava', 700, a(620, 560, 545.6, 2, {clear: 5.8, hard: 6.0, median: 5.9, spread: 0.8, away: 60, awayKnown: 600}), {}, ['gto-even', 'gto-off', 'gto-top']),
        p('id-bo', 'Bo', 650, a(500, 300, 430, 25), {}, ['folds', 'near']),
        p('id-cy', 'Cy', 640, a(480, 310, 410, 22), {}, ['folds', 'near']),
        p('id-dee', 'Dee', 300, a(210, 170, 180, 3), {vpn: 40}, ['vpn']),
        p('id-eli', 'Eli', 120, a(90, 50, 76, 6)),
        p('id-flo', 'Flo', 40, null, {hidden: 40}),
      ],
      pairs: [
        {ids: ['id-bo', 'id-cy'], names: {'id-bo': 'Bo', 'id-cy': 'Cy'}, shared: 340, contested: 12, flow: 4200, bb: 2100, near: 52, tests: [
          {kind: 'folds', who: 'id-bo', with: {k: 30, n: 40}, elsewhere: {k: 20, n: 80}, x: 8.6, flagged: true},
          {kind: 'folds', who: 'id-cy', with: {k: 12, n: 40}, elsewhere: {k: 24, n: 80}, x: 1, flagged: false},
          {kind: 'enters', who: 'id-bo', with: {k: 4, n: 30}, elsewhere: {k: 20, n: 90}, x: 1.8, flagged: false},
          {kind: 'contest', who: 'id-bo', with: {k: 12, n: 340}, expected: 30, x: 2.43, flagged: false},
          {kind: 'chips', who: 'id-bo', bb: 2100, chips: 4200, flagged: false},
        ]},
        {ids: ['id-ava', 'id-bo'], names: {'id-ava': 'Ava', 'id-bo': 'Bo'}, shared: 410, contested: 60, flow: -300, bb: -150, tests: [
          {kind: 'raises', who: 'id-ava', with: {k: 14, n: 40}, elsewhere: {k: 30, n: 90}, x: 0.93, flagged: false},
          {kind: 'partner', who: 'id-ava', with: {k: 20, n: 34}, elsewhere: {k: 50, n: 100}, x: 1.4, flagged: false},
        ]},
      ],
      club: {
        assist: {players: 5, n: 1900, top: 1390, exp: 1640, off: 58, away: 72, awayKnown: 1400, pace: 2.2, even: 0.42},
        pairs: {raises: {k: 300, n: 900}, enters: {k: 400, n: 1600}, folds: {k: 500, n: 1400}, checks: {k: 30, n: 120}, dumps: {k: 4, n: 40}, partner: {k: 300, n: 600}},
        p: {hands: 2450, vpn: 40, relay: 0, fake: 0, hidden: 40},
      },
    }),
    club('CCCC-DDDD', Date.UTC(2026, 10, 8, 22), {
      name: 'Rooks', flags: [], pairs: [],
      players: [p('id-gus', 'Gus', 90, a(70, 40, 58, 5))],
      club: {assist: {players: 1, n: 70, top: 40, exp: 58, off: 5, away: 4, awayKnown: 110, pace: null, even: 0.44}, pairs: {}, p: {hands: 90, vpn: 0, relay: 0, fake: 0, hidden: 0}},
    }),
  ],
};
const HISTORY = {id: 'id-ava', weeks: [
  {week: '2026-11-09', code: 'AAAA-BBBB', club: 'Owls', at: 0, name: 'Ava', hands: 700, flags: ['gto-even', 'gto-off', 'gto-top'], a: a(620, 560, 545.6, 2, {away: 60, awayKnown: 600}), p: {vpn: 0, relay: 0, fake: 0, hidden: 0}},
  {week: '2026-11-02', code: 'AAAA-BBBB', club: 'Owls', at: 0, name: 'Ava', hands: 640, flags: [], a: a(380, 240, 330, 18), p: {vpn: 0, relay: 0, fake: 0, hidden: 0}},
  {week: '2026-10-26', code: 'AAAA-BBBB', club: 'Owls', at: 0, name: 'Ava', hands: 520, flags: [], a: a(300, 180, 262, 20), p: {vpn: 0, relay: 0, fake: 0, hidden: 0}},
]};

// The relay's answers: each request must be a signed admin envelope for its path.
async function standIn(page, seen) {
  await page.route(`${RELAY}/**`, async route => {
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST'};
    // A browser may ask first (CORS).
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    seen.push({path, signed: !!(body?.sig && body?.from && body?.body?.type === 'admin' && body.body.path === path)});
    const out = path === '/admin/fair-play' ? FAIR : path === '/admin/fair-play/history' ? {...HISTORY, id: body.body.data.id} : {error: 'not here'};
    await route.fulfill({status: out.error ? 404 : 200, contentType: 'application/json', headers: cors, body: JSON.stringify(out)});
  });
}

const fits = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const shot = async (page, name, info) => {
  if (!process.env.ADMIN_SHOTS) return;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme: scheme});
    await page.screenshot({path: `${process.env.ADMIN_SHOTS}/${name}-${info.project.name}-${scheme}.png`, fullPage: true});
  }
  await page.emulateMedia({colorScheme: 'light'});
};

test('fair play: open flags, players, pairs and averages across clubs; sorting; one club; a player’s weeks (#612)', async ({page}, info) => {
  const problems = [];
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  const seen = [];
  await standIn(page, seen);
  await page.goto(`/admin.html?relay=${encodeURIComponent(RELAY)}#fair`);

  await expect(page.getByRole('heading', {name: 'Fair play'})).toBeVisible();
  await expect(page.locator('nav button[data-go="fair"]')).toHaveAttribute('aria-current', 'page');
  const flags = page.locator('table[data-table="flags"]');
  // Strongest first: the folds at ×8.6 (from 30/40 vs 20/80).
  await expect(flags.locator('tr').nth(1)).toContainText('Folds to');
  await expect(flags).toContainText('30/40 vs 20/80');
  await expect(flags).toContainText('Main #212, #215, #230');
  await expect(flags.locator('tr')).toHaveCount(7);
  const players = page.locator('table[data-table="players"]');
  await expect(players.locator('tr')).toHaveCount(8);
  await expect(page.locator('table[data-table="averages"] tr')).toHaveCount(3);
  await expect(page.locator('table[data-table="pairs"]')).toContainText('×8.60');
  await expect(page.locator('table[data-table="rates"]')).toContainText('33.3%');
  await fits(page);
  await shot(page, 'fair', info);

  // Sorted by hidden tab, largest first, then the other way.
  const hidden = players.getByRole('button', {name: 'Hidden tab'});
  await hidden.click();
  await expect(players.locator('tr').nth(1)).toContainText('Ava');
  await expect(players.locator('th[aria-sort="descending"]')).toContainText('Hidden tab');
  await players.getByRole('button', {name: /Hidden tab/}).click();
  await expect(players.locator('th[aria-sort="ascending"]')).toContainText('Hidden tab');
  await expect(players.locator('tr').nth(1)).not.toContainText('Ava');
  // No numbers (Flo): last either way.
  await expect(players.locator('tr').last()).toContainText('Flo');

  // One club.
  await page.selectOption('#fp-club', 'CCCC-DDDD');
  await expect(page.locator('table[data-table="players"] tr')).toHaveCount(2);
  await expect(page.getByText('No open flags')).toBeVisible();
  await page.selectOption('#fp-club', '');

  // A player's weeks.
  await page.locator('table[data-table="flags"]').getByRole('button', {name: 'Ava'}).first().click();
  await expect(page).toHaveURL(/#fair-player=id-ava$/);
  const weeks = page.locator('table[data-table="history"]');
  await expect(weeks.locator('tr')).toHaveCount(4);
  await expect(weeks.locator('tr').nth(1)).toContainText('2026-11-09');
  await expect(page.locator('nav button[data-go="fair"]')).toHaveAttribute('aria-current', 'page');
  await fits(page);
  await shot(page, 'fair-player', info);

  // Every request was signed, for its own path.
  expect(seen.map(s => s.path)).toEqual(['/admin/fair-play', '/admin/fair-play/history']);
  expect(seen.every(s => s.signed)).toBe(true);
  // No cards on the page.
  expect(await page.locator('body').innerText()).not.toMatch(/\b[2-9TJQKA][shdc]\b/);
  expect(problems).toEqual([]);
});

test('clubs: a grant shows its one-time link once; Wipe all clubs takes the environment’s name (#636)', async ({page}, info) => {
  const problems = [];
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  const TOKEN = 'T'.repeat(40) + '_-x';
  const sent = [];
  let invites = {'id-old': {at: Date.UTC(2026, 10, 1), note: 'Owls', limits: null, usedAt: Date.UTC(2026, 10, 2), code: 'AAAA-BBBB', used: true}};
  let clubs = [{code: 'AAAA-BBBB', name: 'Owls', owner: 'id-old', limits: {tables: 2, tourneysPerDay: 1}, lastActive: Date.UTC(2026, 10, 9), days: {}, minutes: 0}];
  await page.route(`${RELAY}/**`, async route => {
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST'};
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (body) sent.push({path, data: body.body?.data, signed: !!(body.sig && body.body?.path === path)});
    let out;
    if (path === '/usage') out = {clubs: clubs.length, limits: {total: 25}, days: []};
    else if (path === '/admin/clubs') out = {clubs, grants: {}, invites, trials: {}, limits: {perOwner: 3, total: 25}};
    else if (path === '/admin/grant') {
      invites = {...invites, [body.body.data.id]: {at: Date.now(), note: body.body.data.note, limits: null, usedAt: null, code: null, used: false}};
      out = {at: Date.now(), note: body.body.data.note, maxClubs: 0, token: TOKEN};
    } else if (path === '/admin/wipe') {
      out = body.body.data.confirm === 'local' ? {clubs: clubs.length} : {error: 'Type local to wipe this relay’s clubs.'};
      if (!out.error) { clubs = []; invites = {}; }
    } else out = {error: 'not here'};
    await route.fulfill({status: out.error ? 400 : 200, contentType: 'application/json', headers: cors, body: JSON.stringify(out)});
  });
  page.on('dialog', d => d.accept());
  await page.goto(`/admin.html?relay=${encodeURIComponent(RELAY)}#clubs`);
  await expect(page.getByRole('heading', {name: 'Who may create clubs'})).toBeVisible();
  await expect(page.locator('#g-max')).toHaveCount(0);
  await expect(page.getByText('Used')).toBeVisible();
  await fits(page);

  // Granting shows the link, on this local page's manager with its relay, once.
  await page.locator('#g-id').fill('id-new');
  await page.locator('#g-note').fill('Thursdays');
  await page.locator('#grant').click();
  const link = page.locator('#g-link');
  await expect(link).toHaveValue(new RegExp(`/manage\\.html\\?relay=${encodeURIComponent(RELAY).replace(/[.%]/g, '\\$&')}#clubs/start/${TOKEN}$`));
  await expect(page.getByRole('button', {name: 'Copy'})).toBeVisible();
  await expect(page.getByText('Not used')).toBeVisible();
  await expect(page.getByRole('button', {name: 'New link'})).toBeVisible();
  await fits(page);
  await shot(page, 'grant', info);
  expect(sent.find(s => s.path === '/admin/grant').data).toEqual({id: 'id-new', note: 'Thursdays', limits: null});

  // Wipe: off until the environment's name is typed exactly.
  const wipe = page.locator('#wipe');
  await expect(wipe).toBeDisabled();
  await page.locator('#w-confirm').fill('Local');
  await expect(wipe).toBeDisabled();
  await page.locator('#w-confirm').fill('local');
  await expect(wipe).toBeEnabled();
  await wipe.click();
  await expect(page.locator('#status')).toHaveText('Wiped 1 club on Local.');
  await expect(page.getByText('No clubs yet')).toBeVisible();
  await expect(page.locator('#g-link')).toHaveCount(0);
  await fits(page);
  expect(sent.filter(s => s.path === '/admin/wipe').map(s => s.data)).toEqual([{confirm: 'local'}]);
  expect(sent.every(s => s.path === '/usage' || s.signed)).toBe(true);
  expect(problems).toEqual([]);
});

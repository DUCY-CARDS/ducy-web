// The club manager's pages and addresses (#398, src/club-nav.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { managerPage, NAV, navOf, pageHash, PAGES, pageTitle } from '../src/club-nav.js';

test('the sidebar groups the pages by task', () => {
  assert.deepEqual(NAV.map(g => g.group), ['', 'Games', 'Members', 'Settings']);
  assert.deepEqual(PAGES, ['overview', 'cash', 'tourneys', 'promos', 'requests', 'members', 'chips', 'info', 'rules', 'backup', 'history']);
  assert.equal(pageTitle('backup'), 'Backup and devices');
});

test('each page has its own address, and a member theirs', () => {
  for (const p of PAGES) assert.deepEqual(managerPage(`#${pageHash(p)}`), {page: p, member: '', old: false});
  assert.equal(pageHash('member', 'AbC/12'), 'clubs/member/AbC%2F12');
  assert.deepEqual(managerPage('#clubs/member/AbC%2F12'), {page: 'member', member: 'AbC/12', old: false});
  assert.equal(navOf('member'), 'members');
  assert.equal(navOf('cash'), 'cash');
});

test('the older addresses still open the right page', () => {
  const old = {own: 'overview', tables: 'cash', players: 'members', accounting: 'chips', settings: 'rules'};
  for (const [from, to] of Object.entries(old)) assert.deepEqual(managerPage(`#clubs/${from}`), {page: to, member: '', old: true}, from);
  // Tabs whose name is still a page's are that page.
  for (const p of ['tourneys', 'promos', 'history']) assert.equal(managerPage(`#clubs/${p}`).page, p);
});

test('addresses that aren’t the club you run name no page', () => {
  for (const h of ['', '#clubs', '#clubs/c/ABCD-EFGH', '#play', '#clubs/nope', '#clubs/member/', '#clubs/constructor', '#clubs/__proto__']) assert.equal(managerPage(h), null, h);
});

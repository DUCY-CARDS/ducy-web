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

test('a club you manage has the same pages under its own address (#417)', () => {
  assert.equal(pageHash('members', '', 'AB/CD'), 'clubs/c/AB%2FCD/members');
  assert.equal(pageHash('member', 'x y', 'ABCD-EFGH'), 'clubs/c/ABCD-EFGH/member/x%20y');
  assert.deepEqual(managerPage('#clubs/c/ABCD-EFGH/cash'), {page: 'cash', member: '', old: false, code: 'ABCD-EFGH'});
  assert.deepEqual(managerPage('#clubs/c/ABCD-EFGH/member/x%20y'), {page: 'member', member: 'x y', old: false, code: 'ABCD-EFGH'});
  // The club's own page (its tools) and older names aren't pages here.
  assert.equal(managerPage('#clubs/c/ABCD-EFGH'), null);
  assert.equal(managerPage('#clubs/c/ABCD-EFGH/players'), null);
});

test('addresses that aren’t the club you run name no page', () => {
  for (const h of ['', '#clubs', '#clubs/c/ABCD-EFGH', '#play', '#clubs/nope', '#clubs/member/', '#clubs/constructor', '#clubs/__proto__']) assert.equal(managerPage(h), null, h);
});

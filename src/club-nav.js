// The club manager's pages (#398): the sidebar's groups by task, the
// address of each page (#clubs/<page>, a member's #clubs/member/<id>), and
// the older addresses (the club home's tabs, #225) that still open them.

import { FILTERS, SORTS } from './club-overview.js';

export const NAV = [
  {group: '', pages: [['overview', 'Overview']]},
  {group: 'Games', pages: [['cash', 'Tables'], ['tourneys', 'Tournaments'], ['promos', 'Promotions']]},
  {group: 'Members', pages: [['requests', 'Requests'], ['members', 'Members'], ['settle', 'Settle'], ['chips', 'Chips']]},
  {group: 'Settings', pages: [['info', 'Club info'], ['rules', 'Rules'], ['backup', 'Backup and devices'], ['history', 'History']]},
];

export const PAGES = NAV.flatMap(g => g.pages.map(([id]) => id));
export const pageTitle = id => NAV.flatMap(g => g.pages).find(([p]) => p === id)?.[1] || '';

// Addresses from before #398, and the page each now opens.
export const OLD_PAGES = {
  own: 'overview', tables: 'cash', tourneys: 'tourneys', players: 'members',
  accounting: 'chips', promos: 'promos', history: 'history', settings: 'rules',
};

// The Members list's filter, order and page (#426) are in its address, so
// Back returns to the same place: #clubs/members?show=owes&sort=balance&page=2,
// or ?agent=<id> for an agent's players. The filters and orders are
// club-overview.js FILTERS and SORTS; All, by name and page 1 aren't written.

// The page of the club you run that address `hash` names: {page, member,
// old} (member: a member's page; old: an older address), and on Members
// {sort, n, show, agent}, its order, page and filter; or null when it names none (the list of
// clubs, a club you help run).
// A club you manage (#417) has the same pages under its own address,
// #clubs/c/CODE/<page>: then `code` says which.
export function managerPage(hash) {
  const [path, query = ''] = String(hash || '').replace(/^#/, '').split('?');
  const p = path.split('/');
  if (p[0] === 'clubs' && p[1] === 'c' && p[2] && p[3]) {
    const r = managerPage(`clubs/${p.slice(3).join('/')}${query ? `?${query}` : ''}`);
    return r && !r.old ? {...r, code: decodeURIComponent(p[2])} : null;
  }
  if (p[0] !== 'clubs' || !p[1]) return null;
  if (p[1] === 'member' && p[2]) return {page: 'member', member: decodeURIComponent(p[2]), old: false};
  if (p[1] === 'members') {
    const q = new URLSearchParams(query);
    const agent = q.get('agent') || '';
    const show = agent ? 'agent' : FILTERS.includes(q.get('show')) ? q.get('show') : 'all';
    return {page: 'members', member: '', old: false, sort: SORTS.includes(q.get('sort')) ? q.get('sort') : 'name', n: Math.max(1, Math.floor(Number(q.get('page'))) || 1), show, agent};
  }
  if (PAGES.includes(p[1])) return {page: p[1], member: '', old: false};
  if (Object.hasOwn(OLD_PAGES, p[1])) return {page: OLD_PAGES[p[1]], member: '', old: true};
  return null;
}

// The address of page `page` (or member `member`'s page), without the '#';
// in club `code` you manage, when given. Members takes its order, page and
// filter ({sort, n, show, agent}, as managerPage gives them).
export function pageHash(page, member = '', code = '', {sort = 'name', n = 1, show = 'all', agent = ''} = {}) {
  let tail = page === 'member' ? `member/${encodeURIComponent(member)}` : page;
  if (page === 'members') {
    const q = new URLSearchParams();
    if (agent) q.set('agent', agent);
    else if (show !== 'all' && FILTERS.includes(show)) q.set('show', show);
    if (sort !== 'name' && SORTS.includes(sort)) q.set('sort', sort);
    if (n > 1) q.set('page', String(n));
    if (q.size) tail += `?${q}`;
  }
  return code ? `clubs/c/${encodeURIComponent(code)}/${tail}` : `clubs/${tail}`;
}

// The sidebar entry a page sits under: a member's page under Members.
export const navOf = page => (page === 'member' ? 'members' : page);

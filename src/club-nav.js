// The club manager's pages (#398): the sidebar's groups by task, the
// address of each page (#clubs/<page>, a member's #clubs/member/<id>), and
// the older addresses (the club home's tabs, #225) that still open them.

export const NAV = [
  {group: '', pages: [['overview', 'Overview']]},
  {group: 'Games', pages: [['cash', 'Cash games'], ['tourneys', 'Tournaments'], ['promos', 'Promotions']]},
  {group: 'Members', pages: [['requests', 'Requests'], ['members', 'Members'], ['chips', 'Chips']]},
  {group: 'Settings', pages: [['info', 'Club info'], ['rules', 'Rules'], ['backup', 'Backup and devices'], ['history', 'History']]},
];

export const PAGES = NAV.flatMap(g => g.pages.map(([id]) => id));
export const pageTitle = id => NAV.flatMap(g => g.pages).find(([p]) => p === id)?.[1] || '';

// Addresses from before #398, and the page each now opens.
export const OLD_PAGES = {
  own: 'overview', tables: 'cash', tourneys: 'tourneys', players: 'members',
  accounting: 'chips', promos: 'promos', history: 'history', settings: 'rules',
};

// The page of the club you run that address `hash` names: {page, member,
// old} (member: a member's page; old: an older address), or null when it
// names none (the list of clubs, a club you help run).
// A club you manage (#417) has the same pages under its own address,
// #clubs/c/CODE/<page>: then `code` says which.
export function managerPage(hash) {
  const p = String(hash || '').replace(/^#/, '').split('/');
  if (p[0] === 'clubs' && p[1] === 'c' && p[2] && p[3]) {
    const r = managerPage(`clubs/${p.slice(3).join('/')}`);
    return r && !r.old ? {...r, code: decodeURIComponent(p[2])} : null;
  }
  if (p[0] !== 'clubs' || !p[1]) return null;
  if (p[1] === 'member' && p[2]) return {page: 'member', member: decodeURIComponent(p[2]), old: false};
  if (PAGES.includes(p[1])) return {page: p[1], member: '', old: false};
  if (Object.hasOwn(OLD_PAGES, p[1])) return {page: OLD_PAGES[p[1]], member: '', old: true};
  return null;
}

// The address of page `page` (or member `member`'s page), without the '#';
// in club `code` you manage, when given.
export function pageHash(page, member = '', code = '') {
  const tail = page === 'member' ? `member/${encodeURIComponent(member)}` : page;
  return code ? `clubs/c/${encodeURIComponent(code)}/${tail}` : `clubs/${tail}`;
}

// The sidebar entry a page sits under: a member's page under Members.
export const navOf = page => (page === 'member' ? 'members' : page);

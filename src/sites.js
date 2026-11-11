// ducy's sites (#637): the player app (ducy.cards) and the sites beside it
// on their own subdomains, each with its own browser storage. The club
// manager is club.ducy.cards; staging's and the sandbox's are
// club-staging.ducy.cards and club-sandbox.ducy.cards, beside
// staging.ducy.cards and sandbox.ducy.cards. Sites to come (quest, odds,
// training: #639–#641) add their names to SITES.
//
// A local page (localhost, the browser tests) has no subdomains: the club
// manager is manage.html beside index.html, as before.

export const SITES = ['club'];
const ENVS = ['staging', 'sandbox'];

// The player app's host for page host `h`: 'ducy.cards', 'staging.ducy.cards'
// or 'sandbox.ducy.cards'; '' for a local page.
export function playerHost(h) {
  if (h === 'ducy.cards' || h === 'www.ducy.cards') return 'ducy.cards';
  const m = String(h).match(/^([a-z]+)(?:-([a-z]+))?\.ducy\.cards$/);
  if (!m) return '';
  if (!m[2] && ENVS.includes(m[1])) return h;
  if (SITES.includes(m[1]) && !m[2]) return 'ducy.cards';
  if (SITES.includes(m[1]) && ENVS.includes(m[2])) return `${m[2]}.ducy.cards`;
  return '';
}

// Site `site`'s host beside page host `h` (club.ducy.cards for ducy.cards
// or any of its subdomains), or '' for a local page.
export function siteHost(site, h) {
  const p = playerHost(h);
  if (!p) return '';
  return p === 'ducy.cards' ? `${site}.ducy.cards` : `${site}-${p.split('.')[0]}.ducy.cards`;
}

// Which site page host `h` is: 'player', one of SITES, or 'local'.
export function siteOf(h) {
  const p = playerHost(h);
  if (!p) return 'local';
  for (const s of SITES) if (siteHost(s, h) === h) return s;
  return 'player';
}

// A subdomain site (not the player app, not a local page): the first visit
// signs in with the player's passkey (site-signin.js), and the relay never
// vouches there (passkey.js recover).
export const isSubsite = (h = location.hostname) => SITES.includes(siteOf(h));

const withHash = (base, hash) => `${base}${hash ? `#${String(hash).replace(/^#/, '')}` : ''}`;

// The club manager's page `hash` (e.g. 'clubs/members'), from page `loc`:
// on the club site, or manage.html on a local page.
export function clubUrl(hash = '', loc = location) {
  const h = siteHost('club', loc.hostname);
  if (h) return withHash(h === loc.hostname ? './' : `https://${h}/`, hash);
  return withHash('manage.html', hash);
}

// The player app's page `hash`, from page `loc`.
export function playerUrl(hash = '', loc = location) {
  const h = playerHost(loc.hostname);
  if (h && h !== loc.hostname && !(h === 'ducy.cards' && loc.hostname === 'www.ducy.cards')) return withHash(`https://${h}/`, hash);
  return withHash('./', hash);
}

// Where page `loc` belongs, when it's on the wrong site: a manager page
// (manage.html) opened on the player app goes to the club site. '' when
// it's where it belongs.
export function managerRedirect(loc = location) {
  if (siteOf(loc.hostname) !== 'player') return '';
  return clubUrl(loc.hash.slice(1), loc);
}

// The club manager (manage.html): a page of its own for running a club or
// helping run one, apart from the player app (index.html), where people
// join clubs and play. It loads only the club code (clubs.js in its
// 'manage' mode): the club you run (its tables, members, chips, promotions,
// history and settings), the clubs where you're a game assistant or agent,
// and starting or restoring a club.
//
//   #clubs           the list, and starting a club
//   #clubs/overview  the club you run, by page (club-nav.js, #398); older
//                    addresses (#clubs/own, #clubs/players …) still work
//   #clubs/c/CODE    a club you help run
//   #play            a table being watched (play.js), inside the manager

// First, so a demo club's storage (#406) is in place before anything reads storage.
import './demo.js';
import { closeClubs, openClubs, setClubsMode, setShowTable } from './clubs.js';
import { closePlay, openPlay, tableGroup } from './play.js';

setClubsMode('manage');
const root = document.getElementById('clubs');
const playRoot = document.getElementById('mg-play');
// Watching a table (#73): the table view opens here, not in the player app
// (manage.html has no #play of its own otherwise).
let playing = false;
function showTable() {
  playing = true;
  closeClubs();
  playRoot.hidden = false;
  openPlay(playRoot, null, 'play');
}
setShowTable(showTable);

function route() {
  // #play only while a table is open (being watched); else the clubs.
  if (location.hash === '#play' && tableGroup()) { if (!playing) showTable(); return; }
  if (playing) { playing = false; closePlay(); playRoot.hidden = true; playRoot.innerHTML = ''; }
  if (!location.hash.startsWith('#clubs')) history.replaceState(null, '', `${location.pathname}${location.search}#clubs`);
  openClubs(root, 'clubs');
}
route();
// The club code draws what the address names; a new address redraws it.
window.addEventListener('hashchange', route);
document.body.classList.remove('booting');

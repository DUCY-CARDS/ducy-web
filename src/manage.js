// The club manager (manage.html): a page of its own for running a club or
// helping run one, apart from the player app (index.html), where people
// join clubs and play. It loads only the club code (clubs.js in its
// 'manage' mode): the club you run (its tables, members, chips, promotions,
// history and settings), the clubs where you're a game assistant or agent,
// and starting or restoring a club.
//
//   #clubs           the list, and starting a club
//   #clubs/own       the club you run (or one of its tabs: #clubs/players …)
//   #clubs/c/CODE    a club you help run

// First, so a demo club's storage (#406) is in place before anything reads storage.
import './demo.js';
import { openClubs, setClubsMode } from './clubs.js';

setClubsMode('manage');
if (!location.hash.startsWith('#clubs')) history.replaceState(null, '', `${location.pathname}${location.search}#clubs`);
const root = document.getElementById('clubs');
openClubs(root, 'clubs');
// The club code draws what the address names; a new address redraws it.
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#clubs')) history.replaceState(null, '', `${location.pathname}${location.search}#clubs`);
  openClubs(root, 'clubs');
});
document.body.classList.remove('booting');

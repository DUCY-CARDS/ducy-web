// The player app on the club site (#637) is there only for demo clubs
// (demo.js plays every part of one in one window, so on one site): anyone
// else goes to the player app's own site. Imported by main.js right after
// demo.js; waiting forever here keeps the rest of the page from starting
// while the browser leaves (an error would be reported as one).
import { demo } from './demo.js';
import { playerUrl, siteOf } from './sites.js';

if (siteOf(location.hostname) === 'club' && !demo) {
  location.replace(playerUrl(location.hash.slice(1)));
  await new Promise(() => {});
}

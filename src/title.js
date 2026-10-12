// The window title (#195): the section that's open, "Drills · DUCY", with
// the count of what's waiting for you in your clubs first, "(2) Clubs ·
// DUCY". With no section yet it's the site's name, as in index.html. A dev
// profile's "[name] " prefix (profile.js) is kept.

const SITE = 'DUCY: Poker Games and Training';
let section = '';
let waiting = 0;

function update() {
  // Read each time: profile.js may add its prefix after this module loads.
  const prefix = (document.title.match(/^\[[^\]]*\] /) || [''])[0];
  document.title = `${prefix}${waiting ? `(${waiting}) ` : ''}${section ? `${section} · DUCY` : SITE}`;
}

// The section showing, e.g. 'Trainer'; '' for none.
export function setTitleSection(name) {
  section = name || '';
  update();
}

// How many club requests are waiting for you.
export function setTitleWaiting(n) {
  waiting = n || 0;
  update();
}

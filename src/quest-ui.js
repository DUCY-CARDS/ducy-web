// Bankroll Quest's lobby (#303): your bankroll, the clock and the goal; where
// to start a run; the trip while you travel; the room you're in, its games
// and their waitlists, and your place on them; the other rooms by city, a
// trip away; study while you travel or wait; and the end of a run. Pure: it
// builds the page from the quest (quest.js), the rooms (quest-rooms.js) and
// the lists (quest-waitlist.js), and play.js handles the buttons:
// data-qstart (start in a region), data-qlist / data-qunlist (a waitlist),
// data-qopen (take a seat you've been called to), data-qpass, data-qsit (sit
// down with the amount you typed), data-qgo (travel), data-qans (a study
// answer), data-qnew (a new run), and life on the road (#351): data-qsleep
// ('home' or 'hotel', sleep here), data-qgohome (go home to sleep) and
// data-qmovehome (make this city home). Countdowns carry data-qcount (the
// real time they end, in ms) for play.js to tick.

import { GOAL, MAX_TABLE_MINUTES, QUEST_SPEED, SLEEP_MINUTES, START_BANKROLL, TIRED_MINUTES, buyInRange, canSit, clockText, exhausted, gameMinutes, listStatus, status, tableMinutes } from './quest.js';
import { GAMES, REGIONS, ROOMS, cheapestBuyIn, cityNamed, cityOf, homeCityOf, homeRoomOf, hotelCost, knownRoom, moveCost, regionOf, roomById, travelMinutes, tripCost } from './quest-rooms.js';
import { listsNow } from './quest-waitlist.js';
import { question } from './quest-study.js';
import { lineupFor, stacksAt } from './quest-lineup.js';
import { FAMILY_NAMES, personOf } from './quest-people.js';
import { TAG_NAMES, accuracyText, tagOf } from './quest-reads.js';
import { bankrollChart, bankrollSeries, biggestPots, byStakes, durationText, hallOfRecords, withRegulars } from './quest-stats.js';
import { halfOf, openOffers, stakingTotals, unread } from './quest-scenarios.js';
import { BACKER, NEVER, horseRep, passMark } from './quest-backer.js';
import { chipInput, chipText } from './chip-format.js';
import { avatarUrl, botAvatar } from './avatars.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = n => `$${chipText(n)}`;

/** How far along the road from $1,000 to $1,000,000, 0 to 1 (by multiples). */
export function goalProgress(bankroll) {
  if (bankroll <= START_BANKROLL) return 0;
  return Math.min(1, Math.log(bankroll / START_BANKROLL) / Math.log(GOAL / START_BANKROLL));
}

/** The room the quest is in (the first one to start with). */
export const currentRoom = q => roomById(q.room) || ROOMS[0];

/**
 * Sitting down at a table, in chips: the room's range, what your bankroll
 * lets you take within it, and where the amount starts (100 BB, or as near
 * as you can). Null when the bankroll can't cover the minimum.
 */
export function buyInAsk(q, blinds, room) {
  const {min, max} = buyInRange(blinds, room);
  const most = Math.min(max, q.bankroll);
  if (most < min) return null;
  return {min, max, most, start: Math.max(min, Math.min(most, 100 * blinds[1]))};
}

/** A seat's avatar id, for a Regular or a generic player ('' if none). */
export const faceOf = id => botAvatar(id) || personOf(id)?.avatar || '';
/** A seat's name: a Regular's (from `names`) or a generic player's. */
export const nameOfBot = (id, names = x => x) => personOf(id)?.name || names(id);

// An open table (like walking up to it): who's there and the chips in front
// of each, and how much you want to buy in for. play.js handles data-qsit
// (reads #qt-amt), data-qamt (sets it) and data-qclose.
function openTableHtml(q, room, game, id, minutes, names, have, amount, generic) {
  const blinds = game.blinds;
  const who = lineupFor(q.seed, id, game.stakes, minutes, have, {generic});
  const stacks = stacksAt(q.seed, id, who, blinds, room, minutes);
  const ask = buyInAsk(q, blinds, room);
  let h = '<div class="qt-open-bg" data-qclose="1"></div>';
  h += `<section class="qt-open" role="dialog" aria-label="${esc(game.stakes)} at ${esc(room.name)}">`;
  h += `<div class="qt-open-head"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">${esc(room.name)} · ${esc(GAMES[game.game]?.name || GAMES.nlhe.name)} · 6-max</span></div>`;
  h += '<ul class="qt-seats">';
  who.forEach((w, i) => {
    const face = faceOf(w) ? `<img src="${avatarUrl(faceOf(w))}" alt="">` : '<span class="qt-noface"></span>';
    const tag = tagOf(q, w);
    const read = tag && tag !== 'unsure' ? ` <span class="qr-chip">${esc(TAG_NAMES[tag])}</span>` : '';
    h += `<li>${face}<span class="qt-seat-name">${esc(nameOfBot(w, names))}${read}</span><b class="qt-seat-chips">${money(stacks[i])}</b></li>`;
  });
  h += '</ul>';
  if (!ask) {
    h += `<p class="qt-note">Your bankroll doesn’t cover the ${money(buyInRange(blinds, room).min)} minimum here.</p>`;
    return h + '<div class="qt-open-acts"><button class="cc-btn" data-qclose="1">Back to the lobby</button></div></section>';
  }
  const quick = [['Min', ask.min], ['100 BB', 100 * blinds[1]], [ask.most < ask.max ? 'All your bankroll' : 'Max', ask.most]]
    .filter(([, v], i, all) => v >= ask.min && v <= ask.most && all.findIndex(([, x]) => x === v) === i);
  h += '<div class="qt-buyin">';
  h += `<label class="qt-label" for="qt-amt">How much do you want to buy in for?</label>`;
  h += `<div class="qt-buyin-row"><span class="qt-dollar">$</span><input class="pl-text" type="number" id="qt-amt" inputmode="decimal" min="${chipInput(ask.min)}" max="${chipInput(ask.most)}" step="1" value="${chipInput(amount > 0 ? Math.max(ask.min, Math.min(ask.most, amount)) : ask.start)}">`;
  h += quick.map(([label, v]) => `<button class="cc-btn" data-qamt="${chipInput(v)}">${esc(label)}</button>`).join('');
  h += '</div>';
  h += `<span class="qt-meta">Buy-in ${money(ask.min)}–${money(ask.max)} · your bankroll ${money(q.bankroll)}</span>`;
  h += '</div>';
  h += `<div class="qt-open-acts"><button class="tr-start" data-qsit="${esc(id)}">Sit down</button><button class="cc-btn" data-qclose="1">Back to the lobby</button></div>`;
  return h + '</section>';
}

/**
 * The lobby. `names(id)` gives a Regular's name; `have` the personality ids
 * this engine has (or null); `note` a line to show (e.g. after leaving);
 * `open` the id of the table you've opened, to choose your buy-in;
 * `generic` whether the engine seats generic players; `review` the last
 * session's reads (quest-reads.js `reviewReads` rows).
 */
export function questLobbyHtml(q, now = Date.now(), {names = id => id, have = null, note = '', open = null, amount = 0, generic = false, review = null, study = null, backerTest = null, testResult = null, mastered = 0, confirmNew = false} = {}) {
  const minutes = gameMinutes(q, now);
  const st = status(q, cheapestBuyIn());
  const room = currentRoom(q);
  const runMinutes = Math.max(0, minutes - (q.started ?? minutes));
  let h = '<div class="pl-head"><h1>Bankroll Quest</h1></div>';
  h += '<section class="qt-head">';
  h += `<div class="qt-stat"><span class="qt-label">Bankroll</span><b class="qt-big">${money(q.bankroll)}</b></div>`;
  h += `<div class="qt-stat"><span class="qt-label">Clock</span><b>${esc(clockText(minutes))}</b></div>`;
  const home = cityNamed(homeCityOf(q));
  if (home) h += `<div class="qt-stat"><span class="qt-label">Home</span><b>${esc(home.name)}</b></div>`;
  if (q.room || q.trip || q.rest) h += `<div class="qt-stat"><span class="qt-label">At the tables</span><b class="${exhausted(q, now) ? 'qw-tired' : ''}">${esc(hoursText(tableMinutes(q, now)))} of ${MAX_TABLE_MINUTES / 60}h</b></div>`;
  h += `<div class="qt-goal"><span class="qt-label">To ${money(GOAL)}</span><span class="qt-bar"><span style="width:${(100 * goalProgress(q.bankroll)).toFixed(1)}%"></span></span>`;
  h += `<span class="qt-meta">Best ${money(q.best)} · ${q.history.length} session${q.history.length === 1 ? '' : 's'}</span></div>`;
  h += '</section>';
  if (note) h += `<p class="pl-desc">${esc(note)}</p>`;
  // A backer's test in progress takes the lobby until it's done (#356).
  if (backerTest) return h + testHtml(backerTest);
  if (testResult) h += testResultHtml(testResult);
  h += backingHtml(q, minutes);
  h += inboxHtml(q, minutes, mastered);
  if (review?.length) h += reviewHtml(review);
  if (st === 'won') {
    h += `<section class="qt-end"><h2>A million.</h2><p>You turned ${money(START_BANKROLL)} into ${money(q.bankroll)} in ${q.history.length} sessions and ${(q.hands || 0).toLocaleString('en-US')} hands, over ${esc(durationText(runMinutes))} of game time.</p>`;
    h += '<button class="tr-start" data-qnew="won">Start a new run</button></section>';
    return h + statsHtml(q, names) + runsHtml(q);
  }
  if (st === 'broke') {
    h += `<section class="qt-end"><h2>Broke.</h2><p>Your bankroll can’t cover a seat anywhere. This run peaked at ${money(q.best)} over ${q.history.length} session${q.history.length === 1 ? '' : 's'}.</p>`;
    h += `<button class="tr-start" data-qnew="broke">Start again with ${money(START_BANKROLL)}</button></section>`;
    return h + statsHtml(q, names) + runsHtml(q);
  }
  // A new run: choose where to put down roots.
  if (!q.room && !q.trip) return h + regionPickerHtml() + statsHtml(q, names) + runsHtml(q);
  // On the road: the trip takes real time, and you can study on the way.
  if (q.trip) return h + travelHtml(q, now, minutes, study) + statsHtml(q, names) + runsHtml(q);
  // Asleep: the night runs on the game clock, like a trip.
  if (q.rest) return h + sleepHtml(q, now, minutes, study) + statsHtml(q, names) + runsHtml(q);
  const all = listsNow(q.seed, minutes, homeRoomOf(q)?.id);
  const here = all.find(r => r.room.id === room.id);
  // Other cities' local clubs are only known to the people who live there.
  const rooms = all.filter(r => r.room.id === room.id || knownRoom(q, r.room));
  const mine = listStatus(q, now);
  const city = cityOf(room);
  const homeRoom = homeRoomOf(q);
  const isHome = city?.id === homeCityOf(q);
  h += `<section class="qt-room${isHome ? ' qw-at-home' : ''}">`;
  // At home, it says so (#299).
  if (isHome) h += `<span class="qw-home-badge">Home · ${esc(city.name)}</span>`;
  h += `<h2>${esc(room.name)}</h2><p class="qt-meta">${esc(room.kind)}${city ? ` · ${esc(city.name)}, ${esc(city.region.name)}` : ''}</p>`;
  // Away from home: go home whenever you like, to your home club (#299).
  if (homeRoom && homeRoom.id !== room.id) {
    const cost = tripCost(room, homeRoom);
    const atHome = cityOf(homeRoom)?.id === city?.id;
    h += `<div class="qt-open-acts qw-gohome"><button class="cc-btn" data-qgohome="go"${q.bankroll < cost ? ' disabled' : ''}>${atHome ? 'Back to' : 'Go home to'} ${esc(homeRoom.name)} · ${clock(travelMinutes(room, homeRoom) * 60000)}${cost ? ` · ${money(cost)}` : ''}</button></div>`;
  }
  // Your seat is ready: take it before the floor gives it away.
  for (const l of mine.filter(x => x.called)) {
    const game = here?.games.find(g => g.key === l.key);
    if (!game) continue;
    h += `<div class="qw-called"><b>Your seat is ready: ${esc(gameLabel(game))}.</b><span class="qt-meta">${Number.isFinite(l.expires) ? `Take it within <b data-qcount="${realAt(now, minutes, l.expires)}">${esc(gameClock(realAt(now, minutes, l.expires) - now))}</b>, or it goes to the next name.` : 'It’s held for you.'}</span>`;
    h += `<div class="qt-open-acts"><button class="tr-start" data-qopen="${esc(game.ids[0])}">Take the seat</button><button class="cc-btn" data-qpass="${esc(l.key)}">Pass</button></div></div>`;
  }
  if (!here?.games.length) h += '<p class="pl-desc">Nothing’s running here right now. Come back later, or try another room.</p>';
  else {
    h += '<ul class="qw-games">';
    for (const game of here.games) h += gameRowHtml(q, room, game, mine.find(l => l.key === game.key), now, minutes);
    h += '</ul>';
  }
  h += '</section>';
  h += restHtml(q, room, now);
  h += '<p class="qt-meta qw-away">The clock stops while you’re away from the game, except to finish a trip or a night’s sleep, or while your name’s on a list: do something else and you’ll hear when your seat’s ready.</p>';
  // Waiting for a seat: study while you wait.
  if (mine.some(l => !l.called)) h += studyHtml(q, study, 'while you wait');
  h += otherRoomsHtml(rooms, room, q);
  const opened = open && here?.games.find(g => g.ids.includes(open));
  if (opened) h += openTableHtml(q, room, opened, open, minutes, names, have, amount, generic);
  return h + statsHtml(q, names) + runsHtml(q) + newRunHtml(q, confirmNew);
}

// Start over (#299): a new run at $1,000 at home. This one goes into the
// records first, and what carries over after going broke carries over here.
// Asks once before it does it.
function newRunHtml(q, confirm) {
  let h = '<section class="qt-newrun">';
  if (!confirm) return h + '<button class="link-btn" data-qquit="ask">Start a new run</button></section>';
  h += `<p><b>Start over at ${money(START_BANKROLL)}?</b> This run (${money(q.bankroll)} now, best ${money(q.best)}, ${q.history.length} session${q.history.length === 1 ? '' : 's'}) is saved to your records. Your reads, stats and backers carry over.</p>`;
  return h + '<div class="qt-open-acts"><button class="tr-start" data-qnew="quit">Start a new run</button><button class="cc-btn" data-qquit="no">Keep playing</button></div></section>';
}

export const gameLabel = g => `${g.stakes} ${GAMES[g.game]?.name || GAMES.nlhe.name}`;
// Real time (ms) when the clock reaches game minute `at`.
const realAt = (now, minutes, at) => Math.round(now + ((at - minutes) * 60000) / QUEST_SPEED);
/** A real-time countdown, "1:05", or "1:29:40" from an hour up. */
export const clock = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
// A wait in game minutes, roughly: "about 20 min", "under a minute". Every
// time the lobby shows is game time, like its clock, which runs QUEST_SPEED
// times as fast as real time.
const gameWait = gm => (gm < 1 ? 'under a minute' : `about ${Math.round(gm)} min`);
/** A countdown of `realMs` real milliseconds, shown in game time ("2:00:00" for a 30-minute real wait). */
export const gameClock = realMs => clock(realMs * QUEST_SPEED);

// Where to start a run: one card a region, with its small town.
function regionPickerHtml() {
  let h = '<section class="qt-room"><h2>Where do you want to start?</h2><p class="pl-desc">Every run starts at home: a small club in a small town. Build your bankroll there, then head up the road, where every place has more games.</p><ul class="qw-regions">';
  for (const r of REGIONS) {
    const town = r.cities.find(c => c.small);
    const club = ROOMS.find(x => x.local && x.city === town.id);
    h += `<li class="qw-region"><b class="qt-stakes">${esc(r.name)}</b><span class="qt-note">${esc(r.blurb)}</span><span class="qt-meta">Home: ${esc(club ? `${club.name}, ${town.name}` : town.name)}</span>`;
    h += `<button class="tr-start" data-qstart="${esc(r.id)}">Start in ${esc(r.name)}</button></li>`;
  }
  return h + '</ul></section>';
}

// On the road: where to, how long is left (in real time), and study.
function travelHtml(q, now, minutes, study) {
  const t = q.trip;
  const to = roomById(t.to);
  const from = roomById(t.from);
  const city = cityOf(to);
  const far = from && regionOf(from)?.id !== regionOf(to)?.id;
  const how = far ? 'Flying' : from && from.city === to.city ? 'Across town' : 'On the road';
  const start = realAt(now, minutes, t.start);
  const end = realAt(now, minutes, t.end);
  let h = `<section class="qw-trip" aria-live="polite"><span class="qt-label">${esc(how)}</span><h2>${esc(to.name)}</h2>`;
  h += `<p class="qt-meta">${esc(city ? `${city.name}, ${city.region.name}` : '')}</p>`;
  h += `<div class="qw-road" aria-hidden="true"><span class="qw-car${far ? ' qw-plane' : ''}" data-qmove="${start},${end}" style="left:${(100 * Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)))).toFixed(1)}%"></span></div>`;
  h += `<p class="qw-left">Arriving in <b data-qcount="${end}">${esc(gameClock(end - now))}</b> · ${esc(clockText(t.end))}</p>`;
  // A long trip runs on the game clock, not this page.
  if (t.end - t.start > 30) h += `<p class="qt-note">The trip goes on without you watching: play the Regulars, study, or close the page. Come back at ${esc(realTime(t.then === 'sleep' ? realAt(now, minutes, t.end + SLEEP_MINUTES) : end))} and you’ll be ${t.then === 'sleep' ? 'home and rested' : 'there'}.</p>`;
  h += '</section>';
  return h + studyHtml(q, study, 'on the way');
}

// A game in the room you're in: its tables, who's on the list, and your place.
function gameRowHtml(q, room, game, mine, now, minutes) {
  const afford = canSit(q, game.blinds, room);
  const {min, max} = buyInRange(game.blinds, room);
  let h = `<li class="qw-game${afford ? '' : ' qt-off'}"><div class="qt-top"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">${esc(GAMES[game.game]?.name || GAMES.nlhe.name)} · ${plural(game.tables, 'table')}</span></div>`;
  const shown = game.waiting.slice(0, 3).join(', ');
  const more = game.waiting.length > 3 ? ` and ${game.waiting.length - 3} more` : '';
  h += `<p class="qt-note">${game.waiting.length ? `Waiting: ${esc(shown)}${esc(more)}` : 'No one waiting'}</p>`;
  h += `<p class="qt-meta">Buy-in ${money(min)}–${money(max)}</p>`;
  if (mine?.called) h += '<p class="qw-you">Your seat is ready.</p>';
  else if (mine) {
    const at = realAt(now, minutes, mine.callAt);
    h += `<p class="qw-you">You’re ${mine.ahead ? `${ordinal(mine.ahead + 1)} on the list` : 'next'} · called in <b data-qcount="${at}">${esc(gameClock(at - now))}</b></p>`;
    h += `<button class="cc-btn qt-open-btn" data-qunlist="${esc(game.key)}">Take my name off</button>`;
  } else if (afford && exhausted(q, now)) h += '<p class="qt-note">Sleep before you put your name down again.</p>';
  else if (afford) h += `<button class="cc-btn qt-open-btn" data-qlist="${esc(game.key)}">Put my name down · ${esc(gameWait((game.waiting.length + 1) * game.gap))}</button>`;
  else h += `<p class="qt-note">Needs ${money(min)} to sit down.</p>`;
  return h + '</li>';
}

/** A real time of day, in the viewer's own clock: "10:42 PM". */
export const realTime = ms => new Date(ms).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

/** Game minutes as hours and minutes: "3h 20m", "45m". */
export const hoursText = m => {
  const h = Math.floor(m / 60), mm = Math.floor(m % 60);
  return h ? `${h}h${mm ? ` ${mm}m` : ''}` : `${mm}m`;
};

// Asleep: where, when you'll be up, and study meanwhile.
function sleepHtml(q, now, minutes, study) {
  const r = q.rest;
  const end = realAt(now, minutes, r.end);
  let h = `<section class="qw-trip" aria-live="polite"><span class="qt-label">${r.where === 'hotel' ? 'At the hotel' : 'At home'}</span><h2>Asleep</h2>`;
  h += `<p class="qw-left">Up in <b data-qcount="${end}">${esc(gameClock(end - now))}</b> · ${esc(clockText(r.end))}</p>`;
  h += `<p class="qt-note">The night goes on without you watching: play the Regulars, study, or close the page. Come back at ${esc(realTime(end))} and you’ll be rested.</p></section>`;
  return h + studyHtml(q, study, 'before bed');
}

// Rest and home: tired after a long session, sleep here (home, or a hotel
// away from it) or go home to sleep; away from home, make this city home.
function restHtml(q, room, now) {
  const played = tableMinutes(q, now);
  const homeId = homeCityOf(q);
  const atHome = cityOf(room)?.id === homeId;
  const homeRoom = homeRoomOf(q);
  const tired = exhausted(q, now);
  const sleepy = played >= TIRED_MINUTES;
  let h = `<section class="qw-rest${tired ? ' qw-rest-tired' : ''}"><h3>${tired ? 'You’re exhausted' : 'Rest'}</h3>`;
  h += `<p class="qt-meta">${tired ? `After ${MAX_TABLE_MINUTES / 60} hours at the tables you need ${hoursText(SLEEP_MINUTES)} of sleep before you play again.` : sleepy ? `${hoursText(played)} at the tables: time to think about bed.` : `${hoursText(played)} at the tables since you last slept, of ${MAX_TABLE_MINUTES / 60}.`}</p>`;
  h += '<div class="qt-open-acts">';
  if (atHome) h += '<button class="cc-btn" data-qsleep="home">Sleep at home</button>';
  else {
    const night = hotelCost(room);
    h += `<button class="cc-btn" data-qsleep="hotel"${q.bankroll < night ? ' disabled' : ''}>Get a hotel room · ${money(night)}</button>`;
    if (homeRoom) {
      const cost = tripCost(room, homeRoom);
      h += `<button class="cc-btn" data-qgohome="sleep"${q.bankroll < cost ? ' disabled' : ''}>Go home to sleep · ${clock(travelMinutes(room, homeRoom) * 60000)}${cost ? ` · ${money(cost)}` : ''}</button>`;
    }
  }
  h += '</div>';
  if (!atHome) {
    const cost = moveCost(homeId, room);
    h += `<p class="qt-meta">Living in ${esc(cityOf(room)?.name || '')} would put these games across town.</p>`;
    h += `<button class="cc-btn" data-qmovehome="1"${q.bankroll < cost ? ' disabled' : ''}>Move here · ${money(cost)}</button>`;
  }
  return h + '</section>';
}

// The other rooms, by city: their games and lists, how far, and the fare.
function otherRoomsHtml(rooms, room, q) {
  const here = regionOf(room);
  const order = [here, ...REGIONS.filter(r => r.id !== here?.id)].filter(Boolean);
  let h = '<section class="qt-rooms"><h2>Other rooms</h2>';
  for (const region of order) {
    const list = rooms.filter(x => x.room.id !== room.id && regionOf(x.room)?.id === region.id);
    if (!list.length) continue;
    h += `<h3 class="qw-region-name">${esc(region.name)}</h3><ul>`;
    for (const r of list) {
      const city = cityOf(r.room);
      const games = r.games.map(g => `${g.stakes}${g.game !== 'nlhe' ? ` ${GAMES[g.game]?.short || g.game}` : ''} (${g.waiting.length ? `${g.waiting.length} waiting` : 'no list'})`).join(' · ') || 'Quiet right now';
      const mins = travelMinutes(room, r.room);
      h += `<li class="qt-other"><span class="qt-other-name"><b>${esc(r.room.name)}</b><span class="qt-meta">${esc(city?.name || '')} · ${esc(r.room.kind)}</span><span class="qt-meta">${esc(games)}</span></span>`;
      const fare = tripCost(room, r.room);
      h += `<button class="cc-btn" data-qgo="${esc(r.room.id)}"${q.bankroll < fare ? ' disabled' : ''}>Go there · ${clock(mins * 60000)}${fare ? ` · ${money(fare)}` : ''}</button></li>`;
    }
    h += '</ul>';
  }
  return h + '</section>';
}

// A study question while travelling or waiting (quest-study.js), with how the
// last one went. play.js handles data-qans.
function studyHtml(q, study, when) {
  const s = q.study || {n: 0, right: 0};
  const qn = question(q.seed, s.n);
  let h = `<section class="qw-study"><h2>Study ${esc(when)}</h2>`;
  if (study?.last) h += `<p class="${study.last.right ? 'qw-right' : 'qw-wrong'}">${study.last.right ? 'Right.' : 'Not quite.'} ${esc(study.last.why)}</p>`;
  h += `<p class="qw-q">${esc(qn.text)}</p><div class="qw-choices">`;
  qn.choices.forEach((c, i) => { h += `<button class="cc-btn" data-qans="${i}">${esc(c)}</button>`; });
  h += '</div>';
  if (s.n) h += `<p class="qt-meta">${s.right} of ${s.n} right so far</p>`;
  h += '<p class="qt-meta">Or study the <a href="#charts">pre-flop charts</a> or the <a href="#trainer">ranges trainer</a>; the clock keeps running.</p>';
  return h + '</section>';
}

// The inbox (#355, quest-scenarios.js): offers waiting for an answer first,
// then the newest news, unread ones marked. play.js handles data-qsc
// ("<message id>:<answer>") and marks them read once shown.
const INBOX_SHOWN = 5;
function inboxHtml(q, minutes, mastered = 0) {
  const all = q.inbox || [];
  if (!all.length) return '';
  const offers = openOffers(q, minutes);
  // An answered offer is replaced by its news ("You staked…"), so it isn't shown again.
  const news = all.filter(m => !offers.includes(m) && !m.offer?.answered).slice(0, Math.max(0, INBOX_SHOWN - offers.length));
  const fresh = unread(q);
  let h = `<section class="qs-inbox" aria-live="polite"><h2>Inbox${fresh ? ` <span class="qs-new">${fresh} new</span>` : ''}</h2><ul>`;
  for (const m of offers) {
    h += `<li class="qs-offer"><p>${esc(m.text)}</p><div class="qt-open-acts">`;
    if (m.offer.kind === 'stake') {
      const affordable = q.bankroll >= m.offer.amount;
      h += `<button class="tr-start" data-qsc="${m.id}:accept"${affordable ? '' : ' disabled'}>Stake them ${money(m.offer.amount)}</button>`;
      h += `<button class="cc-btn" data-qsc="${m.id}:more">Ask for ${Math.round(Math.min(0.8, m.offer.share + 0.15) * 100)}% of the profit</button>`;
      h += `<button class="cc-btn" data-qsc="${m.id}:less">Offer ${money(halfOf(m.offer.amount))} instead</button>`;
      h += `<button class="cc-btn" data-qsc="${m.id}:decline">No thanks</button>`;
    } else if (m.offer.kind === 'backer') {
      h += `<button class="tr-start" data-qsc="${m.id}:test">Take the test</button><button class="cc-btn" data-qsc="${m.id}:decline">No thanks</button>`;
    } else if (m.offer.kind === 'backer-settle') {
      h += m.offer.owed ? `<button class="tr-start" data-qsc="${m.id}:pay">Pay ${money(Math.min(m.offer.owed, q.bankroll))}</button><button class="cc-btn" data-qsc="${m.id}:stiff">Keep it</button>`
        : `<button class="tr-start" data-qsc="${m.id}:pay">Tell them</button>`;
    } else {
      h += `<button class="tr-start" data-qsc="${m.id}:confront">Ask about the money</button><button class="cc-btn" data-qsc="${m.id}:letgo">Let it go</button>`;
    }
    h += '</div>';
    if (m.offer.kind === 'backer') {
      const mark = passMark(q, mastered);
      h += `<span class="qt-meta">${BACKER.hands} hands from Ducybot’s ranges: get ${mark}% right. ${mastered ? `Your ${mastered} mastered 6-max spot${mastered === 1 ? '' : 's'} in Pre-flop ranges lowered the mark.` : 'Mastering 6-max spots in <a href="#trainer">Pre-flop ranges</a> lowers the mark.'}${horseRep(q) < 0 ? ' Your name with backers raised it.' : ''}</span>`;
    }
    h += m.offer.expires >= NEVER ? '</li>' : `<span class="qt-meta">${esc(clockText(m.at))} · answer by ${esc(clockText(m.offer.expires))}</span></li>`;
  }
  for (const m of news) h += `<li class="${m.read ? '' : 'qs-unread'}"><p>${esc(m.text)}</p><span class="qt-meta">${esc(clockText(m.at))}</span></li>`;
  return h + '</ul></section>';
}

// A backer's test (#356): the hand, its spot and question, and the actions.
// play.js handles data-qbt (the action's index). No feedback until the end.
function testHtml(t) {
  if (t.loading) return '<section class="qb-test"><p class="pl-desc">Dealing the test…</p></section>';
  let h = `<section class="qb-test" aria-live="polite"><span class="qt-label">${esc(t.name)}’s 6-max test · hand ${t.n + 1} of ${t.of} · ${t.mark}% to pass</span>`;
  h += `<h2>${esc(t.title)}</h2><p class="qb-ask">${esc(t.question)}</p>`;
  h += `<div class="qb-cards">${t.cards.map(c => `<span class="qb-card${'hd'.includes(c[1]) ? ' r' : ''}">${esc(c[0])}${{s: '♠', h: '♥', d: '♦', c: '♣'}[c[1]]}</span>`).join('')}</div>`;
  h += `<div class="qt-open-acts">${t.actions.map((a, k) => `<button class="${k === 0 ? 'cc-btn' : 'tr-start'}" data-qbt="${k}">${esc(a)}</button>`).join('')}</div>`;
  return h + '<p class="qt-meta">Pick what Ducybot would do most often. You’ll see how you did at the end.</p></section>';
}

// How the last test went, with the hands missed.
function testResultHtml(r) {
  let h = `<section class="qb-result ${r.passed ? 'qr-right' : 'qr-wrong'}"><h2>${r.passed ? 'Passed' : 'Not this time'}: ${r.right} of ${r.of} (${r.pct}%)</h2>`;
  h += `<p class="qt-meta">You needed ${r.mark}%.</p>`;
  if (r.passed && r.cut != null) h += `<p>You scored ${r.pct}%: they’ll take ${Math.round(r.cut * 100)}% of the profit.</p>`;
  if (r.misses.length) {
    h += '<ul>';
    for (const m of r.misses.slice(0, 6)) {
      const top = m.mix.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).filter(([p]) => p >= 3).map(([p, i]) => `${m.verbs[i]} ${Math.round(p)}%`).join(' · ');
      h += `<li>${esc(m.hand.cards.join(' '))} · ${esc(m.hand.id.replace(/^hu-/, 'heads-up ').replace(/-/g, ' '))}: you chose ${esc(m.verbs[m.k] || '?')}; Ducybot: ${esc(top)}</li>`;
    }
    h += '</ul>';
  }
  return h + '<button class="cc-btn" data-qbtdone="1">Done</button></section>';
}

// Who's backing you, until when.
function backingHtml(q, minutes) {
  const b = q.backing;
  if (!b || b.due) return '';
  return `<p class="qb-backed">${esc(b.name)} is backing you: ${money(b.amount)} to play ${b.stakes[0] / 100}/${b.stakes[1] / 100} until ${esc(clockText(b.end))}. Then they get their money back and ${Math.round(b.share * 100)}% of your profit.</p>`;
}

// The hall of records: wins (fastest first), then the best peaks.
function runsHtml(q) {
  if (!q.runs?.length) return '';
  let h = '<section class="qt-runs"><h2>Hall of records</h2><ul>';
  for (const r of hallOfRecords(q.runs)) {
    const how = r.result === 'won' ? `Won in ${durationText(r.minutes)}`
      : r.result === 'quit' ? `Ended at ${money(r.final ?? 0)} · best ${money(r.peak)}`
      : `Broke · peak ${money(r.peak)}`;
    const parts = [how, `${r.sessions} session${r.sessions === 1 ? '' : 's'}`];
    if (r.hands) parts.push(`${r.hands.toLocaleString('en-US')} hands`);
    h += `<li>${esc(parts.join(' · '))}</li>`;
  }
  return h + '</ul></section>';
}

const signed = n => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;

// Stats for the run: the bankroll line, results by stakes, the biggest pots,
// results with the named Regulars, and how well you read players.
function statsHtml(q, names) {
  const hist = q.history || [];
  if (!hist.length && !q.readStats && !q.stakes?.length) return '';
  let h = '<section class="qt-stats"><h2>Your run</h2>';
  const chart = bankrollChart(bankrollSeries(hist), 560, 160, money);
  if (chart) h += `<div class="qs-box">${chart}</div>`;
  const rows = byStakes(hist);
  if (rows.length) {
    h += '<div class="qs-scroll"><table class="qs-table"><thead><tr><th>Stakes</th><th>Sessions</th><th>Hands</th><th>Won</th><th>bb/100</th></tr></thead><tbody>';
    for (const r of rows) h += `<tr><td>${esc(r.stakes)}</td><td>${r.sessions}</td><td>${r.hands.toLocaleString('en-US')}</td><td>${signed(r.net)}</td><td>${r.bb100 == null ? '—' : r.bb100.toFixed(1)}</td></tr>`;
    h += '</tbody></table></div>';
  }
  const pots = biggestPots(hist);
  const facts = [];
  if (pots.won > 0) facts.push(`Biggest pot won ${money(pots.won)}`);
  if (pots.lost < 0) facts.push(`biggest lost ${money(-pots.lost)}`);
  if (facts.length) h += `<p class="qt-meta">${esc(facts.join(' · '))}</p>`;
  const regs = withRegulars(hist).slice(0, 6);
  if (regs.length) h += `<p class="qt-meta">With the Regulars: ${regs.map(r => `${esc(names(r.id))} ${signed(r.net)} (${r.sessions})`).join(' · ')}</p>`;
  if (q.readStats) h += `<p class="qt-meta">Your reads: first reads right ${esc(accuracyText(q.readStats.first))} · later reads ${esc(accuracyText(q.readStats.later))}</p>`;
  const st = stakingTotals(q);
  if (st.count || st.outstanding) {
    const parts = [];
    if (st.count) parts.push(`${plural(st.count, 'stake')} settled: ${money(st.staked)} put up, ${money(st.returned)} back (${signed(st.net)}, ${st.roi >= 0 ? '+' : '−'}${Math.abs(Math.round(st.roi * 100))}%)`);
    if (st.outstanding) parts.push(`${money(st.outstanding)} still out`);
    h += `<p class="qt-meta">Staking: ${esc(parts.join(' · '))}</p>`;
  }
  return h + '</section>';
}

// The last session's reads: each tagged player's real style against your
// tag; for the others, only what their hands suggested (their real style
// stays yours to read).
function reviewHtml(rows) {
  const shown = rows.filter(r => r.tag || r.guess);
  if (!shown.length) return '';
  let h = '<section class="qt-review"><h2>Your reads last session</h2><ul>';
  for (const r of shown) {
    const real = FAMILY_NAMES[r.family].toLowerCase();
    const line = r.tag
      ? (r.right ? `You read ${r.name} as a ${real}. Right.` : `You read ${r.name} as a ${TAG_NAMES[r.tag].toLowerCase()}. ${r.name} is a ${real}.`)
      : `${r.name} ${r.guess.why}, like a ${FAMILY_NAMES[r.guess.family].toLowerCase()}.`;
    h += `<li class="${r.tag ? (r.right ? 'qr-right' : 'qr-wrong') : ''}">${esc(line)}</li>`;
  }
  return h + '</ul></section>';
}

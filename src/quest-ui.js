// Bankroll Quest's lobby (#303): your bankroll, the clock and the goal; the
// room you're in and its tables, with who's sitting there; the other rooms,
// a trip away; and the end of a run. Pure: it builds the page from the quest
// (quest.js) and the rooms (quest-rooms.js), and play.js handles the
// buttons (data-qopen to open a table, data-qsit to sit down there with the
// amount you typed, data-qgo to travel, data-qnew to start a new run).

import { GOAL, START_BANKROLL, buyInRange, canSit, clockText, gameMinutes, status } from './quest.js';
import { GAMES, ROOMS, TRAVEL_MINUTES, cheapestBuyIn, lobby, roomById } from './quest-rooms.js';
import { WHALES, lineupFor, stacksAt } from './quest-lineup.js';
import { FAMILY_NAMES, personOf } from './quest-people.js';
import { TAG_NAMES, accuracyText, tagOf } from './quest-reads.js';
import { bankrollChart, bankrollSeries, biggestPots, byStakes, durationText, hallOfRecords, withRegulars } from './quest-stats.js';
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

function tableHtml(q, room, game, id, minutes, names, have, generic) {
  const blinds = game.blinds;
  const afford = canSit(q, blinds, room);
  const who = lineupFor(q.seed, id, game.stakes, minutes, have, {generic});
  const whale = who.find(w => WHALES.includes(w));
  const {min, max} = buyInRange(blinds, room);
  let h = `<li class="qt-table${afford ? '' : ' qt-off'}">`;
  h += `<div class="qt-top"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">${esc(GAMES[game.game]?.name || GAMES.nlhe.name)} · 6-max</span>`;
  h += `<span class="qt-faces">${who.map(w => (faceOf(w) ? `<img src="${avatarUrl(faceOf(w))}" alt="${esc(nameOfBot(w, names))}" title="${esc(nameOfBot(w, names))}">` : '')).join('')}</span></div>`;
  if (whale) h += `<p class="qt-note">${esc(names(whale))} is playing here.</p>`;
  // Players you've tagged, so you can find them again.
  const known = who.filter(w => tagOf(q, w) && tagOf(q, w) !== 'unsure');
  if (known.length) h += `<p class="qt-note">${known.map(w => `${esc(nameOfBot(w, names))} (${esc(TAG_NAMES[tagOf(q, w)].toLowerCase())})`).join(', ')}</p>`;
  h += `<p class="qt-meta">Buy-in ${money(min)}–${money(max)}</p>`;
  if (afford) h += `<button class="cc-btn qt-open-btn" data-qopen="${esc(id)}">Open table</button>`;
  else h += `<p class="qt-note">Needs ${money(min)} to sit down.</p>`;
  return h + '</li>';
}

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
export function questLobbyHtml(q, now = Date.now(), {names = id => id, have = null, note = '', open = null, amount = 0, generic = false, review = null} = {}) {
  const minutes = gameMinutes(q, now);
  const st = status(q, cheapestBuyIn());
  const room = currentRoom(q);
  const runMinutes = Math.max(0, minutes - (q.started ?? minutes));
  let h = '<div class="pl-head"><h1>Bankroll challenge</h1></div>';
  h += '<section class="qt-head">';
  h += `<div class="qt-stat"><span class="qt-label">Bankroll</span><b class="qt-big">${money(q.bankroll)}</b></div>`;
  h += `<div class="qt-stat"><span class="qt-label">Clock</span><b>${esc(clockText(minutes))}</b></div>`;
  h += `<div class="qt-goal"><span class="qt-label">To ${money(GOAL)}</span><span class="qt-bar"><span style="width:${(100 * goalProgress(q.bankroll)).toFixed(1)}%"></span></span>`;
  h += `<span class="qt-meta">Best ${money(q.best)} · ${q.history.length} session${q.history.length === 1 ? '' : 's'}</span></div>`;
  h += '</section>';
  if (note) h += `<p class="pl-desc">${esc(note)}</p>`;
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
  const rooms = lobby(q.seed, minutes);
  const here = rooms.find(r => r.room.id === room.id);
  h += `<section class="qt-room"><h2>${esc(room.name)}</h2><p class="qt-meta">${esc(room.kind)}</p>`;
  if (!here?.games.length) h += '<p class="pl-desc">Nothing’s running here right now. Come back later, or try another room.</p>';
  else {
    h += '<ul class="qt-tables">';
    for (const game of here.games) for (const id of game.ids) h += tableHtml(q, room, game, id, minutes, names, have, generic);
    h += '</ul>';
  }
  h += '</section>';
  h += '<section class="qt-rooms"><h2>Other rooms</h2><ul>';
  for (const r of rooms.filter(x => x.room.id !== room.id)) {
    const games = r.games.map(g => `${g.stakes}${g.game && g.game !== 'nlhe' ? ` ${GAMES[g.game]?.short || g.game}` : ''}${g.tables > 1 ? ` ×${g.tables}` : ''}`).join(' · ') || 'Quiet right now';
    h += `<li class="qt-other"><span class="qt-other-name"><b>${esc(r.room.name)}</b><span class="qt-meta">${esc(r.room.kind)} · ${esc(games)}</span></span>`;
    h += `<button class="cc-btn" data-qgo="${esc(r.room.id)}">Go there · ${TRAVEL_MINUTES} min</button></li>`;
  }
  h += '</ul></section>';
  const opened = open && here?.games.find(g => g.ids.includes(open));
  if (opened) h += openTableHtml(q, room, opened, open, minutes, names, have, amount, generic);
  return h + statsHtml(q, names) + runsHtml(q);
}

// The hall of records: wins (fastest first), then the best peaks.
function runsHtml(q) {
  if (!q.runs?.length) return '';
  let h = '<section class="qt-runs"><h2>Hall of records</h2><ul>';
  for (const r of hallOfRecords(q.runs)) {
    const parts = [r.result === 'won' ? `Won in ${durationText(r.minutes)}` : `Broke · peak ${money(r.peak)}`, `${r.sessions} session${r.sessions === 1 ? '' : 's'}`];
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
  if (!hist.length && !q.readStats) return '';
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

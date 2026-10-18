// Bankroll Quest's lobby (#303): your bankroll, the clock and the goal; the
// room you're in and its tables, with who's sitting there; the other rooms,
// a trip away; and the end of a run. Pure: it builds the page from the quest
// (quest.js) and the rooms (quest-rooms.js), and play.js handles the
// buttons (data-qopen to open a table, data-qsit to sit down there with the
// amount you typed, data-qgo to travel, data-qnew to start a new run).

import { GOAL, START_BANKROLL, buyInRange, canSit, clockText, gameMinutes, status } from './quest.js';
import { ROOMS, TRAVEL_MINUTES, cheapestBuyIn, lobby, roomById } from './quest-rooms.js';
import { WHALES, lineupFor, stacksAt } from './quest-lineup.js';
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

function tableHtml(q, room, game, id, minutes, names, have) {
  const blinds = game.blinds;
  const afford = canSit(q, blinds, room);
  const who = lineupFor(q.seed, id, game.stakes, minutes, have);
  const whale = who.find(w => WHALES.includes(w));
  const {min, max} = buyInRange(blinds, room);
  let h = `<li class="qt-table${afford ? '' : ' qt-off'}">`;
  h += `<div class="qt-top"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">No-limit Hold’em · 6-max</span>`;
  h += `<span class="qt-faces" aria-hidden="true">${who.map(w => (botAvatar(w) ? `<img src="${avatarUrl(botAvatar(w))}" alt="">` : '')).join('')}</span></div>`;
  if (whale) h += `<p class="qt-note">${esc(names(whale))} is playing here.</p>`;
  h += `<p class="qt-meta">Buy-in ${money(min)}–${money(max)}</p>`;
  if (afford) h += `<button class="cc-btn qt-open-btn" data-qopen="${esc(id)}">Open table</button>`;
  else h += `<p class="qt-note">Needs ${money(min)} to sit down.</p>`;
  return h + '</li>';
}

// An open table (like walking up to it): who's there and the chips in front
// of each, and how much you want to buy in for. play.js handles data-qsit
// (reads #qt-amt), data-qamt (sets it) and data-qclose.
function openTableHtml(q, room, game, id, minutes, names, have, amount) {
  const blinds = game.blinds;
  const who = lineupFor(q.seed, id, game.stakes, minutes, have);
  const stacks = stacksAt(q.seed, id, who, blinds, room, minutes);
  const ask = buyInAsk(q, blinds, room);
  let h = '<div class="qt-open-bg" data-qclose="1"></div>';
  h += `<section class="qt-open" role="dialog" aria-label="${esc(game.stakes)} at ${esc(room.name)}">`;
  h += `<div class="qt-open-head"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">${esc(room.name)} · No-limit Hold’em · 6-max</span></div>`;
  h += '<ul class="qt-seats">';
  who.forEach((w, i) => {
    const face = botAvatar(w) ? `<img src="${avatarUrl(botAvatar(w))}" alt="">` : '<span class="qt-noface"></span>';
    h += `<li>${face}<span class="qt-seat-name">${esc(names(w))}</span><b class="qt-seat-chips">${money(stacks[i])}</b></li>`;
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
 * `open` the id of the table you've opened, to choose your buy-in.
 */
export function questLobbyHtml(q, now = Date.now(), {names = id => id, have = null, note = '', open = null, amount = 0} = {}) {
  const minutes = gameMinutes(q, now);
  const st = status(q, cheapestBuyIn());
  const room = currentRoom(q);
  let h = '<div class="pl-head"><h1>Bankroll challenge</h1></div>';
  h += '<section class="qt-head">';
  h += `<div class="qt-stat"><span class="qt-label">Bankroll</span><b class="qt-big">${money(q.bankroll)}</b></div>`;
  h += `<div class="qt-stat"><span class="qt-label">Clock</span><b>${esc(clockText(minutes))}</b></div>`;
  h += `<div class="qt-goal"><span class="qt-label">To ${money(GOAL)}</span><span class="qt-bar"><span style="width:${(100 * goalProgress(q.bankroll)).toFixed(1)}%"></span></span>`;
  h += `<span class="qt-meta">Best ${money(q.best)} · ${q.history.length} session${q.history.length === 1 ? '' : 's'}</span></div>`;
  h += '</section>';
  if (note) h += `<p class="pl-desc">${esc(note)}</p>`;
  if (st === 'won') {
    h += `<section class="qt-end"><h2>A million.</h2><p>You turned ${money(START_BANKROLL)} into ${money(q.bankroll)} in ${q.history.length} sessions.</p>`;
    h += '<button class="tr-start" data-qnew="won">Start a new run</button></section>';
    return h;
  }
  if (st === 'broke') {
    h += `<section class="qt-end"><h2>Broke.</h2><p>Your bankroll can’t cover a seat anywhere. This run peaked at ${money(q.best)} over ${q.history.length} session${q.history.length === 1 ? '' : 's'}.</p>`;
    h += `<button class="tr-start" data-qnew="broke">Start again with ${money(START_BANKROLL)}</button></section>`;
    return h + runsHtml(q);
  }
  const rooms = lobby(q.seed, minutes);
  const here = rooms.find(r => r.room.id === room.id);
  h += `<section class="qt-room"><h2>${esc(room.name)}</h2><p class="qt-meta">${esc(room.kind)}</p>`;
  if (!here?.games.length) h += '<p class="pl-desc">Nothing’s running here right now. Come back later, or try another room.</p>';
  else {
    h += '<ul class="qt-tables">';
    for (const game of here.games) for (const id of game.ids) h += tableHtml(q, room, game, id, minutes, names, have);
    h += '</ul>';
  }
  h += '</section>';
  h += '<section class="qt-rooms"><h2>Other rooms</h2><ul>';
  for (const r of rooms.filter(x => x.room.id !== room.id)) {
    const games = r.games.map(g => `${g.stakes}${g.tables > 1 ? ` ×${g.tables}` : ''}`).join(' · ') || 'Quiet right now';
    h += `<li class="qt-other"><span class="qt-other-name"><b>${esc(r.room.name)}</b><span class="qt-meta">${esc(r.room.kind)} · ${esc(games)}</span></span>`;
    h += `<button class="cc-btn" data-qgo="${esc(r.room.id)}">Go there · ${TRAVEL_MINUTES} min</button></li>`;
  }
  h += '</ul></section>';
  const opened = open && here?.games.find(g => g.ids.includes(open));
  if (opened) h += openTableHtml(q, room, opened, open, minutes, names, have, amount);
  return h + runsHtml(q);
}

function runsHtml(q) {
  if (!q.runs?.length) return '';
  let h = '<section class="qt-runs"><h2>Past runs</h2><ul>';
  for (const r of [...q.runs].reverse().slice(0, 5)) h += `<li>${r.result === 'won' ? 'Won' : 'Broke'} · peak ${money(r.peak)} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}</li>`;
  return h + '</ul></section>';
}

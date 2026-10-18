// Bankroll Quest's lobby (#303): your bankroll, the clock and the goal; the
// room you're in and its tables, with who's sitting there; the other rooms,
// a trip away; and the end of a run. Pure: it builds the page from the quest
// (quest.js) and the rooms (quest-rooms.js), and play.js handles the
// buttons (data-qsit / data-qbb to sit down, data-qgo to travel, data-qnew to
// start a new run).

import { GOAL, START_BANKROLL, buyInRange, canSit, clockText, gameMinutes, status } from './quest.js';
import { ROOMS, STAKES, TRAVEL_MINUTES, cheapestBuyIn, lobby, roomById } from './quest-rooms.js';
import { WHALES, lineupFor } from './quest-lineup.js';
import { chipText } from './chip-format.js';
import { avatarUrl, botAvatar } from './avatars.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = n => `$${chipText(n)}`;
// The buy-ins offered, in big blinds, within the room's range.
const BUY_INS = [40, 100, 200];

/** How far along the road from $1,000 to $1,000,000, 0 to 1 (by multiples). */
export function goalProgress(bankroll) {
  if (bankroll <= START_BANKROLL) return 0;
  return Math.min(1, Math.log(bankroll / START_BANKROLL) / Math.log(GOAL / START_BANKROLL));
}

/** The room the quest is in (the first one to start with). */
export const currentRoom = q => roomById(q.room) || ROOMS[0];

/** A table's buy-in choices, in chips: [{bb, chips, ok}] within the room's range and what you can afford. */
export function buyInChoices(q, stakes, room) {
  const blinds = STAKES[stakes];
  const {min, max} = buyInRange(blinds, room);
  const bbs = [...new Set([Math.round(min / blinds[1]), ...BUY_INS, Math.round(max / blinds[1])])]
    .filter(bb => bb * blinds[1] >= min && bb * blinds[1] <= max).sort((a, b) => a - b);
  return bbs.map(bb => ({bb, chips: bb * blinds[1], ok: bb * blinds[1] <= q.bankroll}));
}

function tableHtml(q, room, game, id, minutes, names, have) {
  const blinds = game.blinds;
  const afford = canSit(q, blinds, room);
  const who = lineupFor(q.seed, id, game.stakes, minutes, have);
  const whale = who.find(w => WHALES.includes(w));
  let h = `<li class="qt-table${afford ? '' : ' qt-off'}">`;
  h += `<div class="qt-top"><span class="qt-stakes">${esc(game.stakes)}</span><span class="qt-meta">No-limit Hold’em · 6-max</span>`;
  h += `<span class="qt-faces" aria-hidden="true">${who.map(w => (botAvatar(w) ? `<img src="${avatarUrl(botAvatar(w))}" alt="">` : '')).join('')}</span></div>`;
  if (whale) h += `<p class="qt-note">${esc(names(whale))} is playing here.</p>`;
  if (afford) {
    h += '<div class="qt-buyins">';
    for (const c of buyInChoices(q, game.stakes, room)) {
      h += `<button class="cc-btn" data-qsit="${esc(id)}" data-qbb="${c.bb}"${c.ok ? '' : ' disabled'}>${c.bb} BB · ${money(c.chips)}</button>`;
    }
    h += '</div>';
  } else h += `<p class="qt-note">Needs ${money(buyInRange(blinds, room).min)} to sit down.</p>`;
  return h + '</li>';
}

/**
 * The lobby. `names(id)` gives a Regular's name; `have` the personality ids
 * this engine has (or null); `note` a line to show (e.g. after leaving).
 */
export function questLobbyHtml(q, now = Date.now(), {names = id => id, have = null, note = ''} = {}) {
  const minutes = gameMinutes(q, now);
  const st = status(q, cheapestBuyIn());
  const room = currentRoom(q);
  let h = '<div class="pl-head"><h1>Bankroll quest</h1></div>';
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
  return h + runsHtml(q);
}

function runsHtml(q) {
  if (!q.runs?.length) return '';
  let h = '<section class="qt-runs"><h2>Past runs</h2><ul>';
  for (const r of [...q.runs].reverse().slice(0, 5)) h += `<li>${r.result === 'won' ? 'Won' : 'Broke'} · peak ${money(r.peak)} · ${r.sessions} session${r.sessions === 1 ? '' : 's'}</li>`;
  return h + '</ul></section>';
}

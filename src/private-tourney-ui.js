// The page of a one-off private tournament (#394): Start a game's
// Tournament form, then the tournament's own page for everyone in it: the
// lobby (the code and link to share, who has registered, Start for the
// host), how it's going while it runs, and the places and payouts at the
// end. HTML builders only; private-tourney-room.js owns the state and the
// clicks (data-tz="…").
//
// Tournament chips are whole numbers; payouts are shares of the places paid.

import { GAMES, maxSeats } from './club-tables.js';
import { levelText } from './club-tourneys-ui.js';
import { PAYOUTS, results } from './private-tourney.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const whole = n => Number(n || 0).toLocaleString('en-US');
const pct = bp => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
export const ordinal = n => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
const gameName = id => (id === 'nlhe' ? 'Hold’em' : GAMES.find(g => g.id === id)?.label || id);
// "in 4 min", "in 1 h 5 min", "now"
function until(t, now = Date.now()) {
  const m = Math.ceil((t - now) / 60_000);
  if (m <= 0) return 'now';
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

const chip = (on, attr, value, text) => `<button type="button" class="sg-chip${on ? ' on' : ''}" ${attr}="${esc(value)}" aria-pressed="${on}">${text}</button>`;
const field = (label, body) => `<div class="sg-field"><span class="sg-label">${label}</span>${body}</div>`;

// ---- the form ----

// The Tournament form, after Start a game's heading and kind. `f`: {name,
// game, stack, tableSize, payout}; `editor`: the blind structure editor
// (tourney-structure-ui.js); `lead`: Start a game's fields that come first
// (your name, the first time, and the kind of game); `levelsOpen`: the blind
// levels shown.
export function setupHtml(f, editor, {lead = '', note = '', placeholder = 'Friday night tournament', levelsOpen = false} = {}) {
  let h = '<div class="sg-wrap"><div class="sg-form pz-form" data-tzform>' + lead;
  h += field('Game', `<div class="sg-chips">${GAMES.filter(g => !g.bomb).map(g => chip(f.game === g.id, 'data-tzgame', g.id, esc(gameName(g.id)))).join('')}</div>`);
  h += field('Starting stack', `<div class="sg-nums"><input class="pl-text" type="number" name="stack" min="20" step="1" value="${esc(f.stack)}" data-tzstack></div>`);
  h += field('Players a table', `<div class="sg-chips">${[2, 3, 4, 5, 6, 7, 8, 9].filter(n => n <= maxSeats(f.game)).map(n => chip(f.tableSize === n, 'data-tzsize', n, n)).join('')}</div>`);
  // The levels folded away: a preset suits most games.
  const steps = editor.steps(), levels = steps.filter(s => !s.break);
  const mins = [...new Set(levels.map(s => s.minutes))];
  const sum = `${levels.length} levels${mins.length === 1 ? ` of ${mins[0]} min` : ''}, from ${whole(levels[0]?.sb)}/${whole(levels[0]?.bb)}`;
  h += field('Blinds', `<details class="pz-levels" data-tzlevels${levelsOpen || editor.errors().length ? ' open' : ''}><summary>${esc(sum)}</summary><div class="pz-editor" data-tseditor>${editor.html()}</div></details>`);
  h += field('Payouts', `<div class="sg-chips">${PAYOUTS.map(p => chip(f.payout === p.id, 'data-tzpay', p.id, esc(p.label))).join('')}</div>`);
  h += field('Name it', `<input class="pl-text" name="name" maxlength="40" placeholder="${esc(placeholder)}" value="${esc(f.name)}">`);
  h += '<p class="pl-desc">Any number of players: with more than a table seats, it runs on several tables and moves players to keep them even. Everyone starts with the same tournament chips; there are no buy-ins.</p>';
  if (note) h += `<p class="pl-desc pl-neterr">${esc(note)}</p>`;
  h += '<button class="tr-start sg-open" type="button" data-tz="open">Open the lobby</button></div>';
  h += '<aside class="sg-invite"><span class="sg-invite-title">Invite your friends</span>';
  h += '<div class="sg-code" aria-hidden="true">····-····</div><p class="sg-note">The code and link come once the lobby is open. Players register there, and you start when everyone is in.</p></aside></div>';
  return h;
}

// ---- the tournament's page ----

// Live standings: the level, when it changes, who's left and the chip leaders.
function liveHtml(b, me, now) {
  const l = b.live;
  if (!l) return '<p class="pl-meta">Dealing the first hands…</p>';
  const parts = [levelText(b.structure, l)];
  if (l.stepEndsAt) parts.push(`next ${until(l.stepEndsAt, now)}`);
  parts.push(`${l.playersLeft} left on ${l.tables.length} table${l.tables.length === 1 ? '' : 's'}`);
  if (l.playersLeft) parts.push(`average ${whole(Math.round((b.players.length * b.stack) / l.playersLeft))}`);
  if (l.handForHand) parts.push('hand for hand');
  let h = `<p class="pz-live"><b>${esc(parts.filter(Boolean).join(' · '))}</b></p>`;
  if (l.standings?.length) {
    h += '<span class="sg-label">Chip counts</span><ol class="cl-standings">';
    h += l.standings.slice(0, 10).map(s => `<li>${s.id === me ? `<b>${esc(s.name)} (you)</b>` : esc(s.name)} <span class="pl-meta">${whole(s.stack)}${s.absent ? ' · away' : ''}</span></li>`).join('');
    h += '</ol>';
  }
  return h;
}

// The places so far (or final), with the payout shares.
function placesHtml(b, me, final) {
  const rows = results(b);
  if (!rows.length) return '';
  let h = `<span class="sg-label">${final ? 'Results' : 'Knocked out'}</span><table class="cl-acct pz-places"><tbody>`;
  for (const r of rows) {
    h += `<tr${r.id === me ? ' class="pz-me"' : ''}><th>${ordinal(r.place)}</th><td>${esc(r.name)}${r.id === me ? ' (you)' : ''}</td><td>${r.share ? pct(r.share) : ''}</td></tr>`;
  }
  return h + '</tbody></table>';
}

function blindsHtml(b) {
  let h = `<details class="cl-tdetails"><summary>Blinds and payouts</summary><div class="cl-tlobby">`;
  h += `<p class="pl-meta">${esc(gameName(b.game))} · starting stack ${whole(b.stack)} · ${b.tableSize} a table</p>`;
  h += `<span class="pl-label">Payouts${b.status === 'scheduled' ? ' (for the players so far)' : ''}</span><table class="cl-acct"><tbody>`;
  h += b.paid.map(p => `<tr><th>${ordinal(p.place)}</th><td>${pct(p.share)}</td></tr>`).join('');
  h += '</tbody></table>';
  h += '<span class="pl-label">Blinds</span><table class="cl-acct"><thead><tr><th>Level</th><th>Blinds</th><th>Ante</th><th>Minutes</th></tr></thead><tbody>';
  let n = 0;
  for (const s of b.structure || []) {
    if (s.break) { h += `<tr><td colspan="3" class="pl-meta">Break</td><td>${s.minutes}</td></tr>`; continue; }
    n++;
    h += `<tr><td>${n}</td><td>${whole(s.sb)}/${whole(s.bb)}</td><td>${s.ante ? whole(s.ante) : '–'}</td><td>${s.minutes}</td></tr>`;
  }
  return h + '</tbody></table></div></details>';
}

// The page: `b` the lobby body (private-tourney.js lobbyBody); `ui` = {me,
// host (this tab runs it), link, note, atTable, connecting}.
export function pageHtml(b, ui, now = Date.now()) {
  const {me, host = false, link = '', note = '', atTable = false} = ui;
  let h = `<div class="pl-head"><h1>${esc(b?.name || 'Tournament')}</h1></div>`;
  const err = note ? `<p class="pl-desc pl-neterr">${esc(note)}</p>` : '';
  if (!b) {
    return h + err + `<section class="cl-card"><p class="pl-meta">${ui.connecting === false ? 'Not connected.' : 'Connecting to the tournament…'}</p><div class="pl-actions"><button class="btn-small" data-tz="done">${ui.connecting === false ? 'Close' : 'Cancel'}</button></div></section>`;
  }
  const mine = b.players.find(p => p.id === me);
  const over = b.status === 'finished' || b.status === 'cancelled';
  h += '<div class="sg-wrap"><div class="sg-form pz-page">';
  h += err;
  if (b.status === 'scheduled') {
    h += `<p class="pz-status">${host ? 'Your lobby is open. Share the code; you start when everyone is in.' : `Waiting for ${esc(b.host)} to start.`}</p>`;
    h += `<span class="sg-label">Registered (${b.players.length})</span><ul class="pz-players">`;
    for (const p of b.players) {
      const tags = [p.id === me ? 'you' : '', p.away ? 'away' : ''].filter(Boolean).join(', ');
      h += `<li><span>${esc(p.name)}${tags ? ` <span class="pl-meta">(${tags})</span>` : ''}</span>`;
      if (host && p.id !== me) h += `<button type="button" class="link-btn" data-tz="remove" data-id="${esc(p.id)}">Remove</button>`;
      h += '</li>';
    }
    h += '</ul>';
    if (host) {
      const enough = b.players.length >= 2;
      h += `<div class="pl-actions"><button class="tr-start sg-open" data-tz="start"${enough ? '' : ' disabled'}>Start</button><button class="btn-small" data-tz="cancel">Cancel tournament</button></div>`;
      if (!enough) h += '<p class="pl-desc">It needs at least 2 players.</p>';
    } else h += '<div class="pl-actions"><button class="btn-small" data-tz="leave">Leave</button></div>';
  } else if (b.status === 'running') {
    if (mine?.place) h += `<p class="pz-status">You finished <b>${ordinal(mine.place)}</b>. Stay to watch how it ends.</p>`;
    else if (mine) h += `<div class="pl-actions"><button class="tr-start sg-open" data-tz="table">${atTable ? 'Back to the table' : 'Go to your table'}</button></div>`;
    h += liveHtml(b, me, now);
    h += placesHtml(b, me, false);
  } else if (b.status === 'finished') {
    const win = b.players.find(p => p.place === 1);
    h += `<p class="pz-status">${win ? `${win.id === me ? '<b>You won!</b>' : `<b>${esc(win.name)}</b> won.`}` : 'It’s over.'}${mine?.place && mine.place > 1 ? ` You finished ${ordinal(mine.place)}.` : ''}</p>`;
    h += placesHtml(b, me, true);
  } else {
    h += `<p class="pz-status">The tournament was cancelled${b.why ? `: ${esc(b.why)}` : ''}.</p>`;
  }
  if (over) h += `<div class="pl-actions"><button class="tr-start" data-tz="done">${host ? 'Close the tournament' : 'Done'}</button></div>`;
  if (!over) h += blindsHtml(b);
  h += '</div>';
  // The code and link, while players can still come.
  if (b.status === 'scheduled') {
    h += '<aside class="sg-invite"><span class="sg-invite-title">Invite your friends</span>';
    h += `<div class="sg-code pz-code">${esc(b.code)}</div>`;
    h += '<p class="sg-note">They enter the code on Play, or open the link.</p>';
    if (link) h += `<div class="pl-actions"><button class="btn-small primary" data-tz="copy">Copy link</button></div><p class="pl-meta pz-link">${esc(link)}</p>`;
    h += '</aside>';
  }
  return h + '</div>';
}

// The line above the felt while playing: the level, when it goes up, and how
// many are left.
export function bannerText(b, now = Date.now()) {
  const l = b?.live;
  if (!l || b.status !== 'running') return '';
  return [b.name, levelText(b.structure, l), l.stepEndsAt ? `next ${until(l.stepEndsAt, now)}` : '', `${l.playersLeft} left`].filter(Boolean).join(' · ');
}

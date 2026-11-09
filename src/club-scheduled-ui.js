// Scheduled cash games on the page (#599): a member's Upcoming (sign up,
// check in, your seat), and the owner's Scheduled list with its form.
// clubs.js draws them and sends what their buttons say:
//   member  data-cl="sched-act" data-code data-id data-type (sign_up | leave | check_in)
//           data-cl="offer-sit" data-code data-table (your seat, at the start)
//   owner   data-cl="sched-new" | "sched-edit" data-id | "sched-cancel" data-id
//           | "sched-start" data-id | "sched-close"; the form: data-schedform

import { CHECK_IN_MS, localToUtc, roster, timeLeft, utcToLocal, whenText } from './club-scheduled.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Redraws when a countdown or check-in changes: `render` once a minute
// while there's an upcoming game, and as check-in opens or a game starts.
let tick = null;
function tickAt(games, render) {
  if (tick || !games.length) return;
  const now = Date.now();
  const next = Math.min(now + 60_000, ...games.flatMap(g => [g.checkInAt, g.startAt]).filter(t => t > now));
  tick = setTimeout(() => { tick = null; render(); }, Math.max(1000, next - now + 500));
}

// What member `m` sees of game `g`: [meta, buttons].
function mine(m, g, hostHere) {
  const k = `data-code="${esc(m.code)}" data-id="${esc(g.id)}"${hostHere ? '' : ' disabled'}`;
  const btn = (type, label, primary = false) => `<button class="btn-small${primary ? ' primary' : ''}" data-cl="sched-act" data-type="${type}" ${k}>${label}</button>`;
  const me = g.mine;
  const now = Date.now();
  if (g.status === 'cancelled') return ['Cancelled', ''];
  if (g.status === 'started') {
    if (!me) return ['Started', ''];
    if (me.result === 'seated') {
      const t = (m.tables || []).find(x => x.id === me.table);
      return [`Your seat · ${t?.name || 'Table'}`, t ? `<button class="btn-small primary" data-cl="offer-sit" data-code="${esc(m.code)}" data-table="${esc(t.id)}"${hostHere ? '' : ' disabled'}>Sit</button>` : ''];
    }
    return [me.result === 'waitlist' ? 'On the waitlist' : me.result === 'noShow' ? 'Missed check-in' : 'Not seated', ''];
  }
  if (!me) {
    const meta = `${g.taken}/${g.players} signed up${g.waiting ? ` · ${g.waiting} waiting` : ''}`;
    return [meta, g.status === 'upcoming' ? btn('sign_up', g.taken >= g.players ? 'Join waitlist' : 'Sign up', true) : ''];
  }
  const where = me.place ? `Waitlist #${me.place}` : me.promoted ? 'You got a seat' : 'You’re in';
  if (g.status === 'short') return [`${where} · Waiting on the owner`, ''];
  // Open by the club's clock when it said so, else by this page's.
  const open = g.checkInOpen ?? (now >= g.checkInAt && now < g.startAt);
  const parts = [where];
  if (me.edited) parts.push('Updated');
  let acts = '';
  if (me.checkedIn) parts.push('Checked in');
  else if (open) acts += btn('check_in', 'Check in', true);
  else parts.push(`Check-in in ${timeLeft(g.checkInAt, now)}`);
  acts += btn('leave', 'Leave');
  return [parts.join(' · '), acts];
}

// A member's Upcoming: the club's scheduled games, each with its time in
// their own time zone and what they can do.
export function upcomingHtml(m, hostHere, {gameName, render}) {
  const games = (m.scheduled || []).slice().sort((a, b) => a.startAt - b.startAt);
  if (!games.length) return '';
  tickAt(games.filter(g => g.status === 'upcoming'), render);
  let h = '<h3 class="cl-menu-head">Upcoming</h3><ul class="cl-tables cl-tcards cl-sched">';
  for (const g of games) {
    const [meta, acts] = mine(m, g, hostHere);
    h += `<li class="cl-game-head" data-sched="${esc(g.id)}"><span><b>${esc(gameName(g))}</b><span class="pl-meta cl-when">${esc(whenText(g.startAt))}</span>`;
    h += `<span class="pl-meta${g.mine ? ' cl-mine' : ''}">${esc(meta)}</span></span><span class="cl-sched-acts">${acts}</span></li>`;
  }
  return h + '</ul>';
}

// ---- the owner's ----

// This browser's time zone, short: "CST".
const zoneName = (at = Date.now()) => new Intl.DateTimeFormat('en-US', {timeZoneName: 'short'}).formatToParts(at).find(p => p.type === 'timeZoneName')?.value || '';

const CHECK_INS = [15, 30, 60, 120];

// The form: a new game (`form.id` empty) or one being changed. `games`: the
// games it can be, [{key, label, seats}].
function formHtml(form, games, club) {
  const g = form.id ? club.scheduled?.find(x => x.id === form.id) : null;
  const pick = g?.game.key || form.key || games[0]?.key || '';
  const seats = g?.game.seats || games.find(x => x.key === pick)?.seats || 6;
  const at = g ? utcToLocal(g.startAt) : form.at || '';
  let h = `<form class="pl-form cl-schedform" data-schedform="${esc(form.id || '')}"><div class="tf-grid">`;
  if (g) h += `<label>Game<input class="pl-text" value="${esc(games.find(x => x.key === pick)?.label || pick)}" disabled></label>`;
  else h += `<label>Game<select class="pl-text" name="key" required>${games.map(x => `<option value="${esc(x.key)}"${x.key === pick ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>`;
  h += `<label>Starts (${esc(zoneName())})<input class="pl-text" type="datetime-local" name="at" value="${esc(at)}" required></label>`;
  h += `<label>Players<input class="pl-text" type="number" name="players" min="2" max="60" value="${g?.players || seats}" required></label>`;
  h += `<label>Fewest to start<input class="pl-text" type="number" name="minPlayers" min="2" max="60" value="${g?.minPlayers || 2}" required></label>`;
  const ci = Math.round((g?.checkInMs || CHECK_IN_MS) / 60_000);
  h += `<label>Check-in<select class="pl-text" name="checkInMins">${CHECK_INS.map(n => `<option value="${n}"${n === ci ? ' selected' : ''}>${n < 60 ? `${n} min` : `${n / 60} hr`} before</option>`).join('')}</select></label>`;
  h += '</div>';
  if (form.note) h += `<p class="pl-desc pl-neterr">${esc(form.note)}</p>`;
  h += `<div class="cl-formacts"><button class="btn-small primary" type="submit">${g ? 'Save' : 'Schedule'}</button><button class="btn-small" type="button" data-cl="sched-close">Cancel</button></div>`;
  return h + '</form>';
}

// The form read: {spec} for schedule_game / edit_scheduled, or {note} why not.
export function readSchedForm(f) {
  const v = n => f.elements[n]?.value;
  const startAt = localToUtc(v('at'));
  if (!Number.isFinite(startAt)) return {note: 'Pick a date and time.'};
  const spec = {startAt, players: Number(v('players')), minPlayers: Number(v('minPlayers')), checkInMins: Number(v('checkInMins'))};
  if (f.elements.key) spec.key = v('key');
  return {spec};
}

// The owner's Scheduled: Schedule a game (the form), and each game with its
// time, its lists, and Edit and Cancel; one short of players at its start
// asks: Start short, or Cancel.
export function ownerScheduledHtml(club, {games, form, name}) {
  const list = (club.scheduled || []).slice().sort((a, b) => a.startAt - b.startAt);
  let h = '<section class="cl-sched-owner"><div class="mg-head"><h3>Scheduled</h3>';
  if (!form) h += `<button class="btn-small" data-cl="sched-new"${games.length ? '' : ' disabled'}>Schedule a game</button>`;
  h += '</div>';
  if (form) h += formHtml(form, games, club);
  if (!list.length) return h + '</section>';
  h += '<ul class="cl-sched-list">';
  for (const g of list) {
    const r = roster(g);
    const label = games.find(x => x.key === g.game.key)?.label || g.game.key;
    const state = {upcoming: '', short: 'Too few checked in', started: 'Started', cancelled: 'Cancelled'}[g.status];
    h += `<li data-sched="${esc(g.id)}"><div class="cl-sched-row"><span><b>${esc(label)}</b><span class="pl-meta">${esc(whenText(g.startAt))}${state ? ` · ${state}` : ''}</span></span><span class="cl-sched-acts">`;
    if (g.status === 'short') {
      h += `<button class="btn-small primary" data-cl="sched-start" data-id="${esc(g.id)}">Start short</button>`;
      h += `<button class="btn-small" data-cl="sched-cancel" data-id="${esc(g.id)}" data-ask="Cancel this game?" data-yes="Cancel game">Cancel</button>`;
    } else if (g.status === 'upcoming') {
      h += `<button class="btn-small" data-cl="sched-edit" data-id="${esc(g.id)}">Edit</button>`;
      h += `<button class="btn-small" data-cl="sched-cancel" data-id="${esc(g.id)}" data-ask="Cancel this game?" data-yes="Cancel game">Cancel</button>`;
    }
    h += '</span></div>';
    if (g.note) h += `<p class="pl-desc pl-neterr">${esc(g.note)}</p>`;
    const col = (title, ids) => `<div><h4>${title} <span class="pl-meta">${ids.length}</span></h4>${ids.length ? `<ul>${ids.map(id => `<li>${esc(name(id))}</li>`).join('')}</ul>` : ''}</div>`;
    h += `<div class="cl-sched-roster">${col('Signed up', r.signedUp)}${col('Checked in', r.checkedIn)}${col('Waitlist', r.waitlist)}${col('No-shows', r.noShows)}</div></li>`;
  }
  return h + '</ul></section>';
}

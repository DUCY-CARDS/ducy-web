// The club page's tournaments (#64): the host's Tournaments tab (a new
// tournament with its blind structure, the lobby, payouts, live standings
// and results) and a member's list (register, unregister, play, late
// registration and re-entry). HTML builders and form readers only; clubs.js
// owns the state and sends the actions.
//
// Club chips (buy-ins, prizes) are shown divided by 100 (chip-format.js);
// tournament chips (stacks, blinds) are whole numbers.

import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { GAMES } from './club-tables.js';
import { entryCount, playerCount, pool, prizes, payoutShares } from './club-tourneys.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const whole = n => Number(n || 0).toLocaleString();
const club$ = n => chipText(n);
const gameName = id => GAMES.find(g => g.id === id)?.label || id;
const dateTime = t => new Date(t).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const ordinal = n => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
// "in 2 h 5 min", "in 3 min", "now"
function until(t, now = Date.now()) {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `on ${dateTime(t)}`;
}
// A datetime-local input's value for time `t`, and back.
const localInput = t => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = v => (v ? new Date(v).getTime() : NaN);

const STATUS = {scheduled: 'Registering', running: 'Running', finished: 'Finished', cancelled: 'Cancelled'};

// The level being played, as text: "Level 3 · 50/100 (ante 10)", or a break.
export function levelText(structure, live) {
  if (!live) return '';
  if (live.onBreak) return 'On a break';
  const lv = structure.filter(s => !s.break)[live.level];
  if (!lv) return '';
  return `Level ${live.level + 1} · ${whole(lv.sb)}/${whole(lv.bb)}${lv.ante ? ` (ante ${whole(lv.ante)})` : ''}`;
}

// ---- the host ----

// The New tournament form. `editor`: the blind structure editor
// (tourney-structure-ui.js); `last`: the last settings used.
export function tourneyFormHtml(editor, last = {}, now = Date.now()) {
  const opens = now, starts = now + 60 * 60_000;
  const field = (label, html) => `<label>${label}${html}</label>`;
  const num = (name, value, attrs = '') => `<input class="pl-text" name="${name}" type="number" step="1" value="${esc(value)}" ${attrs}>`;
  let h = '<form class="cl-tableform tf" data-tourneyform="1">';
  h += '<div class="tf-fields">';
  h += field('Name', `<input class="pl-text" name="name" maxlength="40" placeholder="Tournament" value="${esc(last.name || '')}">`);
  h += field('Game', `<select class="pl-text" name="game">${GAMES.map(g => `<option value="${g.id}"${g.id === (last.game || 'nlhe') ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}</select>`);
  h += field('Buy-in (club chips)', `<input class="pl-text" name="buyIn" type="number" min="0" step="${CHIP_STEP}" value="${esc(chipInput(last.buyIn ?? 0))}">`);
  h += field('Added to the prize pool', `<input class="pl-text" name="added" type="number" min="0" step="${CHIP_STEP}" value="${esc(chipInput(last.added ?? 0))}">`);
  h += field('Starting stack', num('stack', last.stack || 10000, 'min="20" data-tstack="1"'));
  h += field('Table size', num('tableSize', Math.min(last.tableSize || 9, 9), 'min="2" max="9"'));
  h += field('Minimum players', num('minPlayers', last.minPlayers || 2, 'min="2"'));
  h += field('Maximum players', num('maxPlayers', last.maxPlayers || 50, 'min="2" max="1000"'));
  h += field('Registration opens', `<input class="pl-text" name="opensAt" type="datetime-local" value="${localInput(opens)}">`);
  h += field('Starts', `<input class="pl-text" name="startsAt" type="datetime-local" value="${localInput(starts)}">`);
  h += field('Late registration until the end of level', num('lateLevel', last.lateLevel ?? 0, 'min="0"'));
  h += `<label class="tf-check"><input type="checkbox" name="reentry"${last.reentry ? ' checked' : ''}> Re-entry after busting, during late registration</label>`;
  h += field('Re-entries per player (0: no limit)', num('maxReentries', last.maxReentries ?? 0, 'min="0"'));
  h += '</div>';
  h += `<div data-tseditor="1">${editor.html()}</div>`;
  h += '<p class="pl-desc">Players don’t need to be online at the start: anyone absent is dealt in and blinded off until they come. Below the minimum at the start time, it’s cancelled and every buy-in refunded.</p>';
  h += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Create tournament</button><button class="btn-small" type="button" data-cl="cancel-tourney-form">Cancel</button></div>';
  return h + '</form>';
}

// The form's settings, for club-tourneys.js's newTourney. Throws what's wrong.
export function readTourneyForm(f, editor) {
  const v = name => f.elements[name].value;
  const int = name => Number(v(name));
  const errs = editor.errors();
  if (errs.length) throw new Error(errs[0]);
  const buyIn = parseChips(v('buyIn') || '0'), added = parseChips(v('added') || '0');
  if (!Number.isSafeInteger(buyIn) || !Number.isSafeInteger(added)) throw new Error('The buy-in and added prize pool are amounts like 10 or 2.50.');
  return {
    name: v('name'), game: v('game'), buyIn, added, stack: int('stack'), tableSize: int('tableSize'),
    minPlayers: int('minPlayers'), maxPlayers: int('maxPlayers'),
    opensAt: fromLocal(v('opensAt')), startsAt: fromLocal(v('startsAt')),
    lateLevel: int('lateLevel'), reentry: f.elements.reentry.checked, maxReentries: int('maxReentries'),
    structure: editor.steps(),
  };
}

// The payouts: each paid place's share and prize; the host's editor when
// there's a `draft` (shares being edited). Shares are basis points; shown
// as percentages.
function payoutsHtml(t, draft) {
  const editing = !!draft;
  const amounts = prizes(t);
  const shares = payoutShares(t).slice(0, amounts.length);
  let h = `<div class="cl-payouts"><span class="pl-label">Payouts${t.payout ? '' : ' (defaults for the entries so far)'}</span>`;
  if (editing) {
    h += `<form data-payoutform="${esc(t.id)}"><table class="ts-levels"><thead><tr><th>Place</th><th>%</th><th></th></tr></thead><tbody>`;
    draft.forEach((bp, i) => {
      h += `<tr><td>${ordinal(i + 1)}</td><td><input class="pl-text" type="number" min="0.01" step="0.01" name="p${i}" value="${(bp / 100).toFixed(2)}"></td>`;
      h += `<td><button type="button" class="btn-small" data-cl="payout-remove" data-id="${esc(t.id)}" data-i="${i}" aria-label="Remove">✕</button></td></tr>`;
    });
    h += '</tbody></table>';
    h += `<div class="cl-formacts"><button type="button" class="btn-small" data-cl="payout-add" data-id="${esc(t.id)}">Add a place</button>`;
    h += '<button class="btn-small primary" type="submit">Save payouts</button>';
    h += `<button type="button" class="btn-small" data-cl="payout-default" data-id="${esc(t.id)}">Use the defaults</button>`;
    h += `<button type="button" class="btn-small" data-cl="payout-cancel">Cancel</button></div>`;
    h += '<p class="pl-desc">The shares must add up to exactly 100%; rounding goes to first place.</p></form>';
  } else {
    h += '<table class="cl-acct"><tbody>';
    amounts.forEach((a, i) => { h += `<tr><th>${ordinal(i + 1)}</th><td>${(shares[i] / 100).toFixed(2)}%</td><td>${club$(a)}</td></tr>`; });
    h += '</tbody></table>';
  }
  return h + '</div>';
}

// The shares in the payout form, in basis points, in order.
export function readPayoutForm(f) {
  const out = [];
  for (let i = 0; f.elements[`p${i}`]; i++) out.push(Math.round(Number(f.elements[`p${i}`].value) * 100));
  return out;
}

// The host's Tournaments tab. `club` has the tournaments; `live` how running
// ones are going; `ui` = {form, editor, last, payoutEdit: {id, places}}.
export function hostTourneysHtml(club, live, ui, now = Date.now()) {
  const list = [...(club.tourneys || [])].sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.startsAt - a.startsAt);
  let h = `<h3>Tournaments${list.length ? ` (${list.length})` : ''}</h3>`;
  h += ui.form ? tourneyFormHtml(ui.editor, ui.last, now) : '<div class="pl-actions"><button class="btn-small primary" data-cl="new-tourney">New tournament</button></div>';
  if (!list.length && !ui.form) h += '<p class="pl-meta">No tournaments yet.</p>';
  h += '<ul class="cl-list">';
  for (const t of list) {
    const players = playerCount(t), entries = entryCount(t);
    h += `<li class="cl-tourney"><span class="cl-name">${esc(t.name)}</span><span class="cl-status">${STATUS[t.status]}</span>`;
    h += `<span class="pl-meta">${esc(gameName(t.game))} · buy-in ${club$(t.buyIn)}${t.added ? ` + ${club$(t.added)} added` : ''} · stack ${whole(t.stack)} · ${players}/${t.maxPlayers} players${entries !== players ? `, ${entries} entries` : ''} · pool ${club$(pool(t))}</span>`;
    if (t.status === 'scheduled') h += `<span class="pl-meta">${now < t.opensAt ? `Registration opens ${until(t.opensAt, now)} · ` : ''}starts ${until(t.startsAt, now)} (${dateTime(t.startsAt)}) · at least ${t.minPlayers}</span>`;
    if (t.status === 'cancelled') h += `<span class="pl-meta">Cancelled${t.why ? `: ${esc(t.why)}` : ''}. Every buy-in was refunded.</span>`;
    if (t.status === 'scheduled' || t.status === 'running') {
      h += `<span class="cl-acts"><button class="btn-small" data-cl="payout-edit" data-id="${esc(t.id)}">Edit payouts</button>`;
      h += `<button class="btn-small" data-cl="cancel-tourney" data-id="${esc(t.id)}">Cancel</button></span>`;
    }
    const l = live?.[t.id];
    if (t.status === 'running' && l) {
      h += `<div class="cl-live"><b>${esc(levelText(t.structure, l))}</b>`;
      if (l.stepEndsAt) h += ` · next ${until(l.stepEndsAt, now)}`;
      h += ` · ${l.playersLeft} left on ${l.tables.length} table${l.tables.length === 1 ? '' : 's'}${l.handForHand ? ' · hand for hand' : ''}`;
      if (l.standings?.length) h += `<ol class="cl-standings">${l.standings.slice(0, 10).map(s => `<li>${esc(s.name)} <span class="pl-meta">${whole(s.stack)}${s.absent ? ' · away' : ''}</span></li>`).join('')}</ol>`;
      h += '</div>';
    }
    if (t.status === 'finished') {
      h += '<ol class="cl-standings">';
      for (const p of (t.paid || [])) h += `<li value="${p.place}">${esc(club.members[p.member]?.name || p.member)} <span class="pl-meta">${club$(p.amount)}</span></li>`;
      h += '</ol>';
    }
    if (t.status !== 'cancelled' && t.status !== 'finished') h += payoutsHtml(t, ui.payoutEdit?.id === t.id ? ui.payoutEdit.places : null);
    if (t.entries.length && t.status === 'scheduled') {
      const names = [...new Set(t.entries.map(e => club.members[e.member]?.name || e.member))];
      h += `<span class="pl-desc">Registered: ${names.map(esc).join(', ')}</span>`;
    }
    h += '</li>';
  }
  return h + '</ul>';
}

// ---- a member ----

// A member's list of the club's tournaments. `me`: their id; `playing`: the
// tournament they're at, if any.
export function memberTourneysHtml(mem, me, {hostHere, playing}, now = Date.now()) {
  const list = mem.tourneys || [];
  if (!list.length) return '';
  const code = esc(mem.code);
  let h = '<div class="cl-tourneys"><span class="pl-label">Tournaments</span><ul class="cl-tables">';
  for (const t of list) {
    const mine = t.players.some(p => p.id === me), inNow = t.in.includes(me);
    const place = t.places.filter(p => p.id === me).map(p => p.place).sort((a, b) => a - b)[0];
    const btn = (act, label, primary = false) => `<button class="btn-small${primary ? ' primary' : ''}" data-cl="${act}" data-code="${code}" data-tourney="${esc(t.id)}"${hostHere ? '' : ' disabled title="The host is away"'}>${label}</button>`;
    h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameName(t.game))} · buy-in ${club$(t.buyIn)} · ${t.players.length}/${t.maxPlayers} players · pool ${club$(t.pool)}`;
    if (t.status === 'scheduled') h += ` · starts ${until(t.startsAt, now)}`;
    if (t.status === 'running') h += t.live ? ` · ${esc(levelText(t.structure, t.live))} · ${t.live.playersLeft} left` : ' · running';
    if (t.status === 'finished') h += ' · finished';
    if (t.status === 'cancelled') h += ` · cancelled${t.why ? ` (${esc(t.why)})` : ''}`;
    h += '</span>';
    if (t.status === 'scheduled') {
      if (mine) h += btn('t-unregister', 'Unregister');
      else if (now >= t.opensAt && t.players.length < t.maxPlayers) h += btn('t-register', `Register (${club$(t.buyIn)})`, true);
    } else if (t.status === 'running') {
      const lateOpen = t.live ? t.live.level < t.lateLevel : false;
      if (inNow) h += playing === t.id ? '<button class="btn-small primary" data-cl="to-table">Back to the table</button>' : btn('t-play', 'Play', true);
      else if (lateOpen && (!mine || t.reentry)) h += btn('t-enter', mine ? `Re-enter (${club$(t.buyIn)})` : `Late register (${club$(t.buyIn)})`, true);
    }
    if (place) h += `<span class="pl-meta">You finished ${ordinal(place)}${t.status === 'finished' ? '' : ' (so far)'}</span>`;
    if (mem.tourneyError?.tourney === t.id) h += `<span class="pl-desc pl-neterr cl-err">${esc(mem.tourneyError.reason)}</span>`;
    if (t.status === 'finished' && t.places.length) {
      const top = t.places.filter(p => p.place <= t.prizes.length).sort((a, b) => a.place - b.place);
      h += `<span class="pl-desc">${top.map(p => `${ordinal(p.place)} ${esc(p.name)} ${club$(t.prizes[p.place - 1])}`).join(' · ')}</span>`;
    }
    h += '</li>';
  }
  return h + '</ul></div>';
}

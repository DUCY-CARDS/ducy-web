// What members and the club's manager see of High Hand promotions (#278):
// the members' Promotions panel, and the manager's Promotions part of
// Manage (set up, pause, end, approve and void). The promotions themselves
// are club-promos.js; clubs.js draws these and sends the manager's actions.

import { CATEGORIES, CATEGORY_NAMES, PERIODS, promosAdmin, VOID_MS } from './club-promos.js';
import { GAMES } from './club-tables.js';
import { chipInput, chipText, parseChips } from './chip-format.js';
import { ago } from './time-ago.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const chips = n => esc(chipText(n));
const SUIT = {s: '♠', h: '♥', d: '♦', c: '♣'};
const cardsHtml = cards => `<span class="cl-promo-cards">${(cards || []).map(c => {
  const s = String(c).at(-1).toLowerCase();
  return `<span class="cl-promo-card${s === 'h' || s === 'd' ? ' red' : ''}">${esc(String(c).slice(0, -1).replace('T', '10'))}${SUIT[s] || ''}</span>`;
}).join('')}</span>`;
const gameLabel = id => GAMES.find(g => g.id === id)?.label || id;
// A hand's name mid-sentence ("quad kings", "a royal flush"), and a tier's
// on its own ("Straight flush").
const lower = s => s.charAt(0).toLowerCase() + s.slice(1);
const tierName = c => { const s = CATEGORY_NAMES[c].replace(/^An? /, ''); return s.charAt(0).toUpperCase() + s.slice(1); };

// Time left in a period, e.g. "3 h 20 min left".
function left(end, now = Date.now()) {
  const m = Math.max(0, Math.round((end - now) / 60e3));
  if (m >= 48 * 60) return `${Math.round(m / 1440)} days left`;
  if (m >= 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''} left`;
  return `${m} min left`;
}

// ---- members ----

// The running promotions with their leaderboards or caps, and the latest
// prizes. '' when the club runs none.
export function memberPromosHtml(p, now = Date.now()) {
  const list = (p?.promos || []).filter(x => x.status === 'running');
  if (!list.length && !p?.recent?.length) return '';
  let h = '<div class="cl-promos">';
  for (const x of list) {
    h += `<div class="cl-promo"><div class="cl-promo-head"><b>${esc(x.name)}</b>${x.period ? `<span class="pl-meta">${left(x.period.end, now)}</span>` : '<span class="pl-meta">Not on right now</span>'}</div>`;
    h += `<p class="pl-desc">${esc(x.rules)}${x.minPlayers > 2 ? ` Hands with ${x.minPlayers} or more players dealt in count.` : ''}</p>`;
    if (x.kind === 'high_hand') {
      for (const g of x.games) {
        const leaders = x.leaders?.[g] || [];
        h += `<div class="cl-promo-board"><span class="pl-label">${esc(gameLabel(g))}</span>`;
        h += leaders.length
          ? `<ol>${leaders.map(l => `<li><b>${esc(l.name)}</b> ${esc(lower(l.hand))} ${cardsHtml(l.cards)}</li>`).join('')}</ol>`
          : '<span class="pl-meta">No qualifying hand yet.</span>';
        h += '</div>';
      }
    } else if (x.caps?.some(c => c.cap)) {
      h += `<ul class="cl-promo-caps">${x.caps.map(c => `<li>${esc(tierName(c.category))}: ${c.cap ? `${c.used} of ${c.cap} paid` : `${c.used} paid`}</li>`).join('')}</ul>`;
    }
    h += '</div>';
  }
  if (p?.recent?.length) {
    h += `<div class="cl-promo-recent"><span class="pl-label">Latest prizes</span><ul>${p.recent.slice(0, 5).map(r => `<li><b>${esc(r.name)}</b> ${esc(lower(r.hand))} ${cardsHtml(r.cards)} <span class="cl-chips">+${chips(r.amount)}</span> <span class="pl-meta">${esc(r.promo)} · ${esc(ago(r.at))}</span></li>`).join('')}</ul></div>`;
  }
  return h + '</div>';
}

// The table banner (#278): the promotions running for a table's hands, in
// a line: the high hand's leader to beat, or the bonuses still on offer.
// `table`: its id, `game`, and `tourney` (a tournament's table). '' if none.
export function tableBannerText(p, {table = '', game = '', tourney = false} = {}, now = Date.now()) {
  const on = (p?.promos || []).filter(x => x.status === 'running' && x.period && now < x.period.end && x.games.includes(game)
    && (tourney ? x.tourneys : !x.tables?.length || x.tables.includes(table)));
  const parts = on.map(x => {
    if (x.kind === 'high_hand') {
      const lead = x.leaders?.[game]?.[0];
      return lead ? `${x.name}: ${lower(lead.hand)} (${lead.name}) to beat` : `${x.name}: no qualifying hand yet`;
    }
    const open = (x.caps || []).filter(c => !c.cap || c.used < c.cap);
    if (!open.length) return `${x.name}: all paid this period`;
    return `${x.name}: ${open.map(c => `${tierName(c.category).toLowerCase()} ${chipText(c.amount)}`).join(', ')}`;
  });
  return parts.slice(0, 2).join(' · ') + (parts.length > 2 ? ` · ${parts.length - 2} more` : '');
}

// ---- the manager ----

const PERIOD_TEXT = {hour: 'Each hour', day: 'Each day', week: 'Each week (from Monday)', session: 'A session, on set days'};
const DAY_TEXT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CAT_OPTIONS = CATEGORIES.slice(3);
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// The form for a new promotion, or for changing `edit` (its settings).
function formHtml(edit, newKind = 'high_hand', cd = '') {
  const v = edit || {kind: newKind, games: ['nlhe'], every: 'day', prizes: [5000], minCategory: 'full_house', ties: 'split',
    tiers: [{category: 'quads', amount: 1000}, {category: 'straight_flush', amount: 2500}, {category: 'royal_flush', amount: 10000}], capPerTier: 5, capPerPlayer: 0, minPlayers: 4, minPot: 0, budget: 0, days: [5], from: 20 * 60, to: 23 * 60};
  const kind = v.kind;
  let h = `<form class="cl-promo-form" data-promoform="${esc(edit?.id || '')}"${cd}>`;
  if (!edit) {
    h += `<div class="pl-row"><label class="pl-label">Kind <select class="pl-text" name="kind" data-promokind="1">
      <option value="high_hand"${kind === 'high_hand' ? ' selected' : ''}>High hand of the period</option>
      <option value="bonus"${kind === 'bonus' ? ' selected' : ''}>Hand bonuses</option></select></label></div>`;
  } else h += `<input type="hidden" name="kind" value="${esc(kind)}">`;
  h += `<div class="pl-row"><label class="pl-label">Name <input class="pl-text" name="name" maxlength="40" value="${esc(v.name || '')}" placeholder="${kind === 'bonus' ? 'Hand bonuses' : 'High hand'}"></label></div>`;
  h += `<fieldset class="cl-promo-games"><legend class="pl-label">Games${kind === 'high_hand' ? ' (each its own contest)' : ''}</legend>${GAMES.map(g => `<label><input type="checkbox" name="games" value="${g.id}"${v.games.includes(g.id) ? ' checked' : ''}> ${esc(g.label)}</label>`).join(' ')}</fieldset>`;
  h += `<div class="pl-row"><label class="pl-label">Period <select class="pl-text" name="every" data-promoevery="1">${PERIODS.map(p => `<option value="${p}"${v.every === p ? ' selected' : ''}>${PERIOD_TEXT[p]}</option>`).join('')}</select></label></div>`;
  h += `<div class="pl-row cl-promo-session"${v.every === 'session' ? '' : ' hidden'}>${DAY_TEXT.map((d, i) => `<label><input type="checkbox" name="days" value="${i}"${(v.days || []).includes(i) ? ' checked' : ''}> ${d}</label>`).join(' ')}
    <label class="pl-label">From <input class="pl-text" type="time" name="from" value="${hhmm(v.from ?? 1200)}"></label><label class="pl-label">to <input class="pl-text" type="time" name="to" value="${hhmm(v.to ?? 1380)}"></label></div>`;
  if (kind === 'high_hand') {
    const pz = v.prizes || [];
    h += `<div class="pl-row"><label class="pl-label">1st <input class="pl-text cl-num" name="p1" inputmode="decimal" value="${pz[0] ? chipInput(pz[0]) : ''}"></label><label class="pl-label">2nd <input class="pl-text cl-num" name="p2" inputmode="decimal" value="${pz[1] ? chipInput(pz[1]) : ''}"></label><label class="pl-label">3rd <input class="pl-text cl-num" name="p3" inputmode="decimal" value="${pz[2] ? chipInput(pz[2]) : ''}"></label></div>`;
    h += `<div class="pl-row"><label class="pl-label">At least <select class="pl-text" name="minCategory">${CAT_OPTIONS.map(c => `<option value="${c}"${v.minCategory === c ? ' selected' : ''}>${esc(tierName(c))}</option>`).join('')}</select></label>
      <label class="pl-label">Ties <select class="pl-text" name="ties"><option value="split"${v.ties !== 'first' ? ' selected' : ''}>Split the prize</option><option value="first"${v.ties === 'first' ? ' selected' : ''}>First to make it wins</option></select></label></div>`;
  } else {
    const tiers = v.tiers || [];
    h += '<div class="cl-promo-tiers"><span class="pl-label">Bonuses (a hand pays only its highest one)</span>';
    for (let i = 0; i < 4; i++) {
      const t = tiers[i] || {};
      h += `<div class="pl-row"><select class="pl-text" name="tcat${i}"><option value="">—</option>${CAT_OPTIONS.map(c => `<option value="${c}"${t.category === c ? ' selected' : ''}>${esc(tierName(c))}</option>`).join('')}</select>
        <input class="pl-text cl-num" name="tamt${i}" inputmode="decimal" aria-label="Prize" placeholder="Prize" value="${t.amount ? chipInput(t.amount) : ''}"></div>`;
    }
    h += `</div><div class="pl-row"><label class="pl-label">At most <input class="pl-text cl-num" type="number" min="0" name="capPerTier" value="${v.capPerTier || ''}"> of each per period</label><label class="pl-label">and <input class="pl-text cl-num" type="number" min="0" name="capPerPlayer" value="${v.capPerPlayer || ''}"> per player</label> <span class="pl-meta">(blank: no limit)</span></div>`;
  }
  h += `<details class="cl-promo-more"${edit ? ' open' : ''}><summary>Conditions and budget</summary>
    <div class="pl-row"><label class="pl-label">Players dealt in, at least <input class="pl-text cl-num" type="number" min="2" max="9" name="minPlayers" value="${v.minPlayers ?? 4}"></label>
    <label class="pl-label">Pot, at least <input class="pl-text cl-num" name="minPot" inputmode="decimal" value="${v.minPot ? chipInput(v.minPot) : ''}"></label></div>
    <div class="pl-row"><label class="pl-label">Budget per period <input class="pl-text cl-num" name="budget" inputmode="decimal" value="${v.budget ? chipInput(v.budget) : ''}"></label> <span class="pl-meta">Blank: none. Over it, a high hand waits for you to approve it, and bonuses stop.</span></div>
    <div class="pl-row"><label><input type="checkbox" name="tourneys"${v.tourneys ? ' checked' : ''}> Tournament hands count too</label></div>
    <p class="pl-meta">Prizes are club chips the club gives; nothing comes out of the pots.</p></details>`;
  h += `<div class="pl-actions"><button class="tr-start" type="submit">${edit ? 'Save for the next period' : 'Start it'}</button><button class="btn-small" type="button" data-cl="promo-cancel"${cd}>Cancel</button></div>`;
  return h + '</form>';
}

// The manager's Promotions part: each promotion with its period so far, the
// awards (approve or void), and the latest qualifying hands.
export const hostPromosHtml = (club, opts = {}, now = Date.now()) => promosPartHtml(promosAdmin(club, now), {...opts, replay: club.code}, now);

// The same from promosAdmin's data `a`, for the host or (`code`: their
// club's) an assistant, whose buttons carry the code so they go to the
// host (#274); `disabled` while the club can't be reached.
// `replay`: the club's code, for the host, whose history holds the hands
// behind the prizes (#278).
export function promosPartHtml(a, {form = null, note = '', code = '', disabled = false, replay = ''} = {}, now = Date.now()) {
  a ||= {list: [], awards: [], hands: []};
  const cd = (code ? ` data-code="${esc(code)}"` : '') + (disabled ? ' disabled' : '');
  let h = '<div class="cl-promos-host">';
  if (note) h += `<p class="pl-desc pl-neterr">${esc(note)}</p>`;
  if (form) h += form.startsWith('new') ? formHtml(null, form === 'new-bonus' ? 'bonus' : 'high_hand', cd) : formHtml(a.list.find(p => p.id === form), 'high_hand', cd);
  else h += `<div class="pl-actions"><button class="tr-start" data-cl="promo-new"${cd}>New promotion</button></div>`;
  const live = a.list.filter(p => p.status !== 'ended');
  if (!live.length && !form) h += '<p class="pl-meta">No promotions yet. A high hand of the day, or bonuses for quads and better, give members something to chase. The prizes are club chips the club gives.</p>';
  for (const p of live) {
    h += `<div class="cl-promo"><div class="cl-promo-head"><b>${esc(p.name)}</b><span class="pl-meta">${p.status === 'paused' ? 'Paused' : p.period ? left(p.period.end, now) : 'Not on right now'}</span></div>`;
    h += `<p class="pl-desc">${esc(p.rules)}${p.next ? ' <span class="pl-meta">(changes waiting for the next period)</span>' : ''}</p>`;
    if (p.budget) h += `<p class="pl-meta">Paid this period: ${chips(p.paid)} of ${chips(p.budget)}</p>`;
    if (p.leaders) {
      for (const [g, list] of Object.entries(p.leaders)) {
        h += `<div class="cl-promo-board"><span class="pl-label">${esc(gameLabel(g))}</span>${list.length ? `<ol>${list.map(l => `<li><b>${esc(l.name)}</b> ${esc(lower(l.hand))} ${cardsHtml(l.cards)}</li>`).join('')}</ol>` : '<span class="pl-meta">No qualifying hand yet.</span>'}</div>`;
      }
    }
    if (p.caps) h += `<ul class="cl-promo-caps">${p.caps.map(c => `<li>${esc(tierName(c.category))} ${chips(c.amount)}: ${c.used}${p.capPerTier ? ` of ${p.capPerTier}` : ''} paid</li>`).join('')}</ul>`;
    h += `<div class="pl-actions"><button class="btn-small" data-cl="promo-edit" data-id="${esc(p.id)}"${cd}>Change</button>`;
    h += `<button class="btn-small" data-cl="promo-status" data-id="${esc(p.id)}" data-status="${p.status === 'paused' ? 'running' : 'paused'}"${cd}>${p.status === 'paused' ? 'Resume' : 'Pause'}</button>`;
    h += `<button class="btn-small" data-cl="promo-status" data-id="${esc(p.id)}" data-status="ended"${cd}>End</button></div></div>`;
  }
  if (a.awards.length) {
    h += '<h3>Prizes</h3><ul class="cl-list cl-promo-awards">';
    for (const w of a.awards) {
      const canVoid = w.status === 'held' || (w.status === 'paid' && now - (w.paidAt || w.at) < VOID_MS);
      h += `<li><span class="cl-name">${esc(w.name)}</span><span>${esc(lower(w.handName))} ${cardsHtml(w.cards)}</span><span class="cl-chips">${chips(w.amount)}</span>`;
      h += `<span class="pl-meta">${esc(w.promoName)}${w.place ? ` · ${w.place === 1 ? '1st' : w.place === 2 ? '2nd' : '3rd'}` : ''} · ${esc(ago(w.paidAt || w.at))}${w.status === 'void' ? ' · voided' : w.status === 'held' ? ' · waiting to be paid' : ''}</span>`;
      h += '<span class="cl-acts">';
      if (replay && w.hand) h += `<button class="btn-small" data-cl="promo-replay" data-code="${esc(replay)}" data-who="host" data-hand="${esc(w.hand)}">Replay</button>`;
      if (w.status === 'held') h += `<button class="btn-small primary" data-cl="promo-approve" data-id="${esc(w.id)}"${cd}>Pay it</button>`;
      if (canVoid) h += `<button class="btn-small" data-cl="promo-void" data-id="${esc(w.id)}"${cd}>Void</button>`;
      h += '</span></li>';
    }
    h += '</ul>';
  }
  if (a.hands.length) {
    h += `<details class="cl-history"><summary>Qualifying hands (${a.hands.length})</summary><ul>`;
    for (const x of a.hands) h += `<li><span class="pl-meta">${esc(ago(x.at))}</span> <b>${esc(x.name)}</b> ${esc(lower(x.handName))} ${cardsHtml(x.cards)} · ${esc(gameLabel(x.game))} · ${x.players} players${x.ineligible ? ` · <span class="pl-neterr">doesn’t count: ${esc(x.ineligible)}</span>` : ''}</li>`;
    h += '</ul></details>';
  }
  return h + '</div>';
}

// The settings in a promotion form; throws what's wrong with them.
export function readPromoForm(f) {
  const v = name => f.elements[name]?.value ?? '';
  const amount = (name, label) => {
    const t = v(name).trim();
    if (!t) return 0;
    const n = parseChips(t);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} is an amount like 10 or 2.50.`);
    return n;
  };
  const time = name => { const [hh, mm] = v(name).split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
  const checked = name => [...f.querySelectorAll(`[name=${name}]:checked`)].map(x => x.value);
  const kind = v('kind');
  const out = {
    kind, name: v('name'), games: checked('games'), every: v('every'),
    days: checked('days').map(Number), from: time('from'), to: time('to'),
    minPlayers: Number(v('minPlayers')) || 4, minPot: amount('minPot', 'The pot'), budget: amount('budget', 'The budget'),
    tourneys: !!f.elements.tourneys?.checked,
    // The manager's time zone now, as minutes to add to UTC.
    tz: -new Date().getTimezoneOffset(),
  };
  if (kind === 'high_hand') {
    out.prizes = ['p1', 'p2', 'p3'].map((n, i) => amount(n, `The ${['1st', '2nd', '3rd'][i]} prize`)).filter((x, i) => i === 0 || x > 0);
    out.minCategory = v('minCategory');
    out.ties = v('ties');
  } else {
    out.tiers = [0, 1, 2, 3].map(i => ({category: v(`tcat${i}`), amount: amount(`tamt${i}`, 'A bonus')})).filter(t => t.category);
    out.capPerTier = Number(v('capPerTier')) || 0;
    out.capPerPlayer = Number(v('capPerPlayer')) || 0;
  }
  return out;
}

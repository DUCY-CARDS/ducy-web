// Pre-flop charts (#charts): Ducybot's six-handed GTO strategy at each stack
// depth, and how each Regular actually plays, at the same spots. Each chart
// is a 13 × 13 grid of hands, every cell split into how often that hand
// folds, calls, raises and goes all-in.
//
// The data are static JSON files next to the page (charts/, from ducy-gto's
// sixmax_charts and sixmax_field --per-bot):
//   charts/index.json             {ducybot: [depths], regulars: [depths]}
//   charts/ducybot-<bb>.json      {bb, actions, spots: [{id, kind, hero, villain, overall, cells}]}
//   charts/regulars-<bb>.json     {bb, actions, bots: [{id, name, spots: [... and hands]}]}
// cells: 169 × [fold, call, raise, all-in] percentages in chart order (rows
// from aces down, pairs on the diagonal, suited above it, offsuit below), or
// null where a Regular played too few of that hand to say.

import { avatarUrl, botAvatar } from './avatars.js';

const RANKS = 'AKQJT98765432';
const ACTION_NAMES = ['Fold', 'Call', 'Raise', 'All-in'];
const POSITION_ORDER = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const KINDS = [
  {kind: 'open', label: 'Open', text: s => `${s.hero}, everyone before folded`},
  {kind: 'vs-open', label: 'Facing an open', text: s => `${s.hero} facing a ${s.villain} open`},
  {kind: 'vs-3bet', label: 'Facing a 3-bet', text: s => `${s.hero} opened, ${s.villain} 3-bet`},
  {kind: 'vs-limp', label: 'Facing a limp', text: s => `${s.hero} after the ${s.villain} limps`},
];
// What "call" and "raise" mean at each kind of spot.
const VERBS = {
  open: ['Fold', 'Limp', 'Raise', 'All-in'],
  'vs-open': ['Fold', 'Call', '3-bet', 'All-in'],
  'vs-3bet': ['Fold', 'Call', '4-bet', 'All-in'],
  'vs-limp': ['Fold', 'Check', 'Raise', 'All-in'],
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** The hand in chart cell `i` (0–168): "AA", "AKs", "AKo"… */
export function cellHand(i) {
  const r = Math.floor(i / 13), c = i % 13;
  if (r === c) return RANKS[r] + RANKS[r];
  return r < c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
}

let root = null;
let open = false;
let index = null; // charts/index.json, once loaded
const files = new Map(); // url → parsed JSON (or a promise of it)
// What's picked: who ('ducybot' or a Regular's id), depth, spot kind, hero, villain.
const pick = {who: 'ducybot', bb: 100, kind: 'open', hero: 'UTG', villain: null};
let focus = null; // the cell whose mix shows in detail
let note = '';

const dataUrl = name => new URL(`charts/${name}`, document.baseURI).href;

function load(name) {
  const url = dataUrl(name);
  if (!files.has(url)) {
    files.set(url, fetch(url, {cache: 'no-cache'}).then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(j => { files.set(url, j); render(); return j; }));
  }
  const v = files.get(url);
  return v instanceof Promise ? undefined : v;
}

const depthsFor = who => (who === 'ducybot' ? index?.ducybot : index?.regulars) || [];
const fileFor = (who, bb) => (who === 'ducybot' ? `ducybot-${bb}.json` : `regulars-${bb}.json`);

// The spots for who's picked at this depth (null while loading).
function spotsFor(who, bb) {
  const data = load(fileFor(who, bb));
  if (data === undefined) return null;
  if (!data) return [];
  if (who === 'ducybot') return data.spots;
  return data.bots.find(b => b.id === who)?.spots || [];
}

// The Regulars, by name, from whichever depth's file is loaded.
function regulars() {
  for (const bb of depthsFor('regulars')) {
    const d = load(fileFor('regulars', bb));
    if (d) return d.bots.map(b => ({id: b.id, name: b.name}));
  }
  return [];
}

// Keeps the pick valid: a depth this source has, and a spot it has.
function settle(spots) {
  const depths = depthsFor(pick.who);
  if (depths.length && !depths.includes(pick.bb)) pick.bb = depths.reduce((a, b) => (Math.abs(b - 100) < Math.abs(a - 100) ? b : a));
  if (!spots?.length) return null;
  const ofKind = spots.filter(s => s.kind === pick.kind);
  if (!ofKind.length) { pick.kind = spots[0].kind; return settle(spots); }
  let s = ofKind.find(x => x.hero === pick.hero && (x.villain ?? null) === (pick.villain ?? null))
    || ofKind.find(x => x.hero === pick.hero) || ofKind[0];
  pick.hero = s.hero;
  pick.villain = s.villain ?? null;
  return s;
}

function cellHtml(mix, i) {
  const hand = cellHand(i);
  const on = focus === i ? ' on' : '';
  if (!mix) return `<button class="ch-cell none${on}" data-cell="${i}" title="${hand}: too few hands to say"><span class="ch-hand">${hand}</span></button>`;
  // Stacked from the left: all-in, raise, call, fold.
  let x = 0;
  const parts = [3, 2, 1, 0].map(a => {
    const w = mix[a];
    const s = w > 0 ? `<span class="ch-part a${a}" style="left:${x}%;width:${w}%"></span>` : '';
    x += w;
    return s;
  }).join('');
  return `<button class="ch-cell${on}" data-cell="${i}" title="${hand}"><span class="ch-bars">${parts}</span><span class="ch-hand">${hand}</span></button>`;
}

function legendHtml(spot, verbs) {
  let h = '<div class="ch-legend">';
  for (const a of [2, 3, 1, 0]) h += `<span class="ch-key"><span class="ch-swatch a${a}"></span>${verbs[a]} <b>${spot.overall[a].toFixed(1)}%</b></span>`;
  return h + '</div>';
}

function render() {
  if (!open || !root) return;
  if (!index) {
    root.innerHTML = '<div class="ch-wrap"><p class="ch-note">Loading the charts…</p></div>';
    return;
  }
  const spots = spotsFor(pick.who, pick.bb);
  const spot = settle(spots);
  const regs = regulars();
  const whoName = pick.who === 'ducybot' ? 'Ducybot' : regs.find(r => r.id === pick.who)?.name || pick.who;
  let h = '<div class="ch-wrap">';
  h += '<div class="ch-head"><h1>Pre-flop charts</h1><p>Six-handed No-limit Hold’em. Ducybot’s are his GTO strategy; each Regular’s is how they actually play, recorded from their hands.</p></div>';
  // Who.
  h += '<div class="ch-row"><span class="ch-label">Whose</span><div class="ch-who">';
  const who = [{id: 'ducybot', name: 'Ducybot', av: 'gto'}, ...regs.map(r => ({...r, av: botAvatar(r.id)}))];
  for (const w of who) {
    const av = w.av ? `<img src="${avatarUrl(w.av)}" alt="">` : '';
    h += `<button class="ch-person${pick.who === w.id ? ' on' : ''}" data-who="${esc(w.id)}">${av}<span>${esc(w.name)}</span></button>`;
  }
  h += '</div></div>';
  // Depth.
  const depths = depthsFor(pick.who);
  if (depths.length > 1) {
    h += '<div class="ch-row"><span class="ch-label">Stacks</span><div class="pl-opts">';
    for (const bb of depths) h += `<button class="cc-btn${pick.bb === bb ? ' on' : ''}" data-bb="${bb}">${bb} BB</button>`;
    h += '</div></div>';
  }
  if (spots === null) {
    h += '<p class="ch-note">Loading…</p></div>';
    root.innerHTML = h;
    return;
  }
  if (!spot) {
    h += `<p class="ch-note">No charts for ${esc(whoName)} at ${pick.bb} BB yet.</p></div>`;
    root.innerHTML = h;
    return;
  }
  // Spot: kind, then position, then who it's against.
  const kinds = KINDS.filter(k => spots.some(s => s.kind === k.kind));
  h += '<div class="ch-row"><span class="ch-label">Spot</span><div class="pl-opts">';
  for (const k of kinds) h += `<button class="cc-btn${pick.kind === k.kind ? ' on' : ''}" data-kind="${k.kind}">${k.label}</button>`;
  h += '</div></div>';
  const ofKind = spots.filter(s => s.kind === pick.kind);
  const heroes = POSITION_ORDER.filter(p => ofKind.some(s => s.hero === p));
  if (heroes.length > 1) {
    h += `<div class="ch-row"><span class="ch-label">${pick.kind === 'vs-3bet' ? 'You opened' : 'You’re'}</span><div class="pl-opts">`;
    for (const p of heroes) h += `<button class="cc-btn${pick.hero === p ? ' on' : ''}" data-hero="${p}">${p}</button>`;
    h += '</div></div>';
  }
  const villains = POSITION_ORDER.filter(p => ofKind.some(s => s.hero === pick.hero && s.villain === p));
  if (villains.length > 1) {
    h += `<div class="ch-row"><span class="ch-label">${pick.kind === 'vs-3bet' ? '3-bet by' : 'Against'}</span><div class="pl-opts">`;
    for (const p of villains) h += `<button class="cc-btn${pick.villain === p ? ' on' : ''}" data-villain="${p}">${p}</button>`;
    h += '</div></div>';
  }
  const verbs = VERBS[spot.kind] || ACTION_NAMES;
  const kind = KINDS.find(k => k.kind === spot.kind);
  h += `<div class="ch-title"><b>${esc(whoName)}</b> · ${esc(kind.text(spot))} · ${pick.bb} BB</div>`;
  h += legendHtml(spot, verbs);
  if (pick.who !== 'ducybot') {
    // The same spot GTO, to compare.
    const gto = load(fileFor('ducybot', pick.bb))?.spots?.find(s => s.id === spot.id);
    const sample = spot.hands ? `${Number(spot.hands).toLocaleString()} hands recorded. ` : '';
    h += `<p class="ch-note">${sample}${gto ? `Ducybot here: ${[2, 3, 1].filter(a => gto.overall[a] >= 0.5).map(a => `${verbs[a].toLowerCase()} ${gto.overall[a].toFixed(1)}%`).join(', ')}.` : ''}</p>`;
  }
  h += '<div class="ch-grid" role="grid">';
  spot.cells.forEach((mix, i) => { h += cellHtml(mix, i); });
  h += '</div>';
  if (focus != null) {
    const mix = spot.cells[focus];
    h += `<div class="ch-detail"><b>${cellHand(focus)}</b> `;
    h += mix ? [2, 3, 1, 0].filter(a => mix[a] > 0).map(a => `${verbs[a]} ${mix[a]}%`).join(' · ') : 'too few hands to say';
    h += '</div>';
  } else h += '<p class="ch-note">Tap a hand for its exact mix.</p>';
  if (note) h += `<p class="ch-note">${esc(note)}</p>`;
  h += '</div>';
  root.innerHTML = h;
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.who) { pick.who = d.who; focus = null; }
  else if (d.bb) pick.bb = +d.bb;
  else if (d.kind) { pick.kind = d.kind; pick.villain = null; focus = null; }
  else if (d.hero) { pick.hero = d.hero; pick.villain = null; }
  else if (d.villain) pick.villain = d.villain;
  else if (d.cell) focus = focus === +d.cell ? null : +d.cell;
  else return;
  render();
}

export function openCharts(el) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
  }
  open = true;
  if (!index) {
    fetch(dataUrl('index.json'), {cache: 'no-cache'}).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
      .then(j => { index = j; render(); });
  }
  render();
}

export function closeCharts() {
  open = false;
}

export const chartsOpen = () => open;

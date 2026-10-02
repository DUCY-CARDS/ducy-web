// Preflop range trainer: pick a target range, get dealt random Hold'em hands,
// and decide for each whether it's in the range. After the set, a summary
// splits mistakes into hands wrongly included (played but not in the range)
// and wrongly excluded (folded but in the range).

import { RANGE_PRESETS, PRESET_GROUPS } from './presets.js';
import { RK, parseRange, comboCount, handClass, gridLabel } from './ranges.js';

const SUITS = [
  {c: 's', ch: '♠', red: false},
  {c: 'h', ch: '♥', red: true},
  {c: 'd', ch: '♦', red: true},
  {c: 'c', ch: '♣', red: false},
];
const DECK = SUITS.flatMap(s => RK.map(r => r + s.c));
const HAND_COUNTS = [25, 50, 100];
const SAVED_RANGES_KEY = 'ducyRanges';

const ACTIONS = {
  open: {yes: 'Raise', no: 'Fold'},
  '3bet': {yes: '3-bet', no: 'Don’t 3-bet'},
  '4bet': {yes: '4-bet', no: 'Don’t 4-bet'},
  other: {yes: 'In range', no: 'Not in range'},
};

let root = null;
let open = false;
let st = {screen: 'setup', choice: 'preset:open-btn', total: 50};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

function savedRanges() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_RANGES_KEY) || '[]');
    return Array.isArray(list)
      ? list.filter(r => r && typeof r.name === 'string' && typeof r.range === 'string' && (r.game || 'nlhe') === 'nlhe')
      : [];
  } catch {
    return [];
  }
}

// A target is what the player is trying to match: hand classes split into
// value and bluff (saved ranges have no split), plus how to phrase the spot.
function targetFor(choice) {
  const [kind, id] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
  if (kind === 'preset') {
    const p = RANGE_PRESETS.find(x => x.id === id);
    if (!p) return null;
    return {
      name: p.name, spot: p.spot,
      context: spotContext(p),
      value: parseRange(p.value), bluff: p.bluff ? parseRange(p.bluff) : new Set(),
    };
  }
  const r = savedRanges()[+id];
  if (!r) return null;
  return {name: r.name, spot: 'other', context: 'Your saved range', value: parseRange(r.range), bluff: new Set()};
}

function spotContext(p) {
  if (p.spot === 'open') return `${p.hero}, folded to you`;
  if (p.spot === '3bet') return p.hero ? `${p.hero} vs ${p.villain.join('/')} open` : `Facing a ${p.villain.join('/')} open`;
  if (p.spot === '4bet') return p.villain ? `Facing a ${p.villain.join('/')} 3-bet` : 'Facing a 3-bet';
  return 'Is this hand in the range?';
}

function inTarget(t, cls) {
  return t.value.has(cls) ? 'value' : t.bluff.has(cls) ? 'bluff' : null;
}

function dealHand() {
  const i = Math.floor(Math.random() * 52);
  let j = Math.floor(Math.random() * 51);
  if (j >= i) j++;
  // Higher rank first, the way players read a hand.
  return RK.indexOf(DECK[i][0]) <= RK.indexOf(DECK[j][0]) ? [DECK[i], DECK[j]] : [DECK[j], DECK[i]];
}

function cardHtml(c) {
  const s = SUITS.find(x => x.c === c[1]);
  return `<div class="tr-card ${s.red ? 'r' : 'bk'} s-${s.c}">${c[0]}${s.ch}</div>`;
}

function rangeGrid(t, marks = {}) {
  let h = '<div class="tr-grid">';
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const l = gridLabel(r, c);
    const k = inTarget(t, l);
    const m = marks[l] ? ` ${marks[l]}` : '';
    h += `<div class="tr-cell ${k || 'out'}${m}" title="${l}">${l}</div>`;
  }
  return h + '</div>';
}

// ---- screens ----

function renderSetup() {
  const t = targetFor(st.choice) || targetFor(st.choice = 'preset:open-btn');
  const saved = savedRanges();
  let h = '<div class="tr-wrap">';
  h += '<div class="tr-head"><h1>Range trainer</h1>';
  h += `<p>Pick a range, then decide for each random hand whether it belongs. There’s no feedback along the way; after ${st.total} hands you’ll see your accuracy and which hands you wrongly played or wrongly folded.</p></div>`;
  h += '<div class="tr-setup">';
  h += '<div class="tr-choose">';
  for (const g of PRESET_GROUPS) {
    h += `<div class="tr-group">${esc(g.label)}</div><div class="tr-options">`;
    for (const p of RANGE_PRESETS.filter(x => x.spot === g.spot)) {
      const key = `preset:${p.id}`;
      h += `<button class="tr-opt${st.choice === key ? ' on' : ''}" data-choice="${esc(key)}">${esc(p.name)}</button>`;
    }
    h += '</div>';
  }
  if (saved.length) {
    h += '<div class="tr-group">Your saved ranges</div><div class="tr-options">';
    saved.forEach((r, i) => {
      const key = `saved:${i}`;
      h += `<button class="tr-opt${st.choice === key ? ' on' : ''}" data-choice="${esc(key)}">${esc(r.name)}</button>`;
    });
    h += '</div>';
  }
  h += '</div>';

  const all = new Set([...t.value, ...t.bluff]);
  h += '<div class="tr-preview">';
  h += `<div class="tr-preview-name">${esc(t.name)}</div>`;
  h += `<div class="tr-preview-meta">${esc(t.context)} · ${(comboCount(all) / 1326 * 100).toFixed(1)}% of hands</div>`;
  h += rangeGrid(t);
  if (t.bluff.size) h += '<div class="tr-legend"><span class="tr-key value"></span>Value <span class="tr-key bluff"></span>Bluff</div>';
  h += '<div class="tr-count">Hands: ';
  for (const n of HAND_COUNTS) h += `<button class="cc-btn${st.total === n ? ' on' : ''}" data-total="${n}">${n}</button>`;
  h += '</div>';
  h += '<button class="tr-start" data-act="start">Start</button>';
  h += '</div></div></div>';
  root.innerHTML = h;
}

// No feedback during a set: answering deals the next hand, and results are
// only revealed in the summary.
function renderPlay() {
  const t = st.target, a = ACTIONS[t.spot];
  const n = st.hands.length;
  const cur = st.current;
  let h = '<div class="tr-wrap tr-play">';
  h += '<div class="tr-bar">';
  h += `<div><div class="tr-preview-name">${esc(t.name)}</div><div class="tr-preview-meta">${esc(t.context)}</div></div>`;
  h += `<div class="tr-progress"><span>Hand ${n + 1} of ${st.total}</span></div>`;
  h += '<button class="link-btn" data-act="quit">Quit</button></div>';
  h += `<div class="tr-meter"><div style="width:${(n / st.total * 100).toFixed(1)}%"></div></div>`;
  // The key changes every hand so the deal animation replays, even when the
  // same two cards come up again.
  h += `<div class="tr-felt"><div class="tr-cards" data-deal="${n}">${cardHtml(cur.cards[0])}${cardHtml(cur.cards[1])}</div></div>`;
  h += '<div class="tr-actions">';
  h += `<button class="tr-btn no" data-answer="no">${esc(a.no)}<kbd>F</kbd></button>`;
  h += `<button class="tr-btn yes" data-answer="yes">${esc(a.yes)}<kbd>R</kbd></button>`;
  h += '</div>';
  h += '</div>';
  root.innerHTML = h;
}

function renderSummary() {
  const t = st.target, a = ACTIONS[t.spot];
  const hands = st.hands;
  const correct = hands.filter(x => x.correct).length;
  const wrongIn = hands.filter(x => !x.correct && x.answer);
  const wrongOut = hands.filter(x => !x.correct && !x.answer);
  const rightIn = hands.filter(x => x.correct && x.answer).length;
  const rightOut = hands.filter(x => x.correct && !x.answer).length;
  const marks = {};
  for (const x of wrongOut) marks[x.cls] = 'miss-out';
  for (const x of wrongIn) marks[x.cls] = 'miss-in';
  // One chip per hand class, with a count when the same class came up more than once.
  const list = xs => {
    if (!xs.length) return '<span class="tr-none">None</span>';
    const byClass = new Map();
    for (const x of xs) byClass.set(x.cls, {x, n: (byClass.get(x.cls)?.n || 0) + 1});
    return [...byClass.values()].map(({x, n}) =>
      `<span class="tr-chip">${esc(x.cls)}${n > 1 ? ` ×${n}` : ''}${x.kind && t.bluff.size ? ` <em>${x.kind}</em>` : ''}</span>`).join('');
  };

  let h = '<div class="tr-wrap">';
  h += `<div class="tr-head"><h1>${correct} / ${hands.length} correct</h1>`;
  h += `<p>${esc(t.name)} · ${(correct / hands.length * 100).toFixed(0)}% accuracy</p></div>`;
  h += '<div class="tr-summary">';
  h += '<div class="tr-stats">';
  h += `<div class="tr-stat"><b>${rightIn}</b><span>Correct ${esc(a.yes.toLowerCase())}</span></div>`;
  h += `<div class="tr-stat"><b>${rightOut}</b><span>Correct ${esc(a.no.toLowerCase())}</span></div>`;
  h += `<div class="tr-stat bad"><b>${wrongIn.length}</b><span>Wrongly included</span></div>`;
  h += `<div class="tr-stat bad"><b>${wrongOut.length}</b><span>Wrongly excluded</span></div>`;
  h += '</div>';
  h += `<div class="tr-mistakes"><div class="tr-group">Wrongly included — you chose “${esc(a.yes)}” but the hand isn’t in the range</div>${list(wrongIn)}</div>`;
  h += `<div class="tr-mistakes"><div class="tr-group">Wrongly excluded — you chose “${esc(a.no)}” but the hand is in the range</div>${list(wrongOut)}</div>`;
  h += '<div class="tr-preview">' + rangeGrid(t, marks);
  h += '<div class="tr-legend"><span class="tr-key value"></span>In range';
  if (t.bluff.size) h += ' <span class="tr-key bluff"></span>Bluff';
  h += ' <span class="tr-key miss-in"></span>Wrongly included <span class="tr-key miss-out"></span>Wrongly excluded</div></div>';
  h += '<div class="tr-actions"><button class="tr-btn" data-act="setup">Choose another range</button>';
  h += '<button class="tr-btn yes" data-act="start">Play again</button></div>';
  h += '</div></div>';
  root.innerHTML = h;
}

function render() {
  if (!open) return;
  if (st.screen === 'play') renderPlay();
  else if (st.screen === 'summary') renderSummary();
  else renderSetup();
}

// ---- game flow ----

function start() {
  const target = targetFor(st.choice);
  if (!target) return;
  st = {...st, screen: 'play', target, hands: []};
  next();
}

function next() {
  if (st.hands.length >= st.total) { st.screen = 'summary'; render(); return; }
  const cards = dealHand();
  st.current = {cards, cls: handClass(cards[0], cards[1])};
  render();
}

function answer(yes) {
  if (st.screen !== 'play') return;
  const kind = inTarget(st.target, st.current.cls);
  st.hands.push({...st.current, kind, answer: yes, correct: yes === !!kind});
  next();
}

function onClick(e) {
  const el = e.target.closest('[data-choice],[data-total],[data-act],[data-answer]');
  if (!el) return;
  if (el.dataset.choice) { st.choice = el.dataset.choice; render(); }
  else if (el.dataset.total) { st.total = +el.dataset.total; render(); }
  else if (el.dataset.answer) answer(el.dataset.answer === 'yes');
  else if (el.dataset.act === 'start') start();
  else if (el.dataset.act === 'quit' || el.dataset.act === 'setup') { st.screen = 'setup'; render(); }
}

function onKey(e) {
  if (!open || st.screen !== 'play' || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'r' || k === 'y') { e.preventDefault(); answer(true); }
  else if (k === 'f' || k === 'n') { e.preventDefault(); answer(false); }
}

export function openTrainer(el) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
  }
  open = true;
  render();
}

export function closeTrainer() {
  open = false;
}

export function trainerOpen() {
  return open;
}

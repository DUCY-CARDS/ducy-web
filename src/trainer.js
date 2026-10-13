// Preflop range trainer: pick a target range, get dealt random Hold'em hands,
// and decide for each whether it's in the range. After the set, a summary
// splits mistakes into hands wrongly included (played but not in the range)
// and wrongly excluded (folded but in the range).

import { RANGE_PRESETS, PRESET_GROUPS } from './presets.js';
import { RK, COMBOS, parseRange, comboCount, handClass, gridLabel } from './ranges.js';
import { omahaPercentile, omahaTags, omahaLabels, omahaModelVersion } from './omaha-hand.js';
import { HOLDEM_PERCENTILE } from './holdem-rank.js';
import { holdemTags, HOLDEM_TAG_LABELS } from './holdem-tags.js';
import { MASTERY, gainFor, skillKey, skillState, skillTable } from './trainer-skills.js';
import { overviewHtml } from './ranges-overview.js';

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
  omaha: {yes: 'Play', no: 'Fold'},
};
// Top-% games by hole cards: 2 is Hold'em, 4-6 are Omaha.
const OMAHA_CARDS = [2, 4, 5, 6];
const OMAHA_TARGETS = [10, 15, 20, 25, 30, 40, 50];

let root = null;
let open = false;
// drill: a hand kind (tag) to practise on its own, or null for all hands.
// The first screen is the overview (ranges-overview.js, V3 #225); ovCards is
// the game it has open.
let st = {screen: 'overview', ovCards: 2, game: 'holdem', choice: 'preset:open-btn', total: 50, omaha: {cards: 4, pct: 20}, lookup: '', drill: null};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}

// Saved ranges are shared with the calculator's range picker (same storage key
// and format). `i` is the index in the stored list, used for editing.
function storedRanges() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_RANGES_KEY) || '[]');
    return Array.isArray(list) ? list.filter(r => r && typeof r.name === 'string' && typeof r.range === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredRanges(list) {
  try {
    localStorage.setItem(SAVED_RANGES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function savedRanges() {
  return storedRanges().map((r, i) => ({...r, i})).filter(r => (r.game || 'nlhe') === 'nlhe');
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
  const r = savedRanges().find(x => x.i === +id);
  if (!r) return null;
  return {name: r.name, spot: 'other', context: 'Your saved range', value: parseRange(r.range), bluff: new Set()};
}

function spotContext(p) {
  if (p.context) return p.context;
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

const RANK_ORDER = 'AKQJT98765432';
const SUIT_ORDER = 'shdc';

/** Deals an Omaha hand, sorted high to low (then by suit) for reading. */
function dealOmaha(n) {
  const d = DECK.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (52 - i));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d.slice(0, n).sort((a, b) => RANK_ORDER.indexOf(a[0]) - RANK_ORDER.indexOf(b[0]) || SUIT_ORDER.indexOf(a[1]) - SUIT_ORDER.indexOf(b[1]));
}

// Top-% games share one flow; these pick Hold'em or Omaha by hole-card count.
// V3's names (#225): the same as the Pre-flop ranges overview.
const gameName = n => (n === 2 ? 'Hold’em' : `Omaha ${n}`);
const handsName = n => (n === 2 ? 'Hold’em hands' : `${n}-card hands`);
const dealTop = n => (n === 2 ? dealHand() : dealOmaha(n));
const topPercentile = h => (h.length === 2 ? HOLDEM_PERCENTILE[handClass(h[0], h[1])] : omahaPercentile(h));
const topTags = h => (h.length === 2 ? holdemTags(h) : omahaTags(h));
const labelsFor = n => (n === 2 ? HOLDEM_TAG_LABELS : omahaLabels());

/** The top X% of Hold'em hands as a target, for drawing the 13x13 grid. */
function holdemTopTarget(pct) {
  return {value: new Set(Object.keys(HOLDEM_PERCENTILE).filter(c => HOLDEM_PERCENTILE[c] < pct)), bluff: new Set()};
}

function handText(cards) {
  return cards.map(c => {
    const s = SUITS.find(x => x.c === c[1]);
    return `<span class="tr-hc ${s.red ? 'r' : 'bk'} s-${s.c}">${c[0]}${s.ch}</span>`;
  }).join('');
}

// One decimal, so hands just either side of a cutoff (19.6% vs 20.4%) read
// differently. Cutoffs are whole numbers, so when one decimal would round onto
// one (19.96% to "20.0%"), show two so the hand doesn't seem to sit on the line.
const pctLabel = p => {
  const one = p.toFixed(1);
  return `top ${Number.isInteger(+one) && Math.abs(+one - p) > 1e-9 ? p.toFixed(2) : one}%`;
};

// Example hands just inside and just outside an Omaha cutoff, cached per
// setting so the setup screen doesn't reshuffle on every render.
const exampleCache = new Map();
function omahaExamples(cards, pct) {
  const key = `${cards}:${pct}`;
  if (exampleCache.has(key)) return exampleCache.get(key);
  const inside = [], outside = [];
  for (let i = 0; i < 20000 && (inside.length < 3 || outside.length < 3); i++) {
    const h = dealTop(cards), p = topPercentile(h);
    if (p < pct && p >= pct - 3 && inside.length < 3) inside.push({h, p});
    else if (p >= pct && p < pct + 3 && outside.length < 3) outside.push({h, p});
  }
  const ex = {inside, outside};
  exampleCache.set(key, ex);
  return ex;
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

function gameTabs() {
  return '<div class="tr-game-tabs card-count">' +
    `<button class="cc-btn${st.game === 'holdem' ? ' on' : ''}" data-tgame="holdem">Hold’em ranges</button>` +
    `<button class="cc-btn${st.game === 'omaha' ? ' on' : ''}" data-tgame="omaha">Top %</button></div>`;
}

function handCountAndStart() {
  let h = '<div class="tr-count">Hands: ';
  for (const n of HAND_COUNTS) h += `<button class="cc-btn${st.total === n ? ' on' : ''}" data-total="${n}">${n}</button>`;
  return h + '</div><button class="tr-start" data-act="start">Start</button>';
}

function renderOmahaSetup() {
  const {cards, pct} = st.omaha;
  let h = '<div class="tr-wrap">';
  h += '<div class="tr-head"><button type="button" class="link-btn tr-back" data-act="overview">‹ All skills</button><h1>Pre-flop ranges</h1>';
  h += `<p>Decide for each random hand whether it’s in the top ${pct}% of ${handsName(cards)}. Practice adapts to you and explains mistakes; a test gives no feedback until the end.</p></div>`;
  h += gameTabs();
  h += '<div class="tr-setup"><div class="tr-choose">';
  h += '<div class="tr-group">Game</div><div class="tr-options">';
  for (const n of OMAHA_CARDS) h += `<button class="tr-opt${cards === n ? ' on' : ''}" data-ocards="${n}">${gameName(n)}</button>`;
  h += '</div><div class="tr-group">Play the top</div><div class="tr-options">';
  for (const p of OMAHA_TARGETS) h += `<button class="tr-opt${pct === p ? ' on' : ''}" data-opct="${p}">${p}%</button>`;
  h += `<label class="tr-custom-pct">Other <input type="number" id="tr-opct" min="1" max="99" step="1" value="${OMAHA_TARGETS.includes(pct) ? '' : pct}" placeholder="%"></label>`;
  h += '</div>';
  h += cards === 2
    ? '<p class="tr-note">Ranked for 100bb+ play: mostly by how much equity a hand keeps against the opponents who continue after the flop, plus implied odds (making trips or better and winning, rather than losing with it), with raw preflop equity counting for less. Checked against 6-max 100bb opening charts; a guide, not a solver output.</p>'
    : '<p class="tr-note">Hands are ranked by raw preflop equity and how often they flop well against opponents who are strong on that flop (top set, nut draws, the top of a straight) rather than dominated. The ranking is a fitted approximation, not exact.</p>';
  h += '<div class="tr-group">Look up a hand</div>';
  h += `<input class="tr-lookup" id="tr-lookup" placeholder="AKs, Ah Kd, or AsKsJh9h" value="${esc(st.lookup)}" autocomplete="off" spellcheck="false">`;
  h += `<div class="tr-lookup-out" id="tr-lookup-out" role="status">${lookupHtml(st.lookup, pct)}</div>`;
  h += '</div>';

  const ex = omahaExamples(cards, pct);
  const row = e => `<div class="tr-ex"><span class="tr-hand">${handText(e.h)}</span><span class="tr-pct">${pctLabel(e.p)}</span></div>`;
  h += '<div class="tr-preview">';
  h += `<div><div class="tr-preview-name">${gameName(cards)} · top ${pct}%</div>`;
  h += `<div class="tr-preview-meta">Play about ${pct} of every 100 hands dealt</div></div>`;
  h += `<div class="tr-group">Just inside the cutoff</div>${ex.inside.map(row).join('')}`;
  h += `<div class="tr-group">Just outside</div>${ex.outside.map(row).join('')}`;
  if (cards === 2) h += rangeGrid(holdemTopTarget(pct));
  h += practiceCard(cards, pct);
  h += skillsList(cards, pct);
  h += '<div class="tr-mode"><div class="tr-mode-row"><div><b>Test</b><span>A fixed set with no feedback until the end.</span></div></div>';
  h += handCountAndStart().replace('class="tr-start"', 'class="tr-start secondary"').replace('>Start<', '>Start test<');
  h += '</div>';
  h += '</div></div></div>';
  root.innerHTML = h;
}

// ---- practice drills ----
// Besides all hands, practice can drill one kind of hand (only double-suited,
// only small pairs...). Each drill has its own score and level, and every
// answer also adds to lifetime per-kind accuracy for the game and target, kept
// across visits, so the setup screen can point at the weakest kinds.

// A drill needs some hands on each side of the cutoff; it deals plays and folds
// 50/50 either way, so a kind that's mostly folds (weak suited) still drills well.
const DRILL_MIN_SHARE = 0.04;
const WEAK_MIN_SEEN = 8;     // hands of a kind needed before calling it weak
const SESSIONS_KEPT = 30;
const RECENT_KEPT = 30;      // weakness is judged on each kind's latest hands, so improvement shows

const shortLabel = (n, tag) => {
  const l = labelsFor(n)[tag].replace(/\s*\(.*$/, '');
  return l[0].toUpperCase() + l.slice(1);
};

// Kinds worth drilling at this cutoff: ones with real decisions on both sides
// (aces at top 50% would be all plays). Exact for Hold'em, sampled for Omaha.
const drillCache = new Map();
function drillTags(cards, pct) {
  const key = `${cards}:${pct}`;
  if (drillCache.has(key)) return drillCache.get(key);
  const count = {};
  const add = (tags, inside, w) => { for (const t of tags) { const c = count[t] ||= {in: 0, out: 0}; c[inside ? 'in' : 'out'] += w; } };
  if (cards === 2) {
    for (const [cls, p] of Object.entries(HOLDEM_PERCENTILE)) {
      const h = cls.length === 2 ? [cls[0] + 's', cls[1] + 'h'] : cls[2] === 's' ? [cls[0] + 's', cls[1] + 's'] : [cls[0] + 's', cls[1] + 'h'];
      add(holdemTags(h), p < pct, COMBOS[cls]);
    }
  } else {
    for (let i = 0; i < 6000; i++) { const h = dealOmaha(cards); add(omahaTags(h), omahaPercentile(h) < pct, 1); }
  }
  const tags = Object.keys(labelsFor(cards)).filter(t => {
    const c = count[t];
    return c && Math.min(c.in, c.out) / (c.in + c.out) >= DRILL_MIN_SHARE;
  });
  drillCache.set(key, tags);
  return tags;
}

/** Recent accuracy per kind for a target (its last RECENT_KEPT hands), weakest first. */
function weakestKinds(rec, tags) {
  const kinds = (rec && rec.kinds) || {};
  return tags.map(t => ({tag: t, recent: (kinds[t] && kinds[t].recent) || ''}))
    .filter(k => k.recent.length >= WEAK_MIN_SEEN)
    .map(k => ({tag: k.tag, seen: k.recent.length, acc: k.recent.split('').filter(c => c === '1').length / k.recent.length}))
    .sort((a, b) => a.acc - b.acc);
}

function levelChip(rec) {
  const score = rec ? rec.score : 0;
  if (skillState(rec).status === 'mastered') return `<span class="tr-level lvl-mastered">✓ Mastered · ${score}</span>`;
  return `<span class="tr-level lvl-${levelFor(score).name.toLowerCase()}">${rec ? `${levelFor(score).name} · ${score}` : 'New'}</span>`;
}

// Every skill (game × target) with where it stands: mastered (✓, once 90 is
// reached; the current score is shown too), started (its score) or not yet.
// Picking one selects that game and target.
function skillsList(cards, pct) {
  const t = skillTable(loadProgress(), OMAHA_CARDS, OMAHA_TARGETS);
  let h = `<details class="tr-skills"${st.skillsOpen ? ' open' : ''}><summary><b>Skills</b> <span>${t.mastered} of ${t.total} mastered · ${t.started} started</span></summary>`;
  h += '<table class="tr-skill-table"><thead><tr><th>Top</th>';
  for (const n of OMAHA_CARDS) h += `<th>${gameName(n)}</th>`;
  h += '</tr></thead><tbody>';
  for (const row of t.rows) {
    h += `<tr><th>${row.pct}%</th>`;
    for (const c of row.cells) {
      const on = c.cards === cards && c.pct === pct ? ' on' : '';
      const label = c.status === 'mastered' ? `✓ ${c.score}` : c.status === 'started' ? `${c.score}` : '–';
      const title = c.status === 'new' ? 'Not started'
        : `${c.status === 'mastered' ? 'Mastered' : levelFor(c.score).name}: score ${c.score}, best ${c.best}, ${c.answered} hands`;
      h += `<td><button class="tr-skill ${c.status}${on}" data-skill="${c.cards}:${c.pct}" title="${title}">${label}</button></td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  h += `<p class="tr-note">Practice raises a skill’s score toward 100. ${MASTERY} or more masters it (✓): about 36 right answers in a row from 0.</p>`;
  return h + '</details>';
}

function practiceCard(cards, pct) {
  const all = loadProgress();
  const base = practiceKey(cards, pct), rec = all[base];
  const tags = drillTags(cards, pct);
  if (st.drill && !tags.includes(st.drill)) st.drill = null;
  const weak = weakestKinds(rec, tags).filter(w => w.acc < 0.9).slice(0, 3);
  const cur = st.drill ? all[`${base}:${st.drill}`] : rec;
  let h = '<div class="tr-mode">';
  h += `<div class="tr-mode-row"><div><b>Practice</b><span>Adaptive: easy hands first, closer calls as your score rises.</span></div>${levelChip(cur)}</div>`;
  if (cur && cur.resetBy === 'model' && !cur.answered) h += '<div class="tr-weak">The hand ranking was updated, so your progress here started over.</div>';
  if (cur && (cur.score || cur.answered)) {
    h += `<div class="tr-weak"><button class="link-btn tr-reset${st.confirmReset ? ' confirm' : ''}" data-act="reset-progress">${st.confirmReset ? 'Click again to reset this score to 0' : 'Reset score'}</button></div>`;
  }
  h += '<div class="tr-group">Hands</div><div class="tr-drills">';
  h += `<button class="tr-drill${st.drill ? '' : ' on'}" data-drill="">All hands</button>`;
  for (const t of tags) {
    const r = all[`${base}:${t}`];
    const isWeak = weak.some(w => w.tag === t);
    const done = skillState(r).status === 'mastered' ? '✓ ' : '';
    h += `<button class="tr-drill${st.drill === t ? ' on' : ''}${isWeak ? ' weak' : ''}" data-drill="${t}" title="${esc(labelsFor(cards)[t])}">${esc(shortLabel(cards, t))}${r ? ` <em>${done}${r.score}</em>` : ''}</button>`;
  }
  h += '</div>';
  if (weak.length) {
    h += `<div class="tr-weak">Weakest so far: ${weak.map(w => `<button class="link-btn" data-drill="${w.tag}">${esc(shortLabel(cards, w.tag))}</button> ${Math.round(w.acc * 100)}% of last ${w.seen}`).join(' · ')}</div>`;
  } else if (rec && rec.answered) {
    h += '<div class="tr-weak">Keep practicing all hands; your weakest kinds show here once there’s enough to go on.</div>';
  }
  if (rec && rec.sessions && rec.sessions.length) {
    const n = rec.sessions.length, hands = rec.sessions.reduce((a, x) => a + x.hands, 0);
    h += `<div class="tr-weak">${n} session${n > 1 ? 's' : ''}, ${hands} hands practiced here.</div>`;
  }
  h += `<button class="tr-start" data-act="practice">${st.drill ? `Practice ${esc(shortLabel(cards, st.drill).toLowerCase())}` : 'Practice'}</button>`;
  return h + '</div>';
}

// Adds an answer to the target's lifetime per-kind stats and this session's entry.
function recordLifetime(pr, tags, correct) {
  try {
    const all = loadProgress();
    const rec = all[pr.baseKey] ||= newRecord(pr.baseKey);
    const kinds = rec.kinds ||= {};
    // seen/wrong are lifetime totals; recent is the latest answers as '1' (right) / '0' (wrong).
    for (const t of tags) {
      const k = kinds[t] ||= {seen: 0, wrong: 0, recent: ''};
      k.seen++; if (!correct) k.wrong++;
      k.recent = ((k.recent || '') + (correct ? '1' : '0')).slice(-RECENT_KEPT);
    }
    const sessions = rec.sessions ||= [];
    let sess = sessions.find(x => x.id === pr.sessionId);
    if (!sess) { sess = {id: pr.sessionId, at: Date.now(), drill: pr.drill, hands: 0, correct: 0, from: pr.startScore}; sessions.push(sess); }
    sess.hands++; if (correct) sess.correct++; sess.to = pr.score;
    if (sessions.length > SESSIONS_KEPT) sessions.splice(0, sessions.length - SESSIONS_KEPT);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {}
}

// A drill hand: the drilled kind, on either side of the cutoff, preferring the
// level's band and non-obvious hands but falling back rather than giving up.
function dealDrill(cards, cut, band, tag) {
  const sides = Math.random() < 0.5 ? [true, false] : [false, true];
  for (const b of [band, [0, 1]]) for (const inside of sides) {
    const r = findInBand(cards, cut, b, tag, inside);
    if (r) return r;
  }
  for (let i = 0; i < 20000; i++) {
    const h = dealTop(cards);
    if (topTags(h).includes(tag)) return {cards: h, pct: topPercentile(h)};
  }
  const h = dealTop(cards);
  return {cards: h, pct: topPercentile(h)};
}

// ---- adaptive practice (Omaha) ----
// An IXL-style skill score from 0 to 100 per game and target. The score picks
// how close to the cutoff hands are dealt; correct answers raise it (less as
// it climbs), and wrong answers lower it more the more obvious the hand was.
//
// Closeness is relative to each side of the cutoff: for a hand inside the
// range, how far in as a share of the cutoff; outside, how far out as a share
// of the rest. Obvious hands (deep inside, or far outside) aren't dealt except
// as occasional probes for major mistakes, and practice leans toward the
// kinds of hands (omaha-hand.js, holdem-tags.js) the player keeps getting wrong.

const PROGRESS_KEY = 'ducyTrainerProgress';
// band: relative distance from the cutoff, [min, max).
const LEVELS = [
  {name: 'Easy', from: 0, band: [0.4, 1]},
  {name: 'Medium', from: 50, band: [0.15, 0.4]},
  {name: 'Hard', from: 80, band: [0.05, 0.2]},
  {name: 'Challenge', from: 90, band: [0, 0.08]},
];
const OBVIOUS_INSIDE = 0.75; // deeper than this into the range is an obvious play
const OBVIOUS_OUTSIDE = 0.5; // further than this out of the range is an obvious fold
const PROBE_RATE = 0.1;
const FOCUS_RATE = 0.4;

/** Relative distance from the cutoff: 0 at the edge, 1 at the far end of its side. */
function closeness(p, cut) {
  return p < cut ? (cut - p) / cut : (p - cut) / (100 - cut);
}

function isObvious(p, cut) {
  return p < cut ? closeness(p, cut) > OBVIOUS_INSIDE : closeness(p, cut) > OBVIOUS_OUTSIDE;
}

const levelFor = score => [...LEVELS].reverse().find(l => score >= l.from);

// Progress is only meaningful for the ranking it was earned on, so each record
// carries a fingerprint of that ranking (Hold'em, or the Omaha model for its
// card count). When the ranking changes, the record starts over from 0.
function fingerprint(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const modelVersions = {};
function modelVersion(key) {
  const cards = key.startsWith('holdem:') ? 2 : +key.split(':')[1];
  return modelVersions[cards] ||= cards === 2
    ? fingerprint(JSON.stringify(HOLDEM_PERCENTILE))
    : omahaModelVersion(cards, fingerprint);
}

/** A fresh record for `key`, stamped with the current ranking. */
function newRecord(key, extra = {}) {
  return {score: 0, best: 0, answered: 0, ...extra, model: modelVersion(key)};
}

function loadProgress() {
  let all;
  try {
    all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    if (!all || typeof all !== 'object') return {};
  } catch {
    return {};
  }
  // Records from an older ranking start over, keeping only the session log.
  let changed = false;
  for (const [key, rec] of Object.entries(all)) {
    if (rec && rec.model !== modelVersion(key)) {
      all[key] = newRecord(key, {sessions: rec.sessions, resetBy: 'model'});
      changed = true;
    }
  }
  if (changed) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch {}
  }
  return all;
}

function saveProgress(key, rec) {
  try {
    const all = loadProgress();
    all[key] = {...rec, model: modelVersion(key)};
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {}
}

/** Starts a target (or one drill of it) over from 0, keeping its session log. */
function resetProgress(key) {
  try {
    const all = loadProgress();
    all[key] = newRecord(key, {sessions: all[key] && all[key].sessions});
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {}
}

const practiceKey = skillKey;

// How bad a wrong answer is, from 0 (right at the cutoff) to 1. It scales
// with how far the hand is from the target, measured against the target
// itself, so at top 15% playing a 25th-percentile hand (10 points out) costs
// far more than a 16th, and folding a top-5% hand far more than a 14th. The
// same scale applies on both sides: a hand a full target-width away (30th at
// top 15%, or the very best hands) is as bad as it gets.
// When rough EVs per hand exist, the EV given up would be the better measure;
// until then, percentile distance stands in for it.
function severityFor(pct, cut) {
  return Math.min(1, Math.abs(pct - cut) / cut);
}

// From 1 point for a hair-thin miss up to 16; missed probes (obvious hands)
// cost 20. Near misses cost about what one correct answer earns in the
// Challenge zone, so a single close call doesn't wipe out a run.
function penaltyFor(severity, probe) {
  if (probe) return 20;
  return Math.max(1, Math.round(16 * severity));
}

// A miss this close to the cutoff is called a close call rather than a mistake.
const CLOSE_CALL = 0.2;

// Deals a non-obvious hand on one side of the cutoff (chosen 50/50 so plays
// and folds stay balanced, unless `side` is 'in' or 'out') within the band,
// optionally with a given tag.
function dealInBand(cards, cut, [lo, hi], tag, side) {
  const inside = side ? side === 'in' : Math.random() < 0.5;
  const found = findInBand(cards, cut, [lo, hi], tag, inside);
  if (found) return found;
  // Nothing found (a rare tag, or a very narrow band): relax the tag, then the band.
  if (tag) return dealInBand(cards, cut, [lo, hi], null, side);
  if (lo > 0 || hi < 1) return dealInBand(cards, cut, [0, 1], null, side);
  const h = dealTop(cards);
  return {cards: h, pct: topPercentile(h)};
}

/** A non-obvious hand on the given side within the band (and with the tag), or null. */
function findInBand(cards, cut, [lo, hi], tag, inside) {
  for (let i = 0; i < 8000; i++) {
    const h = dealTop(cards), p = topPercentile(h);
    if ((p < cut) !== inside || isObvious(p, cut)) continue;
    const r = closeness(p, cut);
    if (r < lo || r >= hi) continue;
    if (tag && !topTags(h).includes(tag)) continue;
    return {cards: h, pct: p};
  }
  return null;
}

function dealProbe(cards, cut) {
  const inside = Math.random() < 0.5;
  for (let i = 0; i < 8000; i++) {
    const h = dealTop(cards), p = topPercentile(h);
    if ((p < cut) === inside && isObvious(p, cut)) return {cards: h, pct: p, probe: true};
  }
  const h = dealTop(cards);
  return {cards: h, pct: topPercentile(h)};
}

// Mistake patterns. Trends are only called out once there's a long record:
// at least DIAG_MIN_HANDS hands and DIAG_MIN_ERRORS mistakes. Players then
// fall into one of three buckets:
//   loose - mostly playing hands outside the range: which kinds are they?
//   tight - mostly folding hands inside the range: which kinds are missed?
//   mixed - both, so good and bad hands are being confused: which kinds go
//           each way (a kind appearing on both sides isn't being sorted at all)?
const DIAG_MIN_HANDS = 20;
const DIAG_MIN_ERRORS = 6;
const TAG_MIN_ERRORS = 3;
const TAG_MIN_RATE = 0.5;
const TREND_NOTE_GAP = 8; // hands between in-play trend notes

// Hand kinds behind one direction of mistake ('over' = played but outside the
// range, 'under' = folded but inside), most frequent first.
function tagsFor(pr, kind) {
  return Object.entries(pr.tagStats)
    .map(([tag, s]) => {
      const n = kind === 'over' ? s.over : s.under, of = kind === 'over' ? s.seenOut : s.seenIn;
      return {tag, n, of};
    })
    .filter(x => x.n >= TAG_MIN_ERRORS && x.n / x.of >= TAG_MIN_RATE)
    .sort((a, b) => b.n - a.n || b.n / b.of - a.n / a.of)
    .slice(0, 3);
}

function diagnose(pr) {
  if (pr.answered < DIAG_MIN_HANDS || pr.history.filter(x => !x.correct).length < DIAG_MIN_ERRORS) return null;
  // Which way mistakes lean is judged from regular deals only: hands dealt to
  // focus on a weak spot are a biased sample and would feed back into it.
  const regular = pr.history.filter(x => !x.focus);
  const misses = regular.filter(x => !x.correct);
  const over = misses.filter(x => x.answer).length, under = misses.length - over;
  const seenOut = regular.filter(x => x.pct >= pr.pct).length;
  const seenIn = regular.length - seenOut;
  // Compare mistake rates, not counts: folding a third of the hands you should
  // play is a problem of its own even next to a lot of overplaying.
  const overRate = seenOut ? over / seenOut : 0, underRate = seenIn ? under / seenIn : 0;
  const lo = Math.min(overRate, underRate), hi = Math.max(overRate, underRate);
  let kind;
  if (over >= 3 && under >= 3 && lo >= 0.2 && lo >= hi / 3) kind = 'mixed';
  // A couple of stray mistakes the other way don't hide a clear lean.
  else if (over >= 4 && (overRate >= 2 * underRate || under < 3)) kind = 'loose';
  else if (under >= 4 && (underRate >= 2 * overRate || over < 3)) kind = 'tight';
  else if (over >= 3 && under >= 3) kind = 'mixed';
  else return null;
  return {kind, over, under, seenOut, seenIn, overTags: tagsFor(pr, 'over'), underTags: tagsFor(pr, 'under'), labels: labelsFor(pr.cards)};
}

const tagList = (xs, labels) => xs.map(x => `${labels[x.tag]} (${x.n} of ${x.of})`).join('; ');

/** {headline, details[]} for a diagnosis. */
function diagnosisText(d, cut) {
  if (d.kind === 'loose') {
    return {
      headline: `You’re playing too many hands: you played ${d.over} of ${d.seenOut} hands outside your top ${cut}%.`,
      details: [d.overTags.length ? `Most of the extra hands: ${tagList(d.overTags, d.labels)}.` : 'The extra hands are spread across all kinds rather than one type, so tighten up overall.'],
    };
  }
  if (d.kind === 'tight') {
    return {
      headline: `You’re folding hands you should play: you folded ${d.under} of ${d.seenIn} hands inside your top ${cut}%.`,
      details: [d.underTags.length ? `Most often missed: ${tagList(d.underTags, d.labels)}.` : 'The missed hands are spread across all kinds, so loosen up overall.'],
    };
  }
  const both = d.overTags.filter(o => d.underTags.some(u => u.tag === o.tag)).map(o => d.labels[o.tag]);
  const details = [];
  if (d.overTags.length) details.push(`Played when they’re outside the range: ${tagList(d.overTags, d.labels)}.`);
  if (d.underTags.length) details.push(`Folded when they’re inside the range: ${tagList(d.underTags, d.labels)}.`);
  if (both.length) details.push(`With ${both.join(' and ')}, you’re going both ways, so look at what separates the good ones from the bad ones.`);
  if (!details.length) details.push('The mix-ups aren’t concentrated in one kind of hand yet.');
  return {
    headline: `You’re mixing up good and bad hands: you played ${d.over} hands outside your top ${cut}% and folded ${d.under} inside it.`,
    details,
  };
}

// The kind of hand to deal more of while practising, if the record shows one,
// and the side of the cutoff its mistakes are on: overplayed kinds are tested
// with hands outside the range, overfolded kinds with hands inside it.
function focusFor(pr) {
  const d = diagnose(pr);
  if (!d) return null;
  const over = d.overTags.map(x => ({...x, side: 'out'})), under = d.underTags.map(x => ({...x, side: 'in'}));
  // A mixed player gets both sides in turn, so neither crowds out the other.
  const pool = d.kind === 'loose' ? over : d.kind === 'tight' ? under
    : [over[0], under[0]].filter(Boolean).sort(() => Math.random() - 0.5);
  return pool.length ? {tag: pool[0].tag, side: pool[0].side} : null;
}

function startPractice() {
  const {cards, pct} = st.omaha;
  const baseKey = practiceKey(cards, pct), drill = st.drill;
  const key = drill ? `${baseKey}:${drill}` : baseKey;
  const saved = loadProgress()[key] || {score: 0, best: 0, answered: 0};
  st.screen = 'practice';
  st.practice = {key, baseKey, drill, sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    cards, pct, score: saved.score, best: saved.best, startScore: saved.score,
    total: saved.answered || 0, answered: 0, correct: 0, streak: 0, history: [], tagStats: {},
    feedback: null, delta: 0, mastered: false};
  nextPractice();
}

function nextPractice() {
  const pr = st.practice;
  pr.feedback = null;
  const band = levelFor(pr.score).band;
  if (pr.drill) { pr.current = dealDrill(pr.cards, pr.pct, band, pr.drill); render(); return; }
  const focus = focusFor(pr);
  if (pr.answered >= 4 && Math.random() < PROBE_RATE) pr.current = dealProbe(pr.cards, pr.pct);
  else if (focus && Math.random() < FOCUS_RATE) pr.current = {...dealInBand(pr.cards, pr.pct, band, focus.tag, focus.side), focus: focus.tag};
  else pr.current = dealInBand(pr.cards, pr.pct, band);
  render();
}

function answerPractice(yes) {
  const pr = st.practice;
  if (!pr || pr.feedback || pr.mastered) return;
  const {cards, pct, probe} = pr.current;
  const inRange = pct < pr.pct;
  const correct = yes === inRange;
  const rel = closeness(pct, pr.pct), severity = severityFor(pct, pr.pct);
  const before = pr.score;
  pr.score = correct ? Math.min(100, pr.score + gainFor(pr.score)) : Math.max(0, pr.score - penaltyFor(severity, probe));
  pr.delta = pr.score - before;
  pr.answered++;
  pr.total++;
  pr.best = Math.max(pr.best, pr.score);
  if (correct) { pr.correct++; pr.streak++; } else pr.streak = 0;
  const tags = topTags(cards);
  for (const t of tags) {
    const s = pr.tagStats[t] ||= {seenIn: 0, seenOut: 0, over: 0, under: 0};
    if (inRange) s.seenIn++; else s.seenOut++;
    if (!correct) { if (yes) s.over++; else s.under++; }
  }
  pr.history.push({cards, pct, answer: yes, correct, rel, severity, distance: Math.abs(pct - pr.pct), major: !correct && !!probe, focus: !!pr.current.focus, tags, level: levelFor(before).name});
  // The record at the drill's key keeps its score; lifetime kinds and sessions live on the base record.
  const prev = loadProgress()[pr.key] || {};
  saveProgress(pr.key, {...prev, score: pr.score, best: pr.best, answered: pr.total});
  recordLifetime(pr, tags, correct);
  // Mastery is announced when the score reaches MASTERY (90). After that,
  // practice carries on up to 100, and mistakes still cost points, so it's
  // announced again only after dropping below 90 and climbing back.
  if (pr.score >= MASTERY && before < MASTERY) { pr.mastered = true; render(); return; }
  if (correct) nextPractice();
  else {
    // Mention the trend only with a long record behind it, when this mistake
    // fits it, and not more often than every TREND_NOTE_GAP hands.
    const d = diagnose(pr);
    const fits = d && (d.kind === 'mixed' || (d.kind === 'loose') === yes);
    const due = pr.lastTrendAt == null || pr.answered - pr.lastTrendAt >= TREND_NOTE_GAP;
    let pattern = null;
    if (fits && due) {
      const t = diagnosisText(d, pr.pct);
      pattern = [t.headline, ...t.details].join(' ');
      pr.lastTrendAt = pr.answered;
    }
    pr.feedback = {cards, pct, yes, major: !!probe, close: !probe && severity < CLOSE_CALL, pattern};
    render();
  }
}

// Practice (V3, #225): the skill's score on a bar marked at 90, its spade,
// the hand, Fold or Play, and a line on the last hand.
const SPADE_D = 'M16 3.5c-3.2 4.2-10 8.1-10 13.2 0 3 2.3 5 4.9 5 1.7 0 3.1-.8 3.9-2-.3 2.6-1.2 4.4-2.8 5.8h8c-1.6-1.4-2.5-3.2-2.8-5.8.8 1.2 2.2 2 3.9 2 2.6 0 4.9-2 4.9-5 0-5.1-6.8-9-10-13.2z';
function renderPractice() {
  const pr = st.practice;
  let h = '<div class="tr-wrap tr-play tr-v3">';
  h += '<div class="tr-v3-head"><button type="button" class="link-btn tr-back" data-act="overview">Pre-flop ranges ›</button>';
  h += `<h1>${gameName(pr.cards)} · top ${pr.pct}%${pr.drill ? ` · ${esc(shortLabel(pr.cards, pr.drill).toLowerCase())}` : ''}</h1></div>`;

  const deltaText = pr.delta > 0 ? `+${pr.delta}` : pr.delta < 0 ? `${pr.delta}` : '';
  const won = pr.best >= MASTERY;
  h += '<div class="tr-v3-score">';
  h += `<div class="tr-v3-bar" role="img" aria-label="Score ${pr.score} of 100; ${MASTERY} masters it"><div class="tr-v3-fill" style="width:${pr.score}%"></div><span class="tr-v3-goal" style="left:${MASTERY}%" title="${MASTERY}: mastered"></span></div>`;
  h += `<b class="tr-v3-num">${pr.score}</b>${deltaText ? `<em class="tr-v3-delta ${pr.delta > 0 ? 'up' : 'down'}" data-k="${pr.answered}">${deltaText}</em>` : ''}`;
  h += `<svg class="tr-v3-spade${won ? ' won' : ''}" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="${won ? 'Spade earned' : 'Spade not earned yet'}"><path d="${SPADE_D}"/></svg>`;
  h += '</div>';

  if (pr.mastered) {
    h += '<div class="tr-mastered" role="status"><strong>Mastered!</strong>';
    h += `<p>You reached ${MASTERY} on ${gameName(pr.cards)} · top ${pr.pct}%${pr.drill ? ` (${esc(labelsFor(pr.cards)[pr.drill])})` : ''} after ${pr.total} hands, and earned its spade. It stays mastered. Keep practicing toward 100, or try another skill.</p>`;
    h += '<div class="tr-actions"><button class="tr-btn" data-act="end-practice">Session summary</button>';
    h += '<button class="tr-btn" data-act="restart-practice">Start over from 0</button>';
    h += '<button class="tr-btn yes" data-act="keep-practicing">Keep practicing</button></div></div>';
    h += '</div>';
    root.innerHTML = h;
    return;
  }

  const show = pr.feedback ? pr.feedback.cards : pr.current.cards;
  // Feedback re-shows the same hand, so only a fresh deal animates.
  // data-focus marks hands dealt to work on a diagnosed weak spot.
  const focusAttr = !pr.feedback && pr.current.focus ? ` data-focus="${pr.current.focus}"` : '';
  h += `<div class="tr-felt"><div class="tr-v3-ask">Is this hand in the top ${pr.pct}%?</div><div class="tr-cards${show.length > 2 ? ' omaha' : ''}"${pr.feedback ? '' : ` data-deal="${pr.answered}"`}${focusAttr}>${show.map(cardHtml).join('')}</div></div>`;
  if (pr.feedback) {
    const f = pr.feedback;
    const where = f.pct < pr.pct ? `inside your top ${pr.pct}%` : `outside your top ${pr.pct}%`;
    h += `<div class="tr-feedback ${f.close ? 'close' : 'bad'}" role="status">`;
    h += `<strong>${f.major ? 'Major mistake' : f.close ? 'Close call' : 'Not quite'}</strong> — this hand is ${pctLabel(f.pct)}, ${where}, so it’s ${f.major ? 'a clear' : 'a'} ${f.pct < pr.pct ? 'play' : 'fold'}.`;
    if (f.pattern) h += `<div class="tr-pattern">${esc(f.pattern)}</div>`;
    h += '</div>';
    h += '<div class="tr-actions"><button class="tr-btn next" data-act="continue-practice">Continue<kbd>Space</kbd></button></div>';
  } else {
    h += '<div class="tr-actions">';
    h += `<button class="tr-btn no" data-answer="no">Fold<kbd>F</kbd></button>`;
    h += `<button class="tr-btn yes" data-answer="yes">Play<kbd>R</kbd></button>`;
    h += '</div>';
    // The last hand, when it was right (a miss gets its own explanation).
    const last = pr.history.at(-1);
    if (last?.correct) {
      const side = last.pct < pr.pct ? 'inside' : 'outside';
      const near = Math.abs(last.pct - pr.pct) < 3 ? `just ${side}` : side;
      h += `<div class="tr-v3-last"><b>Right${pr.delta > 0 ? ` · +${pr.delta}` : ''}</b><span>Last hand: ${handText(last.cards)} is the ${pctLabel(last.pct)}, ${near}.</span></div>`;
    }
  }
  h += `<div class="tr-v3-foot"><span>${pr.answered} hands · ${pr.correct} right · streak ${pr.streak}</span><button type="button" class="link-btn" data-act="end-practice">End practice</button></div>`;
  h += '</div>';
  root.innerHTML = h;
}

function renderPracticeSummary() {
  const pr = st.practice;
  const misses = pr.history.filter(x => !x.correct).sort((a, b) => b.major - a.major || b.severity - a.severity);
  const major = misses.filter(x => x.major).length;
  const diag = diagnose(pr);
  let h = '<div class="tr-wrap">';
  h += `<div class="tr-head"><h1>Score ${pr.startScore} → ${pr.score}</h1>`;
  h += `<p>${gameName(pr.cards)} · top ${pr.pct}%${pr.drill ? ` · ${esc(shortLabel(pr.cards, pr.drill))} only` : ''} · ${pr.correct} of ${pr.answered} correct this session · now at ${levelFor(pr.score).name}</p></div>`;
  h += '<div class="tr-summary">';
  h += '<div class="tr-stats">';
  h += `<div class="tr-stat"><b>${pr.answered}</b><span>Hands this session</span></div>`;
  h += `<div class="tr-stat"><b>${pr.answered ? Math.round(pr.correct / pr.answered * 100) : 0}%</b><span>Accuracy</span></div>`;
  h += `<div class="tr-stat bad"><b>${major}</b><span>Major mistakes (obvious hands)</span></div>`;
  h += `<div class="tr-stat"><b>${misses.length - major}</b><span>Close calls missed</span></div>`;
  h += '</div>';
  h += '<div class="tr-mistakes"><div class="tr-group">Patterns</div>';
  if (diag) {
    const t = diagnosisText(diag, pr.pct);
    h += `<div class="tr-pattern tr-diag-${diag.kind}"><strong>${esc(t.headline)}</strong>${t.details.map(x => `<div>${esc(x)}</div>`).join('')}</div>`;
  } else if (pr.answered < DIAG_MIN_HANDS || misses.length < DIAG_MIN_ERRORS) {
    h += `<span class="tr-none">Not enough evidence for a pattern yet (${pr.answered} hands, ${misses.length} mistakes; patterns need ${DIAG_MIN_HANDS}+ hands and ${DIAG_MIN_ERRORS}+ mistakes).</span>`;
  } else {
    h += '<span class="tr-none">Your mistakes don’t lean one way or share a pattern, so they look like close calls rather than a habit.</span>';
  }
  h += '</div>';
  // Hold'em mistakes are about hand classes, so repeats of a class share a row.
  const rows = [];
  for (const x of misses) {
    const cls = pr.cards === 2 ? handClass(x.cards[0], x.cards[1]) : null;
    const same = cls && rows.find(r => r.cls === cls && r.answer === x.answer && r.major === x.major);
    if (same) same.n++; else rows.push({...x, cls, n: 1});
  }
  const list = rows.length
    ? rows.map(x => `<div class="tr-ex${x.major ? ' major' : ''}"><span class="tr-hand">${x.cls ? `<b class="tr-cls">${x.cls}</b>${x.n > 1 ? ` ×${x.n}` : ''}` : handText(x.cards)}</span><span class="tr-pct">${x.major ? 'major · ' : ''}${pctLabel(x.pct)} · ${x.answer ? 'played' : 'folded'}</span></div>`).join('')
    : '<span class="tr-none">None</span>';
  h += `<div class="tr-mistakes"><div class="tr-group">Mistakes, worst first</div>${list}</div>`;
  if (pr.cards === 2) h += holdemMistakeGrid(pr.pct, misses);
  // After all-hands practice, point at the weakest kind across sessions as the next drill.
  if (!pr.drill) {
    const weak = weakestKinds(loadProgress()[pr.baseKey], drillTags(pr.cards, pr.pct)).filter(w => w.acc < 0.9)[0];
    if (weak) h += `<div class="tr-weak tr-next-drill">Your weakest kind so far is ${esc(labelsFor(pr.cards)[weak.tag])}: ${Math.round(weak.acc * 100)}% right over your last ${weak.seen}. <button class="tr-btn yes" data-drill-start="${weak.tag}">Drill ${esc(shortLabel(pr.cards, weak.tag).toLowerCase())}</button></div>`;
  }
  h += '<div class="tr-actions"><button class="tr-btn" data-act="setup">Change settings</button>';
  h += '<button class="tr-btn yes" data-act="practice">Practice again</button></div>';
  h += '</div></div>';
  root.innerHTML = h;
}

// The top X% on the 13x13 grid with wrongly played and wrongly folded classes marked.
function holdemMistakeGrid(pct, misses) {
  const marks = {};
  for (const x of misses) marks[handClass(x.cards[0], x.cards[1])] = x.answer ? 'miss-in' : 'miss-out';
  return '<div class="tr-preview">' + rangeGrid(holdemTopTarget(pct), marks) +
    `<div class="tr-legend"><span class="tr-key value"></span>Top ${pct}% <span class="tr-key miss-in"></span>Wrongly played <span class="tr-key miss-out"></span>Wrongly folded</div></div>`;
}

// ---- hand lookup ----
// Accepts a Hold'em class (AKs, QJo, 77), or 2, 4, 5 or 6 cards like "Ah Kd"
// or "AsKsJh9h" (any spacing, upper or lower case).

/** {cards} | {cls} | {error} for lookup text, or null when empty. */
export function parseLookup(text) {
  const t = text.replace(/[\s,]+/g, '');
  if (!t) return null;
  const m = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/i.exec(t);
  if (m) {
    const [a, b] = [m[1].toUpperCase(), m[2].toUpperCase()];
    const [hi, lo] = RK.indexOf(a) <= RK.indexOf(b) ? [a, b] : [b, a];
    const suit = m[3].toLowerCase();
    if (hi === lo) return suit ? {error: 'A pair can’t be suited or offsuit: try ' + hi + lo + '.'} : {cls: hi + lo};
    if (!suit) return {error: `Add s (suited) or o (offsuit): ${hi}${lo}s or ${hi}${lo}o.`};
    return {cls: hi + lo + suit};
  }
  if (t.length % 2) return {error: 'Enter cards as rank and suit, like Ah Kd.'};
  const cards = [];
  for (let i = 0; i < t.length; i += 2) {
    const c = t[i].toUpperCase() + t[i + 1].toLowerCase();
    if (!/^[2-9TJQKA][shdc]$/.test(c)) return {error: `“${t.slice(i, i + 2)}” isn’t a card. Use ranks 2-9, T, J, Q, K, A and suits s, h, d, c.`};
    if (cards.includes(c)) return {error: `${c} appears twice.`};
    cards.push(c);
  }
  if (![2, 4, 5, 6].includes(cards.length)) return {error: 'Enter 2 cards for Hold’em or 4, 5 or 6 for Omaha.'};
  return {cards: cards.sort((a, b) => RANK_ORDER.indexOf(a[0]) - RANK_ORDER.indexOf(b[0]) || SUIT_ORDER.indexOf(a[1]) - SUIT_ORDER.indexOf(b[1]))};
}

function lookupHtml(text, cut) {
  const q = parseLookup(text);
  if (!q) return '<span class="tr-none">Type a hand to see where it ranks.</span>';
  if (q.error) return `<span class="tr-lookup-err">${esc(q.error)}</span>`;
  const n = q.cls ? 2 : q.cards.length;
  const cls = q.cls || (n === 2 ? handClass(q.cards[0], q.cards[1]) : null);
  const p = cls ? HOLDEM_PERCENTILE[cls] : omahaPercentile(q.cards);
  const shown = q.cards ? handText(q.cards) : `<b>${cls}</b>`;
  let h = `<div class="tr-ex"><span class="tr-hand">${shown}</span><span class="tr-pct">${pctLabel(p)} of ${handsName(n)}</span></div>`;
  h += '<div class="tr-lookup-bar"><span style="width:' + Math.max(1, 100 - p).toFixed(1) + '%"></span></div>';
  const target = st.omaha.cards === n ? ` · ${p < cut ? 'inside' : 'outside'} your top ${cut}%` : '';
  h += `<div class="tr-preview-meta">${n === 2 ? `${cls}, ` : `${gameName(n)}, `}better than ${(100 - p).toFixed(1)}% of hands${target}</div>`;
  return h;
}

function renderSetup() {
  if (st.game === 'omaha') { renderOmahaSetup(); return; }
  const t = targetFor(st.choice) || targetFor(st.choice = 'preset:open-btn');
  const saved = savedRanges();
  let h = '<div class="tr-wrap">';
  h += '<div class="tr-head"><button type="button" class="link-btn tr-back" data-act="overview">‹ All skills</button><h1>Pre-flop ranges</h1>';
  h += `<p>Pick a range, then decide for each random hand whether it belongs. There’s no feedback along the way; after ${st.total} hands you’ll see your accuracy and which hands you wrongly played or wrongly folded.</p></div>`;
  h += gameTabs();
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
  h += '<div class="tr-group">Your ranges</div><div class="tr-options">';
  for (const r of saved) {
    const key = `saved:${r.i}`;
    h += `<button class="tr-opt${st.choice === key ? ' on' : ''}" data-choice="${esc(key)}">${esc(r.name)}</button>`;
  }
  h += `<button class="tr-opt tr-new${st.edit && st.edit.index == null ? ' on' : ''}" data-act="new">+ New range</button>`;
  h += '</div>';
  h += '</div>';

  if (st.edit) {
    h += editorHtml();
  } else {
    const all = new Set([...t.value, ...t.bluff]);
    h += '<div class="tr-preview">';
    h += '<div class="tr-preview-top"><div>';
    h += `<div class="tr-preview-name">${esc(t.name)}</div>`;
    h += `<div class="tr-preview-meta">${esc(t.context)} · ${(comboCount(all) / 1326 * 100).toFixed(1)}% of hands</div>`;
    h += `</div><button class="btn-small" data-act="customize">${st.choice.startsWith('saved:') ? 'Edit' : 'Customize'}</button></div>`;
    h += rangeGrid(t);
    if (t.bluff.size) h += '<div class="tr-legend"><span class="tr-key value"></span>Value <span class="tr-key bluff"></span>Bluff</div>';
    h += handCountAndStart();
    h += '</div>';
  }
  h += '</div></div>';
  root.innerHTML = h;
}

// ---- range editor ----
// st.edit = {name, sel: Set of hand classes, index: stored index being edited
// or null for a new range, msg, confirmDelete}

function editorHtml() {
  const e = st.edit;
  let h = '<div class="tr-preview tr-editor">';
  h += `<div class="tr-preview-name">${e.index == null ? 'New range' : 'Edit range'}</div>`;
  h += `<input class="range-name" id="tr-ename" maxlength="60" placeholder="Name this range" value="${esc(e.name)}" autocomplete="off">`;
  h += '<div class="tr-grid tr-edit-grid">';
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) {
    const l = gridLabel(r, c);
    h += `<button class="tr-cell ${e.sel.has(l) ? 'value' : 'out'}" data-cell="${l}" aria-pressed="${e.sel.has(l)}">${l}</button>`;
  }
  h += '</div>';
  h += `<div class="tr-preview-meta" id="tr-ecount">${editCountText(e.sel)}</div>`;
  h += `<textarea class="range-text" id="tr-etext" rows="2" placeholder="Click hands above or type: QQ+, AKs, A5s-A2s">${esc([...e.sel].join(', '))}</textarea>`;
  h += '<div class="tr-edit-actions">';
  if (e.index != null) {
    h += `<button class="btn-small tr-del${e.confirmDelete ? ' confirm' : ''}" data-act="delete">${e.confirmDelete ? 'Delete?' : 'Delete'}</button>`;
  }
  h += '<button class="btn-small" data-act="cancel-edit">Cancel</button>';
  h += '<button class="btn-small primary" data-act="save-edit">Save</button></div>';
  h += `<div class="saved-msg" id="tr-emsg" role="status">${esc(e.msg || '')}</div>`;
  h += '</div>';
  return h;
}

function editCountText(sel) {
  const n = comboCount(sel);
  return `${n} combos · ${(n / 1326 * 100).toFixed(1)}% of hands`;
}

// Updates the grid, count and (optionally) text box in place, so typing and
// clicking don't lose focus.
function refreshEditor(updateText) {
  const e = st.edit;
  root.querySelectorAll('[data-cell]').forEach(b => {
    const on = e.sel.has(b.dataset.cell);
    b.classList.toggle('value', on);
    b.classList.toggle('out', !on);
    b.setAttribute('aria-pressed', on);
  });
  root.querySelector('#tr-ecount').textContent = editCountText(e.sel);
  if (updateText) root.querySelector('#tr-etext').value = [...e.sel].join(', ');
}

function startEdit(fromChoice) {
  if (!fromChoice) {
    st.edit = {name: '', sel: new Set(), index: null};
    return;
  }
  const t = targetFor(fromChoice);
  if (!t) return;
  const sel = new Set([...t.value, ...t.bluff]);
  if (fromChoice.startsWith('saved:')) st.edit = {name: t.name, sel, index: +fromChoice.slice(6)};
  else st.edit = {name: `${t.name} (custom)`, sel, index: null};
}

function saveEdit() {
  const e = st.edit;
  e.name = e.name.trim().slice(0, 60);
  if (!e.name) { e.msg = 'Enter a name for this range.'; render(); root.querySelector('#tr-ename').focus(); return; }
  if (!e.sel.size) { e.msg = 'Select at least one hand.'; render(); return; }
  const list = storedRanges();
  const entry = {name: e.name, game: 'nlhe', range: [...e.sel].join(', ')};
  // Saving under an existing name replaces that range, as in the calculator.
  let at = list.findIndex(r => r.name === e.name && (r.game || 'nlhe') === 'nlhe');
  if (at < 0 && e.index != null && list[e.index]) at = e.index;
  if (at >= 0) list[at] = entry; else at = list.push(entry) - 1;
  if (!writeStoredRanges(list)) { e.msg = 'Couldn’t save: this browser is blocking storage.'; render(); return; }
  st.choice = `saved:${at}`;
  st.edit = null;
  render();
}

function deleteEdit() {
  const e = st.edit;
  if (!e.confirmDelete) { e.confirmDelete = true; render(); return; }
  const list = storedRanges();
  list.splice(e.index, 1);
  writeStoredRanges(list);
  st.choice = 'preset:open-btn';
  st.edit = null;
  render();
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
  h += `<div class="tr-felt"><div class="tr-cards${cur.cards.length > 2 ? ' omaha' : ''}" data-deal="${n}">${cur.cards.map(cardHtml).join('')}</div></div>`;
  h += '<div class="tr-actions">';
  h += `<button class="tr-btn no" data-answer="no">${esc(a.no)}<kbd>F</kbd></button>`;
  h += `<button class="tr-btn yes" data-answer="yes">${esc(a.yes)}<kbd>R</kbd></button>`;
  h += '</div>';
  h += '</div>';
  root.innerHTML = h;
}

function renderOmahaSummary() {
  const t = st.target, a = ACTIONS.omaha;
  const hands = st.hands;
  const correct = hands.filter(x => x.correct).length;
  const wrongIn = hands.filter(x => !x.correct && x.answer).sort((x, y) => x.pct - y.pct);
  const wrongOut = hands.filter(x => !x.correct && !x.answer).sort((x, y) => x.pct - y.pct);
  const rightIn = hands.filter(x => x.correct && x.answer).length;
  const rightOut = hands.filter(x => x.correct && !x.answer).length;
  const list = xs => xs.length
    ? xs.map(x => `<div class="tr-ex"><span class="tr-hand">${handText(x.cards)}</span><span class="tr-pct">${pctLabel(x.pct)}</span></div>`).join('')
    : '<span class="tr-none">None</span>';
  // Every decision placed on the 0-100 percentile line; rows spread the dots.
  const dot = (x, i) => {
    const cls = x.correct ? 'ok' : x.answer ? 'miss-in' : 'miss-out';
    return `<span class="tr-dot ${cls}" style="left:${x.pct.toFixed(2)}%;top:${(i % 4) * 7 + 4}px" title="${esc(x.cards.join(' '))}: ${pctLabel(x.pct)}"></span>`;
  };

  let h = '<div class="tr-wrap">';
  h += `<div class="tr-head"><h1>${correct} / ${hands.length} correct</h1>`;
  h += `<p>${esc(t.name)} · ${(correct / hands.length * 100).toFixed(0)}% accuracy</p></div>`;
  h += '<div class="tr-summary">';
  h += '<div class="tr-stats">';
  h += `<div class="tr-stat"><b>${rightIn}</b><span>Correct play</span></div>`;
  h += `<div class="tr-stat"><b>${rightOut}</b><span>Correct fold</span></div>`;
  h += `<div class="tr-stat bad"><b>${wrongIn.length}</b><span>Wrongly included</span></div>`;
  h += `<div class="tr-stat bad"><b>${wrongOut.length}</b><span>Wrongly excluded</span></div>`;
  h += '</div>';
  h += '<div class="tr-preview"><div class="tr-group">Your decisions by hand percentile</div>';
  h += `<div class="tr-strip"><span class="tr-cut" style="left:${t.pct}%"><em>top ${t.pct}%</em></span>${hands.map(dot).join('')}</div>`;
  h += '<div class="tr-strip-scale"><span>Best</span><span>Worst</span></div>';
  h += '<div class="tr-legend dots"><span class="tr-key ok"></span>Correct <span class="tr-key miss-in"></span>Wrongly included <span class="tr-key miss-out"></span>Wrongly excluded</div></div>';
  h += `<div class="tr-mistakes"><div class="tr-group">Wrongly included — you played a hand outside the top ${t.pct}%</div>${list(wrongIn)}</div>`;
  h += `<div class="tr-mistakes"><div class="tr-group">Wrongly excluded — you folded a hand in the top ${t.pct}%</div>${list(wrongOut)}</div>`;
  if (t.cards === 2) h += holdemMistakeGrid(t.pct, [...wrongIn, ...wrongOut]);
  h += '<div class="tr-actions"><button class="tr-btn" data-act="setup">Change settings</button>';
  h += `<button class="tr-btn yes" data-act="start">Play again</button></div>`;
  h += '</div></div>';
  root.innerHTML = h;
}

function renderSummary() {
  if (st.target.omaha) { renderOmahaSummary(); return; }
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
  if (st.screen === 'overview') root.innerHTML = overviewHtml(loadProgress(), st.ovCards);
  else if (st.screen === 'practice') renderPractice();
  else if (st.screen === 'practice-summary') renderPracticeSummary();
  else if (st.screen === 'play') renderPlay();
  else if (st.screen === 'summary') renderSummary();
  else renderSetup();
}

// ---- game flow ----

function start() {
  let target;
  if (st.game === 'omaha') {
    const {cards, pct} = st.omaha;
    target = {omaha: true, cards, pct, spot: 'omaha', name: `${gameName(cards)} · top ${pct}%`, context: `Play the top ${pct}% of ${handsName(cards)}`};
  } else {
    target = targetFor(st.choice);
  }
  if (!target) return;
  st = {...st, screen: 'play', target, hands: []};
  next();
}

function next() {
  if (st.hands.length >= st.total) { st.screen = 'summary'; render(); return; }
  if (st.target.omaha) {
    const cards = dealTop(st.target.cards);
    st.current = {cards, pct: topPercentile(cards)};
  } else {
    const cards = dealHand();
    st.current = {cards, cls: handClass(cards[0], cards[1])};
  }
  render();
}

function answer(yes) {
  if (st.screen !== 'play') return;
  const kind = st.target.omaha
    ? (st.current.pct < st.target.pct ? 'in' : null)
    : inTarget(st.target, st.current.cls);
  st.hands.push({...st.current, kind, answer: yes, correct: yes === !!kind});
  next();
}

function onClick(e) {
  // The skills list stays open (or closed) across re-renders.
  if (e.target.closest('.tr-skills > summary')) { st.skillsOpen = !st.skillsOpen; return; }
  const el = e.target.closest('[data-skill],[data-drill],[data-drill-start],[data-choice],[data-total],[data-act],[data-answer],[data-cell],[data-tgame],[data-ocards],[data-opct],[data-ovgame],[data-ovchoice]');
  if (!el) return;
  if (el.dataset.act !== 'reset-progress') st.confirmReset = false;
  if (el.dataset.ovgame) { st.ovCards = +el.dataset.ovgame; render(); return; }
  if (el.dataset.ovchoice) {
    // A chart by position from the overview: Hold'em's range test.
    st.game = 'holdem'; st.choice = el.dataset.ovchoice; st.edit = null; st.screen = 'setup';
    render();
    return;
  }
  if (el.dataset.skill) {
    const [cards, pct] = el.dataset.skill.split(':').map(Number);
    st.omaha.cards = cards; st.omaha.pct = pct; st.drill = null;
    // From the overview, a skill opens its practice screen.
    if (st.screen === 'overview') { st.game = 'omaha'; st.screen = 'setup'; }
    render();
  }
  else if (el.dataset.drill != null) { st.drill = el.dataset.drill || null; render(); }
  else if (el.dataset.drillStart) { st.drill = el.dataset.drillStart; startPractice(); }
  else if (el.dataset.tgame) { st.game = el.dataset.tgame; st.edit = null; render(); }
  else if (el.dataset.ocards) { st.omaha.cards = +el.dataset.ocards; render(); }
  else if (el.dataset.opct) { st.omaha.pct = +el.dataset.opct; render(); }
  else if (el.dataset.cell && st.edit) {
    const s = st.edit.sel, l = el.dataset.cell;
    if (s.has(l)) s.delete(l); else s.add(l);
    refreshEditor(true);
  }
  else if (el.dataset.choice) { st.choice = el.dataset.choice; st.edit = null; render(); }
  else if (el.dataset.total) { st.total = +el.dataset.total; render(); }
  else if (el.dataset.answer) (st.screen === 'practice' ? answerPractice : answer)(el.dataset.answer === 'yes');
  else if (el.dataset.act === 'start') start();
  else if (el.dataset.act === 'practice') startPractice();
  else if (el.dataset.act === 'continue-practice') nextPractice();
  else if (el.dataset.act === 'keep-practicing') { st.practice.mastered = false; nextPractice(); }
  else if (el.dataset.act === 'restart-practice') { resetProgress(st.practice.key); startPractice(); }
  else if (el.dataset.act === 'reset-progress') {
    // Two clicks: the first asks for confirmation.
    if (!st.confirmReset) { st.confirmReset = true; render(); return; }
    st.confirmReset = false;
    const base = practiceKey(st.omaha.cards, st.omaha.pct);
    resetProgress(st.drill ? `${base}:${st.drill}` : base);
    render();
  }
  else if (el.dataset.act === 'end-practice') { st.screen = 'practice-summary'; render(); }
  else if (el.dataset.act === 'new') { startEdit(null); render(); root.querySelector('#tr-ename').focus(); }
  else if (el.dataset.act === 'customize') { startEdit(st.choice); render(); }
  else if (el.dataset.act === 'save-edit') saveEdit();
  else if (el.dataset.act === 'cancel-edit') { st.edit = null; render(); }
  else if (el.dataset.act === 'delete') deleteEdit();
  else if (el.dataset.act === 'quit' || el.dataset.act === 'setup') { st.screen = 'setup'; render(); }
  else if (el.dataset.act === 'overview') { st.screen = 'overview'; st.edit = null; render(); }
}

function onKey(e) {
  if (!open || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (st.screen === 'practice') {
    const pr = st.practice;
    if (pr.feedback && (k === ' ' || k === 'enter')) { e.preventDefault(); nextPractice(); }
    else if (!pr.feedback && !pr.mastered && (k === 'r' || k === 'y')) { e.preventDefault(); answerPractice(true); }
    else if (!pr.feedback && !pr.mastered && (k === 'f' || k === 'n')) { e.preventDefault(); answerPractice(false); }
    return;
  }
  if (st.screen !== 'play') return;
  if (k === 'r' || k === 'y') { e.preventDefault(); answer(true); }
  else if (k === 'f' || k === 'n') { e.preventDefault(); answer(false); }
}

// Custom Omaha target: applied when the field is committed (change), so typing
// "2" on the way to "25" doesn't redraw the screen mid-entry.
function onChange(e) {
  if (e.target.id !== 'tr-opct') return;
  const v = Math.round(+e.target.value);
  if (v >= 1 && v <= 99) { st.omaha.pct = v; render(); }
}

function onInput(e) {
  // Lookup updates in place so the field keeps focus.
  if (e.target.id === 'tr-lookup') {
    st.lookup = e.target.value;
    root.querySelector('#tr-lookup-out').innerHTML = lookupHtml(st.lookup, st.omaha.pct);
    return;
  }
  if (!st.edit) return;
  if (e.target.id === 'tr-ename') st.edit.name = e.target.value;
  else if (e.target.id === 'tr-etext') { st.edit.sel = parseRange(e.target.value); refreshEditor(false); }
}

function onEditorKey(e) {
  if (st.edit && e.target.id === 'tr-ename' && e.key === 'Enter') { e.preventDefault(); saveEdit(); }
}

export function openTrainer(el) {
  if (!root) {
    root = el;
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onEditorKey);
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

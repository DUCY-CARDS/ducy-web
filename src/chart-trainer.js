// Pre-flop ranges: Ducybot's ranges (#249, #248's training part). Each spot
// of his charts that's on the track (chart-skills.js) is a skill with a spade,
// practised as fixed hands (pick the action) or mixed strategies (set how
// often to take each action). The screens and their clicks; trainer.js hands
// over to these when a chart skill is picked, and shares the saved progress.

import { MASTERY, gainFor } from './trainer-skills.js';
import { cellHand } from './charts.js';
import {
  CHART_TRACKS, CHART_MODES, DEFAULT_BB, chartSkillKey, chartFile, spotName, spotNameFromId, spotQuestion,
  trainingActions, handMix, fixedAnswers, fixedSeverity, mixDistance, obviousCells, pickCell,
  cardsFor, spotFingerprint, fixedPenalty, mixedPenalty, setShare, chartLevel, RIGHT_MIX, CLOSE_MIX,
} from './chart-skills.js';

const PROGRESS_KEY = 'ducyTrainerProgress'; // shared with trainer.js
const PROBE_RATE = 0.1;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// What's picked on the track, and the practice under way.
export const cs = {table: 'hu', bb: DEFAULT_BB, mode: 'fixed', id: null, practice: null};
let index = null; // charts/index.json
const files = new Map(); // file → data, a promise, or null
let rerender = () => {};

/** trainer.js's render, called when a chart file arrives. */
export function setChartRender(fn) { rerender = fn; }

function loadIndex() {
  if (index || typeof fetch === 'undefined') return;
  index = {};
  fetch(new URL('charts/index.json', document.baseURI).href, {cache: 'no-cache'}).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
    .then(j => { index = j || {}; rerender(); });
}

/** The spot's chart data once loaded (undefined while loading, null if missing). */
function spotData(table, bb, id) {
  const f = chartFile(table, bb);
  if (!files.has(f)) {
    files.set(f, fetch(new URL(`charts/${f}`, document.baseURI).href, {cache: 'no-cache'}).then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(j => { files.set(f, j); rerender(); return j; }));
  }
  const d = files.get(f);
  if (d instanceof Promise) return undefined;
  return d?.spots?.find(s => s.id === id) || null;
}

const depthsFor = table => {
  const list = table === 'hu' ? index?.ducybotHu : index?.ducybot;
  return list?.length ? list : [DEFAULT_BB];
};

// ---- progress ----

function loadAll() {
  try { const a = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); return a && typeof a === 'object' ? a : {}; } catch { return {}; }
}
function saveRec(key, rec) {
  try { const all = loadAll(); all[key] = rec; localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch {}
}
const stateOf = rec => {
  const best = Math.max(rec?.best || 0, rec?.score || 0);
  return !rec || !(rec.answered || rec.score || best) ? {status: 'new', score: 0, best: 0}
    : {status: best >= MASTERY ? 'mastered' : 'started', score: rec.score || 0, best};
};

/** The track's skills for a table, depth and mode, with their state. */
function trackSkills(progress, table, bb, mode) {
  const t = CHART_TRACKS.find(x => x.table === table);
  return t.ids.map(id => ({id, name: spotNameFromId(id), ...stateOf(progress[chartSkillKey(table, bb, id, mode)])}));
}

// ---- the overview's track ----

const SPADE = 'M16 3.5c-3.2 4.2-10 8.1-10 13.2 0 3 2.3 5 4.9 5 1.7 0 3.1-.8 3.9-2-.3 2.6-1.2 4.4-2.8 5.8h8c-1.6-1.4-2.5-3.2-2.8-5.8.8 1.2 2.2 2 3.9 2 2.6 0 4.9-2 4.9-5 0-5.1-6.8-9-10-13.2z';
const spade = (won, label) => `<svg class="v3-spade ${won ? 'won' : 'open'}" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="${label}"><path d="${SPADE}"/></svg>`;

/** Ducybot's ranges on the Pre-flop ranges overview (Hold'em). */
export function chartTrackHtml(progress) {
  loadIndex();
  const skills = trackSkills(progress, cs.table, cs.bb, cs.mode);
  const next = skills.find(s => s.status !== 'mastered');
  let h = '<section class="v3-skillcard ct-track"><div class="v3-skillcard-head"><span class="v3-tile-name">Ducybot’s ranges</span></div>';
  h += '<p class="ct-intro">His GTO pre-flop ranges, spot by spot. Fixed hands: pick his action. Mixed strategies: set how often he takes each one.</p>';
  h += '<div class="ct-opts"><div class="pl-opts">';
  for (const t of CHART_TRACKS) h += `<button type="button" class="cc-btn${cs.table === t.table ? ' on' : ''}" data-cht-table="${t.table}">${t.label}</button>`;
  h += '</div><div class="pl-opts">';
  for (const m of CHART_MODES) h += `<button type="button" class="cc-btn${cs.mode === m.mode ? ' on' : ''}" data-cht-mode="${m.mode}" title="${esc(m.text)}">${m.label}</button>`;
  h += '</div>';
  const depths = depthsFor(cs.table);
  if (depths.length > 1) {
    h += '<div class="pl-opts">';
    for (const bb of depths) h += `<button type="button" class="cc-btn${cs.bb === bb ? ' on' : ''}" data-cht-bb="${bb}">${bb} BB</button>`;
    h += '</div>';
  }
  h += '</div><div class="v3-skillrow v3-trackrow">';
  for (const s of skills) {
    const label = s.status === 'mastered' ? 'Mastered' : s.status === 'started' ? `Score ${s.score}` : 'Not started';
    h += `<button type="button" class="v3-skill${s === next ? ' next' : ''}" data-cht-skill="${s.id}">${spade(s.status === 'mastered', label)}<span>${esc(s.name)}</span><b>${s.status === 'new' ? '–' : s.score}</b></button>`;
  }
  h += '</div>';
  h += next
    ? `<div class="v3-track-go"><button type="button" class="tr-start" data-cht-skill="${next.id}">Practice ${esc(next.name)}</button><span>${next.status === 'started' ? `${next.score} of ${MASTERY} to earn its spade.` : `Score ${MASTERY} to earn its spade.`}</span></div>`
    : '<div class="v3-track-go"><span>Every spot here mastered. Tap one to keep practising.</span></div>';
  if (cs.table === '6max') h += '<p class="ct-note">Six-handed, the spots so far are opening ranges. Facing a raise comes once the six-handed solve plays those spots well.</p>';
  return h + '</section>';
}

/** Ducybot's spots as a group of options for the Custom screen. */
export function chartOptionsHtml() {
  let h = '';
  for (const t of CHART_TRACKS) {
    h += `<div class="tr-group">Ducybot’s ranges · ${t.label}</div><div class="tr-options">`;
    for (const id of t.ids) h += `<button class="tr-opt" data-cht-table="${t.table}" data-cht-skill="${id}">${esc(spotNameFromId(id))}</button>`;
    h += '</div>';
  }
  return h;
}

// ---- practice ----

/** Starts practising the picked spot (once its chart has loaded). */
export function startChartPractice() {
  const key = chartSkillKey(cs.table, cs.bb, cs.id, cs.mode);
  cs.practice = {key, table: cs.table, bb: cs.bb, id: cs.id, mode: cs.mode, loading: true};
  prepare();
}

// Fills in the practice once the chart is here: its actions, obvious hands,
// the saved score (starting over if the chart changed), then the first hand.
function prepare() {
  const pr = cs.practice;
  const spot = spotData(pr.table, pr.bb, pr.id);
  if (spot === undefined) return; // rerender() calls back here
  if (!spot) { pr.loading = false; pr.missing = true; return; }
  const ta = trainingActions(spot);
  const fp = spotFingerprint(spot);
  let rec = loadAll()[pr.key];
  const reset = rec && rec.chart !== fp;
  if (!rec || reset) rec = {score: 0, best: 0, answered: 0, chart: fp, ...(reset ? {resetBy: 'chart'} : {})};
  Object.assign(pr, {
    loading: false, spot, ta, fp, obvious: obviousCells(spot, ta), hu: pr.table === 'hu',
    score: rec.score, best: rec.best, startScore: rec.score, total: rec.answered || 0, resetBy: rec.resetBy,
    answered: 0, correct: 0, streak: 0, history: [], delta: 0, feedback: null, mastered: false,
  });
  saveRec(pr.key, {...rec, chart: fp});
  nextHand();
}

function nextHand() {
  const pr = cs.practice;
  pr.feedback = null;
  const probe = pr.answered >= 4 && Math.random() < PROBE_RATE;
  const i = pickCell(pr.spot, {band: chartLevel(pr.mode, pr.score).band, probe, ta: pr.ta, obvious: pr.obvious});
  const mix = handMix(pr.spot, i, pr.ta);
  pr.current = {i, cards: cardsFor(i), mix, probe};
  // Mixed mode starts the sliders at an even split, so no answer is given away.
  if (pr.mode === 'mixed') pr.guess = setShare(pr.ta.actions.map(() => 0), 0, Math.round(100 / pr.ta.actions.length / 5) * 5);
}

// Scores an answer: k is the action picked (fixed) or null with pr.guess (mixed).
function answer(k) {
  const pr = cs.practice;
  if (!pr || pr.feedback || pr.mastered || pr.loading) return;
  const {mix, probe, i} = pr.current;
  const before = pr.score;
  let correct, close = false, severity = 0, distance = 0;
  if (pr.mode === 'fixed') {
    correct = fixedAnswers(mix).includes(k);
    severity = fixedSeverity(mix, k);
    close = !correct && !probe && severity < 0.25;
    pr.score = correct ? Math.min(100, pr.score + gainFor(pr.score)) : Math.max(0, pr.score - fixedPenalty(severity, probe));
  } else {
    distance = mixDistance(pr.guess, mix);
    correct = distance <= RIGHT_MIX;
    close = !correct && distance <= CLOSE_MIX;
    pr.score = correct ? Math.min(100, pr.score + gainFor(pr.score)) : Math.max(0, pr.score - mixedPenalty(distance));
  }
  pr.delta = pr.score - before;
  pr.answered++; pr.total++;
  pr.best = Math.max(pr.best, pr.score);
  if (correct) { pr.correct++; pr.streak++; } else pr.streak = 0;
  pr.history.push({i, mix, k, guess: pr.guess && [...pr.guess], correct, close, severity, distance, probe});
  saveRec(pr.key, {...(loadAll()[pr.key] || {}), score: pr.score, best: pr.best, answered: pr.total, chart: pr.fp});
  if (pr.score >= MASTERY && before < MASTERY) { pr.mastered = true; return; }
  // Fixed mode moves straight on after a right answer; everything else
  // shows the hand's real mix first.
  if (pr.mode === 'fixed' && correct) nextHand();
  else pr.feedback = {correct, close, major: !correct && probe, k, guess: pr.guess && [...pr.guess], distance};
}

// ---- drawing ----

const SUITS = {s: ['♠', false], h: ['♥', true], d: ['♦', true], c: ['♣', false]};
const cardHtml = c => `<div class="tr-card ${SUITS[c[1]][1] ? 'r' : 'bk'} s-${c[1]}">${c[0]}${SUITS[c[1]][0]}</div>`;
const pctText = p => `${Math.round(p)}%`;

// A mix as a bar, coloured by action (the charts' colours), with its words under it.
function mixBar(mix, ta, label) {
  let h = `<div class="ct-mixrow">${label ? `<span class="ct-mixlabel">${esc(label)}</span>` : ''}<div class="ct-mix">`;
  // All-in, raise, call, fold from the left, as on the charts.
  const order = ta.actions.map((x, k) => ({...x, k})).sort((a, b) => b.a - a.a);
  for (const x of order) if (mix[x.k] > 0.5) h += `<span class="pfc-part a${x.a}" style="width:${mix[x.k]}%" title="${esc(x.verb)} ${pctText(mix[x.k])}"></span>`;
  h += '</div></div>';
  return h;
}
// In words, leaving out slivers under 3% (the solve's noise).
const mixWords = (mix, ta) => ta.actions.map((x, k) => ({x, p: mix[k]})).filter(o => o.p >= 3).sort((a, b) => b.p - a.p)
  .map(o => `${esc(o.x.verb)} ${pctText(o.p)}`).join(' · ');

function scoreBar(pr) {
  const deltaText = pr.delta > 0 ? `+${pr.delta}` : pr.delta < 0 ? `${pr.delta}` : '';
  const won = pr.best >= MASTERY;
  let h = '<div class="tr-v3-score">';
  h += `<div class="tr-v3-bar" role="img" aria-label="Score ${pr.score} of 100; ${MASTERY} masters it"><div class="tr-v3-fill" style="width:${pr.score}%"></div><span class="tr-v3-goal" style="left:${MASTERY}%" title="${MASTERY}: mastered"></span></div>`;
  h += `<b class="tr-v3-num">${pr.score}</b>${deltaText ? `<em class="tr-v3-delta ${pr.delta > 0 ? 'up' : 'down'}" data-k="${pr.answered}">${deltaText}</em>` : ''}`;
  h += `<svg class="tr-v3-spade${won ? ' won' : ''}" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="${won ? 'Spade earned' : 'Spade not earned yet'}"><path d="${SPADE}"/></svg>`;
  return h + '</div>';
}

const titleOf = pr => `${pr.hu ? 'Heads-up' : '6-max'} · ${esc(spotName(pr.spot))}`;
const modeLabel = mode => CHART_MODES.find(m => m.mode === mode).label;

/** The next skill on the same track and mode after `id`, or null when all are mastered. */
function nextSkillAfter(pr) {
  const skills = trackSkills(loadAll(), pr.table, pr.bb, pr.mode);
  const at = skills.findIndex(s => s.id === pr.id);
  return [...skills.slice(at + 1), ...skills.slice(0, at)].find(s => s.status !== 'mastered') || null;
}

export function chartPracticeHtml() {
  const pr = cs.practice;
  let h = '<div class="tr-wrap tr-play tr-v3 ct-play">';
  if (!pr || pr.loading) return h + '<p class="pfc-note">Loading Ducybot’s chart…</p></div>';
  if (pr.missing) return h + `<p class="pfc-note">There’s no chart for this spot at ${pr.bb} BB.</p><button type="button" class="link-btn" data-act="overview">‹ Pre-flop ranges</button></div>`;
  h += '<div class="tr-v3-head"><button type="button" class="link-btn tr-back" data-act="overview">Pre-flop ranges ›</button>';
  h += `<h1>${titleOf(pr)}</h1><span class="ct-sub">${pr.bb} BB · ${modeLabel(pr.mode)}</span></div>`;
  h += scoreBar(pr);
  if (pr.resetBy === 'chart' && !pr.answered) h += '<div class="tr-weak">Ducybot’s chart for this spot was updated, so your score here started over.</div>';

  if (pr.mastered) {
    const next = nextSkillAfter(pr);
    h += '<div class="tr-mastered" role="status"><strong>Mastered!</strong>';
    h += `<p>${MASTERY} on ${titleOf(pr)} (${modeLabel(pr.mode).toLowerCase()}) after ${pr.total} hands: its spade is yours, and it stays mastered. Keep going toward 100, or move on.</p>`;
    h += '<div class="tr-actions"><button class="tr-btn yes" data-cht-act="keep">Keep going<kbd>Space</kbd></button>';
    h += next ? `<button class="tr-btn next" data-cht-act="next" data-cht-next="${next.id}">Next: ${esc(next.name)}</button>` : '<button class="tr-btn next" data-act="overview">All skills</button>';
    h += '</div></div>';
    return h + '</div>';
  }

  const {cards, mix} = pr.current;
  h += `<div class="tr-felt"><div class="tr-v3-ask">${esc(spotQuestion(pr.spot, pr.hu))}</div><div class="tr-cards"${pr.feedback ? '' : ` data-deal="${pr.answered}"`}>${cards.map(cardHtml).join('')}</div></div>`;
  const ta = pr.ta;
  if (pr.feedback) {
    const f = pr.feedback;
    const head = f.correct ? 'Right' : f.major ? 'Major mistake' : f.close ? 'Close' : 'Not quite';
    const cls = f.correct ? 'good' : f.close ? 'close' : 'bad';
    h += `<div class="tr-feedback ct-feedback ${cls}" role="status"><p><strong>${head}</strong> — `;
    if (pr.mode === 'fixed') {
      h += `Ducybot ${mix[f.k] >= 0.5 ? `takes “${esc(ta.actions[f.k].verb)}” only ${pctText(mix[f.k])} of the time here` : `never takes “${esc(ta.actions[f.k].verb)}” here`}.`;
    } else {
      h += `you’re ${Math.round(f.distance)} points off his mix${f.correct ? '' : f.close ? ', close enough to keep your score' : ''}.`;
    }
    h += '</p>';
    h += mixBar(mix, ta, 'Ducybot');
    if (pr.mode === 'mixed') h += mixBar(f.guess, ta, 'You');
    h += `<div class="ct-words">${cellHand(pr.current.i)}: ${mixWords(mix, ta)}</div></div>`;
    h += '<div class="tr-actions"><button class="tr-btn next" data-cht-act="continue">Continue<kbd>Space</kbd></button></div>';
  } else if (pr.mode === 'fixed') {
    h += '<div class="tr-actions ct-actions">';
    ta.actions.forEach((x, k) => { h += `<button class="tr-btn ${x.a === 0 ? 'no' : 'yes'} ct-a${x.a}" data-cht-answer="${k}">${esc(x.verb)}<kbd>${k + 1}</kbd></button>`; });
    h += '</div>';
    const last = pr.history.at(-1);
    if (last?.correct) h += `<div class="tr-v3-last"><b>Right${pr.delta > 0 ? ` · +${pr.delta}` : ''}</b><span>Last hand: ${cellHand(last.i)}, ${mixWords(last.mix, ta)}.</span></div>`;
  } else {
    h += '<div class="ct-sliders">';
    ta.actions.forEach((x, k) => {
      h += `<label class="ct-slider"><span class="ct-verb"><span class="pfc-swatch a${x.a}"></span>${esc(x.verb)}</span>`;
      h += `<input type="range" min="0" max="100" step="5" value="${pr.guess[k]}" data-cht-share="${k}" aria-label="${esc(x.verb)}, percent of the time">`;
      h += `<b class="ct-share" data-cht-shown="${k}">${pr.guess[k]}%</b></label>`;
    });
    h += '<div class="ct-quick">';
    ta.actions.forEach((x, k) => { h += `<button type="button" class="btn-small" data-cht-all="${k}">Always ${esc(x.verb.split(' to ')[0].toLowerCase())}</button>`; });
    h += '</div></div>';
    h += '<div class="tr-actions"><button class="tr-btn yes" data-cht-act="submit">Submit<kbd>Enter</kbd></button></div>';
  }
  h += `<div class="tr-v3-foot"><span>${pr.answered} hands · ${pr.correct} right · streak ${pr.streak} · ${chartLevel(pr.mode, pr.score).name}</span><button type="button" class="link-btn" data-cht-act="end">End practice</button></div>`;
  return h + '</div>';
}

// The spot's whole chart, with this session's misses outlined.
function chartGrid(pr, missed) {
  let h = '<div class="pfc-grid ct-grid">';
  for (let i = 0; i < 169; i++) {
    const mix = handMix(pr.spot, i, pr.ta);
    const order = pr.ta.actions.map((x, k) => ({...x, k})).sort((a, b) => b.a - a.a);
    let x = 0, parts = '';
    for (const o of order) { const w = mix[o.k]; if (w > 0) parts += `<span class="pfc-part a${o.a}" style="left:${x}%;width:${w}%"></span>`; x += w; }
    h += `<div class="pfc-cell${missed.has(i) ? ' ct-missed' : ''}" title="${cellHand(i)}: ${mixWords(mix, pr.ta)}"><span class="pfc-bars">${parts}</span><span class="pfc-hand">${cellHand(i)}</span></div>`;
  }
  h += '</div><div class="pfc-legend">';
  for (const o of pr.ta.actions) h += `<span class="pfc-key"><span class="pfc-swatch a${o.a}"></span>${esc(o.verb)}</span>`;
  return h + '<span class="pfc-key"><span class="pfc-swatch ct-missed-key"></span>Missed this session</span></div>';
}

export function chartSummaryHtml() {
  const pr = cs.practice;
  const misses = pr.history.filter(x => !x.correct);
  let h = '<div class="tr-wrap">';
  h += `<div class="tr-head"><h1>Score ${pr.startScore} → ${pr.score}</h1>`;
  h += `<p>${titleOf(pr)} · ${pr.bb} BB · ${modeLabel(pr.mode)} · ${pr.correct} of ${pr.answered} right this session</p></div>`;
  h += '<div class="tr-summary"><div class="tr-stats">';
  h += `<div class="tr-stat"><b>${pr.answered}</b><span>Hands this session</span></div>`;
  h += `<div class="tr-stat"><b>${pr.answered ? Math.round((pr.correct / pr.answered) * 100) : 0}%</b><span>Right</span></div>`;
  h += `<div class="tr-stat bad"><b>${misses.filter(x => x.probe).length}</b><span>Major mistakes (obvious hands)</span></div>`;
  h += `<div class="tr-stat"><b>${misses.filter(x => x.close).length}</b><span>Close</span></div>`;
  h += '</div>';
  const list = misses.length
    ? misses.map(x => `<div class="tr-ex${x.probe ? ' major' : ''}"><span class="tr-hand"><b class="tr-cls">${cellHand(x.i)}</b></span><span class="tr-pct">${pr.mode === 'fixed' ? `you: ${esc(pr.ta.actions[x.k].verb)}` : `${Math.round(x.distance)} points off`} · Ducybot: ${mixWords(x.mix, pr.ta)}</span></div>`).join('')
    : '<span class="tr-none">None</span>';
  h += `<div class="tr-mistakes"><div class="tr-group">Misses</div>${list}</div>`;
  h += `<div class="tr-preview"><div class="tr-group">Ducybot’s chart for this spot</div>${chartGrid(pr, new Set(misses.map(x => x.i)))}</div>`;
  h += '<div class="tr-actions"><button class="tr-btn" data-act="overview">All skills</button><button class="tr-btn yes" data-cht-act="again">Practice again</button></div>';
  return h + '</div></div>';
}

// ---- input ----

/**
 * A click on the chart track or a chart screen. Returns the screen to show
 * ('chart-practice', 'chart-summary', 'overview'), true if handled in place,
 * or false if it isn't a chart control.
 */
export function chartClick(el) {
  const d = el.dataset;
  if (d.chtTable && !d.chtSkill) { cs.table = d.chtTable; if (!depthsFor(cs.table).includes(cs.bb)) cs.bb = DEFAULT_BB; return true; }
  if (d.chtMode) { cs.mode = d.chtMode; return true; }
  if (d.chtBb) { cs.bb = +d.chtBb; return true; }
  if (d.chtSkill) {
    if (d.chtTable) cs.table = d.chtTable;
    cs.id = d.chtSkill;
    startChartPractice();
    return 'chart-practice';
  }
  if (d.chtAnswer != null) { answer(+d.chtAnswer); return true; }
  if (d.chtAll != null) { const pr = cs.practice; pr.guess = pr.ta.actions.map((_, k) => (k === +d.chtAll ? 100 : 0)); return true; }
  const act = d.chtAct;
  if (!act) return false;
  const pr = cs.practice;
  if (act === 'submit') answer(null);
  else if (act === 'continue') nextHand();
  else if (act === 'keep') { pr.mastered = false; nextHand(); }
  else if (act === 'next') { cs.id = d.chtNext; cs.table = pr.table; cs.bb = pr.bb; cs.mode = pr.mode; startChartPractice(); return 'chart-practice'; }
  else if (act === 'end') return 'chart-summary';
  else if (act === 'again') { cs.id = pr.id; cs.table = pr.table; cs.bb = pr.bb; cs.mode = pr.mode; startChartPractice(); return 'chart-practice'; }
  return true;
}

/** A slider moved: the others follow so the mix adds to 100, updated in place. */
export function chartInput(el, root) {
  if (el.dataset.chtShare == null) return false;
  const pr = cs.practice;
  pr.guess = setShare(pr.guess, +el.dataset.chtShare, +el.value);
  root.querySelectorAll('[data-cht-share]').forEach(s => { if (s !== el) s.value = pr.guess[+s.dataset.chtShare]; });
  root.querySelectorAll('[data-cht-shown]').forEach(b => { b.textContent = `${pr.guess[+b.dataset.chtShown]}%`; });
  return true;
}

/** Keys on the chart practice screen: 1-4 pick an action, Enter submits, Space continues. Returns true if used. */
export function chartKey(k) {
  const pr = cs.practice;
  if (!pr || pr.loading) return false;
  if (pr.mastered && k === ' ') { pr.mastered = false; nextHand(); return true; }
  if (pr.feedback && (k === ' ' || k === 'enter')) { nextHand(); return true; }
  if (pr.feedback || pr.mastered) return false;
  if (pr.mode === 'fixed' && /^[1-4]$/.test(k) && +k <= pr.ta.actions.length) { answer(+k - 1); return true; }
  if (pr.mode === 'mixed' && k === 'enter') { answer(null); return true; }
  return false;
}

/** Called by trainer.js's render while a chart practice is loading. */
export function chartTick() {
  if (cs.practice?.loading) prepare();
}

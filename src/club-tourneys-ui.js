// The club page's tournaments (#64): the host's Tournaments tab (the New
// tournament wizard, #477, the lobby, payouts, live standings and results)
// and a member's list (register, unregister, play, late registration and
// re-entry). HTML builders, the wizard's draft and form readers only;
// clubs.js owns the state and sends the actions.
//
// Club chips (buy-ins, rake, prizes) are shown divided by 100
// (chip-format.js); tournament chips (stacks, blinds) are whole numbers.

import { OFF } from './club-beta.js';
import { chipText, chipInput, parseChips, CHIP_STEP } from './chip-format.js';
import { defaultSeats, GAMES, maxSeats } from './club-tables.js';
import { entryCount, playerCount, pool, prizes, payoutShares } from './club-tourneys.js';
import { pct, rowsEditorHtml, rowsTableHtml } from './payout-table-ui.js';
import { PRESETS } from './tourney-structure.js';
import { pickHtml, pickedOther, readPick } from './amount-picks.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const whole = n => Number(n || 0).toLocaleString();
const club$ = n => chipText(n);
const gameName = id => GAMES.find(g => g.id === id)?.label || id;
const dateTime = t => new Date(t).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const dateOnly = t => new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const ordinal = n => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
// A buy-in with its rake (#477): "10 + 1", or "10".
export const buyInText = t => (t.rake ? `${club$(t.buyIn)} + ${club$(t.rake)}` : club$(t.buyIn));
// "in 2 h 5 min", "in 3 min", "now"
function until(t, now = Date.now()) {
  const m = Math.round((t - now) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `on ${dateTime(t)}`;
}
// A datetime-local input's value for time `t`, and back; a date input's.
const localInput = t => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = v => (v ? new Date(v).getTime() : NaN);
const dateInput = t => localInput(t).slice(0, 10);
// The end of the day a date input names, in this browser's time.
const fromDate = v => (v ? new Date(`${v}T23:59`).getTime() : NaN);

const STATUS = {scheduled: 'Registering', running: 'Running', finished: 'Finished', cancelled: 'Cancelled'};

// The level being played, as text: "Level 3 · 50/100 (ante 10)", or a break.
// Past the structure's last level the blinds keep rising (#477): the live
// blinds say what they are.
export function levelText(structure, live) {
  if (!live) return '';
  if (live.onBreak) return 'On a break';
  const lv = live.blinds || structure.filter(s => !s.break)[live.level];
  if (!lv) return '';
  return `Level ${live.level + 1} · ${whole(lv.sb)}/${whole(lv.bb)}${lv.ante ? ` (ante ${whole(lv.ante)})` : ''}`;
}

// ---- the host: the New tournament wizard (#477) ----

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const WIZARD_STEPS = ['Game and buy-in', 'Stack and structure', 'Payouts', 'Schedule', 'Review'];
// When registration opens, before the start; 0: now (a one-time tournament).
export const OPENS = [[0, 'Now'], [30 * MIN, '30 min before'], [HOUR, '1 hour before'], [2 * HOUR, '2 hours before'], [6 * HOUR, '6 hours before'], [DAY, '1 day before'], [2 * DAY, '2 days before'], [7 * DAY, '1 week before']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LATE_LEVELS = 12;
// Re-entries per player: -1 none, 0 no limit.
const REENTRIES = [[-1, 'None'], [1, '1'], [2, '2'], [3, '3'], [0, 'No limit']];
const PRESET_IDS = ['turbo', 'regular', 'deep'];

// The next whole hour at least half an hour from now.
function startDefault(now) {
  const d = new Date(now + 90 * MIN);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// The OPENS value nearest `ms` (series never open "now").
function nearestOpens(ms, series) {
  const opts = OPENS.filter(([v]) => !series || v > 0);
  return opts.reduce((a, [v]) => (Math.abs(v - ms) < Math.abs(a - ms) ? v : a), opts[0][0]);
}

// A new tournament's draft, from the last settings used (`last`).
export function newDraft(last = {}, now = Date.now()) {
  const game = GAMES.some(g => g.id === last.game) ? last.game : 'nlhe';
  const startsAt = startDefault(now);
  return {
    name: '', game, buyIn: last.buyIn ?? 0, rake: last.rake ?? 0, added: last.added ?? 0,
    stack: last.stack || 10000, tableSize: Math.min(last.tableSize || defaultSeats(game), maxSeats(game)),
    minPlayers: last.minPlayers || 2, maxPlayers: last.maxPlayers || 50,
    preset: PRESET_IDS.includes(last.preset) ? last.preset : 'regular',
    payoutTable: last.payoutTable || '',
    when: 'once', startsAt, days: [new Date(startsAt).getDay()], end: 'count', count: 10, until: startsAt + 28 * DAY,
    opensBefore: nearestOpens(last.opensBefore ?? 0, false), lateLevel: last.lateLevel ?? 0,
    reentry: !!last.reentry, maxReentries: last.maxReentries ?? 0,
  };
}

// A draft to change tournament `t` (or a series' settings, as a tournament
// at its next start); `series`: its series, when the whole of it changes.
export function tourneyDraft(t, series = null, now = Date.now()) {
  // A series keeps its own; one already open stays open ("Now").
  const opensBefore = series ? series.opensBefore : t.opensAt <= now ? 0 : t.startsAt - t.opensAt;
  return {
    name: t.name || '', game: t.game || 'nlhe', buyIn: t.buyIn || 0, rake: t.rake || 0, added: t.added || 0,
    stack: t.stack, tableSize: t.tableSize, minPlayers: t.minPlayers || 2, maxPlayers: t.maxPlayers || 50,
    preset: 'custom', payoutTable: t.payoutTable || '',
    when: series ? series.every : 'once', startsAt: t.startsAt,
    days: series?.days?.length ? series.days.slice() : [new Date(t.startsAt).getDay()],
    end: series?.until ? 'until' : 'count', count: series?.count || 10, until: series?.until || t.startsAt + 28 * DAY,
    opensBefore: nearestOpens(opensBefore, !!series), lateLevel: t.lateLevel || 0,
    reentry: !!t.reentry, maxReentries: t.maxReentries || 0,
  };
}

// The settings for the host (club-tourneys.js newTourney, edit_tourney,
// edit_series) from a finished draft and its blind structure. `repeat`:
// whether its schedule goes too (a new one, or a whole series).
export function draftSettings(d, structure, {repeat = true, now = Date.now()} = {}) {
  const s = {
    name: d.name, game: d.game, buyIn: d.buyIn, rake: d.rake, added: d.added, stack: d.stack, tableSize: d.tableSize,
    minPlayers: d.minPlayers, maxPlayers: d.maxPlayers, structure, payoutTable: d.payoutTable || '',
    startsAt: d.startsAt, lateLevel: d.lateLevel, reentry: d.reentry, maxReentries: d.maxReentries,
  };
  const repeats = repeat && d.when !== 'once';
  if (d.opensBefore > 0 || repeats) s.opensBefore = d.opensBefore || 2 * HOUR;
  else s.opensAt = Math.min(now, d.startsAt);
  if (repeats) {
    s.repeat = {every: d.when, offsetMin: -new Date(d.startsAt).getTimezoneOffset()};
    if (d.when === 'week') s.repeat.days = d.days.slice();
    if (d.end === 'until') s.repeat.until = d.until; else s.repeat.count = d.count;
  }
  return s;
}

// The last settings to start the next new one from (kept on this device).
export const draftLast = d => ({
  game: d.game, buyIn: d.buyIn, rake: d.rake, added: d.added, stack: d.stack, tableSize: d.tableSize, minPlayers: d.minPlayers,
  maxPlayers: d.maxPlayers, preset: d.preset, payoutTable: d.payoutTable, opensBefore: d.opensBefore, lateLevel: d.lateLevel,
  reentry: d.reentry, maxReentries: d.maxReentries,
});

// A draft and its blind structure as they stand, to tell whether anything
// was entered since the wizard opened (#544). Re-entries count only when on.
export const draftKey = (d, structure) => JSON.stringify({...d, maxReentries: d.reentry ? d.maxReentries : 0, other: undefined, structure});

// Reads wizard step `step`'s form into draft `d`. `strict`: also checks it,
// returning what's wrong ('' if nothing); not strict (a choice that changes
// what the step shows), what's typed is kept as far as it reads.
export function readStep(f, d, step, {strict = true, now = Date.now(), edit = null, structureErrors = []} = {}) {
  const el = f.elements;
  const v = name => el[name]?.value ?? '';
  // Picked from presets, or typed under Other (#544); Other stays open.
  for (const k of PICKED[step] || []) {
    if (!el[`${k}Pick`]) continue;
    d.other = (d.other || []).filter(x => x !== k).concat(pickedOther(el, k) ? [k] : []);
  }
  const number = t => (t === '' ? NaN : Number(t));
  const int = name => (PICKED[step]?.includes(name) ? readPick(el, name, number) : number(v(name)));
  if (step === 1) {
    d.name = v('name').trim();
    d.game = v('game') || d.game;
    const [buyIn, rake, added] = ['buyIn', 'rake', 'added'].map(k => readPick(el, k, t => parseChips(t || '0')));
    if (Number.isSafeInteger(buyIn)) d.buyIn = buyIn;
    if (Number.isSafeInteger(rake)) d.rake = rake;
    if (Number.isSafeInteger(added)) d.added = added;
    if (d.tableSize > maxSeats(d.game)) d.tableSize = maxSeats(d.game);
    if (strict && ![buyIn, rake, added].every(Number.isSafeInteger)) return 'The buy-in, rake and added are amounts like 10 or 2.50.';
  } else if (step === 2) {
    for (const k of ['stack', 'tableSize', 'minPlayers', 'maxPlayers']) if (Number.isSafeInteger(int(k))) d[k] = int(k);
    d.preset = v('preset') || d.preset;
    if (!strict) return '';
    if (!(d.stack >= 20)) return 'The starting stack is at least 20 chips.';
    if (!(d.tableSize >= 2 && d.tableSize <= maxSeats(d.game))) return `A table seats 2 to ${maxSeats(d.game)}.`;
    if (!(d.minPlayers >= 2 && d.maxPlayers >= d.minPlayers)) return 'At least 2 players, and a maximum no smaller than the minimum.';
    if (structureErrors.length) return structureErrors[0];
  } else if (step === 3) {
    d.payoutTable = v('payoutTable');
  } else if (step === 4) {
    if (el.when) d.when = v('when') || d.when;
    const at = fromLocal(v('startsAt'));
    if (Number.isFinite(at)) d.startsAt = at;
    if (el.days) d.days = [...f.querySelectorAll('[name=days]:checked')].map(x => Number(x.value));
    if (el.end) d.end = v('end') || d.end;
    if (el.count && v('count') !== '') d.count = int('count');
    if (el.until) { const u = fromDate(v('until')); if (Number.isFinite(u)) d.until = u; }
    if (el.opensBefore) d.opensBefore = int('opensBefore');
    if (el.lateLevel) d.lateLevel = int('lateLevel');
    if (el.reentries) { const r = int('reentries'); d.reentry = r >= 0; d.maxReentries = Math.max(0, r); }
    if (!strict) return '';
    if (!Number.isFinite(at)) return 'Pick when it starts.';
    if (at <= now && !(edit && at === edit.startsAt)) return 'It starts later than now.';
    const repeats = d.when !== 'once' && (!edit || edit.series);
    if (repeats && d.when === 'week' && !d.days.length) return 'Pick the days of the week.';
    if (repeats && d.end === 'count' && !(Number.isInteger(d.count) && d.count >= 2 && d.count <= 500)) return 'It repeats 2 to 500 times.';
    if (repeats && d.end === 'until' && !(d.until > d.startsAt)) return 'The last date is after the first start.';
  }
  return '';
}

// The wizard's pieces: a choice as a tile (`meta`: a line of data under
// it), a row of tiles, a segmented choice, a group with its heading, and
// a field with its label.
const tile = (type, name, value, label, on, meta = '') =>
  `<label class="tw-tile"><input type="${type}" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}><span class="tw-tile-name">${label}</span>${meta ? `<span class="tw-tile-meta">${meta}</span>` : ''}</label>`;
const tfRadio = (name, value, label, on, meta) => tile('radio', name, value, label, on, meta);
const tfCheck = (name, value, label, on) => tile('checkbox', name, value, label, on);
const tiles = (html, cls = '') => `<div class="tw-tiles${cls}">${html}</div>`;
const seg = (label, html) => `<div class="tw-row"><span class="tw-label">${label}</span><div class="tw-seg">${html}</div></div>`;
const group = (label, html) => `<section class="tw-group"><h4>${label}</h4>${html}</section>`;
const options = (list, picked) => list.map(([v, label]) => `<option value="${v}"${v === picked ? ' selected' : ''}>${esc(label)}</option>`).join('');
const field = (label, html, wide = false) => `<label class="tw-field${wide ? ' tw-wide' : ''}"><span class="tw-label">${label}</span>${html}</label>`;
// `cls`: tw-trio (three short numbers, side by side even on a phone),
// tw-roomy (wider fields, for a date and time).
const fields = (html, cls = '') => `<div class="tw-fields${cls ? ` ${cls}` : ''}">${html}</div>`;
const num = (name, value, attrs = '') => `<input class="pl-text" name="${name}" type="number" step="1" inputmode="numeric" value="${esc(value)}" ${attrs}>`;
const chips = (name, value) => `<input class="pl-text" name="${name}" type="number" min="0" step="${CHIP_STEP}" inputmode="decimal" value="${esc(chipInput(value))}">`;
// A number picked from presets, or typed under Other (#544, amount-picks.js):
// `box` the Other box; Other stays picked once it is (d.other).
const picks = (label, name, list, d, text, box) => seg(label, pickHtml(name, list, d[name], text, box, {tile: true, other: d.other?.includes(name)}));
// The presets: club chips in hundredths (a buy-in of 20, 50 or 100, like
// the tables' buy-ins), then tournament chips and players.
const BUY_INS = [0, 2000, 5000, 10000];
const RAKES = [0, 200, 500, 1000];
const STACKS = [5000, 10000, 20000];
const MIN_PLAYERS = [2, 4, 6];
const MAX_PLAYERS = [10, 20, 50, 100];
// The fields picked that way, by step.
const PICKED = {1: ['buyIn', 'rake'], 2: ['stack', 'minPlayers', 'maxPlayers']};

// A game's table sizes, [[seats, label]]: short-handed (6) and full (its
// usual size above 6, else its most: Hold'em 9, Omaha 4 and 5 8); Omaha 6
// is only ever 6. `now`: the size a tournament already has, if it's neither.
export function tableSizes(game, now) {
  const short = Math.min(6, maxSeats(game));
  const full = defaultSeats(game) > 6 ? defaultSeats(game) : maxSeats(game);
  const sizes = [[short, 'Short-handed']];
  if (full > short) sizes.push([full, 'Full']);
  if (Number.isInteger(now) && now >= 2 && now <= maxSeats(game) && !sizes.some(([n]) => n === now)) {
    sizes.push([now, `${now}-handed`]);
    sizes.sort((a, b) => a[0] - b[0]);
  }
  return sizes;
}

const presetLabel = id => PRESETS().find(p => p.id === id)?.label || id;
const lateText = n => (n ? `End of level ${n}` : 'Off');
const reentryText = d => (!d.reentry ? 'None' : d.maxReentries ? String(d.maxReentries) : 'No limit');
const opensText = ms => OPENS.find(([v]) => v === ms)?.[1] || `${Math.round(ms / HOUR)} hours before`;

// How a draft repeats, in a few words: "Daily, 10 times", "Weekly on Mon,
// Wed until Mar 3, 2027".
export function repeatText(d) {
  if (d.when === 'once') return 'Once';
  const how = d.when === 'day' ? 'Daily' : `Weekly on ${[...d.days].sort((a, b) => a - b).map(i => WEEKDAYS[i]).join(', ')}`;
  return d.end === 'until' ? `${how} until ${dateOnly(d.until)}` : `${how}, ${d.count} times`;
}

// The wizard, step `w.step` (1 to 5). `w` = {step, d (the draft), editor
// (its blind structure, tourney-structure-ui.js), edit ({id, series,
// startsAt} changing a tournament, {sid} a series, or null), note (what's
// wrong), discard (✕ asked about a draft with something entered, #544)};
// `payTable`: a payout table being made or changed here (step 3).
export function wizardHtml(w, club, payTable = null) {
  const {d, step} = w;
  const tables = club.payoutTables || [];
  const title = w.edit ? 'Edit tournament' : 'New tournament';
  let h = '<div class="tw">';
  h += `<div class="tw-head"><h3>${title}</h3>`;
  h += w.discard
    ? '<span class="cl-confirm tw-discard">Discard?<button class="btn-small primary" type="button" data-cl="tw-discard">Discard</button><button class="btn-small" type="button" data-cl="tw-keep">Keep editing</button></span>'
    : '<button class="tw-close" type="button" data-cl="cancel-tourney-form" aria-label="Close">✕</button>';
  h += '</div>';
  // The steps: done ones go back to themselves.
  h += '<ol class="tw-steps">';
  WIZARD_STEPS.forEach((label, i) => {
    const n = i + 1;
    const inner = `<span class="tw-dot">${n < step ? '✓' : n}</span><span class="tw-name">${esc(label)}</span>`;
    const cls = n === step ? ' class="on" aria-current="step"' : n < step ? ' class="done"' : '';
    h += `<li${cls}>${n < step ? `<button type="button" class="tw-step" data-cl="tw-go" data-step="${n}">${inner}</button>` : `<span class="tw-step">${inner}</span>`}</li>`;
  });
  h += '</ol>';
  h += `<form class="tw-body" id="tw-form" data-tourneyform="${step}">`;
  if (step === 1) {
    h += fields(field('Name', `<input class="pl-text" name="name" maxlength="40" placeholder="Tournament" value="${esc(d.name)}">`, true));
    h += group('Game', tiles(GAMES.map(g => tfRadio('game', g.id, esc(g.label), g.id === d.game)).join('')));
    h += group('Entry', picks('Buy-in', 'buyIn', BUY_INS, d, v => (v ? club$(v) : 'Free'), chips('buyIn', d.buyIn))
      + (OFF.has('rake') && !d.rake ? '' : picks('Rake', 'rake', RAKES, d, v => (v ? club$(v) : 'None'), chips('rake', d.rake)))
      + fields(field('Added', chips('added', d.added)), 'tw-trio'));
  } else if (step === 2) {
    h += group('Stack and players', picks('Starting stack', 'stack', STACKS, d, whole, num('stack', d.stack, 'min="20" data-tstack="1"'))
      + picks('Minimum players', 'minPlayers', MIN_PLAYERS, d, String, num('minPlayers', d.minPlayers, 'min="2"'))
      + picks('Maximum players', 'maxPlayers', MAX_PLAYERS, d, String, num('maxPlayers', d.maxPlayers, 'min="2" max="1000"')));
    h += group('Table', tiles(tableSizes(d.game, d.tableSize).map(([n, label]) => tfRadio('tableSize', n, label, n === d.tableSize, label.startsWith(n) ? '' : `${n} a table`)).join('')));
    const levels = w.editor.steps().filter(s => !s.break).length;
    let blinds = tiles(PRESETS().map(p => tfRadio('preset', p.id, esc(p.label), d.preset === p.id, `${p.minutes} min levels`)).join('')
      + tfRadio('preset', 'custom', 'Customize', d.preset === 'custom', d.preset === 'custom' ? `${levels} levels` : ''));
    if (d.preset === 'custom') blinds += `<div class="tw-editor" data-tseditor="1">${w.editor.html()}</div>`;
    h += group('Blinds', blinds);
  } else if (step === 3) {
    h += '<div class="tw-pays">';
    h += `<div class="tw-pay"><label><input type="radio" name="payoutTable" value=""${d.payoutTable ? '' : ' checked'}><span class="tw-tile-name">Default</span></label></div>`;
    for (const p of tables) {
      const on = d.payoutTable === p.id;
      h += `<div class="tw-pay"><label><input type="radio" name="payoutTable" value="${esc(p.id)}"${on ? ' checked' : ''}><span class="tw-tile-name">${esc(p.name)}</span></label>`;
      if (on && payTable?.id !== p.id) {
        h += `<span class="cl-acts"><button class="btn-small" type="button" data-cl="paytable-edit" data-id="${esc(p.id)}">Edit</button><button class="btn-small" type="button" data-cl="paytable-delete" data-id="${esc(p.id)}">Delete</button></span>`;
        h += rowsTableHtml(p.rows);
      }
      h += '</div>';
    }
    h += '</div>';
  } else if (step === 4) {
    const repeatable = !w.edit || w.edit.series;
    const repeats = repeatable && d.when !== 'once';
    let when = '';
    if (repeatable) when += seg('Repeats', [['once', 'Once'], ['day', 'Daily'], ['week', 'Weekly']].map(([v, l]) => tfRadio('when', v, l, d.when === v)).join(''));
    if (repeats && d.when === 'week') when += seg('Days', WEEKDAYS.map((l, i) => tfCheck('days', i, l, d.days.includes(i))).join(''));
    let at = field(repeats ? 'First start' : 'Starts', `<input class="pl-text" name="startsAt" type="datetime-local" value="${localInput(d.startsAt)}">`);
    if (repeats) {
      at += `<div class="tw-field"><span class="tw-label">Ends</span><div class="tw-seg">${tfRadio('end', 'count', 'After', d.end === 'count') + tfRadio('end', 'until', 'On a date', d.end === 'until')}</div></div>`;
      at += d.end === 'until'
        ? field('Last date', `<input class="pl-text" name="until" type="date" value="${dateInput(d.until)}">`)
        : field('Times', num('count', d.count, 'min="2" max="500"'));
    }
    h += group('When', when + fields(at, 'tw-roomy'));
    h += group('Registration', fields(
      field('Opens', `<select class="pl-text" name="opensBefore">${options(OPENS.filter(([v]) => !repeats || v > 0), d.opensBefore)}</select>`)
      + field('Late entry', `<select class="pl-text" name="lateLevel">${options(Array.from({length: LATE_LEVELS + 1}, (_, n) => [n, lateText(n)]), d.lateLevel)}</select>`)
      + field('Re-entries', `<select class="pl-text" name="reentries">${options(REENTRIES, d.reentry ? d.maxReentries : -1)}</select>`), 'tw-roomy'));
  } else {
    const steps = w.editor.steps().filter(s => !s.break);
    const blinds = d.preset === 'custom' ? `Custom · ${steps.length} levels` : presetLabel(d.preset);
    const payName = d.payoutTable ? tables.find(p => p.id === d.payoutTable)?.name || 'Default' : 'Default';
    const repeatable = !w.edit || w.edit.series;
    // The review, by step, each with its way back.
    const parts = [
      [['Name', d.name || 'Tournament'], ['Game', gameName(d.game)], ['Buy-in', d.rake ? `${club$(d.buyIn)} + ${club$(d.rake)} rake` : club$(d.buyIn)],
        ...(d.added ? [['Added', club$(d.added)]] : [])],
      [['Starting stack', whole(d.stack)], ['Table size', String(d.tableSize)], ['Players', `${d.minPlayers}–${d.maxPlayers}`], ['Blinds', blinds]],
      [['Table', payName]],
      [[d.when === 'once' || !repeatable ? 'Starts' : 'First start', dateTime(d.startsAt)],
        ...(repeatable ? [['Repeats', repeatText(d)]] : []),
        ['Registration opens', opensText(d.when !== 'once' && repeatable && !d.opensBefore ? 2 * HOUR : d.opensBefore)],
        ['Late entry', lateText(d.lateLevel)], ['Re-entries', reentryText(d)]],
    ];
    h += '<div class="tw-review">';
    parts.forEach((rows, i) => {
      h += `<section class="tw-sum"><div class="tw-sum-head"><h4>${esc(WIZARD_STEPS[i])}</h4><button type="button" class="tw-edit" data-cl="tw-go" data-step="${i + 1}">Edit</button></div>`;
      h += `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`;
    });
    h += '</div>';
  }
  if (w.note) h += `<p class="pl-desc pl-neterr tf-note">${esc(w.note)}</p>`;
  h += '</form>';
  // A payout table made or changed here: its own form, after the wizard's.
  if (step === 3) {
    if (payTable) h += payTableForm(payTable.id, payTable.name, payTable.draft);
    else h += '<div class="pl-actions"><button class="btn-small" type="button" data-cl="paytable-new">New payout table</button></div>';
  }
  h += '<div class="tw-foot">';
  if (step > 1) h += '<button class="btn-small" type="button" data-cl="tw-back">Back</button>';
  h += `<button class="btn-small primary" type="submit" form="tw-form">${step < 5 ? 'Next' : w.edit ? 'Save' : 'Create'}</button>`;
  return h + '</div></div>';
}

// A payout table's form (#424): its name and rows.
function payTableForm(id, name, draft) {
  let f = `<form class="cl-paytable" data-paytable="${esc(id)}">`;
  f += `<label class="pl-label">Name <input class="pl-text" name="name" maxlength="30" value="${esc(name)}"></label>`;
  f += rowsEditorHtml(draft, 'data-cl');
  f += '<div class="cl-formacts"><button class="btn-small primary" type="submit">Save</button><button type="button" class="btn-small" data-cl="paytable-cancel">Cancel</button></div>';
  return f + '</form>';
}

// ---- the host: the Tournaments page ----

// The payout choices (#424): Default (ducy's), then the club's tables; the
// tournament's own, when it has one from before them.
function payoutOptions(tables, picked, own = false) {
  let h = `<option value=""${picked || own ? '' : ' selected'}>Default</option>`;
  for (const p of tables) h += `<option value="${esc(p.id)}"${p.id === picked ? ' selected' : ''}>${esc(p.name)}</option>`;
  if (own) h += '<option value="own" selected>Its own</option>';
  return h;
}

// Whether entries can still come (#424): before the start, or during late
// registration (`live`: how it's going, from the host). Until then the
// payouts follow the entries so far.
export function entriesOpen(t, live = t.live) {
  if (t.status === 'scheduled') return true;
  if (t.status !== 'running') return false;
  return live ? live.level < t.lateLevel : t.lateLevel > 0;
}

// Each paid place's share and prize: the row in force (#424).
function prizesTable(amounts, shares) {
  let h = '<table class="cl-acct"><tbody>';
  amounts.forEach((a, i) => { h += `<tr><th>${ordinal(i + 1)}</th><td>${pct(shares[i] ?? 0)}%</td><td>${club$(a)}</td></tr>`; });
  return h + '</tbody></table>';
}

// A tournament's payouts, for the manager: what it pays by (Default, a club
// table; picked here) and the row in force, for the entries so far while
// entries can still come. Running, a change asks first (#544): `ask`, the
// table picked ({id, table}), until it's answered.
function payoutsHtml(club, t, live, ask = null) {
  const amounts = prizes(t, club);
  const shares = payoutShares(t, club);
  const own = !t.payoutTable && !!t.payout;
  const asked = ask?.id === t.id ? ask : null;
  let h = '<div class="cl-payouts">';
  h += `<label class="pl-label">Payouts <select class="pl-text" data-paypick="${esc(t.id)}"${t.status === 'running' ? ' data-running="1"' : ''}>${payoutOptions(club.payoutTables || [], asked ? asked.table : t.payoutTable || '', own && !asked)}</select></label>`;
  if (asked) h += `<span class="cl-confirm">Change payouts mid-tournament?<button class="btn-small primary" data-cl="pay-yes" data-id="${esc(t.id)}" data-table="${esc(asked.table)}">Change</button><button class="btn-small" data-cl="pay-no">Keep</button></span>`;
  if (entriesOpen(t, live)) h += '<span class="pl-meta">For the entries so far</span>';
  return h + prizesTable(amounts, shares) + '</div>';
}

// Whether series `se` makes more tournaments.
export const seriesGoesOn = se => !se.stopped && (se.count == null || se.made < se.count) && (se.until == null || se.next <= se.until);

// How a series repeats, for its card: "Daily", "Weekly on Mon, Wed".
const everyText = se => (se.every === 'day' ? 'Daily' : se.days?.length ? `Weekly on ${se.days.map(i => WEEKDAYS[i]).join(', ')}` : 'Weekly');

// The Edit or Cancel question for a tournament of a series (#477): just it,
// or the whole series from it on.
function askHtml(t, act) {
  const verb = act === 'edit' ? 't-edit' : 't-cancel';
  return `<div class="cl-ask"><span class="pl-label">${act === 'edit' ? 'Edit' : 'Cancel tournament'}</span><button class="btn-small" data-cl="${verb}" data-id="${esc(t.id)}" data-series="0">This one</button><button class="btn-small" data-cl="${verb}" data-id="${esc(t.id)}" data-series="1">Whole series</button><button class="btn-small" data-cl="t-ask-close" aria-label="Close">✕</button></div>`;
}

// The cards on the Tournaments page, in order: running ones, then those to
// come (soonest first; a repeating series one card, its next start), then
// those over (latest first). [{t} | {series}].
export function tourneyCards(club) {
  const ts = club.tourneys || [];
  const series = club.tourneySeries || [];
  const next = new Map(); // series id → its soonest tournament still to start
  for (const t of ts) {
    if (!t.series || t.status !== 'scheduled') continue;
    if (!next.has(t.series) || t.startsAt < next.get(t.series).startsAt) next.set(t.series, t);
  }
  const shown = ts.filter(t => !(t.series && t.status === 'scheduled' && next.get(t.series) !== t));
  const rank = t => (t.status === 'running' ? 0 : t.status === 'scheduled' ? 1 : 2);
  const cards = shown.map(t => ({t, at: t.startsAt, rank: rank(t)}));
  for (const se of series) if (!next.has(se.id) && seriesGoesOn(se)) cards.push({series: se, at: se.next, rank: 1});
  cards.sort((a, b) => a.rank - b.rank || (a.rank === 2 ? b.at - a.at : a.at - b.at));
  return cards;
}

// A series with none of it waiting to start: its next start.
function seriesCardHtml(se, now) {
  const s = se.settings || {};
  let h = `<li class="cl-tourney"><span class="cl-name">${esc(s.name || 'Tournament')}</span><span class="cl-status">${esc(everyText(se))}</span>`;
  h += `<span class="pl-meta">${esc(gameName(s.game || 'nlhe'))} · buy-in ${buyInText({buyIn: s.buyIn || 0, rake: s.rake || 0})} · stack ${whole(s.stack)}</span>`;
  h += `<span class="pl-meta">Next ${esc(dateTime(se.next))} · registration opens ${until(se.next - se.opensBefore, now)}</span>`;
  h += `<span class="cl-acts"><button class="btn-small" data-cl="series-edit" data-id="${esc(se.id)}">Edit</button><button class="btn-small" data-cl="series-stop" data-id="${esc(se.id)}">Cancel series</button></span>`;
  return h + '</li>';
}

// The host's Tournaments tab. `club` has the tournaments; `live` how running
// ones are going; `ui` = {wizard (wizardHtml's), payTable, ask ({id, act}:
// a series question open), payAsk (a running one's payouts being changed,
// payoutsHtml), heading} (heading false: the page has its own, #398).
export function hostTourneysHtml(club, live, ui, now = Date.now()) {
  let h = ui.heading === false ? '' : '<h2>Tournaments</h2>';
  if (ui.wizard) return h + wizardHtml(ui.wizard, club, ui.payTable);
  h += '<div class="pl-actions"><button class="btn-small primary" data-cl="new-tourney">New tournament</button></div>';
  const cards = tourneyCards(club);
  if (!cards.length) return h + '<p class="pl-meta">No tournaments yet.</p>';
  const seriesOf = id => (club.tourneySeries || []).find(s => s.id === id);
  h += '<ul class="cl-list">';
  for (const c of cards) {
    if (c.series) { h += seriesCardHtml(c.series, now); continue; }
    const t = c.t;
    const se = t.series ? seriesOf(t.series) : null;
    const players = playerCount(t), entries = entryCount(t);
    h += `<li class="cl-tourney"><span class="cl-name">${esc(t.name)}</span><span class="cl-status">${STATUS[t.status]}</span>`;
    if (se && t.status === 'scheduled') h += `<span class="cl-badge">${esc(everyText(se))}</span>`;
    h += `<span class="pl-meta">${esc(gameName(t.game))} · buy-in ${buyInText(t)}${t.added ? ` + ${club$(t.added)} added` : ''} · stack ${whole(t.stack)} · ${players}/${t.maxPlayers} players${entries !== players ? `, ${entries} entries` : ''} · pool ${club$(pool(t))}${t.rake && entries ? ` · rake ${club$(entries * t.rake)}` : ''}</span>`;
    if (t.status === 'scheduled') h += `<span class="pl-meta">${now < t.opensAt ? `Registration opens ${until(t.opensAt, now)} · ` : ''}starts ${until(t.startsAt, now)} (${dateTime(t.startsAt)}) · at least ${t.minPlayers}</span>`;
    if (t.status === 'cancelled') h += `<span class="pl-meta">Cancelled${t.why ? `: ${esc(t.why)}` : ''}. Every buy-in was refunded.</span>`;
    if (t.status === 'scheduled' || t.status === 'running') {
      h += '<span class="cl-acts">';
      if (t.status === 'scheduled') h += `<button class="btn-small" data-cl="${se ? 't-ask' : 't-edit'}" data-act="edit" data-id="${esc(t.id)}" data-series="0">Edit</button>`;
      const askCancel = se && t.status === 'scheduled' && seriesGoesOn(se);
      h += `<button class="btn-small" data-cl="${askCancel ? 't-ask' : 'cancel-tourney'}" data-act="cancel" data-id="${esc(t.id)}">Cancel tournament</button></span>`;
      if (ui.ask?.id === t.id) h += askHtml(t, ui.ask.act);
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
    if (t.status !== 'cancelled' && t.status !== 'finished') h += payoutsHtml(club, t, l, ui.payAsk);
    if (t.entries.length && t.status === 'scheduled') {
      const names = [...new Set(t.entries.map(e => club.members[e.member]?.name || e.member))];
      h += `<span class="pl-desc">Registered: ${names.map(esc).join(', ')}</span>`;
    }
    h += '</li>';
  }
  return h + '</ul>';
}

// ---- a member ----

// Tournaments calling member `me` (#189), across `memberships`: one they're
// in that has started while they aren't at its table (`seatedAt`: {code,
// table} or null), or one they registered for that starts within `soonMs`.
// [{kind: 'started' | 'soon', key, mem, t}], keys unique per call.
export function tourneyCallsFor(memberships, me, seatedAt, soonMs, now = Date.now()) {
  const calls = [];
  for (const m of memberships) {
    if (m.status !== 'member') continue;
    for (const t of m.tourneys || []) {
      const key = `${m.code}:${t.id}`;
      const atIt = seatedAt?.code === m.code && seatedAt.table === `tourney:${t.id}`;
      if (t.status === 'running' && t.in.includes(me) && !atIt) calls.push({kind: 'started', key: `${key}:started`, mem: m, t});
      else if (t.status === 'scheduled' && t.players.some(p => p.id === me) && t.startsAt > now && t.startsAt - now <= soonMs) {
        calls.push({kind: 'soon', key: `${key}:soon`, mem: m, t});
      }
    }
  }
  return calls;
}

// A tournament's lobby, under its row (#189): the format, the payouts, who's
// registered and the blind structure, so players can decide before they
// register.
function lobbyHtml(t, me, code, now) {
  let h = `<details class="cl-tdetails" data-keep="tl:${esc(code)}:${esc(t.id)}"><summary>Details</summary><div class="cl-tlobby">`;
  const format = [`starting stack ${whole(t.stack)}`, `${t.tableSize} a table`, `at least ${t.minPlayers} players`];
  if (t.rake) format.push(`rake ${club$(t.rake)}`);
  if (t.lateLevel) format.push(`late registration until the end of level ${t.lateLevel}`);
  if (t.reentry) format.push(t.maxReentries ? `up to ${t.maxReentries} re-entr${t.maxReentries === 1 ? 'y' : 'ies'}` : 're-entry');
  h += `<p class="pl-meta">${esc(format.join(' · '))}</p>`;
  if (t.status === 'scheduled') {
    h += `<p class="pl-meta">Starts ${esc(dateTime(t.startsAt))}${now < t.opensAt ? ` · registration opens ${esc(until(t.opensAt, now))}` : ''}</p>`;
  }
  if (t.prizes?.length) {
    h += `<span class="pl-label">Payouts${entriesOpen(t) ? ' (for the entries so far)' : ''}</span>`;
    h += t.shares ? prizesTable(t.prizes, t.shares) : `<table class="cl-acct"><tbody>${t.prizes.map((a, i) => `<tr><th>${ordinal(i + 1)}</th><td>${club$(a)}</td></tr>`).join('')}</tbody></table>`;
  }
  if (t.players.length) {
    const names = t.players.map(p => (p.id === me ? `<b>${esc(p.name)} (you)</b>` : esc(p.name)));
    h += `<span class="pl-label">Registered (${t.players.length})</span><p class="pl-desc">${names.join(', ')}</p>`;
  }
  const levels = (t.structure || []).filter(s => !s.break);
  if (levels.length) {
    h += '<span class="pl-label">Blinds</span><table class="cl-acct"><thead><tr><th>Level</th><th>Blinds</th><th>Ante</th><th>Minutes</th></tr></thead><tbody>';
    let n = 0;
    for (const s of t.structure) {
      if (s.break) { h += `<tr><td colspan="3" class="pl-meta">Break</td><td>${s.minutes}</td></tr>`; continue; }
      n++;
      h += `<tr><td>${n}</td><td>${whole(s.sb)}/${whole(s.bb)}</td><td>${s.ante ? whole(s.ante) : '–'}</td><td>${s.minutes}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  return h + '</div></details>';
}

// How a running tournament is going, for a member (#189): the level and
// when it changes, players left, the average stack, the places paid, and
// their own stack and rank when they're in the standings.
function liveHtml(t, me, now) {
  const l = t.live;
  if (!l) return '';
  const parts = [levelText(t.structure, l)];
  if (l.stepEndsAt) parts.push(`next ${until(l.stepEndsAt, now)}`);
  parts.push(`${l.playersLeft} left`);
  if (l.playersLeft) parts.push(`average ${whole(Math.round((t.entries * t.stack) / l.playersLeft))}`);
  if (t.prizes?.length) parts.push(l.playersLeft <= t.prizes.length ? 'in the money' : `${t.prizes.length} paid`);
  let h = `<span class="pl-meta cl-tlive">${esc(parts.filter(Boolean).join(' · '))}</span>`;
  const i = (l.standings || []).findIndex(s => s.id === me);
  if (i >= 0) h += `<span class="pl-meta">You: <b>${whole(l.standings[i].stack)}</b>, ${ordinal(i + 1)} of ${l.playersLeft}</span>`;
  return h;
}

// A member's list of the club's tournaments. `me`: their id; `playing`: the
// tournament they're at, if any.
export function memberTourneysHtml(mem, me, {hostHere, playing}, now = Date.now()) {
  const list = mem.tourneys || [];
  if (!list.length) return '';
  const code = esc(mem.code);
  // The club page titles it (#225).
  let h = '<div class="cl-tourneys"><ul class="cl-tables">';
  for (const t of list) {
    const mine = t.players.some(p => p.id === me), inNow = t.in.includes(me);
    const place = t.places.filter(p => p.id === me).map(p => p.place).sort((a, b) => a - b)[0];
    const cost = club$((t.buyIn || 0) + (t.rake || 0));
    const btn = (act, label, primary = false) => `<button class="btn-small${primary ? ' primary' : ''}" data-cl="${act}" data-code="${code}" data-tourney="${esc(t.id)}"${hostHere ? '' : ' disabled title="Can’t reach the club right now"'}>${label}</button>`;
    h += `<li><span class="cl-name">${esc(t.name)}</span><span class="pl-meta">${esc(gameName(t.game))} · buy-in ${buyInText(t)} · ${t.players.length}/${t.maxPlayers} players · pool ${club$(t.pool)}`;
    if (t.every && t.status === 'scheduled') h += ` · ${t.every === 'day' ? 'daily' : 'weekly'}`;
    if (t.status === 'scheduled') h += ` · starts ${until(t.startsAt, now)}`;
    if (t.status === 'running' && !t.live) h += ' · running';
    if (t.status === 'finished') h += ' · finished';
    if (t.status === 'cancelled') h += ` · cancelled${t.why ? ` (${esc(t.why)})` : ''}`;
    h += '</span>';
    if (t.status === 'running') h += liveHtml(t, me, now);
    // Cancelled: the buy-in and rake went back (club-tourneys.js cancelTourney).
    if (t.status === 'cancelled' && mine && (t.buyIn || t.rake)) h += `<span class="pl-meta">Your ${cost} buy-in is back in your balance.</span>`;
    if (t.status === 'scheduled') {
      if (mine) h += btn('t-unregister', 'Unregister');
      else if (now >= t.opensAt && t.players.length < t.maxPlayers) h += btn('t-register', `Register (${cost})`, true);
    } else if (t.status === 'running') {
      const lateOpen = t.live ? t.live.level < t.lateLevel : false;
      if (inNow) h += playing === t.id ? '<button class="btn-small primary" data-cl="to-table">Back to the table</button>' : btn('t-play', 'Play', true);
      else if (lateOpen && (!mine || t.reentry)) h += btn('t-enter', mine ? `Re-enter (${cost})` : `Late register (${cost})`, true);
    }
    if (place) h += `<span class="pl-meta">You finished ${ordinal(place)}${t.status === 'finished' ? '' : ' (so far)'}</span>`;
    if (mem.tourneyError?.tourney === t.id) h += `<span class="pl-desc pl-neterr cl-err">${esc(mem.tourneyError.reason)}</span>`;
    if (t.status === 'finished' && t.places.length) {
      const top = t.places.filter(p => p.place <= t.prizes.length).sort((a, b) => a.place - b.place);
      h += `<span class="pl-desc">${top.map(p => `${ordinal(p.place)} ${esc(p.name)} ${club$(t.prizes[p.place - 1])}`).join(' · ')}</span>`;
    }
    if (t.status === 'scheduled' || t.status === 'running') h += lobbyHtml(t, me, mem.code, now);
    h += '</li>';
  }
  return h + '</ul></div>';
}

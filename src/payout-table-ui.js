// The payout table editor (#424): rows by the number of entries, each with
// its places' shares as percentages, for club payout tables (clubs.js) and
// a one-off tournament's own (private-tourney-room.js). HTML builders, form
// readers and the draft's changes; the callers own the draft and the clicks.
//
// A draft: {rows: [{from, places: [basis points | null]}], cols}, as typed
// (null: a box left empty). cleanRows turns it into rows for
// club-tourneys.js's checkPayoutRows, which says what's wrong with them.

import { defaultPayout } from './club-tourneys.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const ordinal = n => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th'}`;
// Basis points as a percentage: 6500 → "65", 3333 → "33.33".
export const pct = bp => String(+(bp / 100).toFixed(2));

// A table to start from: round shares for small fields, then the Default's
// (club-tourneys.js) up to the most entries a tournament takes.
export const STARTER_ROWS = [
  {from: 2, places: [10000]},
  {from: 6, places: [6500, 3500]},
  {from: 10, places: [5000, 3000, 2000]},
  {from: 20, places: [4000, 2500, 2000, 1500]},
  ...[30, 50, 75, 100, 150, 200, 300, 500, 750, 1000].map(from => ({from, places: defaultPayout(from)})),
];

export const draftOf = (rows = STARTER_ROWS) => ({rows: rows.map(r => ({from: r.from, places: r.places.slice()})), cols: 0});
const colsOf = d => Math.max(1, d.cols || 0, ...d.rows.map(r => r.places.length));

// The editor's table and its buttons; `act`: the attribute the caller's
// clicks go by ('data-cl', 'data-tz'), with prow-add, prow-remove (data-i)
// and pcol-add.
export function rowsEditorHtml(d, act) {
  const cols = colsOf(d);
  let h = '<div class="po-scroll"><table class="ts-levels po-rows"><thead><tr><th>From</th>';
  for (let c = 0; c < cols; c++) h += `<th>${ordinal(c + 1)} %</th>`;
  h += '<th></th></tr></thead><tbody>';
  d.rows.forEach((r, i) => {
    h += `<tr><td><input class="pl-text po-from" type="number" min="1" step="1" name="f${i}" value="${esc(r.from ?? '')}" aria-label="From entries"></td>`;
    for (let c = 0; c < cols; c++) {
      const v = r.places[c];
      h += `<td><input class="pl-text" type="number" min="0" step="0.01" name="p${i}_${c}" value="${v == null ? '' : pct(v)}" aria-label="${ordinal(c + 1)} %"></td>`;
    }
    h += `<td>${d.rows.length > 1 ? `<button type="button" class="btn-small" ${act}="prow-remove" data-i="${i}" aria-label="Remove row">✕</button>` : ''}</td></tr>`;
  });
  h += '</tbody></table></div>';
  h += `<div class="cl-formacts"><button type="button" class="btn-small" ${act}="prow-add">Add a row</button><button type="button" class="btn-small" ${act}="pcol-add">Add a place</button></div>`;
  return h;
}

// The draft as typed in the editor inside `el`.
export function readRows(el, d) {
  const cols = colsOf(d);
  const val = name => el.querySelector(`[name="${name}"]`)?.value ?? '';
  const num = s => (String(s).trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
  const rows = d.rows.map((_, i) => {
    const from = num(val(`f${i}`));
    const places = Array.from({length: cols}, (_, c) => { const v = num(val(`p${i}_${c}`)); return v == null ? null : Math.round(v * 100); });
    return {from, places};
  });
  return {rows, cols: d.cols};
}

// A row more (from 10 entries beyond the last, paying as it does), a row
// less, or a place more.
export function addRow(d) {
  const last = d.rows.at(-1);
  d.rows.push(last ? {from: (last.from || 0) + 10, places: last.places.slice()} : {from: 1, places: [10000]});
  return d;
}
export function removeRow(d, i) {
  if (d.rows.length > 1) d.rows.splice(i, 1);
  return d;
}
export function addPlace(d) {
  d.cols = colsOf(d) + 1;
  return d;
}

// The rows to save: empty boxes after a row's last share dropped. Throws
// for a gap (an empty box before a share).
export function cleanRows(d) {
  return d.rows.map(r => {
    const places = r.places.slice();
    while (places.length && places.at(-1) == null) places.pop();
    if (places.some(p => p == null)) throw new Error(`${r.from ? `From ${r.from} entries` : 'A row'}: fill the places in order, from 1st.`);
    return {from: r.from, places};
  });
}

// A payout table to read: From, then each place's share; `inForce`, the
// index of the row in force, marked.
export function rowsTableHtml(rows, inForce = -1) {
  const cols = Math.max(...rows.map(r => r.places.length));
  let h = '<div class="po-scroll"><table class="cl-acct po-table"><thead><tr><th>From</th>';
  for (let c = 0; c < cols; c++) h += `<th>${ordinal(c + 1)}</th>`;
  h += '</tr></thead><tbody>';
  rows.forEach((r, i) => {
    h += `<tr${i === inForce ? ' class="po-on"' : ''}><th>${r.from}+</th>`;
    for (let c = 0; c < cols; c++) h += `<td>${r.places[c] == null ? '' : `${pct(r.places[c])}%`}</td>`;
    h += '</tr>';
  });
  return h + '</tbody></table></div>';
}

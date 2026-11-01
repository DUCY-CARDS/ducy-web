// The Bankroll Challenge's stats (#304): the bankroll over the run, win rate
// and hands by stakes, the biggest pots, results with each named Regular,
// and the hall of records, built from the quest's session history
// (quest.js `leave`) and past runs. The numbers come from ducy-quest (Rust,
// #466); the chart is drawn here.

import { quest as op } from '../wasm/ducy_wasm.js';

/** Hands, net and bb/100 at each stakes, in stakes order: [{stakes, sessions, hands, net, bb100}]. */
export const byStakes = history => op({op: 'byStakes', history});

/** The biggest single pots won and lost across the run: {won, lost} in chips (lost is negative). */
export const biggestPots = history => op({op: 'biggestPots', history});

/** Your results in sessions with each named Regular at the table: [{id, sessions, net}], most played first. */
export const withRegulars = history => op({op: 'withRegulars', history});

/** The bankroll after each session, from the start: [{session, bankroll}]. */
export const bankrollSeries = history => op({op: 'bankrollSeries', history});

/**
 * The bankroll line as an SVG (a log scale, since the road runs from
 * $1,000 to $1,000,000), `w` by `h`, colored by the page's CSS (qs-line,
 * qs-area, qs-grid, qs-label).
 */
export function bankrollChart(series, w = 560, h = 160, money = n => String(n)) {
  if (series.length < 2) return '';
  const pad = {l: 56, r: 8, t: 8, b: 20};
  const vals = series.map(p => Math.max(1, p.bankroll));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const lg = Math.log10;
  const min = lg(lo) - 0.05, max = lg(hi) + 0.05;
  const x = i => pad.l + ((w - pad.l - pad.r) * i) / (series.length - 1);
  const y = v => pad.t + (h - pad.t - pad.b) * (1 - (lg(Math.max(1, v)) - min) / (max - min || 1));
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.bankroll).toFixed(1)}`);
  // Gridlines at the powers of ten (and their halves) inside the range.
  const ticks = [];
  for (let e = Math.floor(min); e <= Math.ceil(max); e++) {
    for (const m of [1, 3]) {
      const v = m * 10 ** e;
      if (lg(v) >= min && lg(v) <= max) ticks.push(v);
    }
  }
  let s = `<svg class="qs-chart" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Bankroll after each session">`;
  for (const t of ticks) {
    s += `<line class="qs-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`;
    s += `<text class="qs-label" x="${pad.l - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${money(t)}</text>`;
  }
  s += `<polygon class="qs-area" points="${pad.l},${h - pad.b} ${pts.join(' ')} ${x(series.length - 1).toFixed(1)},${h - pad.b}"/>`;
  s += `<polyline class="qs-line" points="${pts.join(' ')}" fill="none"/>`;
  const last = series.at(-1);
  s += `<circle class="qs-dot" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.bankroll).toFixed(1)}" r="3.5"/>`;
  s += `<text class="qs-label" x="${pad.l}" y="${h - 4}">Start</text>`;
  s += `<text class="qs-label" x="${w - pad.r}" y="${h - 4}" text-anchor="end">Session ${last.session}</text>`;
  return s + '</svg>';
}

/** Past runs for the hall of records: wins first (fastest first), then the best peaks. */
export const hallOfRecords = runs => op({op: 'hallOrder', runs}).map(i => runs[i]);

/** Game minutes as "3 days 4 hours" or "5 hours". */
export const durationText = minutes => op({op: 'durationText', minutes});

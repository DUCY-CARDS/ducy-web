// Small charts for the admin site (#601): one line per metric, a day per
// point, in one hue (--series in admin.css, picked for light and dark).
// A hairline baseline and top line, the first and last day under it, a dot
// on the latest value; a crosshair and a readout on hover or keyboard focus
// (wire()). Every value is also in the table view.

const W = 320, H = 110, L = 34, R = 10, T = 10, B = 20;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// A clean top for the axis: 1, 2, 2.5 or 5 times a power of ten, at least `v`.
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// A number as the axis and readout show it: in full under 10,000, then compact.
export function fmt(v, digits = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10_000) return new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(v);
  return v.toLocaleString('en', {maximumFractionDigits: digits, minimumFractionDigits: 0});
}

// "Nov 3" from "2026-11-03".
export const shortDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en', {month: 'short', day: 'numeric', timeZone: 'UTC'});

// The chart's points: x and y in the SVG, y null where there's no value.
export function geometry(values) {
  const n = values.length;
  const top = niceMax(Math.max(0, ...values.filter(v => v != null)));
  const x = i => (n <= 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  return {top, pts: values.map((v, i) => ({x: x(i), y: v == null ? null : y(v)})), base: y(0)};
}

// The line's path, broken where a value is missing.
export function linePath(pts) {
  let d = '', pen = false;
  for (const p of pts) {
    if (p.y == null) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

// A small chart: {key, label, days: ['YYYY-MM-DD'], values: [number|null],
// digits}. The latest value is the headline.
export function chartHtml({key, label, days, values, digits = 0}) {
  const {top, pts, base} = geometry(values);
  const line = linePath(pts);
  // The wash under each unbroken run of the line.
  let area = '';
  for (let i = 0; i < pts.length;) {
    if (pts[i].y == null) { i++; continue; }
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].y != null) j++;
    const run = pts.slice(i, j + 1);
    area += `M${run[0].x.toFixed(1)},${base.toFixed(1)}${run.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('')}L${run[run.length - 1].x.toFixed(1)},${base.toFixed(1)}Z`;
    i = j + 1;
  }
  const lastI = values.map(v => v != null).lastIndexOf(true);
  const last = lastI >= 0 ? pts[lastI] : null;
  const latest = values[values.length - 1];
  const data = esc(JSON.stringify({days, values, digits}));
  return `<figure class="chart" data-chart="${esc(key)}">
  <figcaption><span class="chart-label">${esc(label)}</span><span class="chart-value">${esc(fmt(latest, digits))}</span></figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(`${label}, last ${days.length} days; today ${fmt(latest, digits)}`)}" data-series="${data}">
    <line class="grid" x1="${L}" x2="${W - R}" y1="${T}" y2="${T}"/>
    <line class="axis" x1="${L}" x2="${W - R}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}"/>
    <text class="tick" x="${L - 6}" y="${T + 4}" text-anchor="end">${esc(fmt(top))}</text>
    <text class="tick" x="${L - 6}" y="${(base + 4).toFixed(1)}" text-anchor="end">0</text>
    ${days.length ? `<text class="tick" x="${L}" y="${H - 4}" text-anchor="start">${esc(shortDay(days[0]))}</text><text class="tick" x="${W - R}" y="${H - 4}" text-anchor="end">${esc(shortDay(days[days.length - 1]))}</text>` : ''}
    ${area ? `<path class="wash" d="${area}"/>` : ''}
    ${line ? `<path class="line" d="${line}"/>` : ''}
    ${last ? `<circle class="dot" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4"/>` : ''}
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${base.toFixed(1)}" hidden/>
    <circle class="dot hover" r="4" cx="0" cy="0" hidden/>
  </svg>
  <div class="tip" hidden><b></b> <span></span></div>
</figure>`;
}

// The crosshair and readout for every chart under `root`: pointer or arrow keys.
export function wire(root) {
  const show = (fig, i) => {
    const svg = fig.querySelector('svg');
    const s = JSON.parse(svg.dataset.series);
    const {pts} = geometry(s.values);
    i = Math.max(0, Math.min(s.values.length - 1, i));
    fig.dataset.at = i;
    const p = pts[i];
    const cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot.hover'), tip = fig.querySelector('.tip');
    cross.setAttribute('x1', p.x);
    cross.setAttribute('x2', p.x);
    cross.removeAttribute('hidden');
    if (p.y != null) { dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.removeAttribute('hidden'); } else dot.setAttribute('hidden', '');
    tip.querySelector('b').textContent = fmt(s.values[i], s.digits);
    tip.querySelector('span').textContent = shortDay(s.days[i]);
    tip.hidden = false;
    // Over the point, kept inside the chart.
    const box = svg.getBoundingClientRect(), fbox = fig.getBoundingClientRect();
    const px = box.left - fbox.left + (p.x / W) * box.width;
    tip.style.left = `${Math.max(0, Math.min(fbox.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
  };
  const hide = fig => {
    fig.querySelector('.cross').setAttribute('hidden', '');
    fig.querySelector('.dot.hover').setAttribute('hidden', '');
    fig.querySelector('.tip').hidden = true;
    delete fig.dataset.at;
  };
  const indexAt = (svg, clientX) => {
    const n = JSON.parse(svg.dataset.series).values.length;
    const box = svg.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * W;
    return n <= 1 ? 0 : Math.round(((x - L) / (W - L - R)) * (n - 1));
  };
  root.addEventListener('pointermove', e => {
    const svg = e.target.closest?.('.chart svg');
    if (svg) show(svg.closest('.chart'), indexAt(svg, e.clientX));
  });
  root.addEventListener('pointerout', e => {
    const fig = e.target.closest?.('.chart');
    if (fig && !fig.contains(e.relatedTarget)) hide(fig);
  });
  root.addEventListener('focusin', e => {
    const svg = e.target.closest?.('.chart svg');
    if (svg) show(svg.closest('.chart'), JSON.parse(svg.dataset.series).values.length - 1);
  });
  root.addEventListener('focusout', e => {
    const fig = e.target.closest?.('.chart');
    if (fig) hide(fig);
  });
  root.addEventListener('keydown', e => {
    const svg = e.target.closest?.('.chart svg');
    if (!svg || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const fig = svg.closest('.chart');
    show(fig, Number(fig.dataset.at ?? 0) + (e.key === 'ArrowLeft' ? -1 : 1));
  });
}

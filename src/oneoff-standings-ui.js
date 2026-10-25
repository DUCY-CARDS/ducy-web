// The standings and settle-up list of a one-off private game (#403), as
// HTML: a cash game's (play.js) and a tournament's (private-tourney-ui.js).
// Builders only; the page that shows them owns the clicks.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

// "+1,200", "−300", "0"
export const signed = (n, fmt) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : fmt(0));

// The table: `cols` [[heading, row => amount]] after the player; the last
// column is the net, signed. `me`: this viewer's id, shown in bold.
export function standingsHtml(rows, cols, fmt, me = null) {
  let h = '<table class="cl-acct oo-standings"><thead><tr><th>Player</th>';
  h += cols.map(c => `<th>${esc(c[0])}</th>`).join('') + '<th>+/−</th></tr></thead><tbody>';
  for (const r of rows) {
    h += `<tr${r.id === me ? ' class="oo-me"' : ''}><th>${esc(r.name)}${r.id === me ? ' (you)' : ''}</th>`;
    h += cols.map(c => `<td>${fmt(c[1](r))}</td>`).join('');
    h += `<td class="${r.net > 0 ? 'oo-up' : r.net < 0 ? 'oo-down' : ''}">${signed(r.net, fmt)}</td></tr>`;
  }
  return h + '</tbody></table>';
}

// Who pays whom.
export function settleHtml(transfers, fmt, me = null) {
  if (!transfers.length) return '<p class="pl-meta">Nobody owes anything.</p>';
  const who = (id, name) => (id === me ? '<b>You</b>' : `<b>${esc(name)}</b>`);
  return '<ul class="oo-settle">' + transfers.map(t => `<li>${who(t.from, t.fromName)} → ${who(t.to, t.toName)} <span class="oo-amt">${fmt(t.amount)}</span></li>`).join('') + '</ul>';
}

// Saves `text` as a file `name` (a CSV).
export function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/csv'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A file name for the download: "ducy-friday-night-2026-10-25.csv".
export function fileName(title, now = new Date()) {
  const slug = String(title || 'game').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `ducy-${slug}-${d}.csv`;
}

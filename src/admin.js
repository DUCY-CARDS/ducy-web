// The super admin's page (admin.html, #265, #401). Every request to the
// relay's /admin API is signed with this browser's identity (identity.js);
// the relay lets in only the keys listed in admins.json. Someone not on the
// list is shown their player ID and key to add.
//
// Views, by the page's hash: #clubs (usage, permission, the club list),
// #club=<code> (everything the club stores, read-only), #people,
// #person=<id> (their activity in every club), #log (the admin log).
// A club's lobby chat and finished hands' cards stay hidden until "Show
// chats and cards"; each use goes in the admin log.

import { loadIdentity, showId, signMessage } from './identity.js';
import { chipText } from './chip-format.js';
import { ago as agoText } from './time-ago.js';

const DEFAULT_RELAY = 'https://ducy-relay.ducy.workers.dev';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const ago = t => (t ? agoText(t) : '—');
const when = t => (t ? new Date(t).toLocaleString() : '—');
const day = t => (t ? new Date(t).toLocaleDateString() : '—');
const hours = m => (m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
const chips = n => (n == null ? '—' : chipText(n));
const pid = id => `<button class="link" data-person="${esc(id)}" title="${esc(id)}"><code>${esc(showId(id))}</code></button>`;
const table = (head, rows, empty = 'None') => rows.length
  ? `<div class="scroll tall"><table><tr>${head.map(h => (h.startsWith('#') ? `<th class="n">${esc(h.slice(1))}</th>` : `<th>${esc(h)}</th>`)).join('')}</tr>${rows.join('')}</table></div>`
  : `<p class="muted">${esc(empty)}</p>`;
const tr = cells => `<tr>${cells.map(c => (c && typeof c === 'object' ? `<td class="n">${c.n}</td>` : `<td>${c ?? ''}</td>`)).join('')}</tr>`;
const num = v => ({n: v});

let me = null;
try { $('relay').value = localStorage.getItem('ducyAdminRelay') || DEFAULT_RELAY; } catch { $('relay').value = DEFAULT_RELAY; }
const base = () => $('relay').value.trim().replace(/^ws/, 'http').replace(/\/$/, '');

// A signed request (#401): {type: 'admin', path, data}, as relay/src/admin.js checks it.
async function api(path, data = {}) {
  const env = await signMessage(me, {type: 'admin', path, data});
  const r = await fetch(base() + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(env)});
  const out = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
  if (r.status === 403 && out.pub) notAdmin();
  if (!r.ok || out.error) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}

const say = (text, cls = 'muted') => { $('status').className = cls; $('status').textContent = text; };

function notAdmin() {
  $('not-admin').hidden = false;
  $('nav').hidden = true;
  $('view').innerHTML = '';
  $('na-id').textContent = `${showId(me.id)} (${me.id})`;
  $('na-pub').textContent = me.pub;
  $('na-entry').textContent = JSON.stringify({id: me.id, pub: me.pub, name: ''});
}

// ---- views ----

let data = null; // /admin/clubs
let usage = null;

function route() {
  const h = location.hash.slice(1);
  const [k, v] = h.split('=');
  return {view: ['club', 'person', 'people', 'log'].includes(k) ? k : 'clubs', arg: v ? decodeURIComponent(v) : ''};
}

async function show() {
  const {view, arg} = route();
  for (const b of document.querySelectorAll('nav button')) b.toggleAttribute('aria-current', b.dataset.go === view || (view === 'club' && b.dataset.go === 'clubs') || (view === 'person' && b.dataset.go === 'people'));
  say('Loading…');
  try {
    if (view === 'clubs') {
      data = await api('/admin/clubs');
      usage = await fetch(base() + '/usage').then(r => r.json()).catch(() => null);
      $('view').innerHTML = clubsHtml();
    } else if (view === 'club') {
      $('view').innerHTML = clubHtml(await api(`/admin/club/${encodeURIComponent(arg)}`, {reveal: revealed.has(arg)}), arg);
    } else if (view === 'people') {
      $('view').innerHTML = peopleHtml((await api('/admin/people')).people);
    } else if (view === 'person') {
      $('view').innerHTML = personHtml(await api('/admin/person', {id: arg}));
    } else {
      $('view').innerHTML = logHtml((await api('/admin/log')).log);
    }
    $('nav').hidden = false;
    $('not-admin').hidden = true;
    say(`Loaded at ${new Date().toLocaleTimeString()}.`, 'ok');
    return true;
  } catch (e) {
    $('view').innerHTML = '';
    say(e.message, 'err');
    return false;
  }
}

function clubsHtml() {
  let h = '';
  if (usage) {
    h += `<section><h2>Use of Cloudflare’s free plan</h2><p class="muted">${usage.clubs} clubs · at most ${usage.limits.total} · trial ${usage.limits.trialDays} days</p>`
      + table(['Day', '#Club-hours', '#GB-s', '#Share of free'], usage.days.map(d => tr([esc(d.day), num(d.clubHours), num(d.gbs), num(`<span class="${d.share > 80 ? 'err' : d.share > 50 ? 'warn' : ''}">${d.share}%</span>`)])))
      + '</section>';
  }
  const g = Object.entries(data.grants);
  h += `<section><h2>Who may create clubs</h2><div class="row">
      <input id="g-id" placeholder="Player ID" size="30">
      <input id="g-note" placeholder="Note" size="24">
      <label>Clubs <input id="g-max" type="number" min="0" placeholder="3"></label>
      <label>Tables <input id="g-tables" type="number" min="0" placeholder="2"></label>
      <label>Tournaments a day <input id="g-tourneys" type="number" min="0" placeholder="1"></label>
      <button class="primary" id="grant">Grant</button></div>`
    + table(['Player', 'Note', '#Clubs', 'Limits', 'Since', ''], g.map(([id, x]) => tr([pid(id), esc(x.note || (x.fromEnv ? 'CLUB_CREATORS' : '')), num(x.maxClubs || data.limits.perOwner), x.limits ? `${x.limits.tables} tables, ${x.limits.tourneysPerDay}/day` : 'free', day(x.at), x.fromEnv ? '' : `<button data-revoke="${esc(id)}">Revoke</button>`])), 'Nobody yet')
    + '</section>';
  const clubs = [...data.clubs].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const rows = clubs.map(c => {
    const week = Object.entries(c.days || {}).filter(([d]) => d >= weekAgo).reduce((s, [, m]) => s + m, 0);
    return tr([
      `<button class="link" data-club="${esc(c.code)}"><b>${esc(c.name) || '(no name)'}</b></button><br><code>${esc(c.code)}</code>`,
      pid(c.owner) + (data.grants[c.owner] ? ' <span class="ok">✓</span>' : ''),
      planHtml(c),
      `<input type="number" min="0" value="${c.limits.tables}" data-lim-tables="${esc(c.code)}" aria-label="Tables"> tables<br><input type="number" min="0" value="${c.limits.tourneysPerDay}" data-lim-tourneys="${esc(c.code)}" aria-label="Tournaments a day"> / day <button data-limits="${esc(c.code)}">Set</button>`,
      stateHtml(c), ago(c.lastActive), `${hours(week)} / ${hours(c.minutes || 0)}`,
      `<div class="row"><button data-pause="${esc(c.code)}" data-to="${c.suspended ? 'false' : 'true'}">${c.suspended ? 'Resume' : 'Pause'}</button>`
        + (c.plan === 'trial' ? `<button data-plan="${esc(c.code)}">Make it a club</button><button data-extend="${esc(c.code)}">Trial +14 days</button>` : '') + '</div>',
    ]);
  });
  h += `<section><h2>Clubs</h2>${table(['Club', 'Owner', 'Plan', 'Limits', 'State', 'Last active', 'Play (7 days / all)', ''], rows, 'No clubs yet')}</section>`;
  return h;
}

function planHtml(c) {
  const plan = c.plan === 'trial' ? `Trial, ${c.expires > Date.now() ? `${Math.ceil((c.expires - Date.now()) / 864e5)} days left` : 'ended'}` : 'Club';
  // No backup proved yet (#395): deleted once unused for a week.
  const temp = c.temporary
    ? `<br><span class="warn">Temporary</span> <span class="muted">· removed ${c.removesAt ? esc(when(c.removesAt)) : 'soon'} if unused</span>`
    : c.provedAt ? `<br><span class="muted">Backup proved ${esc(day(c.provedAt))}</span>` : '';
  return plan + temp;
}

const stateHtml = c => (c.suspended ? '<span class="err">Paused</span>' : c.blocked ? '<span class="warn">Trial ended</span>' : '<span class="ok">Running</span>');

// ---- a club ----

const revealed = new Set(); // clubs whose chats and cards are shown, this visit
let club = null; // the club shown, for the ledger's filters and CSV
const ledgerFilter = {member: '', kind: ''};

function clubHtml(x, code) {
  const f = x.full || {};
  const rec = x.record;
  club = f;
  if (!rec && !f.code) return `<section><h2>${esc(code)}</h2><p class="muted">No such club</p></section>`;
  const live = x.inside?.club;
  const members = f.members || [];
  let h = `<section><div class="row" style="justify-content:space-between"><h2>${esc(f.name || rec?.name || '')} <code>${esc(code)}</code></h2>`
    + (f.revealed ? '<span class="warn">Showing chats and cards</span>' : '<button id="reveal">Show chats and cards</button>') + '</div><dl>'
    + `<dt>Owner</dt><dd>${pid(f.ownerId || rec?.owner)} <span class="muted">${ago(f.ownerSeen)}</span></dd>`
    // A temporary club goes after 7 days unused (registry.js removesAt).
    + (rec ? `<dt>Plan</dt><dd>${planHtml({...rec, removesAt: rec.temporary ? (rec.lastActive || rec.at) + 7 * 864e5 : null})}</dd><dt>State</dt><dd>${stateHtml({...rec, blocked: x.blocked})}${x.blocked ? ` <span class="muted">${esc(x.blocked)}</span>` : ''}</dd>` : '')
    + `<dt>Limits</dt><dd>${rec ? `${rec.limits.tables} tables, ${rec.limits.tourneysPerDay}/day` : '—'}</dd>`
    + `<dt>Now</dt><dd>${x.inside?.online ?? 0} connected${live ? ` · ${live.members.seated} seated` : ''}${x.inside?.queued ? ` · ${x.inside.queued} waiting` : ''}</dd>`
    + `<dt>Created</dt><dd>${day(f.createdAt)}</dd>`
    + `<dt>Chips</dt><dd>${chips(f.chips?.issued)} issued · ${chips(f.chips?.reclaimed)} reclaimed</dd></dl></section>`;
  if (x.full?.error) return h + `<section><p class="err">${esc(x.full.error)}</p></section>`;

  h += `<section><h2>Members</h2>${table(['Name', 'Player', 'Status', 'Role', 'Agent', '#Balance', 'Joined', 'Last seen'],
    [...members].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(m => tr([esc(m.name), pid(m.id), esc(m.status), esc(m.role || ''), esc(m.agent || '') + (m.agentOf ? ` <span class="muted">via ${esc(nameIn(m.agentOf))}</span>` : ''), num(chips(m.balance)), day(m.joinedAt || m.requestedAt), ago(m.lastSeen)])))}</section>`;

  h += `<section id="ledger-card">${ledgerHtml()}</section>`;

  h += `<section><h2>Activity log</h2>${table(['When', 'By', 'What', '#Chips'], [...(f.log || [])].reverse().map(e => tr([when(e.at), esc(nameIn(e.by)), esc(e.text), num(e.amount != null ? chips(e.amount) : '')])))}</section>`;

  const open = members.filter(m => m.request);
  h += `<section><h2>Chip requests</h2><h3>Open</h3>${table(['Member', '#Asked', 'Note', 'When'], open.map(m => tr([esc(m.name), num(chips(m.request.amount)), esc(m.request.note), when(m.request.at)])))}`
    + `<h3>Answered</h3>${table(['Member', 'Outcome', '#Asked', '#Given', 'Note', 'By', 'When'], [...(f.requestLog || [])].reverse().map(r => tr([esc(nameIn(r.member)), esc(r.outcome), num(chips(r.asked)), num(chips(r.given)), esc(r.note), esc(r.by ? nameIn(r.by) : ''), when(r.at)])))}</section>`;

  h += `<section><h2>Help requests</h2>${table(['When', 'Member', 'Asked', 'Table', 'Reply', 'Handled'], [...(f.help || [])].reverse().map(r => tr([when(r.at), esc(r.name), esc(r.text), esc(r.table), esc(r.reply), r.handled ? `${esc(nameIn(r.handled.by))} ${ago(r.handled.at)}` : '<span class="warn">Open</span>'])))}</section>`;

  h += `<section><h2>Tables</h2>${table(['Name', 'Game', 'Blinds', 'Seats', 'Status'], (f.tables || []).map(t => tr([esc(t.name), esc(t.game), `${chips(t.sb)}/${chips(t.bb)}`, esc(t.seats), esc(t.status)])))}</section>`;

  h += `<section><h2>Tournaments</h2>${table(['Name', 'Game', 'Status', 'Starts', '#Entries'], [...(f.tourneys || [])].reverse().map(t => tr([esc(t.name), esc(t.game), esc(t.status), when(t.startsAt), num((t.entries || []).length)])))}</section>`;

  const promos = f.promos || {};
  h += `<section><h2>Promotions</h2>${table(['Name', 'Kind', 'Status', '#Budget', 'Since'], (promos.list || []).map(p => tr([esc(p.name), esc(p.kind), esc(p.status), num(p.budget ? chips(p.budget) : '—'), day(p.createdAt)])))}`
    + `<h3>Prizes</h3>${table(['When', 'Member', 'Promotion', 'Hand', '#Chips', 'Status'], [...(promos.awards || [])].reverse().map(a => tr([when(a.at), esc(a.name), esc(a.promoName), esc(a.handName), num(chips(a.amount)), esc(a.status)])))}</section>`;

  h += `<section><h2>Services</h2>${table(['Name', 'Can', '#Budget', 'Expires', 'State'], Object.values(f.services || {}).map(s => tr([esc(s.name), esc(Object.entries(s.perms || {}).filter(([, v]) => v).map(([k]) => k).join(', ')), num(chips(s.budget)), s.expires ? day(s.expires) : '—', s.revoked || s.revokedAt ? '<span class="muted">Revoked</span>' : '<span class="ok">Active</span>'])))}</section>`;

  h += `<section><h2>Hands</h2>${table(['When', 'Table', '#Pot', 'Won', ...(f.revealed ? ['Board', 'Cards'] : [])], (f.hands || []).map(r => tr([
    when(r.at), esc(r.tableName || r.table), num(chips(r.pot)),
    esc((r.seats || []).filter(s => s.inHand && s.net > 0).map(s => `${s.name} +${chipText(s.net)}`).join(', ')),
    ...(f.revealed ? [esc([r.board, r.board2].filter(b => b?.length).map(b => b.join(' ')).join(' / ')), esc((r.seats || []).filter(s => s.cards).map(s => `${s.name} ${s.cards.join(' ')}`).join(' · '))] : []),
  ])))}</section>`;

  h += `<section><h2>Lobby chat</h2>${f.revealed
    ? table(['When', 'Name', 'Said'], [...(f.lobby || [])].reverse().map(l => tr([when(l.at), esc(l.name), esc(l.text)])))
    : `<p class="muted">${f.lobbyCount || 0} ${f.lobbyCount === 1 ? 'line' : 'lines'}</p>`}</section>`;
  return h;
}

const nameIn = id => club?.members?.find(m => m.id === id)?.name || (id === club?.ownerId ? 'Owner' : id === club?.hostId ? 'Club' : String(id ?? ''));

function ledgerRows() {
  return (club?.ledger || []).filter(e => (!ledgerFilter.member || e.member === ledgerFilter.member) && (!ledgerFilter.kind || e.kind === ledgerFilter.kind));
}

function ledgerHtml() {
  const all = club?.ledger || [];
  const kinds = [...new Set(all.map(e => e.kind))].sort();
  const people = [...new Map(all.map(e => [e.member, e.name || e.member])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const rows = ledgerRows();
  return `<h2>Ledger</h2><div class="row">
      <select id="lf-member" aria-label="Member"><option value="">Everyone</option>${people.map(([id, n]) => `<option value="${esc(id)}"${ledgerFilter.member === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select id="lf-kind" aria-label="Kind"><option value="">Every kind</option>${kinds.map(k => `<option${ledgerFilter.kind === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select>
      <span class="muted">${rows.length} of ${all.length}</span>
      <button id="csv">CSV</button></div>`
    + table(['No.', 'When', 'Kind', 'Member', '#Amount', '#Balance', 'Note', 'Table'], rows.slice(-500).reverse().map(e => tr([esc(e.n), when(e.at), esc(e.kind), esc(e.name || e.member), num(chips(e.amount)), num(chips(e.balance)), esc(e.note), esc(e.table)])));
}

function downloadCsv() {
  const cell = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const lines = [['n', 'at', 'kind', 'member', 'name', 'amount', 'balance', 'note', 'table'].join(',')];
  for (const e of ledgerRows()) lines.push([e.n, new Date(e.at).toISOString(), e.kind, e.member, e.name, e.amount / 100, e.balance / 100, e.note, e.table].map(cell).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], {type: 'text/csv'}));
  a.download = `${club.code}-ledger.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- people ----

let peopleFilter = '';
let lastPeople = []; // the last answer, for redrawing as the search changes
function peopleHtml(people) {
  lastPeople = people;
  const q = peopleFilter.toLowerCase();
  const rows = people.filter(p => !q || [p.id, showId(p.id), ...p.names, ...p.clubs.map(c => `${c.club} ${c.code}`)].some(s => String(s).toLowerCase().includes(q)));
  return `<section><h2>People</h2><div class="row"><input id="p-filter" placeholder="Search" size="24" value="${esc(peopleFilter)}"><span class="muted">${rows.length} of ${people.length}</span></div>`
    + table(['Player', 'Names', 'Clubs', 'Last seen', 'Grant'], rows.map(p => tr([
      pid(p.id), esc(p.names.join(', ')),
      p.clubs.map(c => `<button class="link" data-club="${esc(c.code)}">${esc(c.club || c.code)}</button> <span class="muted">${esc([c.role, c.role === 'owner' ? '' : c.status, c.agent ? `agent ${c.agent}` : ''].filter(Boolean).join(', '))}${c.balance != null ? ` · ${chips(c.balance)}` : ''}</span>`).join('<br>')
        + (p.trial ? `<br><span class="muted">trial ${esc(p.trial)}</span>` : ''),
      ago(p.lastSeen),
      p.grant ? `<span class="ok">✓</span> ${esc(p.grant.note || '')}` : '',
    ])), 'Nobody yet') + '</section>';
}

function personHtml(p) {
  let h = `<section><h2><code>${esc(showId(p.id))}</code> <span class="muted">${esc(p.id)}</span></h2><dl>`
    + `<dt>Grant</dt><dd>${p.grant ? `${esc(p.grant.note || '✓')} · ${p.grant.maxClubs || data?.limits?.perOwner || ''} clubs${p.grant.limits ? ` · ${p.grant.limits.tables} tables, ${p.grant.limits.tourneysPerDay}/day` : ''}` : '—'}</dd>`
    + `<dt>Trial</dt><dd>${esc(p.trial || '—')}</dd></dl></section>`;
  if (!p.clubs.length) return h + '<section><p class="muted">In no clubs</p></section>';
  for (const c of p.clubs) {
    const m = c.member;
    h += `<section><h2><button class="link" data-club="${esc(c.code)}">${esc(c.name || c.code)}</button> <code>${esc(c.code)}</code></h2>`;
    if (c.error) { h += `<p class="err">${esc(c.error)}</p></section>`; continue; }
    h += `<dl><dt>Role</dt><dd>${esc([c.owner ? 'owner' : '', m?.status, m?.role, m?.agent ? `agent ${m.agent}` : ''].filter(Boolean).join(', '))}</dd>`
      + (m ? `<dt>Name</dt><dd>${esc(m.name)}</dd><dt>Balance</dt><dd>${chips(m.balance)}</dd><dt>Joined</dt><dd>${day(m.joinedAt || m.requestedAt)}</dd>` : '')
      + `<dt>Last seen</dt><dd>${ago(c.lastSeen)}</dd></dl>`
      + `<h3>Ledger</h3>${table(['No.', 'When', 'Kind', '#Amount', '#Balance', 'Note', 'Table'], [...(c.ledger || [])].reverse().map(e => tr([esc(e.n), when(e.at), esc(e.kind), num(chips(e.amount)), num(chips(e.balance)), esc(e.note), esc(e.table)])))}`
      + `<h3>Chip requests</h3>${table(['When', 'Outcome', '#Asked', '#Given', 'Note'], [...(c.requests || [])].reverse().map(r => tr([when(r.at), esc(r.outcome), num(chips(r.asked)), num(chips(r.given)), esc(r.note)])))}`
      + `<h3>Help requests</h3>${table(['When', 'Asked', 'Reply'], [...(c.help || [])].reverse().map(r => tr([when(r.at), esc(r.text), esc(r.reply)])))}`
      + `<h3>Activity log</h3>${table(['When', 'What'], [...(c.log || [])].reverse().map(e => tr([when(e.at), esc(e.text)])))}</section>`;
  }
  return h;
}

// ---- the admin log ----

const ACTIONS = {grant: 'Grant', revoke: 'Revoke', pause: 'Pause', resume: 'Resume', limits: 'Limits', plan: 'Plan', expires: 'Trial end', reveal: 'Showed chats and cards'};

function logHtml(log) {
  return `<section><h2>Admin log</h2>${table(['When', 'Admin', 'Action', 'Of', 'Detail'], [...log].reverse().map(e => tr([
    when(e.at), `${esc(e.name)} <span class="muted">${esc(showId(e.by))}</span>`, esc(ACTIONS[e.action] || e.action),
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(e.target) ? `<button class="link" data-club="${esc(e.target)}"><code>${esc(e.target)}</code></button>` : pid(e.target),
    esc(e.detail),
  ])), 'Nothing yet')}</section>`;
}

// ---- actions ----

const val = id => { const v = $(id)?.value.trim(); return v ? Number(v) : undefined; };

async function act(fn, done) {
  try { await fn(); if (await show()) say(done, 'ok'); } catch (e) { say(e.message, 'err'); }
}

document.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'load') {
    try { localStorage.setItem('ducyAdminRelay', $('relay').value.trim()); } catch {}
    return show();
  }
  if (b.id === 'na-copy') return navigator.clipboard?.writeText($('na-entry').textContent).then(() => say('Copied.', 'ok'), () => {});
  if (b.dataset.go) { location.hash = b.dataset.go; return; }
  if (b.dataset.club) { location.hash = `club=${encodeURIComponent(b.dataset.club)}`; return; }
  if (b.dataset.person) { location.hash = `person=${encodeURIComponent(b.dataset.person)}`; return; }
  if (b.id === 'reveal') {
    const code = route().arg;
    if (!confirm('Show this club’s chats and cards? It goes in the admin log.')) return;
    revealed.add(code);
    return show();
  }
  if (b.id === 'csv') return downloadCsv();
  if (b.id === 'grant') {
    const id = $('g-id').value.trim();
    const tables = val('g-tables'), tourneysPerDay = val('g-tourneys');
    const limits = tables !== undefined || tourneysPerDay !== undefined ? {tables: tables ?? 2, tourneysPerDay: tourneysPerDay ?? 1} : null;
    return act(() => api('/admin/grant', {id, note: $('g-note').value.trim(), maxClubs: val('g-max') || 0, limits}), `Granted ${id}.`);
  }
  if (b.dataset.revoke) {
    if (!confirm('Take away this player’s permission? Their clubs carry on until paused.')) return;
    return act(() => api('/admin/revoke', {id: b.dataset.revoke}), 'Revoked.');
  }
  const code = b.dataset.pause || b.dataset.plan || b.dataset.extend || b.dataset.limits;
  if (!code) return;
  const set = change => api(`/admin/club/${encodeURIComponent(code)}/set`, change);
  if (b.dataset.pause) {
    const pause = b.dataset.to === 'true';
    if (pause && !confirm('Pause this club? Everyone but its owner is disconnected until you resume it.')) return;
    return act(() => set({suspended: pause}), pause ? 'Paused.' : 'Resumed.');
  }
  if (b.dataset.plan) return act(() => set({plan: 'club'}), 'It’s a club now, with no end date.');
  if (b.dataset.extend) {
    const c = data.clubs.find(x => x.code === code);
    return act(() => set({expires: Math.max(c.expires || 0, Date.now()) + 14 * 864e5}), 'Trial extended by 14 days.');
  }
  if (b.dataset.limits) {
    const tables = Number(document.querySelector(`[data-lim-tables="${CSS.escape(code)}"]`).value);
    const tourneysPerDay = Number(document.querySelector(`[data-lim-tourneys="${CSS.escape(code)}"]`).value);
    return act(() => set({limits: {tables, tourneysPerDay}}), 'Limits set.');
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'lf-member' || e.target.id === 'lf-kind') {
    ledgerFilter[e.target.id === 'lf-member' ? 'member' : 'kind'] = e.target.value;
    $('ledger-card').innerHTML = ledgerHtml();
  }
});

document.addEventListener('input', e => {
  if (e.target.id !== 'p-filter') return;
  peopleFilter = e.target.value;
  // Redrawn from the last answer, keeping the cursor in the box.
  const pos = e.target.selectionStart;
  $('view').innerHTML = peopleHtml(lastPeople);
  const f = $('p-filter');
  f.focus();
  f.setSelectionRange(pos, pos);
});

// Leaving a club hides its chats and cards again: each showing is logged.
window.addEventListener('hashchange', () => { revealed.clear(); ledgerFilter.member = ledgerFilter.kind = ''; show(); });

try {
  me = await loadIdentity();
  $('me').textContent = `You: ${showId(me.id)}`;
  show();
} catch (e) {
  say(`No identity in this browser: ${e.message}`, 'err');
}

// The admin site (admin.ducy.cards, #601; before it admin.html, #265, #401).
// It reads each environment's relay: live, staging and sandbox (ENVS), one
// at a time, picked at the top. Every request to a relay's /admin API is
// signed with this browser's identity (identity.js); each relay lets in
// only the keys listed in its admins.json. Someone not on the list is shown
// their player ID and key to add, or restores their admin key's backup.
//
// Views, by the page's hash: #overview (the default: versions everywhere,
// what's live now, the last 30 days as small charts or a table, and
// Cloudflare's numbers when the relay has its token), #clubs (usage,
// permission, the club list), #club=<code> (everything the club stores,
// read-only), #people, #person=<id> (their activity in every club), #log
// (the admin log), #errors (what pages reported going wrong, #552), #fair
// (every club's fair play numbers, #612, admin-fair-play.js) and
// #fair-player=<id> (that player's weeks).
// A club's lobby chat and finished hands' cards stay hidden until "Show
// chats and cards"; each use goes in the admin log.
//
// ?relay=<url> (local testing) reads that relay alone, as "Local".

import init from '../wasm/ducy_wasm.js';
import { importIdentity, loadIdentity, saveIdentity, showId, signMessage } from './identity.js';
import { chipText } from './chip-format.js';
import { ago as agoText } from './time-ago.js';
import { chartHtml, fmt, wire } from './admin-charts.js';
import { fairHtml, historyHtml, nextSort } from './admin-fair-play.js';

// ducy's engine first: signing (the JSON a request is signed over) and
// player IDs use it (identity.js, #460).
try {
  await init({module_or_path: new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url)});
} catch (e) {
  console.error('WASM init failed:', e);
}

// Each environment's relay and site (DEPLOY.md).
const ENVS = [
  {key: 'live', label: 'Live', relay: 'https://ducy-relay.ducy.workers.dev', site: 'https://ducy.cards'},
  {key: 'staging', label: 'Staging', relay: 'https://ducy-relay-staging.ducy.workers.dev', site: 'https://staging.ducy.cards'},
  {key: 'sandbox', label: 'Sandbox', relay: 'https://ducy-relay-sandbox.ducy.workers.dev', site: 'https://sandbox.ducy.cards'},
];
const localRelay = new URLSearchParams(location.search).get('relay');
const envs = localRelay ? [{key: 'local', label: 'Local', relay: localRelay.replace(/^ws/, 'http').replace(/\/$/, ''), site: location.origin}] : ENVS;
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
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = k => { try { return localStorage.getItem(k); } catch { return null; } };
let env = envs.find(e => e.key === recall('ducyAdminEnv')) || envs[0];
const base = () => env.relay;

// A signed request (#401): {type: 'admin', path, data}, as relay/src/admin.js checks it.
async function api(path, data = {}) {
  const signed = await signMessage(me, {type: 'admin', path, data});
  const r = await fetch(base() + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(signed)});
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
  return {view: ['clubs', 'club', 'person', 'people', 'log', 'errors', 'fair', 'fair-player'].includes(k) ? k : 'overview', arg: v ? decodeURIComponent(v) : ''};
}

// Fair play (#612): the last answers, redrawn as the club or a sort changes.
const fair = {data: null, history: null, club: '', sort: {}, historySort: {}};
const drawFair = () => { $('view').innerHTML = route().view === 'fair' ? fairHtml(fair.data, fair) : historyHtml(fair.history, {sort: fair.historySort}, fair.data?.limits); };

function drawEnvs() {
  $('envs').innerHTML = envs.map(e => `<button data-env="${esc(e.key)}"${e === env ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(e.label)}</button>`).join('');
}

let showing = 0; // the latest show(), so an older answer arriving late is dropped
async function show() {
  const {view, arg} = route();
  const mine = ++showing;
  for (const b of document.querySelectorAll('nav button')) {
    if (b.dataset.go === view || (view === 'club' && b.dataset.go === 'clubs') || (view === 'person' && b.dataset.go === 'people') || (view === 'fair-player' && b.dataset.go === 'fair')) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  say('Loading…');
  $('view').classList.add('stale');
  try {
    let html;
    if (view === 'overview') html = await overviewHtml();
    else if (view === 'clubs') {
      data = await api('/admin/clubs');
      usage = await fetch(base() + '/usage').then(r => r.json()).catch(() => null);
      html = clubsHtml();
    } else if (view === 'club') {
      html = clubHtml(await api(`/admin/club/${encodeURIComponent(arg)}`, {reveal: revealed.has(arg)}), arg);
    } else if (view === 'people') {
      html = peopleHtml((await api('/admin/people')).people);
    } else if (view === 'person') {
      html = personHtml(await api('/admin/person', {id: arg}));
    } else if (view === 'fair') {
      fair.data = await api('/admin/fair-play');
      html = fairHtml(fair.data, fair);
    } else if (view === 'fair-player') {
      fair.history = await api('/admin/fair-play/history', {id: arg});
      html = historyHtml(fair.history, {sort: fair.historySort}, fair.data?.limits);
    } else if (view === 'errors') {
      html = errorsHtml((await api('/admin/errors')).errors);
    } else {
      html = logHtml((await api('/admin/log')).log);
    }
    if (mine !== showing) return false;
    $('view').innerHTML = html;
    $('view').classList.remove('stale');
    $('nav').hidden = false;
    $('not-admin').hidden = true;
    say(`${env.label} · ${new Date().toLocaleTimeString()}`, 'muted');
    return true;
  } catch (e) {
    if (mine !== showing) return false;
    $('view').innerHTML = '';
    $('view').classList.remove('stale');
    say(e.message, 'err');
    return false;
  }
}

// ---- overview (#601) ----

const METRICS = [
  ['active', 'Active players'], ['newPlayers', 'New players'], ['clubsActive', 'Clubs active'], ['clubHands', 'Club hands'],
];
const CF_METRICS = [
  ['requests', 'Requests'], ['errors', 'Errors'], ['cpuP50', 'CPU time, median (ms)', 2], ['cpuP99', 'CPU time, 99th percentile (ms)', 1], ['doRequests', 'Durable Object requests'],
];
let asTable = recall('ducyAdminTable') === '1';

// Each environment's site (/version.json) and relay (/version). A
// password-protected site answers only once you've signed in to it in this
// browser (its .htaccess allows the admin site to read version.json).
async function versions() {
  const get = (url, opts) => fetch(url, {cache: 'no-store', ...opts}).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
  return Promise.all(envs.map(async e => ({
    env: e,
    site: await get(`${e.site}/version.json`, {credentials: 'include'}).catch(() => null),
    relay: await get(`${e.relay}/version`).catch(() => null),
  })));
}

const short = c => (c ? String(c).slice(0, 8) : '');

function versionsHtml(rows) {
  return `<section><h2>Versions</h2>${table(['', 'Site', 'Site commit', 'Relay commit', 'Built'], rows.map(r => tr([
    `<b>${esc(r.env.label)}</b>`,
    r.site ? `<code>${esc(r.site.version)}</code>` : `<a href="${esc(r.env.site)}/version.json" target="_blank" rel="noopener">Sign in</a>`,
    r.site ? `<code>${esc(short(r.site.commit))}</code>` : '—',
    r.relay ? `<code>${esc(short(r.relay.commit) || '—')}</code>${r.site?.commit && r.relay.commit && r.site.commit !== r.relay.commit ? ' <span class="warn">≠ site</span>' : ''}` : '<span class="err">No answer</span>',
    r.site?.built ? when(Date.parse(r.site.built)) : '—',
  ])))}</section>`;
}

const tile = (label, value) => `<div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-value">${esc(fmt(value))}</span></div>`;

function dailyHtml(title, rows, metrics) {
  const days = rows.map(d => d.day);
  if (asTable) {
    return `<section><h2>${esc(title)}</h2>${table(['Day', ...metrics.map(([, label]) => `#${label}`)], [...rows].reverse().map(d => tr([esc(d.day), ...metrics.map(([k, , digits]) => num(esc(fmt(d[k], digits || 0))))])))}</section>`;
  }
  return `<section><h2>${esc(title)}</h2><div class="charts">${metrics.map(([k, label, digits]) => chartHtml({key: k, label, days, values: rows.map(d => d[k]), digits: digits || 0})).join('')}</div></section>`;
}

async function overviewHtml() {
  const [vers, st, cf] = await Promise.all([versions(), api('/admin/stats'), api('/admin/cloudflare').catch(e => ({enabled: true, days: [], errors: [e.message]}))]);
  let h = versionsHtml(vers);
  const n = st.now || {};
  h += `<section><h2>Now</h2><div class="tiles">${tile('Live rooms', n.rooms)}${tile('Players connected', n.players)}${tile('Club tables', n.clubTables)}</div></section>`;
  h += `<div class="row"><div class="seg" role="group" aria-label="View"><button data-view="charts" aria-pressed="${!asTable}">Charts</button><button data-view="table" aria-pressed="${asTable}">Table</button></div></div>`;
  h += dailyHtml('Last 30 days', st.days || [], METRICS);
  if (cf?.enabled) {
    // CPU time comes in microseconds.
    const rows = (cf.days || []).map(d => ({...d, cpuP50: d.cpuP50 == null ? null : d.cpuP50 / 1000, cpuP99: d.cpuP99 == null ? null : d.cpuP99 / 1000}));
    h += (cf.errors || []).map(e => `<p class="err">${esc(e)}</p>`).join('');
    if (rows.length) h += dailyHtml('Cloudflare', rows, CF_METRICS);
  }
  return h;
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
  let h = `<section><div class="row spread"><h2>${esc(f.name || rec?.name || '')} <code>${esc(code)}</code></h2>`
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
    + table(['No.', 'When', 'Kind', 'Member', 'With', '#Amount', '#Balance', 'Note', 'About'], rows.slice(-500).reverse().map(e => tr([esc(e.n), when(e.at), esc(e.kind), esc(e.name || e.member), esc(e.backerName || e.backer), num(chips(e.amount)), num(chips(e.balance)), esc(e.note), esc(e.about)])));
}

function downloadCsv() {
  const cell = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const lines = [['n', 'at', 'tx', 'kind', 'member', 'name', 'backer', 'amount', 'balance', 'note', 'about'].join(',')];
  for (const e of ledgerRows()) lines.push([e.n, new Date(e.at).toISOString(), e.tx, e.kind, e.member, e.name, e.backer, e.amount / 100, e.balance / 100, e.note, e.about].map(cell).join(','));
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
      + `<h3>Ledger</h3>${table(['No.', 'When', 'Kind', 'Member', 'With', '#Amount', '#Balance', 'Note', 'About'], [...(c.ledger || [])].reverse().map(e => tr([esc(e.n), when(e.at), esc(e.kind), esc(e.member), esc(e.backer), num(chips(e.amount)), num(chips(e.balance)), esc(e.note), esc(e.about)])))}`
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

// What pages reported going wrong (#552), most recent first.
function errorsHtml(errors) {
  return `<section><h2>Errors</h2>${table(['Last seen', '#Times', 'Error', 'Page', 'Version', 'Browser'], errors.map(e => tr([
    when(e.last), num(e.count), `${esc(e.message)}${e.where ? ` <span class="muted">${esc(e.where)}</span>` : ''}${e.stack ? `<details><summary class="muted">Stack</summary><pre>${esc(e.stack)}</pre></details>` : ''}`,
    esc(e.page), esc(e.build), esc(e.ua),
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
  if (b.dataset.env) {
    env = envs.find(x => x.key === b.dataset.env) || env;
    remember('ducyAdminEnv', env.key);
    drawEnvs();
    // A club or person belongs to one relay: back to its list.
    const {view} = route();
    if (view === 'club' || view === 'person' || view === 'fair-player') { location.hash = {club: 'clubs', person: 'people', 'fair-player': 'fair'}[view]; return; }
    fair.club = '';
    return show();
  }
  if (b.dataset.view) {
    asTable = b.dataset.view === 'table';
    remember('ducyAdminTable', asTable ? '1' : '0');
    return show();
  }
  if (b.id === 'na-restore') return restore();
  if (b.id === 'na-copy') return navigator.clipboard?.writeText($('na-entry').textContent).then(() => say('Copied.', 'ok'), () => {});
  if (b.dataset.go) { location.hash = b.dataset.go; return; }
  if (b.dataset.club) { location.hash = `club=${encodeURIComponent(b.dataset.club)}`; return; }
  if (b.dataset.person) { location.hash = `person=${encodeURIComponent(b.dataset.person)}`; return; }
  if (b.dataset.fair) { location.hash = `fair-player=${encodeURIComponent(b.dataset.fair)}`; return; }
  if (b.dataset.sort) {
    const text = ['club', 'players', 'signal', 'numbers', 'name', 'week'].includes(b.dataset.key);
    if (b.dataset.sort === 'history') fair.historySort = nextSort(fair.historySort, 'history', b.dataset.key, text);
    else fair.sort = nextSort(fair.sort, b.dataset.sort, b.dataset.key, text);
    return drawFair();
  }
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
  if (e.target.id === 'fp-club') { fair.club = e.target.value; drawFair(); return; }
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

// The admin key's backup file (#601): this site has its own browser
// storage, so a key made on ducy.cards is brought here from its backup.
async function restore() {
  const file = $('na-file').files?.[0];
  if (!file) { say('Choose the backup file.', 'err'); return; }
  try {
    const ident = await importIdentity(await file.text(), $('na-pass').value);
    await saveIdentity(ident);
    me = ident;
    $('na-pass').value = '';
    $('me').textContent = showId(me.id);
    await show();
  } catch (e) {
    say(e.message, 'err');
  }
}

wire($('view'));
drawEnvs();
try {
  me = await loadIdentity();
  $('me').textContent = showId(me.id);
  show();
} catch (e) {
  say(`No identity in this browser: ${e.message}`, 'err');
}

// Demo clubs (#406): from the club manager's Try a demo club, pick a demo
// club (demo-scenarios.js) and play every part of it in one window: the
// manager and each player, switching between them, through the real club
// pages.
//
// The demo is kept apart from everything real:
//   - each person in it gets storage of their own (profile.js's
//     separateStorage), so their own identity, clubs and settings, and the
//     demo never touches the person's real ones;
//   - the club runs in the page (demo-relay.js, the relay's club-room code),
//     with its storage in a database of the demo's, so it uses no relay and
//     leaves nothing on a server;
//   - End demo deletes all of it; Reset puts it back to its start.
// A striped DEMO bar on every page says so, with who you are (and
// switching), Reset and End demo; at a table, Simulate.
//
// Imported first (manage.js, and main.js after profile.js), so a demo's
// storage is in place before anything reads storage. This tab is in the demo
// while window.name says so (it lasts across reloads and pages, and other
// tabs aren't in it), and the demo itself, in this browser's real
// localStorage (ducyDemo), is still on (its record: demo-state.js).

import { separateStorage } from './profile.js';
import { useLocalRelay } from './play-net.js';
import { chipText } from './chip-format.js';
import { inviteLink, newMembership } from './club.js';
import { SCENARIOS, scenarioById, scenarioFacts } from './demo-scenarios.js';
import { dbSuffixOf, demoStorage, isOn, MANAGER, newDemo, prefixOf, relayDb, resetDemo } from './demo-state.js';

const KEY = 'ducyDemo';
const TAB = 'ducy-demo', OVER = 'ducy-demo-over';
const realLocal = window.localStorage, realSession = window.sessionStorage;
const realOpen = IDBFactory.prototype.open, realDrop = IDBFactory.prototype.deleteDatabase;

const load = () => { try { return JSON.parse(realLocal.getItem(KEY)) || null; } catch { return null; } };
const store = d => { try { d ? realLocal.setItem(KEY, JSON.stringify(d)) : realLocal.removeItem(KEY); } catch {} };
// The DEMO bar (below): its element, what it shows, and a redraw coming.
let bar = null, drawn = '', drawTimer = null, simNote = '', settingUp = false;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

let saved = load();
// Reset: this page starts it again from its scenario. The deletes go first,
// so IndexedDB opens anything again only after them.
if (window.name === TAB && isOn(saved) && saved.resetting) {
  clear(saved);
  store(saved = resetDemo(saved));
}
const over = window.name === OVER;
// The demo this tab is in, or null.
export const demo = window.name === TAB && isOn(saved) ? saved : null;
const me = demo && (demo.people.find(p => p.key === demo.current) || demo.people[0]);

if (demo) separateStorage(prefixOf(demo.id, me.key), dbSuffixOf(demo.id, me.key));
else {
  if (window.name === TAB || window.name === OVER) window.name = '';
  // An ended demo is deleted wherever the club manager or app opens next.
  if (saved?.ending) wipe(saved);
}

// Deletes demo `d`'s storage and databases (its people's and the club's),
// at once; returns the deletes. Storage of other demos is left alone.
function clear(d, names = demoStorage(d).dbs) {
  const {prefix} = demoStorage(d);
  for (const s of [realLocal, realSession]) {
    try {
      const keys = [];
      for (let i = 0; i < s.length; i++) if (s.key(i)?.startsWith(prefix)) keys.push(s.key(i));
      for (const k of keys) s.removeItem(k);
    } catch {}
  }
  return Promise.all(names.map(n => new Promise(resolve => {
    try {
      const req = realDrop.call(indexedDB, n);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  })));
}

// Deletes demo `d` and its record, and any database of it this browser lists.
async function wipe(d) {
  if (load()?.id === d.id) store(null);
  await clear(d);
  try { await clear(d, (await indexedDB.databases()).map(x => x.name).filter(demoStorage(d).isDemoDb)); } catch {}
}

// Starts demo club `scenario` (demo-scenarios.js) in this tab, as its
// manager, ending any other demo first. It's set up on its first page.
export async function startDemo(scenario = 'new') {
  const old = load();
  if (old) await wipe(old);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
  store(newDemo(id, scenarioById(scenario).id));
  window.name = TAB;
  go(managerUrl(scenarioById(scenario).club ? 'clubs/own' : 'clubs'));
}

// Ends the demo: the next page (the club manager) deletes it and says so.
function endDemo() {
  const d = load();
  if (d) store({...d, ending: true});
  window.name = OVER;
  go(managerUrl('clubs'));
}

// Back to the demo club's start: the next page clears it and sets it up again.
function reset() {
  const d = load();
  if (!isOn(d)) { endDemo(); return; }
  store({...d, resetting: true});
  go(managerUrl('clubs'));
}

const managerUrl = hash => new URL(`manage.html#${hash}`, location.href).href;
const playerUrl = hash => new URL(`./#${hash}`, location.href).href;
// To `url` with a fresh page, even when only its hash differs.
function go(url) {
  history.replaceState(null, '', url);
  location.reload();
}

// ---- the relay in the page ----

let relayP = null;
// The demo's relay (demo-relay.js), loaded only for a demo.
const relay = () => (relayP ||= import('./demo-relay.js').then(m => {
  const storage = kv(relayDb(demo.id));
  const r = m.createDemoRelay({
    storage,
    identity: () => import('./identity.js').then(i => i.loadIdentity()),
    ready: async () => { const w = await import('../wasm/ducy_wasm.js'); await w.default(); return w; },
  });
  r.onChange(() => drawSoon());
  return r;
}));

// Opens IndexedDB database `name` past separateStorage (which would give
// each person their own), with object store `os`.
function openDb(name, os) {
  return new Promise((resolve, reject) => {
    const req = realOpen.call(indexedDB, name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(os);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const inStore = (db, os, mode, run) => new Promise((resolve, reject) => {
  const t = db.transaction(os, mode);
  const req = run(t.objectStore(os));
  t.oncomplete = () => resolve(req.result);
  t.onerror = t.onabort = () => reject(t.error);
});

// A key-value store in IndexedDB for the relay, shared by the demo's people.
function kv(name) {
  let dbP = null;
  const tx = (mode, run) => (dbP ||= openDb(name, 'kv')).then(db => inStore(db, 'kv', mode, run));
  return {
    get: k => tx('readonly', s => s.get(k)),
    put: (k, v) => tx('readwrite', s => s.put(v, k)),
    delete: k => tx('readwrite', s => s.delete(k)),
  };
}

// ---- setting up a demo club ----

// The scenario's club, once (and again after Reset): made for the manager
// (this page's identity), with an identity for each of its people stored
// as theirs (as identity.js keeps it), and their membership.
async function setUp() {
  settingUp = true;
  drawSoon();
  const sc = scenarioById(demo.scenario);
  const r = await relay();
  const d = load();
  if (!sc.club) { store({...d, setUp: true}); settingUp = false; drawSoon(); return; }
  const {createIdentity, loadIdentity} = await import('./identity.js');
  const owner = await loadIdentity();
  const people = [];
  for (const [i, p] of sc.club.people.entries()) {
    const key = `p${i + 1}`;
    const ident = await createIdentity();
    const db = await openDb(`ducy${dbSuffixOf(demo.id, key)}`, 'identity');
    await inStore(db, 'identity', 'readwrite', s => s.put({alg: ident.alg, privateKey: ident.privateKey, publicKey: ident.publicKey, seq: ident.seq}, 'me'));
    db.close();
    people.push({...p, key, ident});
  }
  const made = await r.setUp(sc, {owner, people});
  await r.flush();
  // The manager runs it (club-owner.js); each person is in it, or asking.
  realLocal.setItem(`${prefixOf(demo.id, MANAGER)}ducyClubRemote`, JSON.stringify({code: made.code, hostId: made.hostId, name: made.name}));
  for (const p of people) {
    const mem = {...newMembership(made), status: p.status === 'pending' ? 'pending' : 'member'};
    realLocal.setItem(`${prefixOf(demo.id, p.key)}ducyClubName`, p.name);
    realLocal.setItem(`${prefixOf(demo.id, p.key)}ducyClubs`, JSON.stringify([mem]));
  }
  store({...d, setUp: true, people: [{key: MANAGER, name: 'Manager', id: owner.id}, ...people.map(p => ({key: p.key, name: p.name, id: p.ident.id}))]});
  go(managerUrl('clubs/own'));
}

if (demo) {
  // Connections open at once; messages wait for the relay to load.
  useLocalRelay({
    connect(code, role, id, handlers) {
      let conn = null, closed = false;
      const waiting = [];
      relay().then(r => {
        if (closed) return;
        conn = r.connect(code, role, id, handlers);
        for (const m of waiting) conn.send(m);
      }).catch(e => { console.warn(e); handlers.onFail('The demo couldn’t start here.'); });
      return {
        send: m => (conn ? conn.send(m) : waiting.push(m)),
        close() { closed = true; conn?.close(); },
        healthy: () => !!conn?.healthy(),
      };
    },
    lookup: code => relay().then(r => r.lookup(code)),
  });
  if (!demo.setUp) setUp().catch(e => { console.warn('demo: not set up:', e); settingUp = false; drawSoon(); });
  // This person's player ID, for the switcher.
  import('./identity.js').then(i => i.loadIdentity()).then(ident => {
    const d = load();
    const p = d?.people.find(x => x.key === me.key);
    if (p && p.id !== ident.id) { p.id = ident.id; store(d); }
    me.id = ident.id;
    drawSoon();
  }).catch(e => console.warn(e));
}

// ---- switching people ----

async function switchTo(key) {
  const d = load();
  if (!isOn(d)) { endDemo(); return; }
  const p = d.people.find(x => x.key === key);
  if (!p) return;
  const r = await relay();
  const club = await r.club();
  await r.flush();
  store({...d, current: key});
  if (key === MANAGER) { go(managerUrl(club ? 'clubs/own' : 'clubs')); return; }
  const status = club?.members[p.id]?.status;
  if (status === 'member') go(playerUrl(`clubs/c/${encodeURIComponent(club.code)}`));
  else if (status === 'pending') go(playerUrl('join'));
  else if (club) go(inviteLink(club, playerUrl('')));
  else go(playerUrl('clubs'));
}

// A new person, who opens the club's invite link and asks to join.
async function newPlayer() {
  const d = load();
  const r = await relay();
  const club = await r.club();
  if (!isOn(d) || !club) return;
  await r.flush();
  const n = d.people.length;
  const p = {key: `p${n}`, name: `Player ${n}`};
  try { realLocal.setItem(`${prefixOf(d.id, p.key)}ducyClubName`, p.name); } catch {}
  store({...d, people: [...d.people, p], current: p.key});
  go(inviteLink(club, playerUrl('')));
}

// ---- the DEMO bar ----


// Each person and where they are in the club.
function stateOf(p, club) {
  if (p.key === MANAGER) return club ? club.name : 'No club yet';
  const m = club?.members[p.id];
  if (m?.status === 'member') return `${m.seat ? 'At a table' : 'Member'} · ${chipText(m.balance + (m.seat?.stack || 0))}`;
  if (m?.status === 'pending') return 'Asking to join';
  if (m?.status === 'declined') return 'Declined';
  if (m?.status === 'removed') return 'Removed';
  return 'Not in the club';
}

const SIM_LABEL = {win: 'Win', lose: 'Lose', bust: 'Bust', play10: 'Playing'};

async function draw() {
  if (!demo || !document.body) return;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Demo');
    bar.addEventListener('click', onClick);
    bar.addEventListener('toggle', e => { if (e.target.open) draw(); }, true);
    document.body.prepend(bar);
    document.body.classList.add('in-demo');
  }
  const d = load() || demo;
  const r = await relay();
  const club = await r.club().catch(() => null);
  const who = d.people.find(p => p.key === me.key) || me;
  const opened = bar.querySelector('details[open]');
  let h = '<div class="demo-row"><span class="demo-tag">DEMO</span>';
  if (settingUp) h += '<span class="demo-note" role="status">Setting up…</span>';
  else {
    h += `<details class="demo-who"${opened ? ' open' : ''}><summary>You are: <b>${esc(who.name)}</b> ▾</summary><div class="demo-menu" role="menu">`;
    for (const p of d.people) {
      h += `<button type="button" role="menuitem" data-demo-as="${esc(p.key)}"${p.key === me.key ? ' aria-current="true"' : ''}><b>${esc(p.name)}</b><span>${esc(stateOf(p, club))}</span></button>`;
    }
    h += `<button type="button" role="menuitem" data-demo-new${club ? '' : ' disabled'}>+ New player from the invite link</button></div></details>`;
  }
  h += '<span class="demo-acts"><button type="button" class="demo-end" data-demo-reset>Reset</button><button type="button" class="demo-end" data-demo-end>End demo</button></span></div>';
  // At a table in the demo's club: Simulate.
  if (me.key !== MANAGER && me.id && location.hash === '#play') {
    const st = await r.status(me.id).catch(() => null);
    if (st?.table) {
      const plan = st.plan;
      const busy = plan ? ' disabled' : '';
      const now = simNote || (plan ? (plan.kind === 'play10' ? `${SIM_LABEL.play10}: ${10 - plan.left + 1} of 10` : `${SIM_LABEL[plan.kind]}: ${plan.dealt ? 'this hand' : 'next hand'}`) : '');
      h += '<div class="demo-row demo-sim"><span class="demo-sim-title">Simulate</span>';
      for (const [what, label] of [['win', 'Win this hand'], ['lose', 'Lose this hand'], ['bust', 'Bust'], ['play10', 'Play 10 hands']]) h += `<button type="button" class="btn-small" data-demo-sim="${what}"${busy}>${label}</button>`;
      h += `<button type="button" class="btn-small" data-demo-bots${busy}>Add bots</button>`;
      if (now) h += `<span class="demo-sim-now" role="status">${esc(now)}</span>`;
      h += '</div>';
    }
  }
  if (h !== drawn) bar.innerHTML = drawn = h;
}
function drawSoon() {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(() => draw().catch(e => console.warn(e)), 50);
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.demoAs) { if (b.dataset.demoAs !== me.key) switchTo(b.dataset.demoAs); else b.closest('details').open = false; return; }
  if (b.dataset.demoNew != null) { newPlayer(); return; }
  if (b.dataset.demoReset != null) { if (confirm('Back to the start? Everything in the demo is deleted.')) reset(); return; }
  if (b.dataset.demoEnd != null) { if (confirm('End the demo? Everything in it is deleted.')) endDemo(); return; }
  const r = await relay();
  simNote = '';
  try {
    if (b.dataset.demoSim) await r.simulate(me.id, b.dataset.demoSim);
    else if (b.dataset.demoBots != null) await r.fillSeats(me.id);
  } catch (err) {
    simNote = err.message;
  }
  drawSoon();
}

// ---- the list of demo clubs, and demo over ----

function dialog(id, html, onClickIn) {
  document.getElementById(id)?.remove();
  const el = document.createElement('div');
  el.id = id;
  el.className = 'demo-over';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', `${id}-h`);
  el.innerHTML = html;
  el.addEventListener('click', e => onClickIn(e, el));
  document.body.append(el);
  el.querySelector('button')?.focus();
}

// Demo clubs: each one opens a club in that state.
export function showDemoList() {
  let h = '<section class="cl-card demo-list"><div class="demo-list-head"><h2 id="demo-list-h">Demo clubs</h2><button type="button" class="link-btn" data-demo-close aria-label="Close">✕</button></div><ul>';
  for (const s of SCENARIOS) {
    const facts = scenarioFacts(s);
    h += `<li><span><b>${esc(s.name)}</b>${facts ? `<span class="pl-meta">${esc(facts)}</span>` : ''}</span><button type="button" class="tr-start" data-demo-start="${esc(s.id)}">Start</button></li>`;
  }
  dialog('demo-list', `${h}</ul></section>`, (e, el) => {
    const b = e.target.closest('button');
    if (b?.dataset.demoStart) startDemo(b.dataset.demoStart);
    else if (b?.dataset.demoClose != null || e.target === el) el.remove();
  });
}

function drawOver() {
  dialog('demo-over', '<section class="cl-card"><h2 id="demo-over-h">Demo over</h2><div class="pl-actions">'
    + '<button type="button" class="tr-start" data-demo-own>Create your own club</button>'
    + '<button type="button" class="btn-small" data-demo-again>New demo</button></div></section>', (e, el) => {
    if (e.target.closest('[data-demo-own]')) { el.remove(); go(managerUrl('clubs')); }
    else if (e.target.closest('[data-demo-again]')) { el.remove(); showDemoList(); }
  });
}

if (demo || over) {
  const ready = fn => (document.body ? fn() : addEventListener('DOMContentLoaded', fn));
  if (demo) {
    ready(drawSoon);
    addEventListener('hashchange', drawSoon);
    // At a table: Simulate once seated, and how it's going.
    setInterval(() => { if (location.hash === '#play') drawSoon(); }, 2000);
  } else ready(drawOver);
}

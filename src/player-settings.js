// Player settings (#144): everything about you that most people set once
// and leave, in a dialog opened from the Play section's tab bar: your name,
// your avatar at the table, your player ID with its backup and restore, how many club hands to keep,
// notifications when something needs you (#145), and the relay in use.
//
// The player ID only lives in this browser, so a backup file (locked with a
// password, identity.js) is the way to keep it after clearing site data or
// to use it on another device. Restoring one reloads the page, so every part
// of it uses the restored ID.

import {
  backupNeedsPassword, exportLockedIdentity, importIdentity, loadIdentity, MIN_PASSWORD, saveIdentity, showId,
} from './identity.js';
import { DEFAULT_RELAY, relayUrl, wsUrl } from './play-net.js';
import { setTableAvatar, setTableName, tableAvatar, tableName } from './play.js';
import { PLAYER_AVATARS, avatarUrl } from './avatars.js';
import { keepHands, memberName, renameMember, setKeepHands, hasClubs } from './clubs.js';

const NOTIFY_KEY = 'ducyNotify';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

let el = null;
let me = null;
let idForm = null; // {kind: 'backup'}, or {kind: 'restore', text, id} waiting for a password
let note = '';

// Whether to tell this person, with a system notification, when something
// needs them while the page isn't in front (#145). Off unless they turn it on.
export function notifyOn() {
  try { return localStorage.getItem(NOTIFY_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'; } catch { return false; }
}

export const myName = () => tableName() || memberName();

export async function openPlayerSettings() {
  el ||= document.getElementById('pset');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    el.addEventListener('change', onChange);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden) close(); });
  }
  note = '';
  idForm = null;
  el.hidden = false;
  render();
  try { me = await loadIdentity(); } catch { note = 'This browser can’t keep a player ID (private mode or storage blocked).'; }
  render();
  el.querySelector('[data-ps=close]')?.focus();
}

function close() {
  el.hidden = true;
  el.innerHTML = '';
}

function render() {
  if (!el || el.hidden) return;
  let h = '<div class="cl-replay-bg" data-ps="close"></div><div class="cl-replay cl-dialog ps" role="dialog" aria-label="Player settings">';
  h += '<div class="cl-replay-head"><b>Player settings</b><button class="link-btn" data-ps="close">Close</button></div>';
  h += `<form class="pl-row" data-psform="name"><span class="pl-label">Your name</span><input class="pl-text" name="name" maxlength="20" placeholder="What others see" value="${esc(myName())}"><button class="btn-small" type="submit">Save</button></form>`;
  h += '<p class="pl-desc">What other players and club hosts see.</p>';
  // Your avatar at the table, or none (your initial).
  const mine = tableAvatar();
  h += '<div class="pl-row ps-avrow"><span class="pl-label">Avatar</span><div class="ps-avatars" role="radiogroup" aria-label="Avatar">';
  h += `<button type="button" class="ps-av none${mine ? '' : ' on'}" role="radio" aria-checked="${!mine}" data-ps="avatar" data-id="" title="None">${esc([...myName().trim()][0]?.toUpperCase() || '?')}</button>`;
  for (const a of PLAYER_AVATARS) h += `<button type="button" class="ps-av${a.id === mine ? ' on' : ''}" role="radio" aria-checked="${a.id === mine}" data-ps="avatar" data-id="${a.id}" title="${esc(a.label)}"><img src="${avatarUrl(a.id)}" alt="${esc(a.label)}"></button>`;
  h += '</div></div>';
  h += '<p class="pl-desc">Shown at your seat at the table.</p>';
  // The player ID, with backup and restore.
  h += '<div class="pl-row"><span class="pl-label">Player ID</span><div class="pl-opts">';
  h += `<code class="pl-pid" title="Your ID in clubs">${me ? esc(showId(me.id)) : '…'}</code>`;
  h += `<button class="btn-small" data-ps="backup"${me ? '' : ' disabled'}>Back up</button>`;
  h += '<label class="btn-small">Restore<input type="file" data-ps="file" accept=".json,application/json" hidden></label>';
  h += '</div></div>';
  h += '<p class="pl-desc">Clubs know you by this ID, and it lives only in this browser: back it up to keep it, or to use it on another device.</p>';
  if (idForm?.kind === 'backup') {
    h += '<form class="pl-idform" data-psform="backup">';
    h += '<p class="pl-desc">Choose a password for the backup file. You’ll need it to restore; it isn’t kept anywhere, so if you forget it the file can’t be opened.</p>';
    h += `<label>Password<input class="pl-text" type="password" name="pw" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
    h += `<label>Again<input class="pl-text" type="password" name="pw2" required minlength="${MIN_PASSWORD}" autocomplete="new-password"></label>`;
    h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Save backup</button><button class="btn-small" type="button" data-ps="cancel">Cancel</button></div></form>';
  } else if (idForm?.kind === 'restore') {
    h += '<form class="pl-idform" data-psform="restore">';
    h += `<p class="pl-desc">This backup of player ID ${esc(showId(idForm.id))} is locked. Enter its password.</p>`;
    h += '<label>Password<input class="pl-text" type="password" name="pw" required autocomplete="current-password"></label>';
    h += '<div class="pl-actions"><button class="btn-small primary" type="submit">Restore</button><button class="btn-small" type="button" data-ps="cancel">Cancel</button></div></form>';
  }
  if (note) h += `<p class="pl-desc">${esc(note)}</p>`;
  if (hasClubs()) {
    h += `<div class="pl-row"><span class="pl-label">Club hands</span><div class="pl-opts">${[100, 500, 2000].map(n => `<button class="cc-btn${keepHands() === n ? ' on' : ''}" data-ps="keep" data-n="${n}">${n}</button>`).join('')}</div><span class="pl-desc">How many of your hands to keep in each club, for your history.</span></div>`;
  }
  // Notifications (#145): only if this browser has them.
  if ('Notification' in window) {
    const denied = Notification.permission === 'denied';
    h += `<label class="pl-row ps-check"><input type="checkbox" data-ps="notify"${notifyOn() ? ' checked' : ''}${denied ? ' disabled' : ''}> Tell me when someone asks to join or for chips while this page isn’t in front</label>`;
    if (denied) h += '<p class="pl-desc">This browser blocks notifications from ducy; allow them in its site settings first.</p>';
  }
  // The relay isn't shown (#152): only the warning for a local test page
  // that's talking to the live one.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && relayUrl() === wsUrl(DEFAULT_RELAY)) h += '<p class="pl-desc pl-neterr">This local page is using the live relay. To test against a local relay, open it with <code>?relay=ws://localhost:8788</code>; links then carry it.</p>';
  el.innerHTML = h + '</div>';
}

async function onClick(e) {
  const b = e.target.closest('[data-ps]');
  if (!b) return;
  const a = b.dataset.ps;
  if (a === 'close') close();
  else if (a === 'backup') { idForm = idForm?.kind === 'backup' ? null : {kind: 'backup'}; note = ''; render(); el.querySelector('[data-psform=backup] [name=pw]')?.focus(); }
  else if (a === 'cancel') { idForm = null; render(); }
  else if (a === 'keep') { setKeepHands(Number(b.dataset.n)); render(); }
  else if (a === 'avatar') { setTableAvatar(b.dataset.id); render(); el.querySelector('.ps-av.on')?.focus(); }
}

async function onChange(e) {
  const t = e.target;
  if (t.dataset.ps === 'file' && t.files[0]) { chooseBackup(t.files[0]); t.value = ''; return; }
  if (t.dataset.ps === 'notify') {
    let on = t.checked;
    if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
    try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch {}
    render();
  }
}

function onSubmit(e) {
  const f = e.target.closest('form[data-psform]');
  if (!f) return;
  e.preventDefault();
  if (f.dataset.psform === 'name') {
    const n = f.elements.name.value.trim().slice(0, 20);
    if (!n) { note = 'Enter a name.'; render(); return; }
    setTableName(n);
    renameMember(n);
    note = 'Saved.';
    render();
    return;
  }
  const pw = f.elements.pw.value;
  if (f.dataset.psform === 'backup') {
    if (pw !== f.elements.pw2.value) { note = 'The passwords don’t match.'; render(); return; }
    backup(pw);
  } else if (idForm?.kind === 'restore') restore(idForm.text, pw);
}

// Hands the browser `text` as a file to save (JSON unless `type` says).
export function downloadFile(text, filename, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A club backup (#152) is a player ID backup with the club's code and name
// added: restoring it brings back the ID that owns the club, and the club is
// reopened here once the page has reloaded (clubs.js).
export const RESTORE_CLUB_KEY = 'ducyRestoreClub';

// Saves a backup file locked with `password`.
async function backup(password) {
  if (!me) return;
  try {
    downloadFile(await exportLockedIdentity(me, password), `ducy-identity-${showId(me.id)}.json`);
    idForm = null;
    note = 'Backup saved, locked with your password. Keep the file and the password safe: with both, anyone can play as you.';
  } catch (e) {
    note = e.message;
  }
  render();
}

// A backup file was chosen: a locked one asks for its password first.
async function chooseBackup(file) {
  const text = await file.text();
  if (backupNeedsPassword(text)) {
    let id = '';
    try { id = JSON.parse(text).id || ''; } catch {}
    idForm = {kind: 'restore', text, id};
    note = '';
    render();
    el.querySelector('[data-psform=restore] [name=pw]')?.focus();
    return;
  }
  restore(text, '');
}

async function restore(text, password) {
  try {
    const ident = await importIdentity(text, password);
    if (me && ident.id !== me.id && !confirm(`Replace player ID ${showId(me.id)} with ${showId(ident.id)}? Clubs that know ${showId(me.id)} won’t recognize this browser any more.`)) return;
    await saveIdentity(ident);
    idForm = null;
    let clubNote = '';
    try {
      const c = JSON.parse(text).club;
      if (c && typeof c.code === 'string') {
        localStorage.setItem(RESTORE_CLUB_KEY, JSON.stringify({code: c.code, name: String(c.name || '')}));
        clubNote = ` Your club ${c.name || c.code} reopens once the page has reloaded.`;
      }
    } catch {}
    note = `Restored player ID ${showId(ident.id)}.${clubNote}${password ? '' : ' That backup had no password: make a new one with Back up, and delete the old file.'} Reloading…`;
    render();
    // Every part of the page (clubs, tables) picks the restored ID up.
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    note = e.message;
    render();
  }
}

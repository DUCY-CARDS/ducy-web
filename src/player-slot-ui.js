// Player slots on staging (#671, player-slot.js): this window's slot, and
// its storage put in place before anything reads storage (main.js and
// manage.js import this first); then the switcher, a small pill at the
// bottom of the page: which player this window is, the others by name, and
// switching this window or opening a new one as any of them.
//
// Nothing here runs on the live sites, nor under a local test profile
// (profile.js, ?as=), which keeps storage of its own already.

import { profile, separateStorage } from './profile.js';
import { NAME_KEY } from './player-name.js';
import { SLOTS_KEY, SLOT_KEY, isStaging, nextSlot, pickSlot, setCurrentSlot, slotList, slotPrefix, slotDbSuffix, slotUrl, slotsAllowed } from './player-slot.js';

const host = location.hostname;
const realLocal = (() => { try { return window.localStorage; } catch { return null; } })();
const realSession = (() => { try { return window.sessionStorage; } catch { return null; } })();
const get = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const set = (s, k, v) => { try { s?.setItem(k, v); } catch {} };

const picked = !profile && slotsAllowed(host)
  ? pickSlot({host, search: location.search, saved: get(realSession, SLOT_KEY)})
  : {slot: 1, chosen: false};
export const slot = picked.slot;
setCurrentSlot(slot);

if (picked.chosen) set(realSession, SLOT_KEY, String(slot));
if (slot > 1) {
  const list = slotList(get(realLocal, SLOTS_KEY));
  if (!list.includes(slot)) set(realLocal, SLOTS_KEY, JSON.stringify([...list, slot].filter(n => n > 1)));
  separateStorage(slotPrefix(slot), slotDbSuffix(slot));
  // Windows tell apart in the taskbar; title.js keeps a "[…] " prefix.
  document.title = `[P${slot}] ${document.title}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const nameOf = n => get(realLocal, `${slotPrefix(n)}${NAME_KEY}`) || '';
const label = n => `P${n}`;

let pill = null;

function row(n, here) {
  const name = nameOf(n);
  let h = `<li${here ? ' aria-current="true"' : ''}><span class="ps-slot-who"><b>${label(n)}</b>${name ? ` ${esc(name)}` : ''}</span>`;
  if (!here) h += `<button type="button" data-slot-here="${n}">Switch</button>`;
  return `${h}<button type="button" data-slot-open="${n}" aria-label="${label(n)} in a new window">New window</button></li>`;
}

function draw() {
  if (!document.body) return;
  if (!pill) {
    pill = document.createElement('details');
    pill.className = 'ps-slot';
    pill.addEventListener('toggle', () => { if (pill.open) draw(); });
    pill.addEventListener('click', onClick);
    document.addEventListener('click', e => { if (pill.open && !pill.contains(e.target)) pill.open = false; });
    document.body.append(pill);
  }
  const list = slotList(get(realLocal, SLOTS_KEY));
  const next = nextSlot(list);
  const mine = nameOf(slot);
  let h = `<summary aria-label="Player ${slot}${mine ? `, ${esc(mine)}` : ''}"><b>${label(slot)}</b>${mine ? `<span class="ps-slot-name"> ${esc(mine)}</span>` : ''}</summary><ul>`;
  for (const n of list) h += row(n, n === slot);
  if (next) h += `<li><span class="ps-slot-who"><b>New player</b></span><button type="button" data-slot-here="${next}">Switch</button><button type="button" data-slot-open="${next}" aria-label="New player in a new window">New window</button></li>`;
  const open = pill.open;
  pill.innerHTML = `${h}</ul>`;
  pill.open = open;
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const base = `${location.origin}${location.pathname}`;
  if (b.dataset.slotHere) location.href = slotUrl(base, b.dataset.slotHere);
  else if (b.dataset.slotOpen) { window.open(slotUrl(base, b.dataset.slotOpen), '_blank', 'noopener'); pill.open = false; }
}

// On staging always; on a local page once this window chose a slot.
if (!profile && (isStaging(host) || (slotsAllowed(host) && picked.chosen))) {
  if (document.body) draw(); else addEventListener('DOMContentLoaded', draw);
  // A name changed in this window or another.
  addEventListener('focus', () => { if (!pill?.open) draw(); });
  addEventListener('hashchange', () => { if (!pill?.open) draw(); });
}

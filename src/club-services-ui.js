// The Services part of an always-on club's Settings (club-services.js):
// the outside servers allowed to give chips, adding one by its service
// line, changing its limits, and revoking it. Drawn by clubs.js.

import { showId } from './identity.js';
import { chipText, chipInput, parseChips } from './chip-format.js';
import { ago } from './time-ago.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const chips = n => esc(chipText(n));
const day = ms => new Date(ms).toISOString().slice(0, 10);

// `form`: null, 'new', or the id of the service being changed; `note`: what
// went wrong with the form.
export function servicesHtml(club, {form = null, note = ''} = {}) {
  const all = Object.values(club.services || {});
  const active = all.filter(s => s.status === 'active');
  const revoked = all.filter(s => s.status !== 'active');
  let h = '<h3>Services</h3>';
  h += '<p class="pl-desc">Servers you run, or someone you trust runs, that give members chips without you, such as a league paying its winners. Each has its own key, made on its server, and only the limits you set here.</p>';
  if (active.length) {
    h += '<ul class="cl-list cl-services">';
    for (const s of active) {
      const can = [s.perms.give && 'give', s.perms.take && 'take back', s.perms.read && 'see members'].filter(Boolean).join(', ') || 'nothing';
      h += `<li><span class="cl-name">${esc(s.name)}</span><code>${esc(showId(s.id))}</code>`;
      h += `<span class="cl-chips">${chips(s.budget)} left to give</span>`;
      const caps = [s.perGive && `${chips(s.perGive)} a give`, s.perDay && `${chips(s.perDay)} a day`].filter(Boolean).join(', ');
      h += `<span class="pl-meta">may ${esc(can)}${caps ? ` · at most ${caps}` : ''} · ${chips(serviceGivenToday(s))} given today${s.expires ? ` · until ${esc(day(s.expires))}` : ''}${s.lastUsed ? ` · last used ${esc(ago(s.lastUsed))}` : ' · not used yet'}</span>`;
      if (s.failures) h += `<span class="pl-meta pl-neterr">${s.failures} refused request${s.failures === 1 ? '' : 's'}${s.lastFailure ? `, last ${esc(ago(s.lastFailure.at))}: ${esc(s.lastFailure.reason)}` : ''}</span>`;
      h += `<span class="cl-acts"><button class="btn-small" data-cl="service-edit" data-id="${esc(s.id)}">Change</button><button class="btn-small" data-cl="service-revoke" data-id="${esc(s.id)}">Revoke</button></span>`;
      if (form === s.id) h += formHtml(s, note);
      h += '</li>';
    }
    h += '</ul>';
  }
  if (form === 'new') h += formHtml(null, note);
  else if (active.length < 10) h += '<div class="pl-actions"><button class="btn-small" data-cl="service-add">Add a service</button></div>';
  if (club.serviceRefused?.count) h += `<p class="pl-meta">${club.serviceRefused.count} request${club.serviceRefused.count === 1 ? '' : 's'} from keys that aren’t your services were refused, the last ${esc(ago(club.serviceRefused.at))}.</p>`;
  if (revoked.length) h += `<p class="pl-meta">Revoked: ${revoked.map(s => esc(s.name)).join(', ')}.</p>`;
  return h;
}

function serviceGivenToday(s) {
  const now = Date.now();
  return (s.gives || []).filter(g => now - g.at < 864e5).reduce((t, g) => t + g.amount, 0);
}

function formHtml(s, note) {
  const p = s?.perms || {give: true, take: false, read: true};
  const box = (name, label, on) => `<label class="pl-meta"><input type="checkbox" name="${name}"${on ? ' checked' : ''}> ${label}</label>`;
  let h = `<form class="pl-idform cl-service-form" data-clform="service" data-id="${esc(s?.id || '')}">`;
  if (!s) {
    h += '<p class="pl-desc">On the service’s server, run <code>node tools/ducy-service.mjs init</code> (from ducy’s code). It makes the key there and prints a service line; paste it here. Check the service ID it prints matches the one shown after you add it.</p>';
    h += '<label>Service line<input class="pl-text" name="line" required placeholder="ducy-service:1:…" autocomplete="off" spellcheck="false"></label>';
  }
  h += `<label>Name<input class="pl-text" name="name" required maxlength="40" value="${esc(s?.name || '')}" placeholder="League payouts"></label>`;
  h += `<div class="pl-row">${box('give', 'Give chips', p.give)}${box('take', 'Take chips back', p.take)}${box('read', 'See the member list', p.read)}</div>`;
  h += s ? `<label>Add to its budget<input class="pl-text" name="addBudget" inputmode="decimal" placeholder="0"></label>`
    : '<label>Budget: the most it can ever give, until you add more<input class="pl-text" name="budget" inputmode="decimal" required placeholder="10000"></label>';
  h += `<label>Most in one give (blank: no cap)<input class="pl-text" name="perGive" inputmode="decimal" value="${s?.perGive ? esc(chipInput(s.perGive)) : ''}"></label>`;
  h += `<label>Most in a day (blank: no cap)<input class="pl-text" name="perDay" inputmode="decimal" value="${s?.perDay ? esc(chipInput(s.perDay)) : ''}"></label>`;
  h += `<label>Stops working on (blank: never)<input class="pl-text" type="date" name="expires" value="${s?.expires ? esc(day(s.expires)) : ''}"></label>`;
  if (note) h += `<p class="pl-desc pl-neterr">${esc(note)}</p>`;
  h += `<div class="pl-actions"><button class="btn-small primary" type="submit">${s ? 'Save' : 'Add the service'}</button><button class="btn-small" type="button" data-cl="service-cancel">Cancel</button></div></form>`;
  return h;
}

// The form's values for service_add or service_update; throws what's wrong.
export function readServiceForm(f) {
  const amount = (name, blank = 0) => {
    const t = f.elements[name]?.value.trim() ?? '';
    if (!t) return blank;
    const n = parseChips(t);
    if (!Number.isFinite(n)) throw new Error('Amounts are numbers of chips, with at most two decimals.');
    return n;
  };
  const out = {
    name: f.elements.name.value.trim(),
    perms: {give: f.elements.give.checked, take: f.elements.take.checked, read: f.elements.read.checked},
    perGive: amount('perGive'), perDay: amount('perDay'),
    // The end of the day picked, in this browser's time.
    expires: f.elements.expires.value ? new Date(`${f.elements.expires.value}T23:59:59`).getTime() : null,
  };
  if (f.elements.line) {
    out.line = f.elements.line.value.trim();
    out.budget = amount('budget');
  } else out.addBudget = amount('addBudget');
  return out;
}

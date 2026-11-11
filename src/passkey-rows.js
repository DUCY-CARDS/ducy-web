// The passkey rows of the You page (player-settings.js, #575), in a browser
// with passkeys: restore with one while this account has none, and a first
// one to add once the relay says so (#646: no unlock, as there's nothing to
// unlock with); this account's once unlocked, each removable (a lost
// device); else Unlock.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function passkeyRows({checked = false, enrolled = false, list: keys = null, busy = false} = {}) {
  const dis = busy ? ' disabled' : '';
  let h = '';
  if (!enrolled) {
    h += `<div class="ps-row"><span>Restore with a passkey</span><button type="button" class="ps-val" data-ps="pk-recover"${dis}>Sign in</button></div>`;
    if (checked) h += `<div class="ps-row"><span>Passkeys</span><button type="button" class="ps-val" data-ps="pk-first"${dis}>Add</button></div>`;
    return h;
  }
  if (!keys) return `<div class="ps-row"><span>Passkeys</span><button type="button" class="ps-val" data-ps="pk-show"${dis}>Unlock</button></div>`;
  h += `<div class="ps-row"><span>Passkeys</span><button type="button" class="ps-val" data-ps="pk-add"${dis}>Add</button></div><ul class="ps-keys">`;
  for (const c of keys) {
    h += `<li><span>${esc(c.name)}${c.current ? ' <span class="pl-meta">(this one)</span>' : ''}<span class="pl-meta"> · added ${esc(new Date(c.at).toLocaleDateString())}</span></span>`;
    if (keys.length > 1) h += `<button type="button" class="link-btn" data-ps="pk-remove" data-id="${esc(c.credId)}"${dis}>Remove</button>`;
    h += '</li>';
  }
  return h + '</ul>';
}

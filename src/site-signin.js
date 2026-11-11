// The first visit to one of ducy's subdomain sites (club.ducy.cards, #637;
// quest, odds and training to come), which have browser storage of their
// own: before anything makes a new player ID there, the player signs in
// with their passkey, which brings their player ID over from ducy.cards
// (passkey.js recover: the relay's copy, opened with the passkey's PRF).
// The relay never vouches here, so opening another site never moves
// anyone's clubs to a new ID. Someone new to ducy goes on with a new one.
//
//   await firstVisit(root)   resolves once the page may load the identity:
//                            at once on the player app, a local page, or
//                            once this site has an identity
import { hasIdentity } from './identity.js';
import * as pk from './passkey.js';
import { isSubsite } from './sites.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Whether the page at `host` asks first: a subdomain site with no identity
// yet, in a browser with passkeys.
export async function asksFirst({host = location.hostname, has = hasIdentity, supported = pk.supported} = {}) {
  if (!isSubsite(host) || !supported()) return false;
  return !(await has().catch(() => false));
}

export function signInHtml(note = '', busy = false) {
  const dis = busy ? ' disabled' : '';
  let h = '<section class="cl-card site-signin"><h1>Sign in</h1>';
  h += `<div class="pl-actions"><button class="tr-start" data-signin="passkey"${dis}>Use your passkey</button>`;
  h += `<button class="link-btn" data-signin="new"${dis}>I’m new to ducy</button></div>`;
  if (note) h += `<p class="pl-desc pl-neterr" role="alert">${esc(note)}</p>`;
  return h + '</section>';
}

export async function firstVisit(root) {
  if (!(await asksFirst())) return;
  pk.prepare().catch(() => {});
  await new Promise(resolve => {
    let busy = false;
    const draw = (note = '') => { root.innerHTML = signInHtml(note, busy); };
    draw();
    root.addEventListener('click', async function onClick(e) {
      const b = e.target.closest('[data-signin]');
      if (!b || busy) return;
      if (b.dataset.signin === 'new') { root.removeEventListener('click', onClick); resolve(); return; }
      busy = true;
      draw();
      try {
        await pk.recover({vouch: false});
        root.removeEventListener('click', onClick);
        resolve();
      } catch (err) {
        busy = false;
        draw(err?.message || String(err));
      }
    });
  });
  root.innerHTML = '';
}

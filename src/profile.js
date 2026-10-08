// Local test profiles (#146): `?as=<name>` makes this page a separate player,
// with its own identity, clubs, tables and settings, so one browser can be a
// host and several players at once (see sim.html). Only on localhost; with no
// profile, nothing here changes how the page stores things.
//
// It works by giving this page profile-named storage before any other module
// runs (main.js imports it first): localStorage and sessionStorage keys get a
// `<name>:` prefix, IndexedDB databases a `@<name>` suffix, and `storage`
// events from other tabs are passed on only for this profile's keys, with the
// prefix taken off. The name lasts for the tab (window.name), so it survives
// reloads and links that drop the query string. The same profile is the same
// player every time.

const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];
const NAME = /^[a-z0-9_-]{1,24}$/i;
const TAB = 'ducy-as:';

function chosen() {
  if (!LOCAL.includes(location.hostname)) return null;
  const q = new URLSearchParams(location.search).get('as');
  if (q === '') { window.name = ''; return null; } // ?as= clears it
  const fromTab = window.name.startsWith(TAB) ? window.name.slice(TAB.length) : null;
  const name = q || fromTab;
  return name && NAME.test(name) ? name : null;
}

// A Storage whose keys are this profile's, kept in `real` under a prefix.
function prefixed(real, prefix) {
  const own = () => {
    const keys = [];
    for (let i = 0; i < real.length; i++) {
      const k = real.key(i);
      if (k.startsWith(prefix)) keys.push(k.slice(prefix.length));
    }
    return keys;
  };
  return {
    getItem: k => real.getItem(prefix + k),
    setItem: (k, v) => real.setItem(prefix + k, v),
    removeItem: k => real.removeItem(prefix + k),
    key: i => own()[i] ?? null,
    get length() { return own().length; },
    clear: () => { for (const k of own()) real.removeItem(prefix + k); },
  };
}

export const profile = chosen();

if (profile) {
  window.name = TAB + profile;
  const prefix = `${profile}:`;
  const realLocal = window.localStorage;
  const local = prefixed(realLocal, prefix);
  Object.defineProperty(window, 'localStorage', {value: local, configurable: true});
  Object.defineProperty(window, 'sessionStorage', {value: prefixed(window.sessionStorage, prefix), configurable: true});

  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name, ...rest) {
    return open.call(this, `${name}@${profile}`, ...rest);
  };

  const add = window.addEventListener;
  const wrapped = new WeakMap();
  window.addEventListener = function (type, fn, opts) {
    if (type !== 'storage' || typeof fn !== 'function') return add.call(this, type, fn, opts);
    const inner = e => {
      if (e.storageArea !== realLocal || !e.key?.startsWith(prefix)) return;
      fn({key: e.key.slice(prefix.length), oldValue: e.oldValue, newValue: e.newValue, storageArea: local, url: e.url});
    };
    wrapped.set(fn, inner);
    return add.call(this, type, inner, opts);
  };
  const remove = window.removeEventListener;
  window.removeEventListener = function (type, fn, opts) {
    return remove.call(this, type, (type === 'storage' && wrapped.get(fn)) || fn, opts);
  };

  document.title = `[${profile}] ${document.title}`;
  const badge = () => {
    const b = document.createElement('div');
    b.className = 'profile-badge';
    b.textContent = `as ${profile}`;
    b.title = 'Local test profile (?as=). Open the page without ?as= to be yourself again.';
    document.body.append(b);
  };
  if (document.body) badge(); else addEventListener('DOMContentLoaded', badge);
}

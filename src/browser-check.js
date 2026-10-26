// The update screen (#442). A classic script that runs first on every page:
// if this browser lacks something the site needs (Safari 15.4 or later, or
// the like), it shows "Update your browser" instead of a blank page. It
// detects features, not browser names, and is written in old JavaScript
// (ES5) so that it runs where the site's modules can't. On a new browser it
// only does the checks below.
(function (g) {
  'use strict';
  var doc = g.document;
  var arr = g.Array && g.Array.prototype;
  var script = g.HTMLScriptElement && g.HTMLScriptElement.prototype;
  var ok = typeof g.WebAssembly === 'object' && typeof g.WebAssembly.instantiate === 'function'
    && !!arr && typeof arr.at === 'function' && typeof arr.findLast === 'function'
    && typeof g.structuredClone === 'function'
    && !!script && 'noModule' in script;
  if (ok) return;

  // Style.css (and admin.css) hide everything else on the page, including
  // whatever the site's modules manage to draw.
  doc.documentElement.className += ' browser-old';
  function show() {
    var body = doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.className = '';
    var box = doc.createElement('div');
    box.className = 'browser-update';
    var h = doc.createElement('h1');
    h.textContent = 'Update your browser to use ducy';
    var p = doc.createElement('p');
    p.textContent = 'On iPhone or iPad: Settings → General → Software Update.';
    box.appendChild(h);
    box.appendChild(p);
    body.appendChild(box);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', show);
  else show();
})(this);

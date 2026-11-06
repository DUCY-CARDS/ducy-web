// Numbers picked from a few buttons, with Other for any (#544): the
// tournament wizard's buy-in, rake, stack and players, a promotion's prize
// and a member's credit limit. The buttons are radios named `${name}Pick`;
// Other shows the box (named `name`) beside them, which is read instead.
// The table form's blinds and seats work the same way, with a list.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

// The buttons for `list` (values), `value` picked (Other when it isn't one
// of them, or `other`), each labelled `text(v)`, then the Other box `box`
// (its HTML). `tile`: the wizard's tiles, else the table form's buttons.
export function pickHtml(name, list, value, text, box, {other = false, tile = false} = {}) {
  const isOther = other || !list.includes(value);
  const btn = (v, label, on) => (tile
    ? `<label class="tw-tile"><input type="radio" name="${name}Pick" value="${v}"${on ? ' checked' : ''}><span class="tw-tile-name">${label}</span></label>`
    : `<label class="cc-btn tf-opt"><input type="radio" name="${name}Pick" value="${v}"${on ? ' checked' : ''}>${label}</label>`);
  let h = list.map(v => btn(esc(v), esc(text(v)), !isOther && v === value)).join('') + btn('other', 'Other', isOther);
  return h + `<span class="pick-other" data-other="${name}"${isOther ? '' : ' hidden'}>${box}</span>`;
}

// What form elements `el` (a form's .elements) have picked for `name`: a
// button's value, or under Other the box's, read by `parse` (its text).
export function readPick(el, name, parse = Number) {
  const p = el[`${name}Pick`]?.value;
  return p && p !== 'other' ? Number(p) : parse(el[name]?.value ?? '');
}

// Whether Other is picked for `name`.
export const pickedOther = (el, name) => el[`${name}Pick`]?.value === 'other';

// Shows each Other box in `root` while its Other is picked (after a click,
// or a redraw that put back what was picked).
export function syncPicks(root) {
  for (const box of root.querySelectorAll('[data-other]')) {
    const f = box.closest('form');
    const on = !!f && pickedOther(f.elements, box.dataset.other);
    if (box.hidden === on) box.hidden = !on;
  }
}

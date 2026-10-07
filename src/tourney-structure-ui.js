// The blind structure editor (#78), for the tournament form (#77): pick a
// preset, edit any level, add or remove levels and breaks, and see about how
// long the tournament will take for a few field sizes.
//
//   const ed = structureEditor({stack: 10000, tableSize: 9, onChange});
//   el.innerHTML = ed.html();          // and again after each change
//   el.addEventListener('click', e => ed.click(e) && rerender());
//   el.addEventListener('change', e => ed.input(e) && rerender());
//   ed.steps()  the structure; ed.errors()  what's wrong with it, if anything
//
// The page re-renders on 'change' (not 'input'), so typing isn't interrupted.

import { PRESETS, checkStructure, durationText, estimate, presetStructure } from './tourney-structure.js';

export const FIELD_SIZES = [6, 9, 18, 27, 45];

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const num = n => Number(n).toLocaleString('en-US');

export function structureEditor({stack, tableSize = 9, preset = 'regular', onChange = () => {}}) {
  let steps = presetStructure(preset, stack);
  let chosen = preset;

  const changed = () => { onChange(steps); return true; };

  function html() {
    let h = '<div class="ts-editor">';
    h += '<div class="pl-row"><span class="pl-label">Blinds</span><div class="pl-opts">';
    h += PRESETS.map(p => `<button type="button" class="cc-btn${chosen === p.id ? ' on' : ''}" data-ts="preset" data-preset="${p.id}">${esc(p.label)}</button>`).join('');
    h += '</div></div>';
    h += '<table class="ts-levels"><thead><tr><th>Level</th><th>Small blind</th><th>Big blind</th><th>Ante</th><th>Minutes</th><th></th></tr></thead><tbody>';
    let level = 0;
    steps.forEach((s, i) => {
      const field = (k, label) => `<td><input class="pl-text" type="number" min="${k === 'ante' ? 0 : 1}" step="1" inputmode="numeric" aria-label="${label}" data-ts-i="${i}" data-ts-k="${k}" value="${s[k]}"></td>`;
      const remove = `<td><button type="button" class="btn-small" data-ts="remove" data-i="${i}" aria-label="Remove">✕</button></td>`;
      if (s.break) {
        h += `<tr class="ts-break"><td colspan="4">Break</td>${field('minutes', 'Break minutes')}${remove}</tr>`;
      } else {
        level++;
        h += `<tr><td>${level}</td>${field('sb', 'Small blind')}${field('bb', 'Big blind')}${field('ante', 'Ante')}${field('minutes', 'Minutes')}${remove}</tr>`;
      }
    });
    h += '</tbody></table>';
    h += '<div class="pl-actions"><button type="button" class="btn-small" data-ts="add-level">Add level</button><button type="button" class="btn-small" data-ts="add-break">Add break</button></div>';
    const errs = errors();
    if (errs.length) {
      h += `<ul class="ts-errors">${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
    } else {
      h += '<div class="ts-estimate"><span class="pl-label">About how long</span><table><tbody>';
      for (const n of FIELD_SIZES) {
        const e = estimate(steps, {stack, players: n, tableSize});
        h += `<tr><td>${n} players</td><td>${durationText(e.minutes)}</td><td class="pl-desc">ends in level ${e.level}</td></tr>`;
      }
      h += `</tbody></table><span class="pl-desc">Starting stack ${num(stack)}, ${tableSize} a table, about 30 hands an hour, breaks included.</span></div>`;
    }
    return h + '</div>';
  }

  function errors() { return checkStructure(steps); }

  // A click in the editor: true when the structure changed.
  function click(e) {
    const b = e.target.closest('[data-ts]');
    if (!b) return false;
    const i = Number(b.dataset.i);
    switch (b.dataset.ts) {
      case 'preset':
        chosen = b.dataset.preset;
        steps = presetStructure(chosen, stack);
        return changed();
      case 'remove':
        steps.splice(i, 1);
        chosen = null;
        return changed();
      case 'add-level': {
        // Half again the last level, as a start.
        const last = steps.filter(s => !s.break).at(-1) || {bb: 2, ante: 0, minutes: 15};
        const bb = Math.ceil(last.bb * 1.5);
        steps.push({sb: Math.floor(bb / 2), bb, ante: last.ante ? Math.ceil(last.ante * 1.5) : 0, minutes: last.minutes});
        chosen = null;
        return changed();
      }
      case 'add-break':
        steps.push({break: true, minutes: 10});
        chosen = null;
        return changed();
    }
    return false;
  }

  // A field edited: true when the structure changed.
  function input(e) {
    const el = e.target.closest('[data-ts-k]');
    if (!el) return false;
    const s = steps[Number(el.dataset.tsI)];
    if (!s) return false;
    s[el.dataset.tsK] = el.value === '' ? NaN : Number(el.value);
    chosen = null;
    return changed();
  }

  // The starting stack changed: the chosen preset follows it; an edited
  // structure is kept as it is.
  function setStack(n) {
    stack = n;
    if (chosen) steps = presetStructure(chosen, stack);
    return changed();
  }

  return {html, errors, click, input, setStack, steps: () => steps.map(s => ({...s}))};
}

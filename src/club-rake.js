// What a club takes from each hand at its cash tables (#449): rake (a share
// of each pot, with a cap, and no rake on hands that end before the flop)
// or time (a fixed charge from each player dealt in). Set per table when
// it's opened (the New table form's More options); ducy's engine takes it
// from each hand (club-host.js), and the club books each player's share
// (ducy-club's rake.rs). Here: the form's fields, what members are told,
// and each player's contributions for the owner and for agents.
//
// A table keeps it as `charge`: {percent (hundredths of a percent), cap
// (hundredths of a chip; 0: none), noFlop, time (hundredths)}. The form and
// new_table send it as {rake: {percent, cap, noFlop}} or {time}.

import { chipText } from './chip-format.js';
import { OFF } from './club-beta.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Rake choices, in hundredths of a percent; the cap and time, in big blinds.
export const RAKE_PCTS = [250, 300, 400, 500, 600, 750, 1000];
export const CAP_BBS = [1, 2, 3, 4, 5, 0];
export const TIME_BBS = [0.25, 0.5, 1];
// The defaults: 5%, capped at 3 big blinds, no flop no drop; time half a big blind.
export const DEFAULTS = {percent: 500, capBB: 3, noFlop: true, timeBB: 0.5};

export const pctText = p => `${Number(p) / 100}%`;
const bbText = n => (n === 0.25 ? '¼' : n === 0.5 ? '½' : String(n));
const option = (v, on, text) => `<option value="${v}"${v === on ? ' selected' : ''}>${esc(text)}</option>`;

// Whether the manager can set one: on in the beta, or the club has one already.
export const chargeOn = club => !OFF.has('rake') || (club?.tables || []).some(t => t.charge);

// The form's fields: House (none, rake, time), and each one's settings,
// shown for the one picked. `last`: the last table's, as the form saved it.
export function chargeFieldsHtml(last = {}) {
  const kind = ['rake', 'time'].includes(last.house) ? last.house : 'none';
  const pct = RAKE_PCTS.includes(last.percent) ? last.percent : DEFAULTS.percent;
  const cap = CAP_BBS.includes(last.capBB) ? last.capBB : DEFAULTS.capBB;
  const time = TIME_BBS.includes(last.timeBB) ? last.timeBB : DEFAULTS.timeBB;
  let h = `<label>House<select class="pl-text" name="house">${option('none', kind, 'None')}${option('rake', kind, 'Rake')}${option('time', kind, 'Time')}</select></label>`;
  h += `<label class="tf-rake"${kind === 'rake' ? '' : ' hidden'}>Rake<select class="pl-text" name="rakePct">${RAKE_PCTS.map(p => option(p, pct, pctText(p))).join('')}</select></label>`;
  h += `<label class="tf-rake"${kind === 'rake' ? '' : ' hidden'}>Cap<select class="pl-text" name="rakeCap">${CAP_BBS.map(n => option(n, cap, n ? `${n} BB` : 'None')).join('')}</select></label>`;
  h += `<label class="tf-rake tf-check"${kind === 'rake' ? '' : ' hidden'}><input type="checkbox" name="noFlop"${last.noFlop === false ? '' : ' checked'}> No flop, no drop</label>`;
  h += `<label class="tf-time"${kind === 'time' ? '' : ' hidden'}>Time<select class="pl-text" name="timeBB">${TIME_BBS.map(n => option(n, time, `${bbText(n)} BB a hand`)).join('')}</select></label>`;
  return h;
}

// Shows the settings for the house's pick.
export function syncChargeFields(f) {
  const kind = f.elements.house?.value;
  if (!kind) return;
  for (const el of f.querySelectorAll('.tf-rake')) el.hidden = kind !== 'rake';
  for (const el of f.querySelectorAll('.tf-time')) el.hidden = kind !== 'time';
}

// What the form picked, for new_table at big blind `bb`: {rake}, {time} or
// {}; and what to remember for next time.
export function readCharge(f, bb) {
  const kind = f.elements.house?.value || 'none';
  const percent = Number(f.elements.rakePct?.value || DEFAULTS.percent);
  const capBB = Number(f.elements.rakeCap?.value ?? DEFAULTS.capBB);
  const noFlop = !!f.elements.noFlop?.checked;
  const timeBB = Number(f.elements.timeBB?.value || DEFAULTS.timeBB);
  const last = {house: kind, percent, capBB, noFlop, timeBB};
  if (kind === 'rake') return {spec: {rake: {percent, cap: Math.round(capBB * bb), noFlop}}, last};
  if (kind === 'time') return {spec: {time: Math.max(1, Math.round(timeBB * bb))}, last};
  return {spec: {}, last};
}

// A table's `charge` as new_table takes it: {rake} or {time}, or {}.
export function chargeSpec(c) {
  if (Number(c?.percent) > 0) return {rake: {percent: c.percent, cap: c.cap || 0, noFlop: !!c.noFlop}};
  if (Number(c?.time) > 0) return {time: c.time};
  return {};
}

// A table's charge, from what members are told ({rake, time}) or the
// table itself ({charge}), in a few words: "Rake 5% · cap 6 · no flop, no
// drop", "Time 1 a hand", or ''.
export function chargeText(t) {
  const c = t?.charge || {...(t?.rake || {}), time: t?.time};
  if (Number(c.percent) > 0) {
    return [`Rake ${pctText(c.percent)}`, Number(c.cap) > 0 ? `cap ${chipText(c.cap)}` : '', c.noFlop ? 'no flop, no drop' : ''].filter(Boolean).join(' · ');
  }
  if (Number(c.time) > 0) return `Time ${chipText(c.time)} a hand`;
  return '';
}

// Each player's contributions (ducy-club's contributions: {players, agents,
// totals}) as the owner sees them, or an agent theirs (`agent`).
export function contributionsHtml(c, {agent = false, link = null} = {}) {
  if (!c?.players?.length) return '';
  const row = (name, r, cls = '') => `<tr${cls}><th>${name}</th><td>${chipText(r.today)}</td><td>${chipText(r.week)}</td><td>${chipText(r.all)}</td></tr>`;
  const head = first => `<thead><tr><th>${first}</th><th>Today</th><th>7 days</th><th>All time</th></tr></thead>`;
  let h = `<section class="cl-rake"><h2>Rake and time</h2><table class="cl-acct cl-rake-table">${head(agent ? 'Your players' : 'Player')}<tbody>`;
  h += row('Total', c.totals, ' class="cl-acct-sum"');
  for (const p of c.players) h += row(link ? `<a href="${esc(link(p.id))}">${esc(p.name)}</a>` : esc(p.name), p);
  h += '</tbody></table>';
  if (!agent && c.agents?.length) {
    h += `<table class="cl-acct cl-rake-table">${head('Agent')}<tbody>`;
    for (const a of c.agents) h += row(esc(a.name), a);
    h += '</tbody></table>';
  }
  return h + '</section>';
}

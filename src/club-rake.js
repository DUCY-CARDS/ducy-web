// What a club takes from each hand at its cash tables (#449): rake (a share
// of each pot, maybe capped; never from a hand that ends before the flop)
// or time (a fixed charge from each player dealt in, 0.05 to 0.25 of a big
// blind). The club sets a default on Rules (none to start); each new table
// takes it unless the New table form sets its own (More options). Ducy's
// engine takes it from each hand (club-host.js), and the club books each
// player's share (ducy-club's rake.rs). Here: the fields, what members and
// the owner are told, and each player's contributions.
//
// Kept as `charge`, on the club and each table: {percent (hundredths of a
// percent), capBB and timeBB (hundredths of a big blind; capBB 0: no cap)}.

import { chipText } from './chip-format.js';
import { OFF } from './club-beta.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// The limits: rake above 0% and at most 10%; time 0.05 to 0.25 BB a hand.
export const MAX_PCT = 10;
export const MIN_TIME_BB = 0.05;
export const MAX_TIME_BB = 0.25;
export const MAX_CAP_BB = 1000;

// "4.5", "3", "0.25": hundredths shown without trailing zeros.
const plain = n => String(Math.round(Number(n)) / 100);

// Whether the manager can set one: on in the beta, or the club has one already.
export const chargeOn = club => !OFF.has('cashRake') || !!club?.charge || (club?.tables || []).some(t => t.charge);

// The fields: House (none, rake, time), and the settings of the one picked:
// rake % and its cap in BB, or time in BB. `c`: the charge they start with.
export function chargeFieldsHtml(c = null) {
  const kind = Number(c?.percent) > 0 ? 'rake' : Number(c?.timeBB) > 0 ? 'time' : 'none';
  const opt = (v, text) => `<option value="${v}"${v === kind ? ' selected' : ''}>${text}</option>`;
  const num = (name, value, attrs) => `<input class="pl-text" type="number" inputmode="decimal" name="${name}" value="${value}" ${attrs}>`;
  let h = `<label>House<select class="pl-text" name="house">${opt('none', 'None')}${opt('rake', 'Rake')}${opt('time', 'Time')}</select></label>`;
  // The limits are checked when it's saved (readCharge), and said in words.
  h += `<label class="tf-rake"${kind === 'rake' ? '' : ' hidden'}>Rake %${num('rakePct', kind === 'rake' ? plain(c.percent) : '', 'step="any"')}</label>`;
  h += `<label class="tf-rake"${kind === 'rake' ? '' : ' hidden'}>Cap (BB)${num('rakeCap', kind === 'rake' && c.capBB ? plain(c.capBB) : '', 'step="any" placeholder="None"')}</label>`;
  h += `<label class="tf-time"${kind === 'time' ? '' : ' hidden'}>Time (BB a hand)${num('timeBB', kind === 'time' ? plain(c.timeBB) : '', 'step="any"')}</label>`;
  return h;
}

// Shows the settings for the house's pick.
export function syncChargeFields(f) {
  const kind = f.elements.house?.value;
  if (!kind) return;
  for (const el of f.querySelectorAll('.tf-rake')) el.hidden = kind !== 'rake';
  for (const el of f.querySelectorAll('.tf-time')) el.hidden = kind !== 'time';
}

// What the fields say: {charge} ({percent, capBB, timeBB}, or null for
// none), or {error} in words.
export function readCharge(f) {
  const kind = f.elements.house?.value || 'none';
  const hundredths = v => Math.round(Number(v) * 100);
  const val = name => String(f.elements[name]?.value ?? '').trim();
  if (kind === 'rake') {
    const pct = Number(val('rakePct'));
    if (!val('rakePct') || !Number.isFinite(pct) || pct <= 0 || pct > MAX_PCT) return {error: `Rake is more than 0% and at most ${MAX_PCT}%.`};
    const cap = val('rakeCap') ? Number(val('rakeCap')) : 0;
    if (!Number.isFinite(cap) || cap < 0 || cap > MAX_CAP_BB) return {error: 'The cap is a number of big blinds, or empty for none.'};
    return {charge: {percent: hundredths(pct), capBB: hundredths(cap), timeBB: 0}};
  }
  if (kind === 'time') {
    const t = Number(val('timeBB'));
    if (!val('timeBB') || !Number.isFinite(t) || t < MIN_TIME_BB || t > MAX_TIME_BB) return {error: 'Time is 0.05 to 0.25 of a big blind a hand.'};
    return {charge: {percent: 0, capBB: 0, timeBB: hundredths(t)}};
  }
  return {charge: null};
}

// A charge in a few words: "Rake 5% · cap 3 BB", "Rake 4.5%",
// "Time 0.25 BB a hand", or ''. `t`: a table (or the club) with `charge`.
export function chargeText(t) {
  const c = t?.charge || {};
  if (Number(c.percent) > 0) return [`Rake ${plain(c.percent)}%`, Number(c.capBB) > 0 ? `cap ${plain(c.capBB)} BB` : ''].filter(Boolean).join(' · ');
  if (Number(c.timeBB) > 0) return `Time ${plain(c.timeBB)} BB a hand`;
  return '';
}

// The club's default on Rules: the fields and Save.
export function clubChargeHtml(club, note = '') {
  let h = '<form class="cl-chargeform tf" data-chargeform="1"><div class="pl-row"><span class="pl-label">Rake</span><span class="pl-meta cl-charge">';
  h += `${esc(chargeText(club) || 'No rake')}</span></div><div class="tf-fields">${chargeFieldsHtml(club?.charge)}</div>`;
  if (note) h += `<p class="pl-desc pl-neterr">${esc(note)}</p>`;
  return h + '<div class="cl-formacts"><button class="btn-small primary" type="submit">Save</button></div></form>';
}

// Each player's contributions (ducy-club's contributions: {players, agents,
// totals}) as the owner sees them. (An agent sees theirs on their Play
// table, club-players.js.)
export function contributionsHtml(c, {link = null} = {}) {
  if (!c?.players?.length) return '';
  const row = (name, r, cls = '') => `<tr${cls}><th>${name}</th><td>${chipText(r.today)}</td><td>${chipText(r.week)}</td><td>${chipText(r.all)}</td></tr>`;
  const head = first => `<thead><tr><th>${first}</th><th>Today</th><th>7 days</th><th>All time</th></tr></thead>`;
  let h = `<section class="cl-rake"><h2>Rake and time</h2><table class="cl-acct cl-rake-table">${head('Player')}<tbody>`;
  h += row('Total', c.totals, ' class="cl-acct-sum"');
  for (const p of c.players) h += row(link ? `<a href="${esc(link(p.id))}">${esc(p.name)}</a>` : esc(p.name), p);
  h += '</tbody></table>';
  if (c.agents?.length) {
    h += `<table class="cl-acct cl-rake-table">${head('Agent')}<tbody>`;
    for (const a of c.agents) h += row(esc(a.name), a);
    h += '</tbody></table>';
  }
  return h + '</section>';
}

// Players (#661): each player's play, so the owner can see who is good for
// the games. One row each: their agent, cash hands dealt in, won or lost at
// cash tables (after the rake), rake and time paid, both per 100 hands,
// tournaments won or lost, and when they last played. Today, 7 days, 30
// days or all time; sorted by any column; filtered by agent; exported as
// CSV. An agent sees the same for their own players (their club page).
//
// The numbers are the club's (ducy-club's players.rs, by club day, kept with
// the rake book): totals only, nothing from inside a hand.

import { chipInput, chipText } from './chip-format.js';
import { view } from './club-money.js';
import { ago } from './time-ago.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// The club's report at `now` (ducy-club's players_report): {players: [{id,
// name, agent, last, today, week, month, all}], agents: [{id, name}]}, each
// period {hands, net, rake, tourney}; with `agent`, theirs only.
export const playersReport = (club, agent = null, now = Date.now()) => view(club, 'players', {now, ...(agent ? {agent} : {})});

export const PERIODS = [['today', 'Today'], ['week', '7 days'], ['month', '30 days'], ['all', 'All']];

// What's picked: the period, the column sorted by and its direction (-1:
// high to low), and the agent ('' everyone, 'club' none, or an agent's id).
export const picked = {period: 'month', sort: 'hands', dir: -1, agent: ''};

// Chips per 100 hands, or null without hands.
export const per100 = (n, hands) => (hands > 0 ? Math.round((n * 100) / hands) : null);

// The columns: key, heading, and the value to sort by.
const COLUMNS = [
  ['name', 'Player', r => r.name.toLowerCase()],
  ['agent', 'Agent', r => r.agentName.toLowerCase()],
  ['hands', 'Hands', r => r.p.hands],
  ['net', 'Won', r => r.p.net],
  ['net100', 'Won/100', r => per100(r.p.net, r.p.hands)],
  ['rake', 'Rake', r => r.p.rake],
  ['rake100', 'Rake/100', r => per100(r.p.rake, r.p.hands)],
  ['tourney', 'Tournaments', r => r.p.tourney],
  ['last', 'Last played', r => r.last],
];

// The report's rows for what's picked: in the period, with anything in it;
// under the agent picked; sorted. Each {id, name, agent, agentName, last, p}
// (p: the period's numbers).
export function shownRows(report, {period, sort, dir, agent} = picked) {
  const names = Object.fromEntries((report?.agents || []).map(a => [a.id, a.name]));
  const rows = (report?.players || [])
    .map(r => ({...r, agentName: r.agent ? names[r.agent] || '' : 'Club', p: r[period] || {hands: 0, net: 0, rake: 0, tourney: 0}}))
    .filter(r => r.p.hands || r.p.net || r.p.rake || r.p.tourney)
    .filter(r => !agent || (agent === 'club' ? !r.agent : r.agent === agent));
  const key = (COLUMNS.find(c => c[0] === sort) || COLUMNS[2])[2];
  // Nothing to compare (per 100 without hands) goes last either way.
  return rows.sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
  });
}

// Whether the report has agents to show (the owner's, with any).
const withAgents = report => !!report?.agents?.length;
// Whether anyone has played a tournament.
const withTourneys = report => (report?.players || []).some(r => r.all?.tourney);

const signed = n => `<span class="${n > 0 ? 'cl-up' : n < 0 ? 'cl-down' : ''}">${n > 0 ? '+' : ''}${chipText(n)}</span>`;

// The last report drawn, for Export CSV.
let last = null;

// The page: the period, the agent filter and Export CSV, then the table.
// `link`: a player's page address, for the owner.
export function playersPageHtml(report, {link = null, now = Date.now()} = {}) {
  last = report;
  if (!report?.players?.length) return '<p class="pl-meta cl-empty">No play yet.</p>';
  const p = picked;
  let h = '<div class="mg-filters pp-tools">';
  h += `<div class="pp-periods" role="group" aria-label="Period">${PERIODS.map(([k, t]) => `<button class="cc-btn${k === p.period ? ' on' : ''}" data-pp-period="${k}" aria-pressed="${k === p.period}">${t}</button>`).join('')}</div>`;
  if (withAgents(report)) {
    const opt = (v, t) => `<option value="${esc(v)}"${v === p.agent ? ' selected' : ''}>${esc(t)}</option>`;
    h += `<select class="pl-text mg-agent-pick${p.agent ? ' on' : ''}" data-pp-agent="1" aria-label="Agent">${opt('', 'All agents')}${opt('club', 'Club')}${report.agents.map(a => opt(a.id, a.name)).join('')}</select>`;
  }
  h += '<button class="btn-small" data-pp-csv="1">Export CSV</button></div>';
  const rows = shownRows(report);
  if (!rows.length) return h + '<p class="pl-meta cl-empty">No one played.</p>';
  const cols = COLUMNS.filter(([k]) => (k !== 'agent' || withAgents(report)) && (k !== 'tourney' || withTourneys(report)));
  h += '<div class="pp-wrap"><table class="cl-acct pp-table"><thead><tr>';
  for (const [k, t] of cols) {
    const on = k === p.sort;
    const sort = on ? (p.dir < 0 ? 'descending' : 'ascending') : 'none';
    h += `<th aria-sort="${sort}"><button class="pp-sort${on ? ' on' : ''}" data-pp-sort="${k}">${t}${on ? (p.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`;
  }
  h += '</tr></thead><tbody>';
  const cell = {
    name: r => `<th>${link ? `<a href="${esc(link(r.id))}">${esc(r.name)}</a>` : esc(r.name)}</th>`,
    agent: r => `<td class="pp-text">${esc(r.agentName)}</td>`,
    hands: r => `<td>${r.p.hands.toLocaleString()}</td>`,
    net: r => `<td>${signed(r.p.net)}</td>`,
    net100: r => `<td>${r.p.hands ? signed(per100(r.p.net, r.p.hands)) : '–'}</td>`,
    rake: r => `<td>${chipText(r.p.rake)}</td>`,
    rake100: r => `<td>${r.p.hands ? chipText(per100(r.p.rake, r.p.hands)) : '–'}</td>`,
    tourney: r => `<td>${signed(r.p.tourney)}</td>`,
    last: r => `<td class="pp-text">${r.last ? esc(ago(r.last, now)) : '–'}</td>`,
  };
  for (const r of rows) h += `<tr>${cols.map(([k]) => cell[k](r)).join('')}</tr>`;
  return h + '</tbody></table></div>';
}

// The rows shown as CSV: amounts in chips, per 100 empty without hands.
export function playersCsv(report, at = picked) {
  const q = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [['player', 'agent', 'hands', 'won', 'won per 100', 'rake', 'rake per 100', 'tournaments', 'last played']];
  for (const r of shownRows(report, at)) {
    const p100 = n => (r.p.hands ? chipInput(per100(n, r.p.hands)) : '');
    out.push([r.name, r.agentName, r.p.hands, chipInput(r.p.net), p100(r.p.net), chipInput(r.p.rake), p100(r.p.rake), chipInput(r.p.tourney), r.last ? new Date(r.last).toISOString() : '']);
  }
  return out.map(r => r.map(q).join(',')).join('\n') + '\n';
}

// A click or change on the page: a period, a column, an agent or Export
// CSV. Whether to draw the page again, or 'csv' to export.
export function playersEvent(e) {
  const t = e.target;
  if (e.type === 'change') {
    if (!t.dataset?.ppAgent) return false;
    picked.agent = t.value;
    return true;
  }
  const b = t.closest?.('[data-pp-period], [data-pp-sort], [data-pp-csv]');
  if (!b) return false;
  if (b.dataset.ppPeriod) picked.period = b.dataset.ppPeriod;
  else if (b.dataset.ppSort) {
    const k = b.dataset.ppSort;
    // The same column again turns it round; names start A to Z, numbers high to low.
    picked.dir = k === picked.sort ? -picked.dir : k === 'name' || k === 'agent' ? 1 : -1;
    picked.sort = k;
  } else return 'csv';
  return true;
}

// Export CSV's file: {text, name} of the last report drawn, as picked.
export function playersCsvFile() {
  const name = PERIODS.find(([k]) => k === picked.period)[1].toLowerCase().replace(/\s+/g, '-');
  return {text: playersCsv(last), name: `ducy-players-${name}.csv`};
}

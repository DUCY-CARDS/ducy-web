// Club info (#398): what the managers write for members, in a few fixed
// sections, each optional. Kept with the club (club.info) and sent to
// members like the tables ({type: 'info', club, info}); About the club also
// shows on the invite screen (relay/src/club-room.js codeInfo). The host's
// checks are ducy-play's club rules (club-rules.js); here, a member's copy,
// the safe formatting and what changed.
//
//   info: {about, chips, rules: text; events: [{at, text}]; at: {section: when it last changed}}
//
// Formatting is simple and safe: everything is escaped first; then blank
// lines make paragraphs, lines starting "- " a list, **bold**, and links,
// [words](https://…) or a bare https:// address. Nothing else is markup.

import { cleanClubInfo } from './club-rules.js';

export const SECTIONS = [
  ['about', 'About the club'],
  ['events', 'Upcoming events'],
  ['chips', 'Getting chips'],
  ['rules', 'House rules'],
];
export const sectionName = id => SECTIONS.find(([s]) => s === id)?.[1] || '';
export const MAX_INFO_TEXT = 2000, MAX_EVENTS = 20, MAX_EVENT_TEXT = 80;

const text = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// Club info as given (the host's form), checked: each section trimmed to
// its length, and `at` saying when each changed since `prev` (the info it
// replaces).
export const cleanInfo = cleanClubInfo;

// A member's copy of the club info is as ducy-play's club_member reads it
// from the host (club.js playerReceive): cut to size, keeping when each
// section changed.

export const isEmpty = info => !info || (!info.about && !info.chips && !info.rules && !info.events?.length);

// What members are sent.
export const infoBody = club => ({type: 'info', club: club.code, info: club.info || null});

// The sections changed since the member last looked (`seen`: {section:
// time}), in order.
export function changedSince(info, seen = {}) {
  if (!info?.at) return [];
  return SECTIONS.map(([k]) => k).filter(k => info.at[k] && info.at[k] > (Number(seen?.[k]) || 0) && (k === 'events' ? info.events.length : info[k]));
}

// The next event from `now`, or null.
export const nextEvent = (info, now = Date.now()) => (info?.events || []).find(e => e.at >= now) || null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// One line's inline formatting, on text already escaped: links, then bold.
function inline(s) {
  const link = (url, words) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${words}</a>`;
  const parts = [];
  // [words](https://…) first, then bare addresses outside them.
  s = s.replace(/\[([^\]]{1,100})\]\((https?:\/\/[^\s)]{1,300})\)/g, (_, words, url) => { parts.push(link(url, words)); return `\u0000${parts.length - 1}\u0000`; });
  s = s.replace(/\bhttps?:\/\/[^\s<]{1,300}[^\s<.,;:!?)]/g, url => { parts.push(link(url, url)); return `\u0000${parts.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*]{1,200})\*\*/g, '<b>$1</b>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[Number(i)]);
}

// A section's text as safe HTML: paragraphs, lists, bold and links only.
export function formatInfo(src) {
  const blocks = esc(text(src, MAX_INFO_TEXT)).split(/\n\s*\n/).filter(b => b.trim());
  return blocks.map(b => {
    const lines = b.split('\n');
    if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

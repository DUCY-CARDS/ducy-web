// The club lobby: who's online now, and a chat for members waiting for a
// game ("Anyone up for PLO?"). Pure functions over the club object;
// club-server.js carries the messages, and clubs.js draws them.
//
// club.lobby: [{id, from, name, text, at}], the last LOBBY_KEEP, oldest
// first; anything older than LOBBY_MAX_AGE_MS is dropped.

import { chatName, cleanChat } from './table-chat.js';

export const LOBBY_KEEP = 50;
export const LOBBY_MAX_AGE_MS = 24 * 3600e3;

const fresh = (club, now) => (club.lobby || []).filter(x => now - x.at < LOBBY_MAX_AGE_MS);

// The host's name in the lobby: an always-on club's owner's, or "Manager" (#417).
const hostName = club => club.members[club.ownerId]?.name || 'Manager';

// `from` says `text` in the lobby: a member, or the host (the club's
// hostId or ownerId). Returns the message, or throws why not.
export function sayInLobby(club, from, text, now = Date.now()) {
  const host = from === club.hostId || from === club.ownerId;
  const m = club.members[from];
  if (!host && m?.status !== 'member') throw new Error('Only members can chat in the lobby.');
  const t = cleanChat(text);
  if (!t) throw new Error('Say something first.');
  const x = {id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, from, name: host ? hostName(club) : chatName(m.name), text: t, at: now};
  if (host) x.host = true;
  club.lobby = [...fresh(club, now), x].slice(-LOBBY_KEEP);
  return x;
}

// Who's online, given who's connected (`online`, a Set) and whether the
// host's own page is running the club: [{id, name, role, table}], role
// 'host' | 'assistant' | '', and the name of the table they're at ('' if
// none). The host first, then by name.
export function onlineList(club, online, hostHere = false) {
  const tables = Object.fromEntries((club.tables || []).map(t => [t.id, t.name]));
  const out = [];
  const ownerOn = club.ownerId && online.has(club.ownerId);
  if (hostHere || ownerOn) out.push({id: club.ownerId || club.hostId, name: hostName(club), role: 'host', table: ''});
  const rest = [];
  for (const id of online) {
    const m = club.members[id];
    if (id === club.ownerId || m?.status !== 'member') continue;
    rest.push({id, name: m.name, role: m.role === 'assistant' ? 'assistant' : '', table: m.seat ? tables[m.seat.table] || 'a table' : ''});
  }
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...rest];
}

// What every member online gets: who's here, and the chat.
export function lobbyBody(club, online, hostHere = false, now = Date.now()) {
  return {type: 'lobby', club: club.code, online: onlineList(club, online, hostHere), chat: fresh(club, now).map(({id, name, text, at, host}) => (host ? {id, name, text, at, host} : {id, name, text, at}))};
}

// The lobby as a member's page keeps it, from a host's 'lobby' message:
// {online, chat}, checked and cut to size.
export function readLobby(b) {
  const online = (Array.isArray(b.online) ? b.online : []).slice(0, 500).filter(x => x && typeof x.name === 'string').map(x => ({
    id: String(x.id || ''), name: chatName(x.name), role: ['host', 'assistant'].includes(x.role) ? x.role : '', table: cleanChat(x.table || '').slice(0, 50),
  }));
  const chat = (Array.isArray(b.chat) ? b.chat : []).slice(-LOBBY_KEEP).filter(x => x && typeof x.text === 'string').map(x => ({
    id: String(x.id || ''), name: chatName(x.name), text: cleanChat(x.text), at: Number(x.at) || 0, host: !!x.host,
  })).filter(x => x.text);
  return {online, chat};
}

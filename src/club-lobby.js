// The club lobby: who's online now, and a chat for members waiting for a
// game ("Anyone up for PLO?"). ducy-play's club rules keep it
// (club-rules.js); club-server.js carries the messages, and clubs.js draws
// them.
//
// club.lobby: [{id, from, name, text, at, host?}], the last LOBBY_KEEP,
// oldest first; anything older than LOBBY_MAX_AGE_MS is dropped. The host's
// name in it is an always-on club's owner's, or "Manager" (#417).

import { rules } from './club-rules.js';

export const LOBBY_KEEP = 50;
export const LOBBY_MAX_AGE_MS = 24 * 3600e3;

// `from` says `text` in the lobby: a member, or the host (the club's
// hostId or ownerId). Returns the message, or throws why not.
export const sayInLobby = (club, from, text, now = Date.now()) => rules(club, {op: 'sayInLobby', from, text: String(text ?? '')}, now);

// Who's online, given who's connected (`online`, a Set) and whether the
// host's own page is running the club: [{id, name, role, table}], role
// 'host' | '', and the name of the table they're at ('' if none). The host
// first, then by name.
export const onlineList = (club, online, hostHere = false) => rules(club, {op: 'onlineList', online: [...online], hostHere});

// What every member online gets: who's here, and the chat.
export const lobbyBody = (club, online, hostHere = false, now = Date.now()) => rules(club, {op: 'lobbyBody', online: [...online], hostHere}, now);

// A member's page keeps the lobby as ducy-play's club_member reads a
// host's 'lobby' message (club.js playerReceive): {online, chat}, checked
// and cut to size.

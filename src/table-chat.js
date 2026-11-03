// Chat at a friends table. Guests send what they type to the host,
// encrypted like everything else at the table (play.js); the host's tab
// checks it, puts the sender's name on it and sends it on to everyone. The
// relay only ever sees ciphertext. The checks are ducy-host's chat (in
// ducy-wasm, #462); the log on screen is the page's.

import { ChatLimiter, chatClean, chatName as wasmChatName, chatRead } from '../wasm/ducy_wasm.js';

export const CHAT_MAX = 200; // characters in one message (ducy-host's CHAT_MAX)
export const CHAT_KEEP = 50; // messages kept on screen

// What someone typed, ready to send: control characters and runs of spaces
// become one space, and it's cut to CHAT_MAX characters. '' if nothing's left.
export const cleanChat = text => chatClean(String(text ?? ''));

// A name for a chat line: what the player calls themselves, cut short.
export const chatName = name => wasmChatName(String(name ?? ''));

// A chat message from the host as a guest receives it, or null if it isn't
// one: {from, text, at}.
export const readChat = m => (m && typeof m === 'object' ? chatRead(m, Date.now()) : null);

// The log with `msg` added, keeping the last `keep`.
export const addChat = (log, msg, keep = CHAT_KEEP) => [...log, msg].slice(-keep);

// The host's flood control: allow(who, now) says whether `who` may send
// another message now, at most 5 in any 10 seconds unless given. free()
// lets it go.
export function chatLimiter(burst, windowMs) {
  const lim = new ChatLimiter(burst, windowMs);
  return {
    allow: (who, now = Date.now()) => lim.allow(String(who), now),
    free: () => lim.free(),
  };
}

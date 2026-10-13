// Chat at a friends table. Guests send what they type to the host,
// encrypted like everything else at the table (play.js); the host's tab
// checks it, puts the sender's name on it and sends it on to everyone. The
// relay only ever sees ciphertext.

export const CHAT_MAX = 200; // characters in one message
export const CHAT_KEEP = 50; // messages kept on screen
export const CHAT_BURST = 5; // messages one person can send...
export const CHAT_WINDOW_MS = 10_000; // ...in this long

// What someone typed, ready to send: control characters and runs of spaces
// become one space, and it's cut to CHAT_MAX characters. '' if nothing's left.
export function cleanChat(text) {
  // eslint-disable-next-line no-control-regex
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return [...t].slice(0, CHAT_MAX).join('').trim();
}

// A name for a chat line: what the player calls themselves, cut short.
export const chatName = name => cleanChat(name).slice(0, 20) || 'A player';

// A chat message from the host as a guest receives it, or null if it isn't
// one: {from, text, at}.
export function readChat(m) {
  if (!m || m.type !== 'chat') return null;
  const text = cleanChat(m.text);
  if (!text) return null;
  const at = Number(m.at);
  return {from: chatName(m.from), text, at: Number.isFinite(at) ? at : Date.now()};
}

// The log with `msg` added, keeping the last `keep`.
export const addChat = (log, msg, keep = CHAT_KEEP) => [...log, msg].slice(-keep);

// The host's flood control: allow(who, now) says whether `who` may send
// another message now, at most CHAT_BURST in any CHAT_WINDOW_MS.
export function chatLimiter(burst = CHAT_BURST, windowMs = CHAT_WINDOW_MS) {
  const sent = new Map();
  return {
    allow(who, now = Date.now()) {
      const recent = (sent.get(who) || []).filter(t => now - t < windowMs);
      if (recent.length >= burst) { sent.set(who, recent); return false; }
      recent.push(now);
      sent.set(who, recent);
      return true;
    },
  };
}

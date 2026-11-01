// Table talk from the bots: each Regular has a way of talking (a tone) and a
// talkativeness, and says something now and then: hello when you sit down,
// after a pot with you in it, after a big pot, when they offer to raise the
// stakes, at the end of a heads-up challenge game, and back when you chat.
// Heads-up they talk a lot more, as players do with only one person to talk
// to. The personas, the lines and when they're said are ducy-bot-games' chat
// (#465); this file keeps what was said lately, and play.js decides when.
//
// Moments a bot may speak at:
//   greet: sitting down with you; wonFromYou: took a pot you lost a lot in;
//   lostToYou: you took a pot from them; bigWin / bigLoss: a big pot that
//   wasn't with you; stakes: offering to raise the stakes; gameWon /
//   gameLost: the end of a heads-up challenge game (theirs to win or lose);
//   idle: heads-up, between hands; and replies to what you say in the chat:
//   hello, luck (gl), nice (nh, wp), thanks, laugh, gg, other.

import { botGames } from '../wasm/ducy_wasm.js';

/** How a bot talks: {tone, talk, tilt?}. Generic players talk by family. */
export const personaOf = id => botGames({op: 'personaOf', id: String(id)});

// Whether a bot speaks at `moment`: its talkativeness, more heads-up.
// A reply to you is more likely than unprompted talk.
export const speaks = (id, moment, {headsUp = false, ladder = false, rng = Math.random} = {}) =>
  botGames({op: 'speaks', id: String(id), moment, headsUp, ladder, r: rng()});

// Every line a bot could say at `moment`: its tone's, its own, and with
// `how` (handMoments: 'youCalled' or 'theyCalled') the lines about who
// called; without it only lines that fit either way.
export const linesFor = (id, moment, how = null) => botGames({op: 'linesFor', id: String(id), moment, how});

// What each bot said lately, and the table as a whole: a line isn't said
// again while it's in either, as long as there's another to say.
const RECENT_BOT = 10;
const RECENT_TABLE = 20;
const recentBy = new Map();
let recentTable = [];

/** Forgets what the bots said lately (a new table, or a test). */
export function forgetRecent() {
  recentBy.clear();
  recentTable = [];
}

// A line for `moment` (null if there's none), one the bot and the table
// haven't heard lately when there is one. `how` as in linesFor.
export function lineFor(id, moment, rng = Math.random, how = null) {
  const mine = recentBy.get(id) || [];
  const line = botGames({op: 'lineFor', id: String(id), moment, how, mine, table: recentTable, r: rng()}) ?? null;
  if (line == null) return null;
  recentBy.set(id, [...mine, line].slice(-RECENT_BOT));
  recentTable = [...recentTable, line].slice(-RECENT_TABLE);
  return line;
}

// What a chat message from you is, for a bot's reply.
export const replyMoment = text => botGames({op: 'replyMoment', text: String(text)});

// Who called whom at the end of a hand, between you (seat 0) and bot `seat`,
// from the hand's events: 'youCalled' when you called the bot's last bet or
// raise, 'theyCalled' when the bot called yours, else null.
export const callShape = (events, seat) => botGames({op: 'callShape', events: events || null, seat}) ?? null;

// What a finished hand gives the bots to talk about: [{seat, moment}], at
// most one, from the seats' results (`net`, in chips) and the big blind.
// Seat 0 is you. With the hand's `events`, a pot between you and that bot
// also says who called (`how`, see callShape), when it's clear.
export const handMoments = (seats, bigBlind, events = null) =>
  botGames({op: 'handMoments', seats, bigBlind: Number(bigBlind) || 0, events});

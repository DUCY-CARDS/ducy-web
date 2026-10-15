// Table talk from the bots: each Regular has a way of talking (a tone) and a
// talkativeness, and says something now and then: hello when you sit down,
// after a pot with you in it, after a big pot, when they offer to raise the
// stakes, at the end of a heads-up challenge game, and back when you chat.
// Heads-up they talk a lot more, as players do with only one person to talk
// to. This file is the personas and the lines; play.js decides when.

// Tones: friendly (nice, says nice hand), chatty (cocky but fun), needle
// (trash talk), grump (complains about luck), cool (says little, dry),
// math (talks in odds), robot (the GTO bot).
export const PERSONAS = {
  doug_poker: {tone: 'cool', talk: 0.3},
  jonny_slow: {tone: 'friendly', talk: 0.25},
  mister_cheating: {tone: 'needle', talk: 0.5},
  // The whale is always nice: happy to gamble, happy to lose.
  milk_king: {tone: 'friendly', talk: 0.6},
  phil_bigmouth: {tone: 'needle', talk: 0.8},
  rampart: {tone: 'needle', talk: 0.5},
  // Friendly, until he loses a pot: then he tilts and cusses you out.
  danny_smallball: {tone: 'friendly', talk: 0.3, tilt: true},
  chris_moneybags: {tone: 'chatty', talk: 0.5},
  robin_jane_lewd: {tone: 'chatty', talk: 0.5},
  gus_bluffsen: {tone: 'needle', talk: 0.5},
  jen_silly: {tone: 'friendly', talk: 0.6},
  michael_miserable: {tone: 'grump', talk: 0.5},
  brad_owned: {tone: 'grump', talk: 0.4},
  nik_airbag: {tone: 'needle', talk: 0.7},
  bungleman: {tone: 'needle', talk: 0.6},
  tom_collins: {tone: 'cool', talk: 0.4},
  the_mathematician: {tone: 'math', talk: 0.4},
  andrew_favorable: {tone: 'friendly', talk: 0.4},
  tommy_sweeden: {tone: 'cool', talk: 0.2},
  gto: {tone: 'robot', talk: 0.3},
};
const DEFAULT = {tone: 'friendly', talk: 0.3};
export const personaOf = id => PERSONAS[String(id).startsWith('gto') ? 'gto' : id] || DEFAULT;

// Moments a bot may speak at.
//   greet: sitting down with you; wonFromYou: took a pot you lost a lot in;
//   lostToYou: you took a pot from them; bigWin / bigLoss: a big pot that
//   wasn't with you; stakes: offering to raise the stakes; gameWon /
//   gameLost: the end of a heads-up challenge game (theirs to win or lose);
//   idle: heads-up, between hands; and replies to what you say in the chat:
//   hello, luck (gl), nice (nh, wp), thanks, laugh, gg, other.
export const LINES = {
  friendly: {
    greet: ['Hi! Good luck today.', 'Hey there, nice to meet you.', 'Hello! Let’s have some fun.', 'Good luck, have fun!'],
    wonFromYou: ['Sorry about that one.', 'I got lucky there.', 'Tough spot, I know.', 'You’ll get me back.'],
    lostToYou: ['Nice hand!', 'Well played.', 'You got me.', 'Good call.'],
    bigWin: ['Oh wow, I’ll take it.', 'What a pot!', 'Lucky me.'],
    bigLoss: ['Ouch. Oh well.', 'That’s poker!', 'Can’t win them all.'],
    stakes: ['Want to make it a bit more interesting?', 'Shall we play a little bigger?'],
    gameWon: ['Good game! That was close.', 'Thanks for the game, well played.', 'GG! Come back for a rematch?'],
    gameLost: ['Well played, you earned it!', 'GG, you were too good today.', 'Great game. Good luck up the ladder!'],
    idle: ['Having fun?', 'This is a fun one.', 'Your deal… well, the dealer’s.'],
    hello: ['Hi!', 'Hello!', 'Hey, good to see you.'],
    luck: ['You too!', 'Thanks, good luck!'],
    nice: ['Thank you!', 'Thanks, you too.'],
    thanks: ['Of course!', 'Any time.'],
    laugh: ['Ha!', ':)'],
    gg: ['GG!', 'Good game!'],
    other: ['Ha, true.', 'Mhm.', 'For sure.'],
  },
  chatty: {
    greet: ['Fresh money! Welcome.', 'Ooh, a new player. Let’s gamble.', 'Hope you brought chips.', 'Let’s make some big pots.'],
    wonFromYou: ['Ship it!', 'Thanks for the chips!', 'That’s how we do it.', 'Too good.'],
    lostToYou: ['Okay, okay, nice hand.', 'You got there. I’ll get it back.', 'Fine, take it.', 'Enjoy those, they’re coming back.'],
    bigWin: ['Stack those up for me.', 'Now we’re talking!', 'Run good!'],
    bigLoss: ['Easy come, easy go.', 'Plenty more where that came from.', 'Rebuy?'],
    stakes: ['These blinds are boring. Double it?', 'Let’s play for real money.', 'Bigger. Come on.'],
    gameWon: ['Told you. Again?', 'Better luck next time!', 'GG, that was fun for me.'],
    gameLost: ['Alright, alright, you got me.', 'I’ll be back for those.', 'GG. Enjoy it while it lasts.'],
    idle: ['Somebody put a bet in already.', 'Let’s see a big one.', 'I’m feeling lucky.'],
    hello: ['Hey hey!', 'Welcome to the action.'],
    luck: ['Don’t need it, but you too.', 'Luck’s for amateurs. GL.'],
    nice: ['I know.', 'Thanks, I’m pretty good.'],
    thanks: ['Sure thing.', 'Don’t mention it.'],
    laugh: ['Haha.', 'LOL.'],
    gg: ['GG!', 'Good game, good game.'],
    other: ['Sure.', 'If you say so.', 'Ha.'],
  },
  needle: {
    greet: ['Another one for the slaughter.', 'Hope you didn’t bring much.', 'Oh good, a fish.', 'Sit down. This won’t take long.'],
    wonFromYou: ['Thanks for the donation.', 'You can fold, you know.', 'Read you like a book.', 'Was that a bluff? Cute.', 'Keep calling, I love it.'],
    lostToYou: ['Lucky.', 'Nice catch. Don’t get used to it.', 'Even a blind squirrel…', 'Enjoy it. Won’t happen again.', 'Sure, sure.'],
    bigWin: ['Too easy.', 'Who’s next?', 'Get these chips out of my way.'],
    bigLoss: ['Unreal. Rigged.', 'Whatever.', 'That guy can’t play.'],
    stakes: ['Scared to play bigger?', 'Let’s double it. Unless you’re scared.', 'Bigger blinds. Show me what you’ve got.'],
    gameWon: ['Too easy. Next.', 'Go practise and come back.', 'Thanks for the chips.'],
    gameLost: ['You got lucky. Rematch.', 'Whatever. Ran bad.', 'Enjoy it, it won’t last.'],
    idle: ['Tick tock.', 'Any time now.', 'You gonna play a hand?'],
    hello: ['Yeah, hi.', 'Sit down and play.'],
    luck: ['You’ll need it.', 'Luck won’t save you.'],
    nice: ['Obviously.', 'I know.'],
    thanks: ['Don’t thank me yet.', 'Sure.'],
    laugh: ['Laugh now.', 'Funny, is it?'],
    gg: ['Was it?', 'GG, I guess.'],
    other: ['Less talking, more playing.', 'Whatever you say.', 'Sure, pal.'],
  },
  grump: {
    greet: ['Here we go again.', 'Watch, I’ll get no cards today.', 'Hello. Don’t expect much from my cards.'],
    wonFromYou: ['Finally, one hand.', 'About time.', 'Wow, I actually won one.'],
    lostToYou: ['Of course. Every time.', 'Unbelievable. Again.', 'Story of my life.', 'Why do I even play.'],
    bigWin: ['Huh. Won one.', 'Don’t get used to it.'],
    bigLoss: ['Of course.', 'Every single time.', 'I’m cursed.'],
    stakes: ['Might as well lose faster. Bigger?', 'Let’s double it. Can’t get worse.'],
    gameWon: ['Well, that never happens. GG.', 'Huh. I won. GG.'],
    gameLost: ['Naturally. GG.', 'Sure, why not. GG.', 'Ran terrible. GG.'],
    idle: ['Deal me something good for once.', 'Nothing again.', 'Seven-two again, probably.'],
    hello: ['Hi. I guess.', 'Yeah, hello.'],
    luck: ['Wish I had some.', 'Thanks. I need it.'],
    nice: ['Rare, for me.', 'Thanks, I suppose.'],
    thanks: ['Mm.', 'Sure.'],
    laugh: ['Glad someone’s having fun.', 'Heh.'],
    gg: ['GG.', 'Yeah. GG.'],
    other: ['Mm.', 'If you say so.', 'Sure.'],
  },
  cool: {
    greet: ['Evening.', 'Good luck.', 'Hey.', 'Let’s play.'],
    wonFromYou: ['Thanks.', 'Close one.', 'Good try.'],
    lostToYou: ['Nice hand.', 'Well played.', 'Fair enough.'],
    bigWin: ['Nice pot.', 'Mm.'],
    bigLoss: ['Happens.', 'On to the next.'],
    stakes: ['Up the stakes?', 'Double it?'],
    gameWon: ['GG.', 'Good game. Thanks.'],
    gameLost: ['GG. Well played.', 'Nicely done.'],
    idle: ['Mm.', 'Take your time.'],
    hello: ['Hey.', 'Evening.'],
    luck: ['You too.', 'GL.'],
    nice: ['Thanks.', 'Appreciated.'],
    thanks: ['Sure.', 'Of course.'],
    laugh: ['Heh.', ':)'],
    gg: ['GG.', 'Good game.'],
    other: ['Mm.', 'Fair.', 'Could be.'],
  },
  math: {
    greet: ['Hello. Let’s see how the numbers fall.', 'Good evening. May variance be kind.', 'Hi. I’ll be calculating.'],
    wonFromYou: ['Expected value says sorry.', 'The math favoured me there.', 'Pot odds, my friend.'],
    lostToYou: ['A 22% shot. Well done.', 'Statistically unlikely. Nice hand.', 'Variance. Noted.'],
    bigWin: ['As the numbers predicted.', 'Positive expectation realised.'],
    bigLoss: ['Variance is a harsh teacher.', 'Over a large sample, I’m fine.'],
    stakes: ['Doubling the blinds halves the depth. Shall we?', 'A larger sample at higher stakes?'],
    gameWon: ['GG. The long run is undefeated.', 'Good game. Mathematically satisfying.'],
    gameLost: ['GG. You ran above expectation.', 'Well played. I’ll recompute.'],
    idle: ['Interesting spot.', 'Calculating…'],
    hello: ['Hello. Good luck, statistically speaking.'],
    luck: ['Luck is just variance. You too.'],
    nice: ['Thank you. It was +EV.'],
    thanks: ['You’re welcome.'],
    laugh: ['Ha. Probably.'],
    gg: ['GG. Fine sample.'],
    other: ['Possibly.', 'The numbers agree.', 'Hm, interesting.'],
  },
  robot: {
    greet: ['Hello. Strategy loaded.', 'Greetings, human. Good luck.', 'Beep. Ready to play.'],
    wonFromYou: ['Equilibrium holds.', 'Calculated.', 'That was the solver’s line.'],
    lostToYou: ['Well played. Updating nothing.', 'A fine exploit, human.', 'Noted. Variance.'],
    bigWin: ['Pot acquired.', 'Calculated.'],
    bigLoss: ['Variance detected.', 'Within expectation.'],
    stakes: ['Shall we double the blinds?', 'Increase stakes? Beep.'],
    gameWon: ['GG. Equilibrium remains undefeated.', 'Game over. Well played, human.'],
    gameLost: ['GG. Impressive, human.', 'You win this time. Recalibrating.'],
    idle: ['Beep.', 'Processing.', 'Awaiting input.'],
    hello: ['Hello, human.', 'Greetings.'],
    luck: ['Luck is not in my programming. Good luck to you.'],
    nice: ['Thank you. It was a mixed strategy.'],
    thanks: ['You are welcome.'],
    laugh: ['Ha. Ha. Ha.'],
    gg: ['GG.', 'Good game, human.'],
    other: ['Input received.', 'Beep.', 'Interesting.'],
  },
};

// A tilting player's lines when he's losing (a persona with `tilt`): angry,
// and he cusses, with the words bleeped.
const LOSING = new Set(['lostToYou', 'bigLoss', 'gameLost']);
export const TILT_LINES = {
  lostToYou: ['Are you kidding me?! @#$%!', 'Unbelievable. You called with THAT?', 'Oh, come ON. #@$%ing river.', 'Every. Single. Time. @#$%.', 'Learn to fold, you @#$%.'],
  bigLoss: ['@#$%! Rigged.', 'Damn it. DAMN it.', 'I can’t believe this @#$%.'],
  gameLost: ['@#$% this. Lucky @#$%. Rematch.', 'You sucked out all game. GG, I guess.', 'Unreal. @#$%ing unreal.'],
};

// Moments a bot always speaks at (when the chat is on), however quiet: they
// open and close a heads-up challenge game, and answer when you talk.
const ALWAYS = new Set(['gameWon', 'gameLost']);
// How much more they talk heads-up.
const HEADS_UP = 2.5;

// Whether a bot speaks at `moment`: its talkativeness, more heads-up.
// A reply to you is more likely than unprompted talk.
export function speaks(id, moment, {headsUp = false, ladder = false, rng = Math.random} = {}) {
  if (ALWAYS.has(moment) || (ladder && moment === 'greet')) return true;
  const {talk} = personaOf(id);
  let p = talk * (headsUp ? HEADS_UP : 1);
  if (REPLIES.has(moment)) p = Math.max(p, 0.5) * (headsUp ? 2 : 1);
  if (moment === 'idle') p *= 0.25;
  return rng() < Math.min(0.95, p);
}

// A line for `moment` in the bot's tone (null if there's none).
export function lineFor(id, moment, rng = Math.random) {
  const persona = personaOf(id);
  const lines = (persona.tilt && LOSING.has(moment) && TILT_LINES[moment]) || LINES[persona.tone]?.[moment];
  if (!lines?.length) return null;
  return lines[Math.floor(rng() * lines.length)];
}

const REPLIES = new Set(['hello', 'luck', 'nice', 'thanks', 'laugh', 'gg', 'other']);

// What a chat message from you is, for a bot's reply.
export function replyMoment(text) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  const has = words => words.some(w => t.includes(` ${w} `));
  const hello = ['hi', 'hello', 'hey', 'yo', 'sup', 'evening', 'morning', 'howdy'];
  // "Hey, nice to meet you" is a hello, whatever follows it.
  if (hello.some(w => t.startsWith(` ${w} `))) return 'hello';
  if (has(['gg', 'good game'])) return 'gg';
  if (has(['gl', 'good luck', 'glhf'])) return 'luck';
  if (has(['nh', 'nice hand', 'wp', 'well played', 'nice', 'good hand'])) return 'nice';
  if (has(['ty', 'thanks', 'thank you', 'thx'])) return 'thanks';
  if (has(['lol', 'haha', 'lmao', 'ha'])) return 'laugh';
  if (has(hello)) return 'hello';
  return 'other';
}

// What a finished hand gives the bots to talk about: [{seat, moment}], at
// most one, from the seats' results (`net`, in chips) and the big blind.
// Seat 0 is you.
export function handMoments(seats, bigBlind) {
  const bb = Math.max(1, bigBlind);
  const net = seats.map(s => Number(s.net) || 0);
  const you = net[0];
  const bots = seats.map((s, i) => ({i, net: net[i], here: i > 0 && !s.empty && !s.sitting_out})).filter(b => b.here);
  if (!bots.length) return [];
  const top = bots.reduce((a, b) => (b.net > a.net ? b : a));
  const low = bots.reduce((a, b) => (b.net < a.net ? b : a));
  if (you <= -10 * bb && top.net > 0) return [{seat: top.i, moment: 'wonFromYou'}];
  if (you >= 10 * bb && low.net < 0) return [{seat: low.i, moment: 'lostToYou'}];
  if (top.net >= 30 * bb) return [{seat: top.i, moment: 'bigWin'}];
  if (low.net <= -30 * bb) return [{seat: low.i, moment: 'bigLoss'}];
  return [];
}

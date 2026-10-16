// Chips on the table: an amount drawn as casino chips in stacks of 20.
// Amounts are in hundredths, like the rest of the page (100 is $1).
//
// The smallest chip in play is the largest one not above the big blind, and
// the game's preferred chip, the one players bet with, is the next one up
// (red at 1/2, green at 2/5). A seat keeps a stack of the smallest chip for
// blinds and change and two stacks of the preferred chip, and each bigger
// chip then takes as much as fits until the seat would need more than SHOWN
// stacks. Past that, the rest goes on one mixed stack, coloured up only as
// far as it takes to fit ($10,000 at 1/2 is mostly yellow). What bigger
// chips can't pay stays in smaller ones, so the chips always add up;
// anything under $1 is left over (no fractional chips). It's worked out
// fresh from the amount each time, so winning a pot colours up on its own.

export const CHIPS = [
  {value: 100, color: 'white'},
  {value: 500, color: 'red'},
  {value: 2500, color: 'green'},
  {value: 10000, color: 'black'},
  {value: 50000, color: 'purple'},
  {value: 100000, color: 'yellow'},
  {value: 500000, color: 'pink'},
  {value: 2500000, color: 'orange'},
  // Tournament chips. The red and green come back, with gold edge spots to
  // tell them from the $5 and $25 (style.css).
  {value: 10000000, color: 'blue'},
  {value: 50000000, color: 'red-500k'},
  {value: 100000000, color: 'green-1m'},
];
export const STACK = 20;
// Stacks of the preferred chip a seat keeps.
const PREFERRED_STACKS = 2;
// Stacks a seat shows at most.
export const SHOWN = 5;

const stacksOf = count => Math.ceil(count / STACK);

// [{value, color, count}], biggest chip first, and the `rest` under $1.
export function breakdown(amount, bigBlind) {
  const whole = Math.floor(Math.max(0, amount) / 100) * 100;
  let left = whole;
  const first = Math.max(0, CHIPS.findLastIndex(c => c.value <= Math.max(100, bigBlind)));
  const out = [];
  let used = 0;
  for (let i = first; left > 0 && i < CHIPS.length; i++) {
    const {value, color} = CHIPS[i];
    const next = CHIPS[i + 1]?.value;
    const all = left / value;
    let count = all; // the top chip: as many as it takes
    if (next) {
      // Smaller chips below this one can't pay a remainder of it: only
      // amounts of whole chips reach here, since the first chip is the
      // smallest in play and leftovers under it go to `rest`.
      const must = (left % next) / value;
      const per = next / value;
      // A stack of the smallest chip, two of the preferred one; a bigger
      // chip takes everything if it fits, else what fits beside a stack
      // kept for the chips above it.
      const cap = i === first ? STACK
        : i === first + 1 ? PREFERRED_STACKS * STACK
        : stacksOf(all) <= SHOWN - used ? all
        : Math.max(0, SHOWN - used - 1) * STACK;
      count = Math.min(all, must + Math.max(0, Math.floor((cap - must) / per) * per));
      if (i > first + 1 && used + stacksOf(count) + (count < all ? 1 : 0) > SHOWN) {
        // Full: the rest on one mixed stack of `loose` chips (toStacks).
        // What's left is a whole number of this chip, so they're never
        // smaller than it, and they colour up only as far as it takes to
        // fit one stack: $800 left is eight blacks, not a purple.
        let top = i;
        while (top < CHIPS.length - 1 && pay(left, top).chips.reduce((n, c) => n + c.count, 0) > STACK) top++;
        out.push(...pay(left, top).chips.reverse().map(c => ({...c, loose: true})));
        left = 0;
        break;
      }
    }
    count = Math.floor(count);
    if (count) out.push({value, color, count});
    used += stacksOf(count);
    left -= count * value;
  }
  // Amounts under the smallest chip in play (a $3 bet with $5 chips) aren't
  // chips either: they go with the rest.
  return {chips: out.reverse(), rest: Math.max(0, amount) - (whole - left)};
}

// A bet (or the pot) paid the way players bet: the highest-valued chips
// first, so $11 is two reds and a white. [{value, color, count}], biggest
// first, and the `rest` under $1. `top` is the index of the biggest chip to
// use (all of them by default).
export function pay(amount, top = CHIPS.length - 1) {
  let left = Math.floor(Math.max(0, amount) / 100) * 100;
  const rest = Math.max(0, amount) - left;
  const chips = [];
  for (const {value, color} of CHIPS.slice(0, top + 1).reverse()) {
    const count = Math.floor(left / value);
    if (count) chips.push({value, color, count});
    left -= count * value;
  }
  return {chips, rest};
}

// Adds `count` chips of `value` to a list of chips (biggest first).
function addChips(list, value, count) {
  const same = list.find(c => c.value === value);
  if (same) same.count += count;
  else {
    list.push({value, color: CHIPS.find(c => c.value === value).color, count});
    list.sort((a, b) => b.value - a.value);
  }
}

// A bet paid from the chips a player has (`have`, as `breakdown` gives
// them), the highest-valued ones first that fit. When their chips can't make
// what's left (a $7 bet with only reds), the smallest chip bigger than it is
// broken: one red goes in, the dealer gives back the change, and the bet is
// a red and two whites with three whites returned to the stack. Returns the
// bet and what's left in front of the player.
export function payFrom(amount, have) {
  const stack = have.map(c => ({...c}));
  const bet = [];
  let left = Math.floor(Math.max(0, amount) / 100) * 100;
  while (left > 0) {
    for (const c of stack) {
      const n = Math.min(c.count, Math.floor(left / c.value));
      if (!n) continue;
      c.count -= n;
      addChips(bet, c.value, n);
      left -= n * c.value;
    }
    if (left <= 0) break;
    // Break a chip: the smallest one bigger than what's owed becomes the
    // next smaller chip (a red, five whites), back in the stack, and paying
    // goes on from there.
    const big = stack.filter(c => c.count > 0 && c.value > left).sort((a, b) => a.value - b.value)[0];
    const smaller = big && CHIPS.filter(c => c.value < big.value).at(-1);
    if (!smaller) {
      // Not enough chips at all (it can't happen when the stack covers the
      // bet): the rest is paid as `pay` would.
      for (const c of pay(left).chips) addChips(bet, c.value, c.count);
      break;
    }
    big.count--;
    addChips(stack, smaller.value, big.value / smaller.value);
  }
  return {bet, stack: stack.filter(c => c.count > 0)};
}

// A seat's chips this street: its stack and its bet, the bet paid out of
// what it had before betting (its stack and bet together).
export function seatChips(stack, bet, bigBlind) {
  const paid = payFrom(bet, breakdown(stack + bet, bigBlind).chips);
  return {stack: paid.stack, bet: paid.bet};
}

const total = chips => chips.reduce((t, c) => t + c.value * c.count, 0);

// Every seat's chips through a hand, from its events: each seat starts with
// its stack at the start of the hand split as `breakdown` does, every blind,
// ante, call, bet and raise is paid out of those chips (`payFrom`), and at
// each new street the bets go into the pot, chip for chip. So the chips a
// player bet are the chips in the middle: green stays green. Chips only
// colour up or down between hands, when each stack is split afresh.
//
// `seats` are [{stack, street_bet}] now; `events` the hand's so far
// ({type, seat, amount | to | dead, live}). Returns {stacks, bets, pot}:
// each seat's chips behind and in front of it, and the pot's chips; or null
// if the events don't add up to the seats' chips (then draw from amounts).
export function handChips(seats, events, bigBlind) {
  const n = seats.length;
  // What each seat put in, to know what it started the hand with.
  const put = new Array(n).fill(0);
  const street = new Array(n).fill(0);
  const paid = [];
  for (const e of events) {
    const s = e.seat;
    const amt = x => Math.max(0, Number(x) || 0);
    if (e.type === 'board') { street.fill(0); paid.push({board: true}); continue; }
    let toPot = 0, toBet = 0;
    if (e.type === 'ante') toPot = amt(e.amount);
    else if (e.type === 'post') { toPot = amt(e.dead); toBet = amt(e.live); }
    else if (e.type === 'small_blind' || e.type === 'big_blind' || e.type === 'call') toBet = amt(e.amount);
    else if (e.type === 'bet' || e.type === 'raise') toBet = Math.max(0, amt(e.to) - street[s]);
    else continue;
    if (s == null || s < 0 || s >= n) return null;
    street[s] += toBet;
    put[s] += toPot + toBet;
    paid.push({seat: s, toPot, toBet});
  }
  const have = seats.map((x, i) => breakdown(Math.max(0, Number(x.stack) || 0) + put[i], bigBlind).chips);
  const bets = seats.map(() => []);
  const pot = [];
  const into = (list, chips) => chips.forEach(c => addChips(list, c.value, c.count));
  for (const p of paid) {
    if (p.board) {
      bets.forEach(b => { into(pot, b); b.length = 0; });
      continue;
    }
    for (const [amount, where] of [[p.toPot, pot], [p.toBet, bets[p.seat]]]) {
      if (!amount) continue;
      const r = payFrom(amount, have[p.seat]);
      have[p.seat] = r.stack;
      into(where, r.bet);
    }
  }
  // The chips must match the amounts shown (whole dollars of them).
  const whole = x => Math.floor(Math.max(0, Number(x) || 0) / 100) * 100;
  for (let i = 0; i < n; i++) {
    if (total(bets[i]) !== whole(seats[i].street_bet)) return null;
  }
  return {stacks: have, bets, pot};
}

// Chips ([{color, count}], biggest first) as stacks of up to STACK, at
// most `max` of them: every colour gets a stack before any gets a second,
// so a small chip never hides behind big ones. Biggest chips first. Loose
// big chips (a deep stack's, `breakdown`) go first, together on mixed
// stacks, `{mix: [{color, count}]}` with the highest value on top.
export function toStacks(chips, max = 5) {
  const mixed = [];
  let room = 0;
  for (const {color, count, loose} of chips) {
    if (!loose) continue;
    for (let n = count; n > 0;) {
      if (!room) { mixed.push({mix: []}); room = STACK; }
      const k = Math.min(n, room);
      mixed.at(-1).mix.push({color, count: k});
      room -= k;
      n -= k;
    }
  }
  const out = mixed.slice(0, max);
  const left = chips.filter(c => !c.loose).map(c => ({color: c.color, count: c.count, out: []}));
  let shown = out.length;
  for (let more = true; more && shown < max;) {
    more = false;
    for (const c of left) {
      if (c.count <= 0 || shown >= max) continue;
      c.out.push({color: c.color, count: Math.min(STACK, c.count)});
      c.count -= STACK;
      shown++;
      more = true;
    }
  }
  return [...out, ...left.flatMap(c => c.out)];
}

function stackHtml(s) {
  if (!s.mix) return `<span class="ch-stack ch-${s.color}" style="--n:${s.count}"></span>`;
  // A mixed stack: one segment a colour, the top one showing its face.
  return `<span class="ch-mix">${s.mix
    .map(m => `<span class="ch-stack ch-${m.color}" style="--n:${m.count}"></span>`)
    .join('')}</span>`;
}

// The stacks to draw for an amount: a stack in front of a player split as
// `breakdown` does, the pot (`bet`) as `pay` does.
export function stacks(amount, bigBlind, max = 5, bet = false) {
  return toStacks((bet ? pay(amount) : breakdown(amount, bigBlind)).chips, max);
}

// Chips as HTML: a row of stacks, `aria-hidden` (the amount is always shown
// as a number too).
export function rowHtml(chips, max = 5, cls = '') {
  const row = toStacks(chips, max);
  if (!row.length) return '';
  return `<span class="ch-row${cls ? ` ${cls}` : ''}" aria-hidden="true">${row.map(stackHtml).join('')}</span>`;
}

export function chipsHtml(amount, bigBlind, max = 5, cls = '', bet = false) {
  return rowHtml((bet ? pay(amount) : breakdown(amount, bigBlind)).chips, max, cls);
}

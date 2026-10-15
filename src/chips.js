// Chips on the table: an amount drawn as casino chips in stacks of 20.
// Amounts are in hundredths, like the rest of the page (100 is $1).
//
// The smallest chip in play is the largest one not above the big blind. Each
// chip holds up to MAX_STACKS stacks, and anything beyond colours up into the
// next chip (the top chip holds as many as it takes), so a stack is a few
// stacks of each of a few colours, as players keep them. A deep stack that
// would still take more than SHOWN stacks keeps one stack each of the
// three smallest chips in play and the rest in the biggest chips ($10,000
// at 1/2 is mostly yellow). What bigger chips can't pay stays in smaller
// ones, so the chips always add up; anything under $1 is left over (no
// fractional chips). It's worked out fresh from the amount each time, so
// winning a pot colours up on its own.

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
const MAX_STACKS = 2;
// Stacks a seat shows at most, and a deep stack's working chips.
export const SHOWN = 5;
const DEEP_TIERS = 3;

const stackCount = chips => chips.reduce((n, c) => n + Math.ceil(c.count / STACK), 0);

// [{value, color, count}], biggest chip first, and the `rest` under $1.
export function breakdown(amount, bigBlind) {
  const usual = fill(amount, bigBlind, MAX_STACKS * STACK, Infinity);
  return stackCount(usual.chips) <= SHOWN ? usual : fill(amount, bigBlind, STACK, DEEP_TIERS);
}

// The smallest `tiers` chips in play each hold up to `cap`; whatever's left
// after them is paid in the biggest chips (as `pay` does).
function fill(amount, bigBlind, cap, tiers) {
  const whole = Math.floor(Math.max(0, amount) / 100) * 100;
  let left = whole;
  const first = Math.max(0, CHIPS.findLastIndex(c => c.value <= Math.max(100, bigBlind)));
  let i = first;
  const out = [];
  while (left > 0 && i < CHIPS.length) {
    const {value, color} = CHIPS[i];
    const next = CHIPS[i + 1]?.value;
    if (i - first >= tiers) {
      // The rest in the biggest chips: what's left is a whole number of
      // this chip, so they're never smaller than it. They're `loose`, a few
      // of each, and go on one mixed stack (toStacks).
      out.push(...pay(left).chips.reverse().map(c => ({...c, loose: true})));
      left = 0;
      break;
    }
    let count;
    if (!next) count = left / value; // the top chip: as many as it takes
    else {
      // Smaller chips below this one can't pay a remainder of it: only
      // amounts of whole chips reach here, since the first chip is the
      // smallest in play and leftovers under it go to `rest`.
      const must = (left % next) / value;
      const per = next / value;
      const room = Math.max(0, Math.floor((cap - must) / per) * per);
      count = Math.min(left / value, must + room);
    }
    count = Math.floor(count);
    if (count) out.push({value, color, count});
    left -= count * value;
    i++;
  }
  // Amounts under the smallest chip in play (a $3 bet with $5 chips) aren't
  // chips either: they go with the rest.
  return {chips: out.reverse(), rest: Math.max(0, amount) - (whole - left)};
}

// A bet (or the pot) paid the way players bet: the highest-valued chips
// first, so $11 is two reds and a white. [{value, color, count}], biggest
// first, and the `rest` under $1.
export function pay(amount) {
  let left = Math.floor(Math.max(0, amount) / 100) * 100;
  const rest = Math.max(0, amount) - left;
  const chips = [];
  for (const {value, color} of [...CHIPS].reverse()) {
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

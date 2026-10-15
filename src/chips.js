// Chips on the table: an amount drawn as casino chips in stacks of 20.
// Amounts are in hundredths, like the rest of the page (100 is $1).
//
// The smallest chip in play is the largest one not above the big blind, and
// it keeps up to BASE_STACKS stacks for betting; each bigger chip holds up to
// MAX_STACKS stacks, and anything beyond colours up into the next chip. What
// bigger chips can't pay stays in smaller ones, so the chips always add up;
// anything under $1 is left over (no fractional chips). It's worked out
// fresh from the amount each time, so winning a pot colours up on its own.

export const CHIPS = [
  {value: 100, color: 'white'},
  {value: 500, color: 'red'},
  {value: 2500, color: 'green'},
  {value: 10000, color: 'black'},
  {value: 50000, color: 'purple'},
  {value: 100000, color: 'yellow'},
];
export const STACK = 20;
const BASE_STACKS = 2;
const MAX_STACKS = 5;

// [{value, color, count}], biggest chip first, and the `rest` under $1.
export function breakdown(amount, bigBlind) {
  const whole = Math.floor(Math.max(0, amount) / 100) * 100;
  let left = whole;
  let i = Math.max(0, CHIPS.findLastIndex(c => c.value <= Math.max(100, bigBlind)));
  const out = [];
  let cap = BASE_STACKS * STACK;
  while (left > 0 && i < CHIPS.length) {
    const {value, color} = CHIPS[i];
    const next = CHIPS[i + 1]?.value;
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
    cap = MAX_STACKS * STACK;
  }
  // Amounts under the smallest chip in play (a $3 bet with $5 chips) aren't
  // chips either: they go with the rest.
  return {chips: out.reverse(), rest: Math.max(0, amount) - (whole - left)};
}

// The stacks to draw, at most `max` of them, biggest chips first:
// [{color, count}] with count up to STACK.
export function stacks(amount, bigBlind, max = 5) {
  const out = [];
  for (const {color, count} of breakdown(amount, bigBlind).chips) {
    for (let n = count; n > 0 && out.length < max; n -= STACK) out.push({color, count: Math.min(STACK, n)});
  }
  return out;
}

// The chips as HTML: a row of stacks, `aria-hidden` (the amount is always
// shown as a number too).
export function chipsHtml(amount, bigBlind, max = 5, cls = '') {
  const row = stacks(amount, bigBlind, max);
  if (!row.length) return '';
  return `<span class="ch-row${cls ? ` ${cls}` : ''}" aria-hidden="true">${row
    .map(s => `<span class="ch-stack ch-${s.color}" style="--n:${s.count}"></span>`)
    .join('')}</span>`;
}

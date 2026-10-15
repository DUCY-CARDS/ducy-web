// Chips in cash games (clubs, friends tables and bot tables) are whole
// numbers of hundredths everywhere they're kept, sent or played: the engine,
// the club ledger, saved tables and hand records. They're shown divided by
// 100, so 25 is 0.25 and 20000 is 200, and amounts typed in are read back
// into hundredths. Tournament chips are whole numbers as they are: show
// them with {whole: true}.

export const CHIP_SCALE = 100;

// An amount for the screen: "200", "0.25", "1,234.50" (cents shown only when
// there are any).
export function chipText(n, {whole = false} = {}) {
  const v = Number(n || 0) / (whole ? 1 : CHIP_SCALE);
  return v.toLocaleString(undefined, Number.isInteger(v) ? {} : {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// An amount for an input's value: plain, no grouping ("1234.5").
export const chipInput = n => String(Number(n || 0) / CHIP_SCALE);

// What was typed, in hundredths: "12", "12.5", "0.25" → 1200, 1250, 25. NaN
// for anything else, including more than two decimals.
export function parseChips(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(t)) return NaN;
  return Math.round(Number(t) * CHIP_SCALE);
}

// Input attributes for an amount box: steps of 0.01.
export const CHIP_STEP = '0.01';

// The casino chips, in hundredths: $1 to $25,000.
export const CASINO_CHIPS = [100, 500, 2500, 10000, 50000, 100000, 500000, 2500000];

// A cash game's smallest chip, which every bet and raise is a whole number
// of (an all-in aside): the largest casino chip not above the small blind.
// 1/2 and 2/5 bet in $1, 5/10 and 10/25 in $5, 25/50 in $25. Below a $1
// small blind, any amount (1). The engine has the same rule (ducy-wasm
// default_chip).
export const tableChip = smallBlind => [...CASINO_CHIPS].reverse().find(c => c <= smallBlind) ?? 1;

// `amount` as a whole number of `chip`s, within [min, max]: the nearest,
// except that max (often all-in, any amount) stays max.
export function toChip(amount, chip, min, max) {
  if (amount >= max) return max;
  const near = Math.round(amount / chip) * chip;
  return Math.max(min, Math.min(max, near));
}

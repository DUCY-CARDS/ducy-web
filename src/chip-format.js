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

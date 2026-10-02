// Built-in Hold'em preflop range presets, structured so other features (the
// range picker now, a preflop trainer later) can query them by spot.
//
// Ranges are approximate 6-max 100bb cash strategies. Only their overall
// frequencies are calibrated, against published solver figures: opens
// UTG ~17-18.5%, HJ ~22%, CO ~28%, BTN ~42-43%, SB ~44%; 3-bets BTN vs CO
// ~6.5%, SB vs BTN ~9-10%, BB vs BTN ~12%, BB vs SB ~17%. The 4-bet ranges
// have no published figure and are structural estimates. Which hands fill
// each range is our own choice, and hands are all-or-nothing (no mixed
// frequencies).
//
// Fields:
//   id        stable identifier (safe to store or reference from a trainer)
//   game      'nlhe'
//   format    table format and stack depth the range assumes
//   spot      'open' (raise first in), '3bet', '4bet', or 'other'
//   hero      position taking the action (null when not position-specific)
//   villain   position (or positions) of the opponent's earlier raise
//   value     hands played for value, in range-text notation
//   bluff     hands played as bluffs or semi-bluffs ('' when none)
//   name      label shown in the picker
//   note      optional explanation (shown in the tooltip)

export const PRESET_FORMAT = '6max-100bb-cash';

export const RANGE_PRESETS = [
  {id: 'open-utg', spot: 'open', hero: 'UTG', villain: null, name: 'UTG open',
    value: '55+, A2s+, K9s+, QTs+, J9s+, T9s, 98s, 87s, 76s, 65s, ATo+, KJo+', bluff: ''},
  {id: 'open-hj', spot: 'open', hero: 'HJ', villain: null, name: 'HJ open',
    value: '44+, A2s+, K7s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, 65s, 54s, A9o+, KTo+, QJo', bluff: ''},
  {id: 'open-co', spot: 'open', hero: 'CO', villain: null, name: 'CO open',
    value: '33+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, A7o+, KTo+, QTo+, JTo', bluff: ''},
  {id: 'open-btn', spot: 'open', hero: 'BTN', villain: null, name: 'BTN open',
    value: '22+, A2s+, K2s+, Q3s+, J5s+, T6s+, 96s+, 85s+, 74s+, 63s+, 53s+, A2o+, K9o+, Q9o+, J9o+, T9o', bluff: ''},
  {id: 'open-sb', spot: 'open', hero: 'SB', villain: null, name: 'SB open',
    value: '22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 95s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o+, K9o+, Q9o+, J9o+, T9o', bluff: '',
    note: 'Hands the SB plays first in; many solver strategies limp part of this range instead of raising.'},

  {id: '3bet-vs-ep', spot: '3bet', hero: null, villain: ['UTG', 'HJ'], name: '3-bet vs UTG/HJ',
    value: 'JJ+, AQs+, AKo', bluff: 'A5s-A4s, KJs'},
  {id: '3bet-btn-vs-co', spot: '3bet', hero: 'BTN', villain: ['CO'], name: '3-bet BTN vs CO',
    value: 'TT+, AJs+, KQs, AKo', bluff: 'A5s-A3s, KTs, T9s, 76s, 65s'},
  {id: '3bet-sb-vs-btn', spot: '3bet', hero: 'SB', villain: ['BTN'], name: '3-bet SB vs BTN',
    value: 'TT+, AJs+, KQs, AQo+', bluff: 'A5s-A2s, KJs-KTs, K9s, QJs, JTs, T9s, 98s, 87s, 76s, 65s'},
  {id: '3bet-bb-vs-btn', spot: '3bet', hero: 'BB', villain: ['BTN'], name: '3-bet BB vs BTN',
    value: '99+, ATs+, KQs, AJo+', bluff: 'A5s-A2s, KJs-KTs, K9s, K8s, QJs, QTs, JTs, T9s, 98s, 87s, 76s, 65s, 54s'},
  {id: '3bet-bb-vs-sb', spot: '3bet', hero: 'BB', villain: ['SB'], name: '3-bet BB vs SB',
    value: '88+, A9s+, KQs, AJo+, KQo',
    bluff: 'A5s-A2s, KJs-K7s, Q9s+, J9s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, KTo, QJo'},

  {id: '4bet', spot: '4bet', hero: null, villain: null, name: '4-bet vs 3-bet',
    value: 'QQ+, AKs, AKo', bluff: 'A5s-A4s'},
  {id: '4bet-vs-blinds', spot: '4bet', hero: null, villain: ['SB', 'BB'], name: '4-bet vs blind 3-bet',
    value: 'JJ+, AQs+, AKo', bluff: 'A5s-A3s, KJs'},

  {id: 'premiums', spot: 'other', hero: null, villain: null, name: 'Premiums', value: 'QQ+, AKs, AKo', bluff: ''},
  {id: 'pairs', spot: 'other', hero: null, villain: null, name: 'All pocket pairs', value: '22+', bluff: ''},
  {id: 'suited-connectors', spot: 'other', hero: null, villain: null, name: 'Suited connectors',
    value: '54s, 65s, 76s, 87s, 98s, T9s, JTs', bluff: ''},
  {id: 'any-two', spot: 'other', hero: null, villain: null, name: 'Any two cards',
    value: '22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, A2o+, K2o+, Q2o+, J2o+, T2o+, 92o+, 82o+, 72o+, 62o+, 52o+, 42o+, 32o', bluff: ''},
].map(p => ({game: 'nlhe', format: PRESET_FORMAT, ...p}));

export const PRESET_GROUPS = [
  {spot: 'open', label: 'Open (raise first in)'},
  {spot: '3bet', label: '3-bet'},
  {spot: '4bet', label: '4-bet'},
  {spot: 'other', label: 'Other'},
];

/** Full range text for a preset: value hands plus bluffs. */
export function presetRangeText(p) {
  return p.bluff ? `${p.value}, ${p.bluff}` : p.value;
}

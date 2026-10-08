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
//   spot      'open' (raise first in), '3bet', '4bet', 'hu' (heads-up, from
//             ducy's GTO bot), or 'other'
//   context   optional: how the trainer describes the spot
//   hero      position taking the action (null when not position-specific)
//   villain   position (or positions) of the opponent's earlier raise
//   value     hands played for value, in range-text notation
//   bluff     hands played as bluffs or semi-bluffs ('' when none)
//   name      label shown in the picker
//   note      optional explanation (shown in the tooltip)

export const PRESET_FORMAT = '6max-100bb-cash';

// Heads-up, 100 big blinds: straight from ducy's GTO bot (the blueprint the
// #play page's GTO table uses, gto-hunl-300m), read with ducy-gto's
// preflop_ranges example:
//   cargo run --release -p ducy-gto --example preflop_ranges -- --cards cards.bin --blueprint blueprint.bin
// Its strategies mix: many hands take two actions some of the time. Each
// range holds the hands whose most frequent action this is, and the note
// says how often the bot takes the action over all hands, mixing included.
// The button is the small blind and acts first preflop; it opens to 2.5 big
// blinds, a 3-bet is to 3×, a 4-bet to 2.3×, and the next raise is all-in.
const HU_FORMAT = 'hu-100bb-cash';
const huNote = (pct, more = '') => `ducy’s GTO bot, heads-up at 100 bb: ${pct}% of all hands, mixing included.${more ? ' ' + more : ''}`;
const HU_GTO = [
  {id: 'hu-btn-open', hero: 'BTN', name: 'HU BTN open', context: 'Heads-up on the button, first to act',
    value: '33+, A2s+, K5s+, Q8s+, J7s+, T7s+, 96s+, 85s+, 74s+, 63s+, 53s+, 42s+, A7o+, KTo+, K8o-K7o, K4o, Q8o-Q4o, J7o-J4o, T7o-T5o, 96o-95o, 85o, 74o, 64o, 43o',
    note: huNote('49.7', 'It limps much of the rest: see BTN limp.')},
  {id: 'hu-btn-limp', hero: 'BTN', name: 'HU BTN limp', context: 'Heads-up on the button, first to act: limp?',
    value: '22, K4s-K2s, Q7s-Q2s, J6s-J2s, T6s-T2s, 95s-92s, 84s-82s, 73s-72s, 62s, 52s, 32s, A6o-A2o, K9o, K6o-K5o, K3o-K2o, Q9o+, Q3o-Q2o, J8o+, J3o-J2o, T8o+, T4o-T2o, 97o+, 94o-93o, 86o+, 84o, 75o+, 73o, 65o, 63o, 52o+',
    note: huNote('43.3', 'The button folds only 7%.')},
  {id: 'hu-bb-defend', hero: 'BB', name: 'HU BB defend vs open', context: 'Big blind, heads-up, facing a 2.5 bb open: call or 3-bet?',
    value: '99+, ATs+, KJs+, 87s, 65s, ATo+, KQo, 88, 77, 66, 55, 44, 33, 22, A9s-A2s, KTs-K2s, Q2s+, J2s+, T2s+, 92s+, 86s-82s, 73s+, 64s-62s, 52s+, 42s+, 32s, A9o-A2o, KJo-K5o, Q6o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o, 54o',
    note: huNote('65.9', 'Every hand it calls or 3-bets with; the next two presets split them.')},
  {id: 'hu-bb-call', hero: 'BB', name: 'HU BB call vs open', context: 'Big blind, heads-up, facing a 2.5 bb open: call?',
    value: '88, 77, 66, 55, 44, 33, 22, A9s-A2s, KTs-K2s, Q2s+, J2s+, T2s+, 92s+, 86s-82s, 73s+, 64s-62s, 52s+, 42s+, 32s, A9o-A2o, KJo-K5o, Q6o+, J7o+, T7o+, 97o+, 86o+, 76o, 65o, 54o',
    note: huNote('49.3')},
  {id: 'hu-bb-3bet', hero: 'BB', name: 'HU BB 3-bet vs open', context: 'Big blind, heads-up, facing a 2.5 bb open: 3-bet?',
    value: '99+, ATs+, KJs+, 87s, 65s, ATo+, KQo',
    note: huNote('16.6', 'Most of that is mixed: many more hands 3-bet some of the time than mostly.')},
  {id: 'hu-btn-4bet', hero: 'BTN', name: 'HU BTN 4-bet vs 3-bet', context: 'Button, heads-up, your open was 3-bet: 4-bet?',
    value: 'JJ+, AKs, AKo',
    note: huNote('8.4', 'Hands outside this range 4-bet now and then as bluffs.')},
  {id: 'hu-btn-call-3bet', hero: 'BTN', name: 'HU BTN call vs 3-bet', context: 'Button, heads-up, your open was 3-bet: call?',
    value: 'TT, 99, 88, 77, 66, 55, 44, 33, 22, AQs-A2s, K2s+, Q2s+, J4s+, J2s, T4s+, 95s+, 84s+, 73s+, 63s+, 52s+, 42s+, 32s, AQo-A9o, K9o+, QTo+, J9o+, T8o+, 98o',
    note: huNote('35.3')},
  {id: 'hu-bb-5bet', hero: 'BB', name: 'HU BB all-in vs 4-bet', context: 'Big blind, heads-up, your 3-bet was 4-bet: all-in?',
    value: 'KK, QQ, 77, 66, 55, 44, 33, 22, AKs, A5s, A3s-A2s, AKo',
    note: huNote('7.5', 'Aces mostly just call, to trap.')},
  {id: 'hu-bb-call-4bet', hero: 'BB', name: 'HU BB call vs 4-bet', context: 'Big blind, heads-up, your 3-bet was 4-bet: call?',
    value: 'AA, JJ, TT, 99, 88, AQs-A6s, A4s, K9s+, Q9s+, J9s+, T8s+, 98s, 86s+, 75s+, 65s, 54s, AQo-ATo, KQo',
    note: huNote('13.3')},
  {id: 'hu-bb-iso', hero: 'BB', name: 'HU BB raise vs limp', context: 'Big blind, heads-up, the button limped: raise?',
    value: '44+, A5s+, A3s, K6s+, Q7s+, Q5s, JTs, J8s-J7s, T7s+, T5s, 96s+, 87s, 85s-84s, 75s+, 63s+, 54s, A7o+, A5o, KJo+, K9o, Q8o, 76o',
    note: huNote('36.1', 'The rest checks.')},
  {id: 'hu-btn-3bet-iso', hero: 'BTN', name: 'HU BTN 3-bet vs raise', context: 'Button, heads-up, you limped and the big blind raised: 3-bet?',
    value: 'TT+, AJs+, KQs, AQo+, KQo',
    note: huNote('10.5')},
  {id: 'hu-btn-call-iso', hero: 'BTN', name: 'HU BTN call vs raise', context: 'Button, heads-up, you limped and the big blind raised: call?',
    value: '99, 88, 77, 66, 55, 44, 33, 22, ATs-A2s, KJs-K2s, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, AJo-A2o, KJo-K3o, Q6o+, J7o+, T7o+, 96o+, 86o+, 75o+, 64o+, 53o+',
    note: huNote('62.4')},
].map(p => ({spot: 'hu', villain: null, bluff: '', format: HU_FORMAT, ...p}));

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

  ...HU_GTO,

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
  {spot: 'hu', label: 'Heads-up GTO (ducy’s GTO bot)'},
  {spot: 'other', label: 'Other'},
];

/** Full range text for a preset: value hands plus bluffs. */
export function presetRangeText(p) {
  return p.bluff ? `${p.value}, ${p.bluff}` : p.value;
}

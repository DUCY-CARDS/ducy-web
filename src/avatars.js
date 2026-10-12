// Seat avatars: each bot's main look, keyed by personality id, and the
// player avatars people pick from. The SVGs in avatars/ are drawn in ducy's
// avatar gallery and exported from it; edit them there, not here.

export const BOT_AVATARS = new Set([
  'doug_poker',
  'jonny_slow',
  'mister_cheating',
  'milk_king',
  'phil_bigmouth',
  'rampart',
  'danny_smallball',
  'chris_moneybags',
  'robin_jane_lewd',
  'gus_bluffsen',
  'jen_silly',
  'michael_miserable',
  'brad_owned',
  'nik_airbag',
  'bungleman',
  'tom_collins',
  'the_mathematician',
  'andrew_favorable',
  'tommy_sweeden',
]);

export const PLAYER_AVATARS = [
  {id: 'player-01', label: 'Hoodie'},
  {id: 'player-02', label: 'Silver fox'},
  {id: 'player-03', label: 'Hoops'},
  {id: 'player-04', label: 'Turban'},
  {id: 'player-05', label: 'Afro'},
  {id: 'player-06', label: 'Backwards cap'},
  {id: 'player-07', label: 'Grandma'},
  {id: 'player-08', label: 'Braid'},
  {id: 'player-09', label: 'Bald & bearded'},
  {id: 'player-10', label: 'Glasses'},
  {id: 'player-11', label: 'Poker face'},
  {id: 'player-12', label: 'Curls'},
  {id: 'player-13', label: 'Jersey'},
  {id: 'player-14', label: 'Old pro'},
  {id: 'player-15', label: 'Laughing'},
  {id: 'player-16', label: 'Beanie'},
  // The Bitcoin set: cartoon nods to Bitcoin personalities. The names are
  // placeholders; each lives only here, and each avatar is its own SVG and
  // its own line, so renaming or dropping one is a one-line change.
  {id: 'btc_satoshi', label: 'Satoshi Nakamaybe', set: 'Bitcoin'},
  {id: 'btc_hal', label: 'Hal Funny', set: 'Bitcoin'},
  {id: 'btc_sailor', label: 'Michael Sailor', set: 'Bitcoin'},
  {id: 'btc_adam', label: 'Adam Backspace', set: 'Bitcoin'},
  {id: 'btc_andreas', label: 'Andreas Antonopoker', set: 'Bitcoin'},
  {id: 'btc_poelstra', label: 'Andrew Polestar', set: 'Bitcoin'},
  {id: 'btc_jack', label: 'Jack Doorsie', set: 'Bitcoin'},
  {id: 'btc_stark', label: 'Elizabeth Spark', set: 'Bitcoin'},
  {id: 'btc_jameson', label: 'Jameson Lockdown', set: 'Bitcoin'},
  {id: 'btc_peter', label: 'Peter Toad', set: 'Bitcoin'},
  {id: 'btc_jimmy', label: 'Jimmy Strong', set: 'Bitcoin'},
  {id: 'btc_pieter', label: 'Pieter Schnorr', set: 'Bitcoin'},
  {id: 'btc_saifedean', label: 'Saifedean Ammo', set: 'Bitcoin'},
  {id: 'btc_greg', label: 'Greg Maxblock', set: 'Bitcoin'},
  {id: 'btc_luke', label: 'Luke Dash-Senior', set: 'Bitcoin'},
  {id: 'btc_shinobi', label: 'Shinobi', set: 'Bitcoin'},
  {id: 'btc_hodl', label: 'Mr Hodl', set: 'Bitcoin'},
  {id: 'btc_alpaca', label: 'Black Alpaca', set: 'Bitcoin'},
  {id: 'btc_mallers', label: 'Jack Mallets', set: 'Bitcoin'},
  {id: 'btc_mechanic', label: 'Bitcoin Mechanic', set: 'Bitcoin'},
  {id: 'btc_rob', label: 'CEO of Bitcoin', set: 'Bitcoin'},
];

// The URL of an avatar's SVG, next to this module (so inside the release folder).
export const avatarUrl = id => new URL(`./avatars/${id}.svg`, import.meta.url).href;

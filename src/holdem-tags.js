// Recognisable kinds of Hold'em starting hands, used by practice mode to spot
// patterns in mistakes ("you play too many weak offsuit hands") and to deal
// more of the kinds a player gets wrong. Each hand gets exactly one tag:
// ducy-training's holdem module (#464).

import { training } from '../wasm/ducy_wasm.js';

/** Plural descriptions, written to complete "you play too many ___". */
export const HOLDEM_TAG_LABELS = {
  pairs_big: 'big pairs (JJ+)',
  pairs_mid: 'middle pairs (77–TT)',
  pairs_small: 'small pairs (22–66)',
  ace_suited: 'suited aces with a weak kicker (A2s–A9s)',
  ace_offsuit: 'offsuit aces with a weak kicker (A2o–A9o)',
  broadway_suited: 'suited broadway hands (KQs, AJs, QTs…)',
  broadway_offsuit: 'offsuit broadway hands (KQo, AJo, QTo…)',
  connector_suited: 'suited connectors (T9s, 76s, 54s…)',
  gapper_suited: 'suited gappers (J9s, 86s, 64s…)',
  connector_offsuit: 'offsuit connectors and gappers (T9o, 86o…)',
  weak_suited: 'weak suited hands (K6s, Q4s, J3s…)',
  weak_offsuit: 'weak offsuit hands (K7o, Q5o, J8o…)',
};

/** The one tag for a two-card hand like ['Kh', '7d']. */
export function holdemTags(cards) {
  const tag = training({op: 'holdemTag', cards: cards.map(String)});
  return tag ? [tag] : [];
}

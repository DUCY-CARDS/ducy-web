// Recognisable kinds of Hold'em starting hands, used by practice mode to spot
// patterns in mistakes ("you play too many weak offsuit hands") and to deal
// more of the kinds a player gets wrong. Each hand gets exactly one tag.

const RV = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14};

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
  const [a, b] = cards.map(c => RV[c[0]]).sort((x, y) => y - x);
  const suited = cards[0][1] === cards[1][1];
  if (a === b) return [a >= 11 ? 'pairs_big' : a >= 7 ? 'pairs_mid' : 'pairs_small'];
  if (b >= 10) return [suited ? 'broadway_suited' : 'broadway_offsuit'];
  if (a === 14) return [suited ? 'ace_suited' : 'ace_offsuit'];
  // Wheel cards connect with the ace, but A-x is already covered above.
  const gap = a - b - 1;
  if (gap === 0) return [suited ? 'connector_suited' : 'connector_offsuit'];
  if (gap <= 2) return [suited ? 'gapper_suited' : gap === 1 ? 'connector_offsuit' : 'weak_offsuit'];
  return [suited ? 'weak_suited' : 'weak_offsuit'];
}

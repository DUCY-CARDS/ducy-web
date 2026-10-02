// Recognisable kinds of Omaha hands (4-6 cards), used by practice mode to spot
// patterns in mistakes ("you play too many weak suited hands") and to deal
// more of the kinds a player gets wrong. A hand can have several tags.

const RV = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14};

/** Plural descriptions, written to complete "you play too many ___". */
export const TAG_LABELS = {
  aa: 'aces (AAxx)',
  big_pair: 'kings or queens (KKxx, QQxx)',
  small_pair: 'hands built around a small pair',
  double_paired: 'double-paired hands',
  dead_cards: 'hands with trips or quads (dead cards)',
  double_suited: 'double-suited hands',
  rainbow: 'rainbow hands with no flush draw',
  suited_ace: 'hands with a suited ace',
  weak_suited: 'weak suited hands (suited, but no ace or king in the suit)',
  rundown: 'rundowns (four ranks in a row)',
  broadway: 'broadway-heavy hands',
  low: 'hands full of low cards',
  danglers: 'hands with a dangling card',
};

export function omahaTags(cards) {
  const ranks = cards.map(c => RV[c[0]]);
  const rc = {}, sc = {};
  for (const r of ranks) rc[r] = (rc[r] || 0) + 1;
  for (const c of cards) sc[c[1]] = (sc[c[1]] || 0) + 1;
  const pairs = Object.keys(rc).map(Number).filter(r => rc[r] === 2).sort((a, b) => b - a);
  const suited = Object.keys(sc).filter(s => sc[s] >= 2);
  const tags = [];

  if (rc[14] === 2) tags.push('aa');
  else if (rc[13] === 2 || rc[12] === 2) tags.push('big_pair');
  else if (pairs.length && pairs[0] <= 9) tags.push('small_pair');
  if (pairs.length >= 2) tags.push('double_paired');
  if (Object.values(rc).some(n => n >= 3)) tags.push('dead_cards');

  if (suited.length >= 2) tags.push('double_suited');
  if (!suited.length) tags.push('rainbow');
  const suitTops = suited.map(s => Math.max(...cards.filter(c => c[1] === s).map(c => RV[c[0]])));
  if (suitTops.includes(14)) tags.push('suited_ace');
  else if (suited.length && suitTops.every(t => t <= 12)) tags.push('weak_suited');

  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let run = 1, best = 1;
  for (let i = 1; i < distinct.length; i++) { run = distinct[i - 1] - distinct[i] === 1 ? run + 1 : 1; best = Math.max(best, run); }
  if (best >= 4) tags.push('rundown');
  if (ranks.filter(r => r >= 10).length >= 3) tags.push('broadway');
  if (ranks.filter(r => r <= 6).length >= Math.ceil(cards.length / 2) + 1) tags.push('low');

  const dangler = cards.some((c, i) => {
    const r = ranks[i];
    return rc[r] === 1 && sc[c[1]] === 1 &&
      !ranks.some((r2, j) => j !== i && r2 !== r && (Math.abs(r2 - r) <= 3 || (r === 14 && r2 <= 4) || (r2 === 14 && r <= 4)));
  });
  if (dangler) tags.push('danglers');
  return tags;
}

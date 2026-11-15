// A player's connection replaced by their newer one (4009, #618): another
// tab, or the other ducy site (the club site and ducy.cards share a player
// ID, #637). The close reason names the newer page's site, so the page that
// lost can say where it's open now (play-net.js replacedWhere).
export function replacedReason(origin) {
  let host = '';
  try { host = new URL(origin).host; } catch {}
  return host ? `replaced ${host}`.slice(0, 120) : 'replaced';
}

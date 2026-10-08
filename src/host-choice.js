// What the Host tab is showing (#152): null for the two choices, 'game' for
// starting a game to invite friends (play.js), or 'club' for creating a club
// (clubs.js). play-section.js draws the choices and the way back to them.

let pick = null;
const listeners = new Set();

export const hostPick = () => pick;

export function setHostPick(p) {
  if (p === pick) return;
  pick = p === 'game' || p === 'club' ? p : null;
  for (const f of listeners) f();
}

export function onHostPick(f) {
  listeners.add(f);
}

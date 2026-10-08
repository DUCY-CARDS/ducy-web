// Tournament blind structures (#78): presets, checking a structure, and how
// long a tournament will take. ducy does the work (ducy_play::structure, via
// its bindings); the tournament form (#77) shows the structure editor from
// tourney-structure-ui.js.
//
// A structure is a list of steps, in order:
//   {sb, bb, ante, minutes}   a level (ante: posted by every player dealt in)
//   {break: true, minutes}    a break between levels
// The last level stays once it's reached.

import { blindPresets, blindPreset, checkBlindStructure, estimateTournament } from '../wasm/ducy_wasm.js';

// The presets, [{id, label, minutes}]: Turbo, Regular and Deep.
let presets;
export function PRESETS() {
  return (presets ||= blindPresets());
}

// A preset's structure for a starting stack: levels until the big blind is
// several starting stacks, so it lasts even for a big field.
export function presetStructure(presetId, stack) {
  if (!Number.isSafeInteger(stack) || stack < 20) throw new Error('The starting stack must be at least 20 chips.');
  return blindPreset(presetId, BigInt(stack));
}

// Problems with a structure, as messages; none means it's playable.
export function checkStructure(steps) {
  if (!Array.isArray(steps) || !steps.length) return ['Add at least one level.'];
  try {
    return checkBlindStructure(steps);
  } catch {
    return ['Blinds and minutes must be numbers.'];
  }
}

// About how long a tournament takes to find a winner: {minutes, hands, level}
// (play and breaks, the hands a table plays, the level it ends in, from 1).
// `steps` must be playable (checkStructure).
export function estimate(steps, {stack, players, tableSize = 9, handsPerHour}) {
  return estimateTournament(steps, BigInt(stack), players, tableSize, handsPerHour);
}

// "about 3 h 20 min"
export function durationText(minutes) {
  const m = Math.round(minutes / 5) * 5;
  if (m < 60) return `about ${Math.max(5, m)} min`;
  return `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

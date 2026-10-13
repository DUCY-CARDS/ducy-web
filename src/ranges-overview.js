// Pre-flop ranges' first screen (V3, #225), like IXL: an overall score for
// each game, then that game's top-% skills, each a spade, filled once
// mastered (a score of 90 or more), with the next one to practise up front
// (#244). Picking a skill opens its practice in trainer.js. Pure: built from
// the trainer's saved progress.

import { MASTERY, skillState, skillKey } from './trainer-skills.js';
import { SPADE_PATH } from './home.js';

export const OVERVIEW_GAMES = [[2, 'Hold’em'], [4, 'Omaha 4'], [5, 'Omaha 5'], [6, 'Omaha 6']];
export const TOP_TARGETS = [10, 15, 20, 25, 30, 40, 50];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** A game's skills and score: {cards, name, skills: [{pct, ...state}], mastered, total, score}. */
export function gameSkills(progress, cards) {
  const skills = TOP_TARGETS.map(pct => ({pct, ...skillState(progress?.[skillKey(cards, pct)])}));
  const mastered = skills.filter(s => s.status === 'mastered').length;
  const name = OVERVIEW_GAMES.find(([n]) => n === cards)?.[1] || '';
  return {cards, name, skills, mastered, total: skills.length, score: Math.round(100 * mastered / skills.length)};
}

const spade = (cls, label) =>
  `<svg class="v3-spade ${cls}" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="${label}"><path d="${SPADE_PATH}"/></svg>`;

/** The overview's html, with game `cards` open. */
export function overviewHtml(progress, cards = 2) {
  const games = OVERVIEW_GAMES.map(([n]) => gameSkills(progress, n));
  const open = games.find(g => g.cards === cards) || games[0];
  let h = '<div class="v3 v3-embed"><div class="v3-page">';
  h += '<div class="v3-headline"><h1>Pre-flop ranges</h1><p>Test your ability to play different ranges.</p></div>';
  h += '<div class="v3-areas">';
  for (const g of games) {
    const on = g.cards === open.cards;
    h += `<button type="button" class="v3-area${on ? ' on' : ''}" data-ovgame="${g.cards}" aria-pressed="${on}">`;
    h += `<span class="v3-ring v3-ring-sm" style="--pct:${g.score}%" aria-hidden="true"><span>${g.score}</span></span>`;
    h += `<span class="v3-area-text"><b>${g.name}</b><span>${g.mastered} of ${g.total} skills</span></span></button>`;
  }
  h += '</div>';
  // One track per game (range-selection design, #244): the top-% skills,
  // the next to work on marked, and a big button to practise it. Opening
  // ranges by position come later (#249).
  const next = nextSkill(open);
  h += '<div class="v3-track">';
  h += `<section class="v3-skillcard"><div class="v3-skillcard-head"><span class="v3-tile-name">Your ranges</span><span>${MASTERY}+ earns a spade</span></div>`;
  h += '<div class="v3-skillrow v3-trackrow">';
  for (const s of open.skills) {
    const state = s.status === 'mastered' ? 'won' : 'open';
    const label = s.status === 'mastered' ? 'Mastered' : s.status === 'started' ? `Score ${s.score}` : 'Not started';
    h += `<button type="button" class="v3-skill${s === next ? ' next' : ''}" data-skill="${open.cards}:${s.pct}">${spade(state, label)}<span>Top ${s.pct}%</span><b>${s.status === 'new' ? '–' : s.score}</b></button>`;
  }
  h += '</div>';
  if (next) {
    const left = next.status === 'started' ? `${next.score} of ${MASTERY} to earn its spade.` : `Score ${MASTERY} to earn its spade.`;
    h += `<div class="v3-track-go"><button type="button" class="tr-start" data-skill="${open.cards}:${next.pct}">Practice top ${next.pct}%</button><span>${left}</span></div>`;
  } else {
    h += `<div class="v3-track-go"><span>Every ${esc(open.name)} range mastered. Tap one to keep practising.</span></div>`;
  }
  h += '</section>';
  h += '<aside class="v3-later"><b>Coming later</b><span>Opening ranges by position, for each game and number of players.</span></aside>';
  return h + '</div></div></div>';
}

/** The skill to work on next: the first not yet mastered, easiest first. */
export function nextSkill(game) {
  return game.skills.find(s => s.status !== 'mastered') || null;
}

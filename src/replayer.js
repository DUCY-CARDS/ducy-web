// The hand replayer (#72, #592): one dialog for any table's hands. It steps
// through a hand (buttons, ← →, Space plays), jumps by street, moves to the
// previous or next hand in its list (Shift+← →), opens the equity calculator
// at any step, and copies the hand as plain text.
//
// Hands are records as hand-replay.js makes them (ducy_play's HandRecord):
// the viewer's own cards (seat 0, unless the viewer is the host) and cards
// shown down, nothing else. What it draws, links and copies holds to that,
// and never shows a folded hand that isn't the viewer's.
//
// A page owns one Replayer, draws `html()` into itself, and passes it the
// clicks on [data-rp] (`click`) and the page's keys (`key`).

import { replayFrames, streetStarts, STREETS } from './hand-replay.js';
import { chipText } from './chip-format.js';
import { gameLabel } from './club-tables.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const SUIT = {s: '♠', h: '♥', d: '♦', c: '♣'};
const cardSpan = c => (c ? `<span class="cl-pc s-${c[1]}">${esc(c[0])}${SUIT[c[1]] || ''}</span>` : '<span class="cl-pc back"></span>');
const cap = s => s[0].toUpperCase() + s.slice(1);

// The equity calculator's game (main.js GM) for a table's game.
const EQUITY_GAME = {nlhe: 'nlhe', plo4: 'omaha', plo5: 'omaha5', plo6: 'omaha6'};
const BY_CARDS = {2: 'nlhe', 4: 'omaha', 5: 'omaha5', 6: 'omaha6'};

// Whether seat `k`'s cards may be shown to the viewer: their own, or a hand
// still in at the end (shown down). A folded hand never is, but the viewer's.
export function knownCards(rec, frames, k) {
  const cards = rec.seats[k]?.cards;
  if (!cards?.length) return null;
  if (rec.who !== 'host' && k === 0) return cards;
  return frames.at(-1)?.seats[k]?.folded ? null : cards;
}

// The equity calculator's address (#equity, main.js loadFromHash) for step
// `i` of a hand: its game and the board then; the viewer's own cards first,
// then each other seat still in: its cards if they were shown down, else
// random. Folded hands are left out (the viewer's own stays in).
export function equityHash(rec, frames, i) {
  const f = frames[Math.max(0, Math.min(frames.length - 1, i))];
  const parts = [`g=${EQUITY_GAME[rec.game] || BY_CARDS[rec.holeCards] || 'nlhe'}`];
  const mine = rec.who !== 'host' ? 0 : -1;
  const hands = [];
  f.seats.forEach((s, k) => {
    if (!s.inHand || (s.folded && k !== mine)) return;
    const cards = knownCards(rec, frames, k);
    if (k === mine && !cards) return;
    const hand = cards ? cards.join('.') : 'random';
    if (k === mine) hands.unshift(hand); else hands.push(hand);
  });
  hands.forEach((h, n) => parts.push(`p${n}=${h}`));
  const board = (f.board || []).slice(0, 5);
  if (board.length) parts.push(`b=${board.join('.')}`);
  return `#${parts.join('&')}`;
}

// The hand as plain text, in the usual hand-history layout: a header, the
// seats and stacks, the viewer's cards, each street's actions, what was
// shown, and the result.
export function handText(rec, frames = replayFrames(rec)) {
  const c = chipText;
  const at = new Date(rec.at);
  const lines = [`${rec.tableName || 'Table'} · hand #${rec.hand} · ${gameLabel(rec.game) || 'Hold’em'} ${c(rec.sb)}/${c(rec.bb)} · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`];
  const start = frames[0];
  rec.seats.forEach((s, k) => {
    if (!s.inHand) return;
    lines.push(`Seat ${k + 1}: ${s.name} (${c(start.seats[k].stack)})${k === rec.button ? ' [button]' : ''}`);
  });
  let street = 'preflop';
  const mine = rec.who !== 'host' ? knownCards(rec, frames, 0) : null;
  let dealt = false;
  const deal = () => {
    if (dealt) return;
    dealt = true;
    lines.push('*** Hole cards ***');
    if (mine) lines.push(`Dealt to ${rec.seats[0].name} [${mine.join(' ')}]`);
  };
  for (const f of frames.slice(1)) {
    const e = f.event;
    if (!e) continue;
    if (e.type === 'board') {
      deal();
      street = f.street;
      lines.push(`*** ${cap(street)} *** [${f.board.join(' ')}]`);
      continue;
    }
    // The blinds and antes come before the deal; the first action after it.
    if (!['ante', 'post', 'small_blind', 'big_blind'].includes(e.type)) deal();
    // A show is drawn from the record below, by the privacy rule.
    if (e.type === 'show') continue;
    lines.push(f.text);
  }
  deal();
  lines.push('*** Summary ***');
  lines.push(`Total pot ${c(rec.pot)}`);
  const board = frames.at(-1).board;
  if (board?.length) lines.push(`Board [${board.join(' ')}]`);
  rec.seats.forEach((s, k) => {
    if (!s.inHand) return;
    const cards = knownCards(rec, frames, k);
    const shown = cards && !(k === 0 && rec.who !== 'host' && frames.at(-1).seats[0].folded) ? ` [${cards.join(' ')}]` : '';
    lines.push(`${s.name}${shown}: ${s.net > 0 ? '+' : ''}${c(s.net)}`);
  });
  return lines.join('\n');
}

export class Replayer {
  // `onChange`: redraws the page. `equityLink(hash)`: the link to the
  // calculator from this page, {href, target} (default: the hash, for a
  // page of index.html; target '_blank' opens a new tab).
  constructor({onChange = () => {}, equityLink = href => ({href, target: ''})} = {}) {
    Object.assign(this, {onChange, equityLink});
    this.state = null; // {hands, at, rec, frames, i, playing, copied, copyText}
  }

  get isOpen() { return !!this.state; }

  // Opens `rec`, one of `hands` (any order; previous and next go by time).
  open(rec, hands = [rec]) {
    this.stopPlaying();
    const list = [...new Map([...hands, rec].map(r => [r.id, r])).values()].sort((a, b) => a.at - b.at || a.hand - b.hand);
    this.state = {hands: list, at: list.findIndex(r => r.id === rec.id), i: 0, playing: null};
    this.load();
  }

  load() {
    const s = this.state;
    s.rec = s.hands[s.at];
    s.frames = replayFrames(s.rec);
    s.i = 0;
    s.copied = false;
    s.copyText = '';
    this.onChange();
  }

  // The previous (-1) or next (+1) hand in the list.
  moveHand(d) {
    const s = this.state;
    if (!s || !s.hands[s.at + d]) return;
    this.stopPlaying();
    s.at += d;
    this.load();
  }

  step(to) {
    const s = this.state;
    if (!s) return;
    s.i = Math.max(0, Math.min(s.frames.length - 1, to));
    this.onChange();
  }

  stopPlaying() {
    if (this.state?.playing) { clearInterval(this.state.playing); this.state.playing = null; }
  }

  togglePlay() {
    const s = this.state;
    if (!s) return;
    if (s.playing) { this.stopPlaying(); this.onChange(); return; }
    if (s.i >= s.frames.length - 1) s.i = 0;
    s.playing = setInterval(() => {
      if (this.state !== s || s.i >= s.frames.length - 1) { clearInterval(s.playing); s.playing = null; this.onChange(); return; }
      this.step(s.i + 1);
    }, 900);
    this.onChange();
  }

  close() {
    this.stopPlaying();
    this.state = null;
    this.onChange();
  }

  // Copies the hand. The clipboard call comes straight from the click; if
  // it's refused, the text shows, selected, to copy by hand.
  copy(el = null) {
    const s = this.state;
    if (!s) return;
    const text = handText(s.rec, s.frames);
    const failed = () => {
      if (this.state !== s) return;
      s.copyText = text;
      this.onChange();
      const box = el?.ownerDocument?.querySelector('.cl-replay-copytext') || globalThis.document?.querySelector('.cl-replay-copytext');
      box?.focus();
      box?.select();
    };
    try {
      const p = globalThis.navigator?.clipboard?.writeText(text);
      if (!p) { failed(); return; }
      p.then(() => { if (this.state === s) { s.copied = true; this.onChange(); } }, failed);
    } catch {
      failed();
    }
  }

  // A click on one of its controls ([data-rp]); true if it was one.
  click(b) {
    const act = b?.dataset?.rp;
    if (!act || !this.state) return false;
    if (act === 'to') this.step(Number(b.dataset.i));
    else if (act === 'play') this.togglePlay();
    else if (act === 'close') this.close();
    else if (act === 'prev') this.moveHand(-1);
    else if (act === 'next') this.moveHand(1);
    else if (act === 'copy') this.copy(b);
    // The Equity link goes on; the replay stays where it is for coming back.
    else if (act === 'equity') this.stopPlaying();
    else return false;
    return true;
  }

  // The page's keys while it's open: ← → step, Shift+← → change hands,
  // Space plays, Esc closes. True if it took the key.
  key(e) {
    if (!this.state || e.target?.closest?.('input, select, textarea')) return false;
    const s = this.state;
    if (e.key === 'ArrowRight' && e.shiftKey) this.moveHand(1);
    else if (e.key === 'ArrowLeft' && e.shiftKey) this.moveHand(-1);
    else if (e.key === 'ArrowRight') this.step(s.i + 1);
    else if (e.key === 'ArrowLeft') this.step(s.i - 1);
    else if (e.key === ' ') this.togglePlay();
    else if (e.key === 'Escape') this.close();
    else return false;
    e.preventDefault?.();
    return true;
  }

  html() {
    const s = this.state;
    if (!s) return '';
    const {rec, frames, i, hands, at} = s;
    const f = frames[i];
    const starts = streetStarts(frames);
    const c = chipText;
    let h = '<div class="cl-replay-bg" data-rp="close"></div><div class="cl-replay" role="dialog" aria-label="Hand replay">';
    h += `<div class="cl-replay-head"><b>${esc(rec.tableName)} · hand ${rec.hand}</b><span class="pl-meta">${esc(new Date(rec.at).toLocaleString())} · blinds ${c(rec.sb)}/${c(rec.bb)}</span><button class="link-btn" data-rp="close">Close</button></div>`;
    if (hands.length > 1) {
      h += '<div class="cl-replay-hands">';
      h += `<button class="btn-small" data-rp="prev"${at > 0 ? '' : ' disabled'} title="Shift+←">‹ Previous hand</button>`;
      h += `<span class="pl-meta">${at + 1}/${hands.length}</span>`;
      h += `<button class="btn-small" data-rp="next"${at < hands.length - 1 ? '' : ' disabled'} title="Shift+→">Next hand ›</button></div>`;
    }
    h += `<div class="cl-replay-board">${[0, 1, 2, 3, 4].map(k => (f.board[k] ? cardSpan(f.board[k]) : '<span class="cl-pc slot"></span>')).join('')}<span class="cl-chips">Pot ${c(f.pot)}</span></div>`;
    h += '<ul class="cl-replay-seats">';
    const last = i === frames.length - 1;
    f.seats.forEach((p, k) => {
      if (!p.inHand) return;
      const btn = k === rec.button ? ' <span class="pl-meta">(D)</span>' : '';
      // Cards the viewer saw: their own, and any shown down (only at the end).
      const cards = knownCards(rec, frames, k);
      const own = rec.who !== 'host' && k === 0;
      const hole = cards && (own || last) ? cards.map(cardSpan).join('') : new Array(rec.holeCards).fill(null).map(cardSpan).join('');
      h += `<li class="${p.folded ? 'folded' : ''}${f.event?.seat === k ? ' acting' : ''}"><span class="cl-name">${esc(p.name)}${btn}</span><span class="cl-hole">${hole}</span>`;
      h += `<span class="cl-chips">${c(p.stack)}</span>${p.bet ? `<span class="cl-bet">bet ${c(p.bet)}</span>` : ''}${p.folded ? '<span class="pl-meta">folded</span>' : ''}${p.allIn ? '<span class="pl-meta">all-in</span>' : ''}</li>`;
    });
    h += '</ul>';
    h += `<p class="cl-replay-text">${esc(f.text)}</p>`;
    h += '<div class="cl-replay-controls">';
    h += `<button class="btn-small" data-rp="to" data-i="0" title="Start" aria-label="Start">⏮</button><button class="btn-small" data-rp="to" data-i="${i - 1}"${i ? '' : ' disabled'} title="Back (←)" aria-label="Back">◀</button>`;
    h += `<button class="btn-small primary" data-rp="play">${s.playing ? 'Pause' : 'Play'}</button>`;
    h += `<button class="btn-small" data-rp="to" data-i="${i + 1}"${last ? ' disabled' : ''} title="Forward (→)" aria-label="Forward">▶</button><button class="btn-small" data-rp="to" data-i="${frames.length - 1}" title="End" aria-label="End">⏭</button>`;
    h += `<span class="pl-meta">${i + 1}/${frames.length}</span>`;
    h += STREETS.filter(st => st in starts).map(st => `<button class="cc-btn${f.street === st ? ' on' : ''}" data-rp="to" data-i="${starts[st]}">${cap(st)}</button>`).join('');
    h += '</div>';
    const link = this.equityLink(equityHash(rec, frames, i));
    const target = link.target ? ` target="${esc(link.target)}" rel="noopener"` : '';
    h += `<div class="cl-replay-tools"><a class="btn-small" data-rp="equity" href="${esc(link.href)}"${target}>Equity</a>`;
    h += `<button class="btn-small" data-rp="copy">${s.copied ? 'Copied ✓' : 'Copy hand'}</button></div>`;
    if (s.copyText) h += `<textarea class="pl-text cl-replay-copytext" readonly rows="8" aria-label="Hand text">${esc(s.copyText)}</textarea>`;
    return h + '</div>';
  }
}

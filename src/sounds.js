// Sounds at the table, with people or bots. Alerts: a gentle chime when it's
// your turn, and a sharper alert when 5 seconds are left to act (where
// there's a turn clock). Game sounds, a separate setting: chips, cards, the
// shuffle and the pot (below). Made with Web
// Audio, so there are no sound files. Browsers only let a page play sound
// after the person has interacted with it: `unlockSounds()` is called on
// each click, and until then the sounds are simply silent.

let ctx = null;

function audio() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  return ctx;
}

// Called from a click: lets sounds play from then on.
export function unlockSounds() {
  const a = audio();
  if (a?.state === 'suspended') a.resume().catch(() => {});
}

// One tone: frequency (Hz), when it starts (s from now), how long (s), how
// loud (0–1), and the wave's shape.
function tone(a, freq, at, dur, gain, type = 'sine') {
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  // A quick rise and a soft fall, so it doesn't click.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function play(fn) {
  const a = audio();
  if (!a || a.state !== 'running') return false;
  try { fn(a); return true; } catch { return false; }
}

// Your turn: two soft rising notes.
export function turnSound() {
  return play(a => {
    tone(a, 660, 0, 0.35, 0.12);
    tone(a, 880, 0.12, 0.45, 0.1);
  });
}

// 5 seconds left: three short, brighter beeps.
export function hurrySound() {
  return play(a => {
    for (let i = 0; i < 3; i++) tone(a, 1040, i * 0.16, 0.12, 0.16, 'triangle');
  });
}

// ---- Game sounds: chips, cards, the shuffle and the pot ----
//
// Made from short bursts of filtered noise, so they sound like clay chips
// and card stock rather than beeps. A separate setting from the alerts above.

let noise = null;
// Half a second of white noise, made once and reused.
function noiseBuffer(a) {
  if (noise && noise.sampleRate === a.sampleRate) return noise;
  noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.5), a.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

// One click of noise: when (s from now), how long (s), how loud, and the
// band it's filtered to (Hz) with its sharpness.
function burst(a, at, dur, gain, freq, q = 1.2) {
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t, Math.random() * 0.4);
  src.stop(t + dur + 0.02);
}

// Chips: a few clacks close together, more for a bigger bet; an all-in is a
// whole stack.
export function chipsSound(size = 1) {
  return play(a => {
    const clicks = Math.min(9, 2 + Math.round(size * 2));
    let t = 0;
    for (let i = 0; i < clicks; i++) {
      burst(a, t, 0.05, 0.22, 3200 + Math.random() * 1600, 2.5);
      t += 0.025 + Math.random() * 0.035;
    }
  });
}

// A card dealt to the board: a soft flick; the flop is three.
export function cardSound(cards = 1) {
  return play(a => {
    for (let i = 0; i < cards; i++) burst(a, i * 0.11, 0.06, 0.2, 1800, 0.8);
  });
}

// The shuffle before a hand: a riffle of quick, quiet clicks that speeds up.
export function shuffleSound() {
  return play(a => {
    let t = 0;
    for (let i = 0; i < 26; i++) {
      burst(a, t, 0.025, 0.08 + 0.04 * Math.random(), 2600 + Math.random() * 1200, 1.5);
      t += 0.03 - i * 0.0006;
    }
  });
}

// The pot pushed to its winner: chips sliding together; when it's yours, a
// bright two-note lift on top.
export function potSound(mine = false) {
  return play(a => {
    let t = 0;
    for (let i = 0; i < 12; i++) {
      burst(a, t, 0.06, 0.16, 2800 + Math.random() * 1400, 2);
      t += 0.02 + Math.random() * 0.02;
    }
    if (mine) {
      tone(a, 784, 0.18, 0.3, 0.08);
      tone(a, 1175, 0.3, 0.4, 0.07);
    }
  });
}

// Sounds at a table played with other people: a gentle chime when it's your
// turn, and a sharper alert when 5 seconds are left to act. Made with Web
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

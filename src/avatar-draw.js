// Avatar drawing, exported from ducy's avatar gallery (export-draw.mjs):
// edit it there, not here. avatar(o) draws a 120x120 SVG from its options,
// seatAvatar(o) the seat version (props and text that don't read at seat
// size dropped, arms on the table edge). The site draws the Bankroll
// Challenge's generic players with it (quest-faces.js).
/* eslint-disable */
const SKIN = { s1: '#f7d8bf', s2: '#edbd98', s3: '#d8a37b', s4: '#b67650', s5: '#895434', s6: '#5d3922', ea: '#eec59c' };

function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) {
  const x = hex(a), y = hex(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
let uid = 0;
const MIRROR = 'transform="translate(120,0) scale(-1,1)"';

// Seat avatars keep what reads at 40–56px (silhouette, hair, hats, glasses,
// facial hair, shirt colour) and drop small props and text.
const SEAT_ACC = ['tie', 'bowtie', 'pearls', 'chain', 'goldchains', 'diamonds', 'collar'];
const SEAT_X = ['lashes', 'blush', 'earrings', 'hoops', 'drops', 'chandelier', 'muscle', 'wrinkles', 'gamechair', 'saltpepper', 'graying', 'touchgray'];
function seatAvatar(o) {
  return avatar(Object.assign({}, o, {
    bubble: null, cards: null, teeText: null, hatText: null, hatTiles: null,
    acc: (o.acc || []).filter(k => SEAT_ACC.includes(k)),
    x: (o.x || []).filter(k => SEAT_X.includes(k)),
  }), true);
}

function avatar(o, seat) {
  const p = Object.assign({
    skin: 's2', face: 'oval', hair: 'short', hairC: '#4a3324', beard: 'none', beardC: null,
    eyes: 'normal', brows: 'normal', mouth: 'smile', glasses: 'none', glassC: '#1d1d1f',
    hat: 'none', hatC: '#2b4c7e', top: 'tee', topC: '#3d5a80', acc: [], x: [], bg: '#dde6ea',
    bubble: null, cards: null, name: null,
  }, o);
  const id = 'a' + (++uid);
  const skin = SKIN[p.skin] || p.skin;
  const line = mix(skin, '#000000', 0.42);
  const hairC = p.hairC, hairD = mix(hairC, '#000000', 0.3);
  const bc = p.beardC || hairC;
  const [rx, ry] = { oval: [21, 25], round: [23, 23], long: [20, 27], wide: [24, 23], square: [22, 25], heavy: [26, 24], heart: [23, 25] }[p.face];
  const L = 60 - rx, R = 60 + rx, T = 54 - ry;
  const has = k => p.acc.includes(k) || p.x.includes(k);
  const s = [];

  // Background
  s.push(`<rect width="120" height="120" rx="14" fill="${p.bg}"/>`);
  s.push(`<circle cx="60" cy="60" r="46" fill="#ffffff" opacity=".16"/>`);
  if (has('formula')) {
    s.push(`<g font-family="IBM Plex Mono, monospace" font-size="6.5" fill="#ffffff" opacity=".55">
      <text x="8" y="16">EV = Σ p·x</text><text x="78" y="22">P(A|B)</text>
      <text x="6" y="88">f = b/(b+1)</text><text x="84" y="80">√n</text><text x="88" y="42">1:3</text></g>`);
  }
  if (has('spotlight')) s.push(`<path d="M44,0 L76,0 L108,120 L12,120Z" fill="#fff8d6" opacity=".55"/>`);
  if (has('balcony')) s.push(`<rect x="0" y="0" width="120" height="120" rx="14" fill="#bfe3f5"/><circle cx="100" cy="18" r="9" fill="#ffe08a"/><g fill="#9fb8c8">${[[4, 58, 12, 50], [17, 44, 10, 64], [28, 62, 14, 46], [80, 50, 12, 58], [93, 38, 10, 70], [104, 56, 14, 52]].map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')}</g><g fill="#dfeef6" opacity=".7">${[[19, 50], [22, 58], [95, 44], [98, 54], [6, 64], [83, 58]].map(([x, y]) => `<rect x="${x}" y="${y}" width="2.4" height="3"/>`).join('')}</g><rect x="0" y="86" width="120" height="3" fill="#e9eef1"/><g fill="#e9eef1">${[...Array(13)].map((_, i) => `<rect x="${2 + i * 9.5}" y="88" width="2" height="32"/>`).join('')}</g>`);
  if (has('felt')) s.push(`<ellipse cx="60" cy="122" rx="70" ry="22" fill="#0d6a47" opacity=".35"/>`);
  if (has('flagbg')) s.push(`<rect x="0" y="0" width="120" height="120" rx="14" fill="#1d5fa8" opacity=".25"/><rect x="30" y="0" width="12" height="120" fill="#f5c400" opacity=".35"/><rect x="0" y="40" width="120" height="12" fill="#f5c400" opacity=".35"/>`);
  // Everything from here to the props is the figure; `zoom` < 1 shrinks it toward the top so more of the outfit shows.
  const fig = s.length;

  // Racing-style gaming chair: tall winged back, stripes, headrest pillow.
  if (has('gamechair')) s.push(`<g><path d="M14,120 L12,92 C8,86 10,76 18,74 L20,22 C20,10 34,6 60,6 C86,6 100,10 100,22 L102,74 C110,76 112,86 108,92 L106,120Z" fill="#e53935"/><path d="M24,120 L23,24 C23,15 36,12 60,12 C84,12 97,15 97,24 L96,120Z" fill="#9aa3b2"/><path d="M30,120 L29,26 C29,19 40,17 60,17 C80,17 91,19 91,26 L90,120Z" fill="#c9d0db"/><rect x="46" y="8" width="28" height="10" rx="5" fill="#1c1c22"/><path d="M50,13 h20" stroke="#e53935" stroke-width="1.6"/></g>`);
  if (p.hair === 'afro') s.push(`<ellipse cx="60" cy="${T + 12}" rx="${rx + 11}" ry="${ry + 6}" fill="${p.hairC}"/>`);
  if (p.hair === 'braid') s.push(`<g fill="${mix(p.hairC, '#000000', 0.25)}">${[0, 1, 2, 3, 4].map(i => `<ellipse cx="${R + 1 - i * 0.6}" cy="${62 + i * 8}" rx="4.6" ry="5"/>`).join('')}</g>`);
  if (p.hat === 'hijab') s.push(`<path d="M${L - 9},104 C${L - 12},70 ${L - 8},${T - 9} 60,${T - 9} C${R + 8},${T - 9} ${R + 12},70 ${R + 9},104 C${R},98 ${L},98 ${L - 9},104Z" fill="${mix(p.hatC, '#000000', 0.12)}"/>`);
  // Behind the head: hood, long hair
  if (p.hat === 'hood') s.push(`<path d="M${L - 9},96 C${L - 12},50 ${L - 4},${T - 10} 60,${T - 10} C${R + 4},${T - 10} ${R + 12},50 ${R + 9},96Z" fill="${mix(p.topC, '#000000', 0.15)}"/>`);
  if (p.hair === 'long') s.push(`<path d="M${L - 3},44 C${L - 7},70 ${L - 7},92 ${L - 2},102 L${R + 2},102 C${R + 7},92 ${R + 7},70 ${R + 3},44Z" fill="${hairD}"/>`);
  if (p.hair === 'glam') s.push(`<path d="M${L - 6},42 C${L - 13},58 ${L - 13},78 ${L - 8},92 C${L - 2},98 ${L + 6},96 ${L + 8},90 L${R - 8},90 C${R - 6},96 ${R + 2},98 ${R + 8},92 C${R + 13},78 ${R + 13},58 ${R + 6},42Z" fill="${hairD}"/>`);
  if (p.hair === 'shoulder') s.push(`<path d="M${L - 4},44 C${L - 9},60 ${L - 9},76 ${L - 6},88 Q${L - 2},92 ${L + 3},88 Q${L + 6},92 ${L + 9},88 L${R - 9},88 Q${R - 6},92 ${R - 3},88 Q${R + 2},92 ${R + 6},88 C${R + 9},76 ${R + 9},60 ${R + 4},44Z" fill="${hairD}"/>`);
  if (p.hair === 'pastshoulder') s.push(`<path d="M${L - 4},42 C${L - 11},56 ${L - 9},72 ${L - 12},86 C${L - 14},96 ${L - 9},104 ${L - 2},102 Q${L + 6},99 ${L + 10},96 L${R - 10},96 Q${R - 6},99 ${R + 2},102 C${R + 9},104 ${R + 14},96 ${R + 12},86 C${R + 9},72 ${R + 11},56 ${R + 4},42Z" fill="${hairD}"/>`);
  if (p.hair === 'bob') s.push(`<path d="M${L - 4},44 C${L - 6},64 ${L - 6},76 ${L - 1},82 L${R + 1},82 C${R + 6},76 ${R + 6},64 ${R + 4},44Z" fill="${hairD}"/>`);
  if (p.hair === 'curlylong') s.push(`<g fill="${hairD}">${[...Array(9)].map((_, i) => `<circle cx="${L - 4 + (i % 2) * 2}" cy="${44 + i * 6}" r="8"/><circle cx="${R + 4 - (i % 2) * 2}" cy="${44 + i * 6}" r="8"/>`).join('')}</g>`);

  // Neck and body
  const nk = p.face === 'heavy' ? 13 : 8;
  s.push(`<path d="M${60 - nk},68 L${60 - nk},92 Q60,97 ${60 + nk},92 L${60 + nk},68Z" fill="${skin}"/><path d="M${60 - nk},74 Q60,80 ${60 + nk},74 L${60 + nk},70 L${60 - nk},70Z" fill="${line}" opacity=".18"/>`);
  s.push(clothes(p, skin, id));

  // Head
  const er = p.bigEars ? [5.6, 7.4, 1.5] : [4.2, 6.2, 0.5];
  s.push(`<ellipse cx="${L + er[2]  - (p.bigEars ? 1.5 : 0)}" cy="56" rx="${er[0]}" ry="${er[1]}" fill="${skin}" stroke="${line}" stroke-width=".7"/>`);
  s.push(`<ellipse cx="${R - er[2] + (p.bigEars ? 1.5 : 0)}" cy="56" rx="${er[0]}" ry="${er[1]}" fill="${skin}" stroke="${line}" stroke-width=".7"/>`);
  if (has('cheekbones')) s.push(`<path d="M${L + 4},60 q4,4 8,4 M${R - 4},60 q-4,4 -8,4" stroke="${line}" stroke-width=".8" fill="none" opacity=".5"/>`);
  // The face's outline, without paint: drawn here, and reused to keep stubble on the skin.
  const faceShape = p.face === 'heart' ? `<path d="M60,${T} C73,${T} ${R + 0.5},${T + 7} ${R + 0.5},51 C${R + 0.5},60 ${R - 4},67 68,73 Q63.5,78.5 60,79.5 Q56.5,78.5 52,73 C${L + 4},67 ${L - 0.5},60 ${L - 0.5},51 C${L - 0.5},${T + 7} 47,${T} 60,${T}Z"`
    : p.face === 'heavy' ? `<path d="M60,${T} C72,${T} ${R},${T + 7} ${R},52 C${R + 1.5},63 ${R - 3},75 60,80 C${L + 3},75 ${L - 1.5},63 ${L},52 C${L},${T + 7} 48,${T} 60,${T}Z"`
    : p.face === 'square' ? `<path d="M${L},50 C${L},${T + 2} 48,${T} 60,${T} C72,${T} ${R},${T + 2} ${R},50 L${R - 0.5},64 C${R - 1},72 ${R - 6},77 ${R - 9},78.5 L${L + 9},78.5 C${L + 6},77 ${L + 1},72 ${L + 0.5},64Z"`
    : `<ellipse cx="60" cy="54" rx="${rx}" ry="${ry}"`;
  s.push(`${faceShape} fill="${skin}" stroke="${line}" stroke-width=".8"/>`);
  if (has('redface')) s.push(`<ellipse cx="60" cy="56" rx="${rx - 1}" ry="${ry - 2}" fill="#e53935" opacity=".32"/>`);
  if (has('blush')) s.push(`<ellipse cx="47" cy="61" rx="4.5" ry="2.6" fill="#ef6f8a" opacity=".38"/><ellipse cx="73" cy="61" rx="4.5" ry="2.6" fill="#ef6f8a" opacity=".38"/>`);
  if (has('wrinkles')) s.push(`<g fill="none" stroke="${line}" stroke-width=".7" opacity=".55"><path d="M51,${T + 8} q9,-2 18,0 M53,${T + 11} q7,-1.6 14,0"/><path d="M42,51 l-3,-1 M42,54 l-3,0 M78,51 l3,-1 M78,54 l3,0"/><path d="M50,64 q-3,3 -2,7 M70,64 q3,3 2,7"/></g>`);
  // Graceful 50s: soft crow's feet, light smile lines, a faint under-eye crease. Subtler than 'wrinkles'.
  if (has('mature')) s.push(`<g fill="none" stroke="${line}" stroke-width=".7" stroke-linecap="round" opacity=".55"><path d="M${L + 5.5},51.5 l-2.8,-1.4 M${L + 5.5},53.5 l-3,.2 M${L + 5.5},55.5 l-2.6,1.4 M${R - 5.5},51.5 l2.8,-1.4 M${R - 5.5},53.5 l3,.2 M${R - 5.5},55.5 l2.6,1.4"/><path d="M47.5,57.2 q3.5,1.8 7,0 M65.5,57.2 q3.5,1.8 7,0"/><path d="M54,60 q-3.4,3.2 -2.6,8 M66,60 q3.4,3.2 2.6,8"/><path d="M55,${T + 9} q5,-1.2 10,0"/></g><path d="M54,82 q6,2.2 12,0 M55,86 q5,1.8 10,0" fill="none" stroke="${line}" stroke-width=".6" opacity=".35"/>`);
  if (has('bags')) s.push(`<path d="M47,57 q4,2.2 8,0 M65,57 q4,2.2 8,0" fill="none" stroke="${line}" stroke-width=".8" stroke-linecap="round" opacity=".5"/>`);
  if (has('muscle')) s.push(`<g fill="${skin}" stroke="${line}" stroke-width=".6"><path d="M4,120 C4,104 14,95 30,94 C38,96 40,104 38,120Z"/><path d="M116,120 C116,104 106,95 90,94 C82,96 80,104 82,120Z"/></g><path d="M18,108 q6,-6 12,0 M90,108 q6,-6 12,0" fill="none" stroke="${line}" stroke-width=".8" opacity=".6"/>`);
  if (has('freckles')) s.push(`<g fill="${line}" opacity=".45">${[[46, 59], [49, 61], [44, 62], [74, 59], [71, 61], [76, 62]].map(([a, b]) => `<circle cx="${a}" cy="${b}" r=".7"/>`).join('')}</g>`);

  // Beard, then mouth over it
  // Stubble is a shadow on the skin, so it stops at the jaw instead of hanging below it.
  if (p.beard === 'stubble') s.push(`<clipPath id="${id}f">${faceShape}/></clipPath><g clip-path="url(#${id}f)">${beard(p.beard, bc, L, R, ry)}</g>`);
  else s.push(beard(p.beard, bc, L, R, ry));
  s.push(`<path d="M60,55 Q57.5,61 59,62.5 Q61,63.2 62,62" fill="none" stroke="${line}" stroke-width="1.1" stroke-linecap="round"/>`);
  s.push(mouth(p.mouth, line));
  // Gray coming in at the chin and jaw, blended into a dark short beard.
  if (has('graychin')) s.push(`<path d="M51,72 C52,81 68,81 69,72 C66,75 54,75 51,72Z" fill="#b9b4ad" opacity=".45"/><g stroke="#cfcac3" stroke-width=".7" stroke-linecap="round" opacity=".7">${[[54, 75], [57, 77], [60, 78], [63, 77], [66, 75], [56, 73.6], [64, 73.6]].map(([x, y]) => `<path d="M${x},${y} l.3,1.6"/>`).join('')}</g><path d="M${L + 3},62 q1,5 3,8 M${R - 3},62 q-1,5 -3,8" stroke="#a9a49d" stroke-width="1" fill="none" opacity=".45"/>`);
  if (has('milkstache')) s.push(`<path d="M51,63.5 C54,60.5 58,61 60,62.5 C62,61 66,60.5 69,63.5 C66,65.5 62,65 60,64 C58,65 54,65.5 51,63.5Z" fill="#ffffff" stroke="#e8e8e8" stroke-width=".5"/>`);

  // Eyes and brows
  s.push(eyes(p.eyes, line, has('lashes'), skin));
  if (p.eyeC && p.eyes === 'normal') s.push(`<circle cx="51" cy="53" r="1.6" fill="${p.eyeC}"/><circle cx="69" cy="53" r="1.6" fill="${p.eyeC}"/><circle cx="51" cy="53" r=".8" fill="#14202b"/><circle cx="69" cy="53" r=".8" fill="#14202b"/><circle cx="51.7" cy="52.3" r=".5" fill="#fff"/><circle cx="69.7" cy="52.3" r=".5" fill="#fff"/>`);
  s.push(brows(p.brows, p.beard !== 'none' || p.hair === 'none' ? bc : hairD, p.hair === 'none' && p.beard === 'none' ? line : null));

  // Hair (front)
  s.push(hair(p.hair, hairC, hairD, L, R, T));

  if (has('saltpepper')) {
    const light = [[47, T + 4], [56, T + 1], [65, T + 2], [73, T + 5], [51, T + 7], [50, 72], [58, 77], [67, 73], [72, 67]];
    const dark = [[52, T + 2], [61, T + 4], [69, T + 1], [46, 68], [54, 75], [63, 76], [70, 70]];
    const streak = ([x, y]) => `<path d="M${x},${y} l2.4,-1"/>`;
    s.push(`<g stroke="#d6d3ce" stroke-width="1" stroke-linecap="round" opacity=".75">${light.map(streak).join('')}</g>`,
      `<g stroke="#2f2b28" stroke-width="1" stroke-linecap="round" opacity=".6">${dark.map(streak).join('')}</g>`,
      `<g stroke="#c9c6c0" stroke-width="2" stroke-linecap="round" fill="none" opacity=".9"><path d="M${L},53 q1,-6 3,-10"/><path d="M${R},53 q-1,-6 -3,-10"/></g>`);
  }
  if (has('touchgray')) {
    const flecks = [[50, T + 3], [61, T + 1], [70, T + 4], [57, T + 6], [56, 76], [63, 77], [60, 79], [52, 72]];
    s.push(`<g stroke="#c9c6c0" stroke-width=".8" stroke-linecap="round" opacity=".7">${flecks.map(([x, y]) => `<path d="M${x},${y} l1.8,-.8"/>`).join('')}</g>`,
      `<g stroke="#b9b6b0" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"><path d="M${L + 0.5},52 q1,-5 2.5,-8"/><path d="M${R - 0.5},52 q-1,-5 -2.5,-8"/></g>`);
  }
  if (has('strands')) s.push(`<g stroke="${hairC}" stroke-width=".9" fill="none" stroke-linecap="round"><path d="M${L + 2},44 q-2,8 1,15"/><path d="M${R - 2},44 q2,8 -1,15"/><path d="M50,${T + 3} q-3,4 -2,9"/></g>`);
  if (has('graying')) s.push(`<g stroke="#b9b6b0" stroke-width="1.1" stroke-linecap="round" opacity=".85" fill="none"><path d="M${L + 1},50 q1,-6 3,-9 M${L + 3},52 q1,-5 3,-8 M${R - 1},50 q-1,-6 -3,-9 M${R - 3},52 q-1,-5 -3,-8 M56,${T - 1} q3,-1 6,0"/></g>`);
  // Glasses
  s.push(glasses(p.glasses, p.glassC));

  // Hat
  s.push(hat(p.hat, p.hatC, L, R, T));
  if (p.hatTiles) s.push(`<g>${[...p.hatTiles].map((ch, i, all) => { const x = 60 - all.length * 2.6 + i * 5.2; return `<rect x="${x}" y="${T - 2}" width="4.6" height="6.4" rx=".8" fill="${i % 2 ? '#ffffff' : '#d62839'}"/><text x="${x + 2.3}" y="${T + 2.9}" font-family="Figtree, sans-serif" font-size="4.4" font-weight="700" fill="${i % 2 ? '#d62839' : '#ffffff'}" text-anchor="middle">${ch}</text>`; }).join('')}</g>`);
  if (p.hatText) s.push(`<text x="60" y="${T + 7}" font-family="Alfa Slab One, serif" font-size="${p.hatSize || 8}" fill="${p.hatTextC || '#ffffff'}" text-anchor="middle">${esc(p.hatText)}</text>`);

  // Extras around the head
  if (has('earrings')) s.push(`<circle cx="${L + 0.5}" cy="64" r="2.2" fill="#e8b923"/><circle cx="${R - 0.5}" cy="64" r="2.2" fill="#e8b923"/>`);
  if (has('chandelier')) s.push(`<g fill="#f6efd8" stroke="#c9a227" stroke-width=".4">${[L + 0.5, R - 0.5].map(x => `<circle cx="${x}" cy="62.5" r="1.1"/><path d="M${x - 2.6},65 L${x + 2.6},65 L${x},69Z"/><circle cx="${x - 2.4}" cy="70" r=".9"/><circle cx="${x}" cy="71.4" r="1.1"/><circle cx="${x + 2.4}" cy="70" r=".9"/>`).join('')}</g>`);
  if (has('drops')) s.push(`<g fill="#e8eef6" stroke="#9fb3c8" stroke-width=".4"><circle cx="${L + 0.5}" cy="63" r="1.2"/><path d="M${L + 0.5},64.5 l-1.8,3.4 l1.8,3 l1.8,-3Z"/><circle cx="${R - 0.5}" cy="63" r="1.2"/><path d="M${R - 0.5},64.5 l-1.8,3.4 l1.8,3 l1.8,-3Z"/></g>`);
  if (has('hoops')) s.push(`<circle cx="${L}" cy="66" r="3.6" fill="none" stroke="#e0b02a" stroke-width="1.4"/><circle cx="${R}" cy="66" r="3.6" fill="none" stroke="#e0b02a" stroke-width="1.4"/>`);
  if (has('earpiece')) s.push(`<circle cx="${R - 0.5}" cy="57" r="2" fill="#e9e9e9" stroke="#999" stroke-width=".5"/><path d="M${R},59 C${R + 4},72 ${R - 2},84 ${R + 6},96" fill="none" stroke="#d6d6d6" stroke-width="1.2"/>`);
  if (has('steam')) s.push(`<g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" opacity=".9"><path d="M30,34 q-4,-5 0,-10 q4,-5 0,-10"/><path d="M90,34 q4,-5 0,-10 q-4,-5 0,-10"/><path d="M22,44 q-4,-4 0,-8"/><path d="M98,44 q4,-4 0,-8"/></g>`);
  if (has('sweat')) s.push(`<path d="M${R - 2},38 q-3,5 0,7 q3,-2 0,-7Z" fill="#7cc6f2" stroke="#3d8fc2" stroke-width=".5"/>`);
  if (has('tear')) s.push(`<path d="M49,57 q-2.5,4 0,6 q2.5,-2 0,-6Z" fill="#7cc6f2"/>`);
  if (has('sparkles')) s.push(`<g fill="#ffd23f" stroke="#c99a00" stroke-width=".4">${[[18, 30, 5], [100, 24, 4], [104, 70, 3.5], [14, 74, 3]].map(([x, y, r]) => `<path d="M${x},${y - r} L${x + r * 0.3},${y - r * 0.3} L${x + r},${y} L${x + r * 0.3},${y + r * 0.3} L${x},${y + r} L${x - r * 0.3},${y + r * 0.3} L${x - r},${y} L${x - r * 0.3},${y - r * 0.3}Z"/>`).join('')}</g>`);
  if (has('cloud')) s.push(`<g><g fill="#7d8791"><circle cx="48" cy="14" r="7"/><circle cx="58" cy="10" r="9"/><circle cx="70" cy="13" r="7.5"/><rect x="44" y="12" width="32" height="9" rx="4.5"/></g><g stroke="#5fa8e0" stroke-width="1.6" stroke-linecap="round"><path d="M50,24 l-2,5"/><path d="M60,24 l-2,5"/><path d="M70,24 l-2,5"/></g></g>`);
  if (has('airbag')) s.push(`<g><ellipse cx="60" cy="86" rx="30" ry="17" fill="#ffffff" stroke="#c9c9c9"/><path d="M40,82 q20,8 40,0 M44,92 q16,5 32,0" fill="none" stroke="#dcdcdc"/><text x="60" y="89" font-family="Figtree, sans-serif" font-size="6" font-weight="700" fill="#9a9a9a" text-anchor="middle">SRS AIRBAG</text></g>`);

  // Props in front
  s.push(props(p, id));
  if (p.bubble) {
    const t = esc(p.bubble), w = Math.min(84, 12 + p.bubble.length * 5.4);
    s.push(`<g><rect x="4" y="5" width="${w}" height="17" rx="8.5" fill="#ffffff" stroke="#00000026"/><path d="M14,21.4 L11,29 L21,21.4Z" fill="#ffffff"/><text x="${4 + w / 2}" y="16.6" font-family="Figtree, sans-serif" font-size="8.6" font-weight="700" fill="#1a1a1a" text-anchor="middle">${t}</text></g>`);
  }
  if (p.zoom && p.zoom !== 1) {
    s.splice(fig, s.length - fig, `<g transform="translate(60,24) scale(${p.zoom}) translate(-60,-24)">${s.slice(fig).join('')}</g>`);
  }
  if (seat) {
    // Forearms resting forward on the table edge.
    const sleeve = p.top === 'plungegown' ? (p.gloveC || skin) : p.top === 'tank' || p.top === 'gown' ? skin : mix(p.topC, '#000000', 0.12);
    const hand = `fill="${skin}" stroke="${line}" stroke-width=".7"`;
    s.push(`<path d="M8,106 C14,96 26,92 38,95 L50,100 L47,106Z" fill="${sleeve}"/><path d="M112,106 C106,96 94,92 82,95 L70,100 L73,106Z" fill="${sleeve}"/>`,
      `<ellipse cx="50" cy="101.5" rx="6" ry="4" ${hand}/><ellipse cx="70" cy="101.5" rx="6" ry="4" ${hand}/>`,
      `<rect x="0" y="104" width="120" height="16" fill="#3e4a44"/><rect x="0" y="104" width="120" height="2.5" fill="#56645c"/>`);
    return `<svg viewBox="14 14 92 92" xmlns="http://www.w3.org/2000/svg" role="img">${s.join('')}</svg>`;
  }
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img">${s.join('')}</svg>`;
}

function clothes(p, skin, id) {
  const c = p.topC, d = mix(c, '#000000', 0.22), l = mix(c, '#ffffff', 0.35);
  const body = `<path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z" fill="${c}"/>`;
  const vskin = `<path d="M51,90 L60,99 L69,90Z" fill="${skin}"/>`;
  const out = [];
  switch (p.top) {
    // Heavy-set crew-neck tee: broad shoulders, ribbed collar.
    case 'crewtee':
      out.push(`<path d="M0,120 C1,101 24,91 46,89 L74,89 C96,91 119,101 120,120Z" fill="${c}"/>`,
        `<path d="M50,89 Q60,97 70,89Z" fill="${skin}"/>`,
        `<path d="M49,89 Q60,98.5 71,89" fill="none" stroke="${d}" stroke-width="2.2"/>`,
        `<path d="M22,96 C20,102 19,108 19,114 M98,96 C100,102 101,108 101,114" fill="none" stroke="${d}" stroke-width=".8" opacity=".6"/>`);
      break;
    case 'hoodie':
      if (p.chestPatch) out.push(body, `<rect x="72" y="104" width="8" height="6" rx="1" fill="${d}"/>`,
        `<path d="M38,93 C38,84 52,86 60,96 C68,86 82,84 82,93 C82,101 38,101 38,93Z" fill="${d}"/>`,
        `<path d="M55,97 L54,112 M65,97 L66,112" stroke="${l}" stroke-width="1.3" stroke-linecap="round"/>`);
      if (p.chestPatch) break;
      out.push(body, `<path d="M38,93 C38,84 52,86 60,96 C68,86 82,84 82,93 C82,101 38,101 38,93Z" fill="${d}"/>`,
        `<path d="M55,97 L54,112 M65,97 L66,112" stroke="${l}" stroke-width="1.3" stroke-linecap="round"/>`);
      break;
    case 'blazer':
      out.push(body, `<path d="M50,90 L60,114 L70,90Z" fill="${p.shirtC || '#f2f2f2'}"/>`,
        `<path d="M48,90 L44,101 L58,116 L60,114 L51,92Z" fill="${d}"/><path d="M72,90 L76,101 L62,116 L60,114 L69,92Z" fill="${d}"/>`);
      break;
    case 'shirt': case 'polo': case 'hawaiian': case 'patches': case 'apron':
      out.push(body, vskin, `<path d="M49,89.5 L54,100 L60,94Z" fill="${l}" stroke="${d}" stroke-width=".7"/><path d="M71,89.5 L66,100 L60,94Z" fill="${l}" stroke="${d}" stroke-width=".7"/>`);
      if (p.top === 'polo') out.push(`<path d="M60,96 L60,108" stroke="${d}" stroke-width="1"/><circle cx="60" cy="101" r=".9" fill="${l}"/><circle cx="60" cy="105" r=".9" fill="${l}"/>`);
      if (p.top === 'hawaiian') out.push(`<g>${[[24, 108], [38, 101], [84, 102], [97, 110], [70, 114], [46, 114]].map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="3.4" fill="${i % 2 ? '#ffffff' : '#e85d75'}"/><circle cx="${x}" cy="${y}" r="1.2" fill="#ffd23f"/>`).join('')}<path d="M30,114 q4,-6 9,-2 M88,96 q5,-4 8,1" stroke="#2e8b57" stroke-width="2" fill="none"/></g>`);
      if (p.top === 'patches') out.push(`<rect x="30" y="102" width="12" height="6" rx="1" fill="#ffd23f"/><rect x="78" y="101" width="13" height="6" rx="1" fill="#e53935"/><rect x="82" y="110" width="10" height="5" rx="1" fill="#ffffff"/><rect x="26" y="111" width="11" height="5" rx="1" fill="#2e8b57"/>`);
      if (p.top === 'apron') out.push(`<path d="M44,98 L76,98 L80,120 L40,120Z" fill="#fafafa" stroke="#dddddd"/><path d="M44,98 L50,90 M76,98 L70,90" stroke="#fafafa" stroke-width="2"/>`);
      break;
    case 'cardigan':
      out.push(body, `<path d="M50,90 L60,116 L70,90Z" fill="${p.shirtC || '#ece6d8'}"/>`,
        `<path d="M50,90 L60,116 M70,90 L60,116" stroke="${d}" stroke-width="2"/>`,
        `<g fill="${l}"><circle cx="57" cy="108" r="1.2"/><circle cx="58.5" cy="113" r="1.2"/></g>`);
      break;
    case 'sweater':
      out.push(body, `<path d="M48,90 Q60,101 72,90" fill="${skin}" stroke="${d}" stroke-width="3"/>`,
        `<path d="M20,112 h80" stroke="${d}" stroke-width="1" opacity=".5"/>`);
      if (p.ribbed) out.push(`<g stroke="${mix(c, '#ffffff', 0.14)}" stroke-width=".8" opacity=".7">${[22, 30, 38, 46, 54, 66, 74, 82, 90, 98].map(x => `<path d="M${x},${x < 60 ? 101 - (60 - x) * 0.12 : 101 - (x - 60) * 0.12} V120"/>`).join('')}</g>`);
      break;
    case 'jersey':
      if (p.hockey) {
        out.push(`<clipPath id="${id}h"><path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z"/></clipPath>`, body,
          `<g clip-path="url(#${id}h)" fill="#ffffff"><rect x="0" y="108" width="26" height="3"/><rect x="0" y="113" width="26" height="3"/><rect x="94" y="108" width="26" height="3"/><rect x="94" y="113" width="26" height="3"/></g>`,
          `<path d="M50,90 L60,99 L70,90" fill="${skin}" stroke="#ffffff" stroke-width="2.6"/>`,
          `<path d="M57,95 l6,0 M57.8,97 l4.4,0" stroke="#ffffff" stroke-width=".8"/>`);
        break;
      }
      out.push(`<clipPath id="${id}c"><path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z"/></clipPath>`, body,
        `<g clip-path="url(#${id}c)">${[94, 104, 114].map(y => `<rect x="0" y="${y}" width="120" height="5" fill="${p.stripeC || '#ffffff'}"/>`).join('')}</g>`,
        `<path d="M50,90 Q60,98 70,90" fill="${skin}" stroke="${d}" stroke-width="2"/>`);
      break;
    case 'robe':
      out.push(body, `<path d="M40,90 L60,120 L80,90 L72,90 L60,108 L48,90Z" fill="#fbfbfb"/>`,
        `<g fill="#111">${[[48, 96], [54, 104], [66, 104], [72, 96], [58, 112], [62, 112]].map(([x, y]) => `<rect x="${x - 0.8}" y="${y - 1.2}" width="1.6" height="2.4"/>`).join('')}</g>`, vskin);
      break;
    case 'tank':
      out.push(`<path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z" fill="${skin}"/>`,
        `<path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z" fill="#000" opacity=".06"/>`,
        `<path d="M38,120 L38,100 C38,95 40,92 42,91 L47,91 C48,100 54,106 60,106 C66,106 72,100 73,91 L78,91 C80,92 82,95 82,100 L82,120Z" fill="${c}"/>`,
        `<path d="M47,91 C48,100 54,106 60,106 C66,106 72,100 73,91" fill="none" stroke="${d}" stroke-width="1.6"/>`,
        `<path d="M30,104 q3,6 2,16 M90,104 q-3,6 -2,16" stroke="${mix(skin, '#000000', 0.2)}" stroke-width="1" fill="none"/>`);
      break;
    case 'sequingown':
      // Curvy figure: wide, rounded shoulders; a full bust above a flat strapless neckline at y≈107.
      const torso = 'M1,120 C1,103 22,92 47,90 L73,90 C98,92 119,103 119,120Z';
      const sh = mix(skin, '#000000', 0.25);
      out.push(`<clipPath id="${id}s"><path d="${torso}"/></clipPath>`,
        `<path d="${torso}" fill="${skin}"/>`,
        `<path d="M52,99.5 C56,100.5 58.6,104 59.6,110 L60,115 L60.4,110 C61.4,104 64,100.5 68,99.5 C64.5,103 62,107 60,115 C58,107 55.5,103 52,99.5Z" fill="#000" opacity=".08"/>`,
        `<path d="M40,101 C43,96.5 53,96 57.8,102.5 M80,101 C77,96.5 67,96 62.2,102.5 M57.8,102.5 C59,105.5 59.5,109 59.7,112.5 M62.2,102.5 C61,105.5 60.5,109 60.3,112.5" fill="none" stroke="${sh}" stroke-width=".8" stroke-linecap="round"/>`,
        `<path d="M44,94.5 Q50,96.5 56,95 M64,95 Q70,96.5 76,94.5" fill="none" stroke="${mix(skin, '#000000', 0.18)}" stroke-width=".8" stroke-linecap="round"/>`,
        `<path d="M7,120 C7,113 11,108.6 20,107.6 C28,105.5 36,101.6 44,101.2 C50,101 54,103.5 55.6,108 C56.8,112 58,116.5 60,116.5 C62,116.5 63.2,112 64.4,108 C66,103.5 70,101 76,101.2 C84,101.6 92,105.5 100,107.6 C109,108.6 113,113 113,120Z" fill="${c}"/>`,
        `<path d="M20,107.6 C28,105.5 36,101.6 44,101.2 C50,101 54,103.5 55.6,108 C56.8,112 58,116.5 60,116.5 C62,116.5 63.2,112 64.4,108 C66,103.5 70,101 76,101.2 C84,101.6 92,105.5 100,107.6" fill="none" stroke="${l}" stroke-width="1.4"/>`,
        `<g clip-path="url(#${id}s)" fill="#ffffff" opacity=".55">${[[24, 112], [32, 110], [40, 114], [48, 110], [56, 113], [64, 110], [72, 113], [80, 110], [88, 114], [96, 111], [28, 117], [44, 118], [60, 117], [76, 118], [92, 117]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".9"/>`).join('')}</g>`);
      break;
    // Sleeveless gown with thin straps and a wide, deep U neckline (bottom at y≈129) over a full bust with deep
    // cleavage, on the curvy figure; shoulders and upper arms bare. Drawn past y=120 so a zoomed-out avatar
    // (zoom < 1) still fills the frame.
    case 'plungegown': {
      const torso = 'M1,150 L1,120 C1,103 22,92 47,90 L73,90 C98,92 119,103 119,150Z';
      const neck = 'M18,111 C27,110 37,104 43,99 C43,108 46,118 51,124.5 Q55.5,129 60,129 Q64.5,129 69,124.5 C74,118 77,108 77,99 C83,104 93,110 102,111';
      const gown = `M1,150 L1,121 C6,115 12,112 ${neck.slice(1)} C108,112 114,115 119,121 L119,150Z`;
      const sh = mix(skin, '#000000', 0.25);
      out.push(`<clipPath id="${id}p"><path d="${gown}"/></clipPath>`,
        `<path d="${torso}" fill="${skin}"/>`,
        `<path d="M46,94.5 Q51,96.2 56,95 M64,95 Q69,96.2 74,94.5" fill="none" stroke="${mix(skin, '#000000', 0.18)}" stroke-width=".8" stroke-linecap="round"/>`,
        // Where the upper arms meet the body.
        `<path d="M19,112 C16,106 18,100 25,96.5 M101,112 C104,106 102,100 95,96.5" fill="none" stroke="${sh}" stroke-width=".8" stroke-linecap="round" opacity=".7"/>`,
        // Rounded tops of the bust meeting in a deep cleavage line, with soft shadow between.
        `<path d="M55.5,106.5 C58,109 59.4,114 60,124 C60.6,114 62,109 64.5,106.5 C62.6,108.4 61,109.6 60,110.8 C59,109.6 57.4,108.4 55.5,106.5Z" fill="#000" opacity=".12"/>`,
        `<path d="M43.5,106 C46,99.5 55,99 58.8,107.6 M76.5,106 C74,99.5 65,99 61.2,107.6" fill="none" stroke="${sh}" stroke-width=".9" stroke-linecap="round"/>`,
        `<path d="M58.8,107.6 C59.6,112 59.9,117 60,123 M61.2,107.6 C60.4,112 60.1,117 60,123" fill="none" stroke="${sh}" stroke-width=".8" stroke-linecap="round"/>`,
        `<path d="M47,103 Q50,101.6 53,102.6 M73,103 Q70,101.6 67,102.6" fill="none" stroke="#ffffff" stroke-width=".8" stroke-linecap="round" opacity=".45"/>`,
        `<path d="${gown}" fill="${c}"/>`,
        `<path d="M24,127 C32,132 44,133 52,129.5 M96,127 C88,132 76,133 68,129.5" fill="none" stroke="${d}" stroke-width="1" opacity=".6"/>`,
        `<path d="${neck}" fill="none" stroke="${l}" stroke-width="1.4"/>`,
        `<path d="M44.6,99.6 L47.6,90.6 M75.4,99.6 L72.4,90.6" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`);
      // Satin: long soft sheen streaks instead of sequins.
      if (p.satin) out.push(`<g clip-path="url(#${id}p)" fill="none" stroke="#ffffff" stroke-linecap="round"><path d="M14,138 C18,122 26,110 38,103" stroke-width="3" opacity=".22"/><path d="M106,138 C102,122 94,110 82,103" stroke-width="3" opacity=".22"/><path d="M22,146 C26,134 32,126 40,121" stroke-width="1.4" opacity=".3"/><path d="M98,146 C94,134 88,126 80,121" stroke-width="1.4" opacity=".3"/><path d="M50,148 C52,140 55,135 58,132" stroke-width="1.2" opacity=".25"/></g>`);
      else out.push(`<g clip-path="url(#${id}p)" fill="#ffffff" opacity=".55">${[[14, 112], [22, 106], [30, 112], [38, 104], [44, 114], [26, 120], [36, 124], [48, 128], [18, 130], [30, 136], [42, 140], [54, 144], [106, 112], [98, 106], [90, 112], [82, 104], [76, 114], [94, 120], [84, 124], [72, 128], [102, 130], [90, 136], [78, 140], [66, 144], [60, 140]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".9"/>`).join('')}</g>`);
      break;
    }
    // Same sapphire sequin strapless gown, modest cut: standard figure, a shallow sweetheart line, no plunge.
    case 'sequingownmodest': {
      const torso = 'M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z';
      const neck = 'M20,101 C30,99 42,98 52,99 Q57,99.6 60,102 Q63,99.6 68,99 C78,98 90,99 100,101';
      out.push(`<clipPath id="${id}s"><path d="${torso}"/></clipPath>`,
        `<path d="${torso}" fill="${skin}"/>`,
        `<path d="M44,94.5 Q50,96.5 56,95 M64,95 Q70,96.5 76,94.5" fill="none" stroke="${mix(skin, '#000000', 0.18)}" stroke-width=".8" stroke-linecap="round"/>`,
        `<g clip-path="url(#${id}s)"><path d="M0,120 L0,104 C6,102 14,101.5 20,101 ${neck.slice(neck.indexOf('C', 1))} C106,101.5 114,102 120,104 L120,120Z" fill="${c}"/></g>`,
        `<path d="${neck}" fill="none" stroke="${l}" stroke-width="1.4"/>`,
        `<g clip-path="url(#${id}s)" fill="#ffffff" opacity=".55">${[[24, 106], [32, 104], [40, 108], [48, 104], [56, 108], [64, 105], [72, 108], [80, 104], [88, 108], [96, 105], [28, 114], [44, 114], [60, 113], [76, 114], [92, 114], [36, 118], [52, 118], [68, 118], [84, 118]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".9"/>`).join('')}</g>`);
      break;
    }
    case 'evening':
      out.push(body, `<path d="M49,90 L60,110 L71,90Z" fill="${skin}"/>`,
        `<path d="M49,90 L60,110 L71,90" fill="none" stroke="${l}" stroke-width="1.2"/>`,
        `<path d="M24,104 C32,98 42,96 48,98 M96,104 C88,98 78,96 72,98" stroke="${l}" stroke-width="1.4" fill="none" opacity=".55"/>`);
      break;
    case 'trackjacket':
      out.push(body, `<path d="M51,90 L60,98 L69,90Z" fill="${skin}"/>`,
        `<path d="M50,89 L52,95 L60,99 L68,95 L70,89" fill="none" stroke="${d}" stroke-width="2.4"/>`,
        `<path d="M60,99 V120" stroke="#9a9a9a" stroke-width="1.2"/>`,
        `<path d="M44,92 C30,95 18,102 12,116 M47,95 C33,98 21,105 16,118" stroke="${p.stripeC || '#f2c230'}" stroke-width="2.2" fill="none"/>`,
        `<path d="M76,92 C90,95 102,102 108,116 M73,95 C87,98 99,105 104,118" stroke="${p.stripeC || '#f2c230'}" stroke-width="2.2" fill="none"/>`);
      break;
    case 'campshirt':
      out.push(body, vskin, `<path d="M48,89.5 L53,99 L60,94Z" fill="${l}"/><path d="M72,89.5 L67,99 L60,94Z" fill="${l}"/>`,
        `<g><rect x="28" y="100" width="64" height="20" fill="#1b2a5a"/>`,
        `<circle cx="40" cy="110" r="6" fill="#f2c230"/><path d="M48,120 L58,102 L68,120Z" fill="#26a69a"/><path d="M62,120 L74,105 L86,120Z" fill="#ff7043"/>`,
        `<path d="M28,103 q8,-3 16,0 t16,0 t16,0 t16,0" stroke="#ffffff" stroke-width="1.2" fill="none" opacity=".8"/><circle cx="84" cy="108" r="2.4" fill="#ffffff"/></g>`,
        `<path d="M60,94 L60,100" stroke="${d}" stroke-width="1"/>`);
      if (p.underBlazer) out.push(`<path d="M48,90 L40,104 L44,120 L28,120 L20,105 C26,97 36,92 48,90Z" fill="${p.blazerC}"/><path d="M72,90 L80,104 L76,120 L92,120 L100,105 C94,97 84,92 72,90Z" fill="${p.blazerC}"/><path d="M6,120 C8,104 20,98 26,96 L20,120Z M114,120 C112,104 100,98 94,96 L100,120Z" fill="${p.blazerC}"/>`);
      break;
    case 'checkblazer':
      out.push(`<clipPath id="${id}b"><path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z"/></clipPath>`, body,
        `<g clip-path="url(#${id}b)" stroke="${d}" stroke-width=".6" opacity=".55">${[14, 26, 38, 82, 94, 106].map(x => `<path d="M${x},88 V120"/>`).join('')}${[100, 110].map(y => `<path d="M0,${y} H120"/>`).join('')}</g>`,
        `<path d="M50,90 L60,112 L70,90Z" fill="#fbfbfb"/>`, vskin,
        `<path d="M50,90 L55,99 L60,95 M70,90 L65,99 L60,95" fill="#ffffff" stroke="#d9d9d9" stroke-width=".6"/>`,
        `<path d="M48,90 L43,101 L57,118 L59,113 L51,92Z" fill="${d}"/><path d="M72,90 L77,101 L63,118 L61,113 L69,92Z" fill="${d}"/>`);
      break;
    case 'gown':
      out.push(`<path d="M6,120 C8,101 28,92 48,90 L72,90 C92,92 112,101 114,120Z" fill="${skin}"/>`,
        `<path d="M26,120 C27,108 31,101 37,99 C44,97 52,98 60,103 C68,98 76,97 83,99 C89,101 93,108 94,120Z" fill="${c}"/>`,
        `<path d="M33,110 C36,101 50,99 58,104 M87,110 C84,101 70,99 62,104" fill="none" stroke="${l}" stroke-width="1.2" opacity=".7"/>`,
        `<path d="M58,103 Q60,108 62,103" fill="none" stroke="${mix(skin, '#000000', 0.25)}" stroke-width="1"/>`,
        `<path d="M40,99 L44,91 M80,99 L76,91" stroke="${c}" stroke-width="2.2"/>`);
      break;
    case 'blouse':
      out.push(body, `<path d="M46,90 Q60,108 74,90Z" fill="${skin}"/>`);
      break;
    case 'jacket':
      out.push(body, `<path d="M51,90 L60,112 L69,90Z" fill="${p.shirtC || '#222'}"/><path d="M60,100 L60,120" stroke="${d}" stroke-width="1.2"/><path d="M48,90 L58,112 M72,90 L62,112" stroke="${l}" stroke-width="1.2"/>`);
      break;
    default: // tee
      out.push(body, `<path d="M50,90 Q60,99 70,90Z" fill="${skin}"/><path d="M50,90 Q60,99 70,90" fill="none" stroke="${d}" stroke-width="1.6"/>`);
      if (p.teeSquare) out.push(`<rect x="53" y="103" width="14" height="11" fill="none" stroke="#ffffff" stroke-width="1.6"/>`);
      if (p.teeText) out.push(`<text x="60" y="${p.teeY || 112}" font-family="Alfa Slab One, serif" font-size="${p.teeSize || 8}" fill="${p.teeTextC || '#fff'}" text-anchor="middle">${esc(p.teeText)}</text>`);
  }
  return out.join('');
}

function beard(kind, c, L, R, ry = 25) {
  const full = `M${L},54 C${L + 1},76 50,87 60,87 C70,87 ${R - 1},76 ${R},54 C${R - 3},64 ${R - 7},69 70,69 C66,73 54,73 50,69 C${L + 7},69 ${L + 3},64 ${L},54Z`;
  switch (kind) {
    case 'full': return `<path d="${full}" fill="${c}"/><path d="M50,63 C54,59.5 58,60 60,61.5 C62,60 66,59.5 70,63 C66,65 62,65 60,64 C58,65 54,65 50,63Z" fill="${c}"/>`;
    case 'short': return `<path d="M${L + 1},58 C${L + 2},74 50,82 60,82 C70,82 ${R - 2},74 ${R - 1},58 C${R - 4},65 ${R - 8},69 70,69 C66,72 54,72 50,69 C${L + 8},69 ${L + 4},65 ${L + 1},58Z" fill="${c}" opacity=".88"/><path d="M51,63 C54,60.5 58,61 60,62 C62,61 66,60.5 69,63 C66,64.5 62,64.5 60,63.8 C58,64.5 54,64.5 51,63Z" fill="${c}" opacity=".88"/>`;
    case 'stubble': return `<path d="${full}" fill="${c}" opacity=".22"/><path d="M50,63 C54,60 58,60.5 60,62 C62,60.5 66,60 70,63 C66,64.6 62,64.6 60,63.8 C58,64.6 54,64.6 50,63Z" fill="${c}" opacity=".3"/>`;
    case 'goatee': return `<path d="M53,72 C54,80 66,80 67,72 C64,74 56,74 53,72Z" fill="${c}"/><path d="M51,63 C54,60 58,60.5 60,62 C62,60.5 66,60 69,63 C66,64.5 62,64.5 60,63.8 C58,64.5 54,64.5 51,63Z" fill="${c}"/><path d="M51,63 L52,70 M69,63 L68,70" stroke="${c}" stroke-width="1.6"/>`;
    case 'thinchin': {
      const b = 54 + ry;
      return `<path d="M${L + 1},56 C${L + 2},${b - 9} 52,${b - 1} 60,${b + 1} C68,${b - 1} ${R - 2},${b - 9} ${R - 1},56" fill="none" stroke="${c}" stroke-width="1.3" opacity=".5"/><path d="M55,${b - 5} C56,${b + 3} 64,${b + 3} 65,${b - 5} C62,${b - 3.5} 58,${b - 3.5} 55,${b - 5}Z" fill="${c}"/>`;
    }
    case 'trimmed': {
      const b = 54 + ry + 3;
      return `<path d="M${L},53 C${L + 0.5},${b - 10} 50,${b} 60,${b} C70,${b} ${R - 0.5},${b - 10} ${R},53 C${R - 3},63 ${R - 7},68 70,68.5 C66,72 54,72 50,68.5 C${L + 7},68 ${L + 3},63 ${L},53Z" fill="${c}"/><path d="M50.5,63.4 C53.5,60.6 58,61 60,62.4 C62,61 66.5,60.6 69.5,63.4 C66,65 62,64.8 60,64 C58,64.8 54,65 50.5,63.4Z" fill="${c}"/>`;
    }
    case 'vandyke': return `<path d="M50.5,63.6 C53.5,60.4 58,60.8 60,62.4 C62,60.8 66.5,60.4 69.5,63.6 C66,65.2 62,64.8 60,64 C58,64.8 54,65.2 50.5,63.6Z" fill="${c}"/><path d="M50.5,63.6 C50,67 51,70 52.5,71.5 L54,71 C53,69 52.6,66.6 52.8,64.6Z M69.5,63.6 C70,67 69,70 67.5,71.5 L66,71 C67,69 67.4,66.6 67.2,64.6Z" fill="${c}"/><path d="M52.5,71.5 C54,79 66,79 67.5,71.5 C64,73.5 56,73.5 52.5,71.5Z" fill="${c}"/>`;
    case 'grizzled': return `<path d="${full}" fill="${c}" opacity=".3"/><path d="M51,72 C52,82 68,82 69,72 C66,75 54,75 51,72Z" fill="${c}" opacity=".85"/><g fill="${mix(c, '#000000', 0.25)}" opacity=".5">${[[54, 76], [58, 78], [62, 78], [66, 76], [56, 80], [64, 80], [60, 81]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".6"/>`).join('')}</g>`;
    case 'pointy': return `<path d="M53,72.5 C56,74.5 64,74.5 67,72.5 L60.5,88 L59.5,88Z" fill="${c}"/><path d="M60,75 L60,85" stroke="${mix(c, '#000000', 0.2)}" stroke-width=".7"/>`;
    case 'mustache': return `<path d="M50,63.5 C53,59.5 58,60 60,62 C62,60 67,59.5 70,63.5 C66,65.5 62,65 60,64 C58,65 54,65.5 50,63.5Z" fill="${c}"/>`;
    case 'bigstache': return `<path d="M46,65 C49,58 57,59 60,61.5 C63,59 71,58 74,65 C70,63.5 66,66.5 60,64.5 C54,66.5 50,63.5 46,65Z" fill="${c}"/>`;
    case 'chinstrap': return `<path d="M${L},54 C${L + 1},76 50,86 60,86 C70,86 ${R - 1},76 ${R},54 L${R - 3},56 C${R - 4},74 68,82 60,82 C52,82 ${L + 4},74 ${L + 3},56Z" fill="${c}"/>`;
    default: return '';
  }
}

function mouth(kind, line) {
  const st = `fill="none" stroke="${line}" stroke-width="1.6" stroke-linecap="round"`;
  switch (kind) {
    case 'grin': return `<path d="M51.5,65.5 Q60,76 68.5,65.5Z" fill="#5a2320"/><path d="M53,66 L67,66 L66,68.5 L54,68.5Z" fill="#ffffff"/>`;
    case 'flat': return `<path d="M54,67.5 L66,67.5" ${st}/>`;
    case 'frown': return `<path d="M53,70 Q60,64 67,70" ${st}/>`;
    case 'smirk': return `<path d="M53,67.5 Q61,70.5 67.5,64.5" ${st}/>`;
    case 'open': return `<ellipse cx="60" cy="68.5" rx="3.4" ry="4.2" fill="#5a2320"/>`;
    case 'shout': return `<path d="M52,65 Q60,62 68,65 Q68,76 60,77 Q52,76 52,65Z" fill="#5a2320"/><path d="M54,65 L66,65 L65,67 L55,67Z" fill="#ffffff"/>`;
    case 'tongue': return `<path d="M51.5,65.5 Q60,76 68.5,65.5Z" fill="#5a2320"/><path d="M53,66 L67,66 L66,68.5 L54,68.5Z" fill="#ffffff"/><path d="M58,70.5 Q60,78 63,71" fill="#ef6f8a"/>`;
    // Full red lips in a wide, bright smile.
    case 'glamsmile': return `<path d="M51.5,65.8 Q60,67.4 68.5,65.8 Q60,72.4 51.5,65.8Z" fill="#ffffff"/><path d="M50.6,65.4 C53.6,62.8 57.8,63.2 60,64.4 C62.2,63.2 66.4,62.8 69.4,65.4 Q60,67.4 50.6,65.4Z" fill="#c4122f"/><path d="M51.5,65.8 Q60,75 68.5,65.8 Q60,72.4 51.5,65.8Z" fill="#c4122f"/><path d="M50.4,65.4 q-.8,-.9 -.9,-1.9 M69.6,65.4 q.8,-.9 .9,-1.9" stroke="#8e0e24" stroke-width=".8" stroke-linecap="round" fill="none"/><path d="M57,72.2 q3,.8 6,0 M55.4,64.6 q2,-.7 3.2,0" stroke="#ff8a9b" stroke-width=".8" stroke-linecap="round" fill="none"/>`;
    case 'pinksmile': return `<path d="M52.5,66 Q60,73.5 67.5,66 Q60,69.4 52.5,66Z" fill="#d9707f"/><path d="M53.5,66.4 Q60,71.6 66.5,66.4" fill="#ffffff" opacity=".9"/><path d="M52.5,66 Q60,73.5 67.5,66" fill="none" stroke="#b44e5e" stroke-width="1.1" stroke-linecap="round"/>`;
    case 'fullpout': return `<path d="M51.5,66.8 C53.5,63.2 57,62.6 59,64.6 L60,65.4 L61,64.6 C63,62.6 66.5,63.2 68.5,66.8 C66.5,73.8 53.5,73.8 51.5,66.8Z" fill="#b3263e"/><path d="M52.5,67.2 Q56,68.4 60,67.6 Q64,68.4 67.5,67.2" stroke="#6e1424" stroke-width=".9" fill="none"/><path d="M56,70.4 q4,1.4 8,0" stroke="#e7808f" stroke-width="1" stroke-linecap="round" fill="none"/><path d="M58.5,58.5 Q60,61.5 61.5,58.5" fill="none" stroke="${line}" stroke-width=".8" opacity=".6"/>`;
    case 'rose': return `<path d="M52.5,66.2 C55,63.6 58,64 60,65 C62,64 65,63.6 67.5,66.2 C65,71 55,71 52.5,66.2Z" fill="#b5566a"/><path d="M53.5,66.6 Q60,68.6 66.5,65.8" stroke="#7a2f40" stroke-width=".8" fill="none"/>`;
    case 'nude': return `<path d="M52.5,66.4 C55,64 58,64.4 60,65.4 C62,64.4 65,64 67.5,66.4 C65,71 55,71 52.5,66.4Z" fill="#b8746a"/><path d="M53.5,66.8 Q60,68.4 66.5,66.8" stroke="#7e4a43" stroke-width=".8" fill="none"/><path d="M56.5,69.2 q3.5,.8 7,0" stroke="#d9a196" stroke-width=".8" fill="none"/>`;
    case 'biglips': return `<path d="M49.5,66.2 C52.5,61.6 57.2,62.2 60,64 C62.8,62.2 67.5,61.6 70.5,66.2 C67.5,74.5 52.5,74.5 49.5,66.2Z" fill="#d81b60" stroke="#8e0e3c" stroke-width=".7"/><path d="M51,66.6 Q60,69.2 69,66.6" stroke="#8e0e3c" stroke-width=".9" fill="none"/><path d="M54.5,64.6 q2.6,-1 4.2,.1 M57,70.4 q3,1 6,0" stroke="#ffd1e1" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
    case 'lips': return `<path d="M52,66 C55,63.6 58,64 60,65 C62,64 65,63.6 68,66 C65,71.5 55,71.5 52,66Z" fill="#c4122f"/><path d="M53.5,66.4 Q60,68.4 66.5,66.4" stroke="#7d0b1e" stroke-width=".8" fill="none"/><path d="M56,64.8 q2,-.6 3,.2" stroke="#ff8a9b" stroke-width=".7" fill="none"/>`;
    case 'pout': return `<path d="M54,68.8 Q60,65.6 66,68.8" fill="none" stroke="${line}" stroke-width="1.7" stroke-linecap="round"/><path d="M56.5,69.6 Q60,71.4 63.5,69.6" fill="none" stroke="${line}" stroke-width=".9" opacity=".7"/>`;
    case 'pursed': return `<path d="M56,67.5 Q60,65.5 64,67.5 Q60,69.5 56,67.5Z" fill="${line}" opacity=".7"/>`;
    default: return `<path d="M53,66 Q60,72.5 67,66" ${st}/>`;
  }
}

function eyes(kind, line, lashes, skin) {
  const ink = '#24170f';
  const skin_lid = skin || '#f2cfb4';
  let out;
  switch (kind) {
    case 'wide': out = `<circle cx="51" cy="52.5" r="4.4" fill="#fff" stroke="${line}" stroke-width=".6"/><circle cx="69" cy="52.5" r="4.4" fill="#fff" stroke="${line}" stroke-width=".6"/><circle cx="51" cy="53" r="2.2" fill="${ink}"/><circle cx="69" cy="53" r="2.2" fill="${ink}"/>`; break;
    case 'shifty': out = `<ellipse cx="51" cy="53" rx="4.2" ry="2.8" fill="#fff" stroke="${line}" stroke-width=".6"/><ellipse cx="69" cy="53" rx="4.2" ry="2.8" fill="#fff" stroke="${line}" stroke-width=".6"/><circle cx="53.6" cy="53.4" r="1.9" fill="${ink}"/><circle cx="71.6" cy="53.4" r="1.9" fill="${ink}"/><path d="M46.6,51.6 L55.4,51.6 M64.6,51.6 L73.4,51.6" stroke="${line}" stroke-width="1.1"/>`; break;
    case 'sultry': out = `<ellipse cx="51" cy="53.4" rx="5.8" ry="3.6" fill="#4a3a52" opacity=".4"/><ellipse cx="69" cy="53.4" rx="5.8" ry="3.6" fill="#4a3a52" opacity=".4"/><path d="M46,54 Q51,51.6 56,54 Q51,57.4 46,54Z M64,54 Q69,51.6 74,54 Q69,57.4 64,54Z" fill="#fff"/><circle cx="52.4" cy="54.8" r="2" fill="#3b2416"/><circle cx="70.4" cy="54.8" r="2" fill="#3b2416"/><circle cx="52.5" cy="54.8" r=".9" fill="${ink}"/><circle cx="70.5" cy="54.8" r=".9" fill="${ink}"/><path d="M45.6,54.4 Q51,51 56.4,54 Q51,53.6 45.6,54.4Z M63.6,54 Q69,51 74.4,54.4 Q69,53.6 63.6,54Z" fill="${skin_lid}"/><path d="M45.4,54.4 Q51,52.2 56.6,54 M63.4,54 Q69,52.2 74.6,54.4" stroke="${ink}" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="M45.4,54.4 l-1.6,-.8 M74.6,54.4 l1.6,-.8" stroke="${ink}" stroke-width="1.1" stroke-linecap="round"/>`; break;
    // Bright, open almond eyes: soft lid shadow, winged liner, a smiling lower lid.
    case 'glam': out = `<ellipse cx="51" cy="51" rx="5.4" ry="2.2" fill="#b98a9a" opacity=".35"/><ellipse cx="69" cy="51" rx="5.4" ry="2.2" fill="#b98a9a" opacity=".35"/><path d="M46,53.6 Q51,49.6 56,53.4 Q51,56 46,53.6Z M64,53.4 Q69,49.6 74,53.6 Q69,56 64,53.4Z" fill="#fff"/><circle cx="51" cy="53.1" r="2.3" fill="#4a2c1a"/><circle cx="69" cy="53.1" r="2.3" fill="#4a2c1a"/><circle cx="51" cy="53.1" r="1" fill="${ink}"/><circle cx="69" cy="53.1" r="1" fill="${ink}"/><circle cx="51.8" cy="52.3" r=".65" fill="#fff"/><circle cx="69.8" cy="52.3" r=".65" fill="#fff"/><path d="M45.6,53.7 Q51,49.2 56.4,53.2 M63.6,53.2 Q69,49.2 74.4,53.7" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M45.6,53.7 l-2.2,-1.6 M74.4,53.7 l2.2,-1.6" stroke="${ink}" stroke-width="1.2" stroke-linecap="round"/><path d="M47.4,56.2 q3.6,1.2 7.2,0 M65.4,56.2 q3.6,1.2 7.2,0" stroke="${line}" stroke-width=".6" fill="none" opacity=".4"/>`; break;
    case 'down': out = `<path d="M47.5,53.5 Q51,51.6 54.5,53.5 Q51,56 47.5,53.5Z M65.5,53.5 Q69,51.6 72.5,53.5 Q69,56 65.5,53.5Z" fill="#fff"/><circle cx="51" cy="54.6" r="1.6" fill="${ink}"/><circle cx="69" cy="54.6" r="1.6" fill="${ink}"/><path d="M47,53.4 Q51,51.4 55,53.4 M65,53.4 Q69,51.4 73,53.4" stroke="${ink}" stroke-width="1.5" fill="none"/>`; break;
    case 'sly': out = `<ellipse cx="51" cy="53" rx="5.2" ry="3.4" fill="#5b4a5e" opacity=".42"/><ellipse cx="69" cy="53" rx="5.2" ry="3.4" fill="#5b4a5e" opacity=".42"/><path d="M46.8,53.8 Q50.5,51.4 55.2,53.2 Q51.5,55.4 46.8,53.8Z M64.8,53.2 Q69.5,51.4 73.2,53.8 Q68.5,55.4 64.8,53.2Z" fill="#fff"/><circle cx="53" cy="53.5" r="1.7" fill="#3b2416"/><circle cx="71" cy="53.5" r="1.7" fill="#3b2416"/><circle cx="53.1" cy="53.5" r=".8" fill="${ink}"/><circle cx="71.1" cy="53.5" r=".8" fill="${ink}"/><path d="M46.5,53.6 Q50.5,51 55.5,52.9 M64.5,52.9 Q69.5,51 73.5,53.6" stroke="${ink}" stroke-width="1.5" fill="none"/>`; break;
    case 'side': out = `<ellipse cx="51" cy="53.2" rx="4" ry="2.3" fill="#fff" stroke="${line}" stroke-width=".5"/><ellipse cx="69" cy="53.2" rx="4" ry="2.3" fill="#fff" stroke="${line}" stroke-width=".5"/><circle cx="53.4" cy="53.4" r="1.9" fill="#4aa3df"/><circle cx="71.4" cy="53.4" r="1.9" fill="#4aa3df"/><circle cx="53.6" cy="53.4" r=".9" fill="${ink}"/><circle cx="71.6" cy="53.4" r=".9" fill="${ink}"/><path d="M46.6,52.2 Q51,50.2 55.4,52.2 M64.6,52.2 Q69,50.2 73.4,52.2" stroke="${ink}" stroke-width="1.4" fill="none"/>`; break;
    case 'heavy': out = `<ellipse cx="51" cy="53.4" rx="3.6" ry="2.4" fill="#fff" stroke="${line}" stroke-width=".5"/><ellipse cx="69" cy="53.4" rx="3.6" ry="2.4" fill="#fff" stroke="${line}" stroke-width=".5"/><circle cx="51.3" cy="54" r="1.8" fill="${ink}"/><circle cx="69.3" cy="54" r="1.8" fill="${ink}"/><path d="M47,53 Q51,50.6 55,53" fill="${skin_lid}" stroke="${ink}" stroke-width="1.2"/><path d="M65,53 Q69,50.6 73,53" fill="${skin_lid}" stroke="${ink}" stroke-width="1.2"/>`; break;
    case 'sleepy': out = `<path d="M47.5,53 Q51,55.5 54.5,53" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/><path d="M65.5,53 Q69,55.5 72.5,53" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`; break;
    case 'narrow': out = `<path d="M47,53 L55,52.6 M65,52.6 L73,53" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`; break;
    case 'happy': out = `<path d="M47.5,54 Q51,49.5 54.5,54" fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/><path d="M65.5,54 Q69,49.5 72.5,54" fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/>`; break;
    case 'wink': out = `<circle cx="51" cy="53" r="2.5" fill="${ink}"/><path d="M65.5,53.5 Q69,51 72.5,53.5" fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/>`; break;
    default: out = `<circle cx="51" cy="53" r="2.5" fill="${ink}"/><circle cx="69" cy="53" r="2.5" fill="${ink}"/><circle cx="51.8" cy="52.2" r=".7" fill="#fff"/><circle cx="69.8" cy="52.2" r=".7" fill="#fff"/>`;
  }
  if (lashes) out += `<path d="M47.5,51 l-2,-1.6 M48.6,50 l-1.4,-2 M72.5,51 l2,-1.6 M71.4,50 l1.4,-2" stroke="${ink}" stroke-width="1" stroke-linecap="round"/>`;
  return out;
}

function brows(kind, c, light) {
  const col = light ? mix(light, '#ffffff', 0.15) : c;
  const st = `fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round"`;
  switch (kind) {
    case 'angry': return `<path d="M46,44.5 L55.5,47.5" ${st}/><path d="M74,44.5 L64.5,47.5" ${st}/>`;
    case 'thick': return `<path d="M45.5,46 Q50,44.6 55.5,46.8" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round"/><path d="M64.5,46.8 Q70,44.6 74.5,46" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`;
    case 'sad': return `<path d="M46,47.5 L55,44.5" ${st}/><path d="M74,47.5 L65,44.5" ${st}/>`;
    case 'raised': return `<path d="M46,45 Q50.5,40.5 55.5,44" ${st}/><path d="M64.5,44 Q69.5,40.5 74,45" ${st}/>`;
    case 'higharch': return `<path d="M45.5,47.5 Q50,41.6 55.5,45.2" fill="none" stroke="${col}" stroke-width="1.3" stroke-linecap="round"/><path d="M64.5,44.6 Q70,40.2 74.5,46.4" fill="none" stroke="${col}" stroke-width="1.3" stroke-linecap="round"/>`;
    case 'one': return `<path d="M46,46.5 L55.5,46" ${st}/><path d="M64.5,44 Q69.5,40 74,44" ${st}/>`;
    default: return `<path d="M46,46.5 Q50.5,44.5 55.5,46" ${st}/><path d="M64.5,46 Q69.5,44.5 74,46.5" ${st}/>`;
  }
}

function hair(kind, c, d, L, R, T) {
  const cap = (top, inner) => `M${L - 1},54 C${L - 1.5},${T - 1} 49,${top} 60,${top} C71,${top} ${R + 1.5},${T - 1} ${R + 1},54 C${R - 2},${T + inner + 2} ${R - 9},${T + inner} 60,${T + inner} C${L + 9},${T + inner} ${L + 2},${T + inner + 2} ${L - 1},54Z`;
  switch (kind) {
    case 'none': return '';
    case 'bald': return `<ellipse cx="52" cy="${T + 7}" rx="6" ry="2.6" fill="#ffffff" opacity=".35"/>`;
    case 'buzz': return `<path d="${cap(T - 1.5, 7)}" fill="${c}" opacity=".62"/>`;
    case 'short': return `<path d="${cap(T - 4, 8)}" fill="${c}"/>`;
    case 'sidepart': return `<path d="${cap(T - 4, 8)}" fill="${c}"/><path d="M${L + 2},${T + 10} C${L + 6},${T - 2} 64,${T - 6} ${R + 1},${T + 8} C70,${T + 1} 58,${T + 1} ${L + 2},${T + 10}Z" fill="${mix(c, '#ffffff', 0.12)}"/><path d="M49,${T - 3} Q50,${T + 3} 47,${T + 8}" stroke="${d}" stroke-width="1" fill="none"/>`;
    case 'messy': return `<path d="${cap(T - 4, 8)}" fill="${c}"/><path d="M44,${T + 1} L45,${T - 7} L51,${T - 2} L54,${T - 9} L58,${T - 3} L63,${T - 10} L66,${T - 3} L71,${T - 8} L73,${T} L78,${T - 3} L77,${T + 5}Z" fill="${c}"/><path d="M50,${T + 6} q4,-5 9,-1 M62,${T + 5} q5,-5 10,0" stroke="${d}" stroke-width="1.1" fill="none"/>`;
    case 'spiky': return `<path d="M${L - 1},54 L${L},${T + 3} L${L + 5},${T + 5} L${L + 6},${T - 8} L52,${T - 1} L55,${T - 12} L60,${T - 3} L65,${T - 12} L68,${T - 1} L${R - 6},${T - 8} L${R - 5},${T + 5} L${R},${T + 3} L${R + 1},54 C${R - 2},${T + 10} ${R - 9},${T + 8} 60,${T + 8} C${L + 9},${T + 8} ${L + 2},${T + 10} ${L - 1},54Z" fill="${c}"/>`;
    case 'curly': case 'curlylong': {
      let out = `<path d="${cap(T - 3, 8)}" fill="${c}"/>`;
      for (let i = 0; i <= 9; i++) {
        const a = Math.PI * (1.08 + i * 0.093);
        out += `<circle cx="${(60 + (R - 60 + 1) * Math.cos(a)).toFixed(1)}" cy="${(54 + (54 - T + 1) * Math.sin(a)).toFixed(1)}" r="6.2" fill="${c}"/>`;
      }
      return out + `<g fill="none" stroke="${d}" stroke-width=".9">${[50, 58, 66].map(x => `<path d="M${x},${T + 2} q3,-4 6,0"/>`).join('')}</g>`;
    }
    case 'slick': return `<path d="M${L - 1},52 C${L - 2},${T - 2} 48,${T - 6} 62,${T - 6} C76,${T - 6} ${R + 2},${T} ${R + 1},52 C${R - 2},${T + 8} ${R - 10},${T + 6} 60,${T + 7} C${L + 9},${T + 7} ${L + 2},${T + 10} ${L - 1},52Z" fill="${c}"/><path d="M46,${T + 2} C54,${T - 4} 68,${T - 4} 76,${T + 2}" stroke="#ffffff" stroke-width="1.4" fill="none" opacity=".35"/>`;
    case 'long': return `<path d="${cap(T - 4, 9)}" fill="${c}"/><path d="M${L - 1},50 L${L - 3},80 L${L + 4},74 L${L + 3},50Z" fill="${c}"/><path d="M${R + 1},50 L${R + 3},80 L${R - 4},74 L${R - 3},50Z" fill="${c}"/><path d="M60,${T - 3} Q54,${T + 6} ${L + 3},${T + 13}" stroke="${d}" stroke-width="1" fill="none"/>`;
    case 'bob': return `<path d="M${L - 2},52 C${L - 2},${T - 2} 49,${T - 5} 60,${T - 5} C71,${T - 5} ${R + 2},${T - 2} ${R + 2},52 L${R - 1},${T + 12} L${L + 1},${T + 12}Z" fill="${c}"/><path d="M${L - 2},52 L${L - 1},72 L${L + 3},70 L${L + 2},52Z M${R + 2},52 L${R + 1},72 L${R - 3},70 L${R - 2},52Z" fill="${c}"/>`;
    case 'receding': return `<g fill="${c}"><path d="M${L - 1},62 C${L - 2},52 ${L},45 ${L + 5},42 L${L + 7},49 C${L + 3},52 ${L + 1},57 ${L + 1},62Z"/><path d="M${L - 1},62 C${L - 2},52 ${L},45 ${L + 5},42 L${L + 7},49 C${L + 3},52 ${L + 1},57 ${L + 1},62Z" ${MIRROR}/></g><ellipse cx="54" cy="${T + 6}" rx="6" ry="2.4" fill="#ffffff" opacity=".3"/>`;
    case 'wavy': return `<path d="M${L - 1},56 C${L - 3},${T + 2} ${L + 2},${T - 9} 52,${T - 11} C57,${T - 14} 66,${T - 14} 71,${T - 10} C${R + 1},${T - 7} ${R + 3},${T + 4} ${R + 1},56 C${R - 1},${T + 13} ${R - 4},${T + 9} ${R - 8},${T + 9} C70,${T + 3} 63,${T + 5} 58,${T + 3} C52,${T + 6} ${L + 7},${T + 6} ${L + 3},${T + 11} C${L + 2},${T + 14} ${L},${T + 20} ${L - 1},56Z" fill="${c}"/><g fill="none" stroke="${d}" stroke-width="1.1" stroke-linecap="round"><path d="M49,${T + 3} C51,${T - 4} 56,${T - 8} 62,${T - 9}"/><path d="M57,${T + 3} C59,${T - 3} 64,${T - 6} 70,${T - 6}"/><path d="M66,${T + 4} C68,${T} 72,${T - 1} 75,${T + 3}"/></g><path d="M53,${T - 9} C58,${T - 12} 65,${T - 12} 69,${T - 9}" stroke="#ffffff" stroke-width="1.1" opacity=".25" fill="none"/>`;
    case 'glam': return `<path d="M${L - 4},54 C${L - 6},${T - 4} 48,${T - 9} 61,${T - 9} C74,${T - 9} ${R + 6},${T - 3} ${R + 4},54 C${R},${T + 8} 70,${T + 2} 62,${T + 4} C56,${T + 2} 50,${T + 6} ${L + 3},${T + 14} C${L},${T + 18} ${L - 2},48 ${L - 4},54Z" fill="${c}"/><path d="M${L - 3},48 C${L - 10},62 ${L - 10},80 ${L - 8},92 C${L - 4},98 ${L + 3},97 ${L + 4},92 C${L + 1},90 ${L - 1},88 ${L + 1},86 C${L + 2},74 ${L + 2},62 ${L + 3},52Z M${R + 3},48 C${R + 10},62 ${R + 10},80 ${R + 8},92 C${R + 4},98 ${R - 3},97 ${R - 4},92 C${R - 1},90 ${R + 1},88 ${R - 1},86 C${R - 2},74 ${R - 2},62 ${R - 3},52Z" fill="${c}"/><path d="M${L + 6},${T + 5} C52,${T - 4} 64,${T - 6} ${R},${T + 2}" stroke="${mix(c, '#ffffff', 0.3)}" stroke-width="1" fill="none" opacity=".55"/><path d="M${L - 6},88 q3,4 8,2 M${R + 6},88 q-3,4 -8,2" stroke="${mix(c, '#ffffff', 0.3)}" stroke-width=".9" fill="none" opacity=".5"/>`;
    case 'shoulder': return `<path d="${cap(T - 4, 9)}" fill="${c}"/><path d="M${L + 1},${T + 12} C${L + 4},${T - 2} 58,${T - 7} ${R + 1},${T + 6} C68,${T + 1} 56,${T + 2} ${L + 1},${T + 12}Z" fill="${mix(c, '#ffffff', 0.08)}"/><path d="M${L - 1},46 C${L - 6},62 ${L - 7},80 ${L - 9},96 Q${L - 5},99 ${L - 1},96 Q${L + 2},98 ${L + 4},94 C${L + 3},82 ${L + 2},64 ${L + 3},50Z M${R + 1},46 C${R + 6},62 ${R + 7},80 ${R + 9},96 Q${R + 5},99 ${R + 1},96 Q${R - 2},98 ${R - 4},94 C${R - 3},82 ${R - 2},64 ${R - 3},50Z" fill="${c}"/><path d="M${L + 6},${T + 6} C54,${T - 1} 64,${T - 3} ${R - 4},${T + 3}" stroke="${mix(c, '#ffffff', 0.25)}" stroke-width=".9" fill="none" opacity=".6"/>`;
    case 'wavyshort': return `<path d="${cap(T - 3, 8)}" fill="${c}"/><g fill="none" stroke="${d}" stroke-width="1.1" stroke-linecap="round"><path d="M46,${T + 4} q4,-4 8,-1 t8,-1"/><path d="M58,${T + 1} q4,-3 8,0 t8,1"/><path d="M50,${T - 1} q4,-2.5 8,0"/></g>`;
    case 'afro': return `<path d="${cap(T - 6, 7)}" fill="${c}"/><g fill="${d}" opacity=".35">${[[44, T - 2], [52, T - 7], [62, T - 8], [72, T - 5], [78, T + 2], [40, T + 6]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2"/>`).join('')}</g>`;
    case 'braid': return `<path d="${cap(T - 4, 8)}" fill="${c}"/><path d="M60,${T - 4} Q57,${T + 2} ${L + 3},${T + 12}" stroke="${d}" stroke-width="1" fill="none"/>`;
    case 'quiff': return `<path d="${cap(T + 2, 6)}" fill="${c}" opacity=".55"/><path d="M47,${T + 8} L46,${T - 4} L51,${T - 1} L52,${T - 11} L57,${T - 4} L60,${T - 13} L63,${T - 4} L68,${T - 11} L69,${T - 1} L74,${T - 4} L73,${T + 8} C68,${T + 4} 52,${T + 4} 47,${T + 8}Z" fill="${c}"/><path d="M54,${T} L56,${T - 7} M60,${T - 1} L61,${T - 9} M66,${T} L66,${T - 7}" stroke="${d}" stroke-width=".9"/>`;
    case 'mohawk': return `<path d="M53,${T + 6} L55,${T - 14} L60,${T - 18} L65,${T - 14} L67,${T + 6}Z" fill="${c}"/><path d="${cap(T - 1, 6)}" fill="${c}" opacity=".3"/>`;
    // Deep side part, a swept wave over the brow, soft S-waves that fall just past the shoulders.
    case 'pastshoulder': {
      const hi = mix(c, '#ffffff', 0.28);
      return `<path d="${cap(T - 5, 7)}" fill="${c}"/>`
        // the sweep: from the part at x≈50 across the brow, tucking down at the far temple
        + `<path d="M49,${T - 4} C58,${T - 6} ${R + 3},${T} ${R + 2},${T + 14} C${R + 1},${T + 20} ${R - 2},${T + 22} ${R - 3},${T + 22} C${R - 4},${T + 14} 70,${T + 7} 58,${T + 8} C52,${T + 8} 49,${T + 6} 49,${T - 4}Z" fill="${mix(c, '#ffffff', 0.06)}"/>`
        + `<path d="M49,${T - 4} C44,${T - 2} ${L},${T + 4} ${L},${T + 18} C${L + 2},${T + 12} 45,${T + 6} 49,${T + 4}Z" fill="${c}"/>`
        // side waves
        + `<path d="M${L - 1},46 C${L - 7},56 ${L - 4},66 ${L - 7},76 C${L - 10},86 ${L - 9},96 ${L - 4},101 C${L},104 ${L + 5},103 ${L + 7},100 C${L + 3},99 ${L + 1},96 ${L + 1},91 C${L + 1},84 ${L + 4},76 ${L + 2},66 C${L + 1},60 ${L + 3},54 ${L + 2},48Z" fill="${c}"/>`
        + `<path d="M${R + 1},44 C${R + 8},54 ${R + 5},66 ${R + 8},76 C${R + 11},86 ${R + 10},96 ${R + 5},101 C${R + 1},104 ${R - 4},103 ${R - 6},100 C${R - 2},99 ${R},96 ${R},91 C${R},84 ${R - 3},76 ${R - 1},66 C${R},60 ${R - 2},54 ${R - 2},48Z" fill="${c}"/>`
        // shine following the waves
        + `<g stroke="${hi}" stroke-width=".9" fill="none" stroke-linecap="round" opacity=".6"><path d="M51,${T - 1} C60,${T - 3} ${R - 1},${T + 2} ${R - 1},${T + 12}"/><path d="M${L - 3},58 C${L - 6},68 ${L - 2},74 ${L - 5},84 C${L - 7},92 ${L - 5},97 ${L - 2},99"/><path d="M${R + 3},56 C${R + 6},66 ${R + 2},74 ${R + 5},84 C${R + 7},92 ${R + 5},97 ${R + 2},99"/></g>`;
    }
    case 'bun': return `<circle cx="60" cy="${T - 8}" r="7.5" fill="${c}"/><path d="${cap(T - 4, 8)}" fill="${c}"/>`;
    case 'ponytail': return `<path d="M${R - 2},${T + 4} C${R + 14},${T + 6} ${R + 14},${T + 34} ${R + 4},${T + 42} C${R + 8},${T + 28} ${R + 6},${T + 16} ${R - 4},${T + 10}Z" fill="${d}"/><path d="${cap(T - 4, 8)}" fill="${c}"/>`;
    default: return `<path d="${cap(T - 4, 8)}" fill="${c}"/>`;
  }
}

function glasses(kind, c) {
  switch (kind) {
    case 'round': return `<g fill="#ffffff22" stroke="${c}" stroke-width="1.5"><circle cx="51" cy="53" r="6"/><circle cx="69" cy="53" r="6"/><path d="M57,53 Q60,51 63,53 M45,52 L40,50 M75,52 L80,50" fill="none"/></g>`;
    case 'square': return `<g fill="#ffffff22" stroke="${c}" stroke-width="1.7"><rect x="44" y="48.5" width="13" height="9.5" rx="2"/><rect x="63" y="48.5" width="13" height="9.5" rx="2"/><path d="M57,52 L63,52 M44,51 L39,50 M76,51 L81,50" fill="none"/></g>`;
    case 'big': return `<g fill="#ffffff26" stroke="${c}" stroke-width="1.5"><path d="M42.5,47.5 h15 v8 a7,6 0 0 1 -15,0Z"/><path d="M62.5,47.5 h15 v8 a7,6 0 0 1 -15,0Z"/><path d="M57.5,50 Q60,48.5 62.5,50 M42.5,49 L38,48 M77.5,49 L82,48" fill="none"/></g>`;
    case 'reading': return `<g fill="#ffffff22" stroke="${c}" stroke-width="1.4"><path d="M44.5,55 h12 a6,4.5 0 0 1 -12,0Z"/><path d="M63.5,55 h12 a6,4.5 0 0 1 -12,0Z"/><path d="M56.5,55.5 Q60,54 63.5,55.5" fill="none"/></g>`;
    case 'shades': return `<g><path d="M43,49 h15 v6 a6,5 0 0 1 -15,0Z M62,49 h15 v6 a6,5 0 0 1 -15,0Z" fill="${c}"/><path d="M58,50.5 L62,50.5 M43,50 L38,49 M77,50 L82,49" stroke="${c}" stroke-width="1.6"/><path d="M46,51 l4,0 M65,51 l4,0" stroke="#ffffff" stroke-width="1" opacity=".5"/></g>`;
    case 'aviator': return `<g><path d="M43,49 h15 c0,8 -3,11 -7.5,11 c-5,0 -7.5,-5 -7.5,-11Z M62,49 h15 c0,6 -2.5,11 -7.5,11 c-4.5,0 -7.5,-3 -7.5,-11Z" fill="${c}" opacity=".85" stroke="#c9a227" stroke-width="1"/><path d="M58,49.5 L62,49.5 M43,49.5 L38,48.5 M77,49.5 L82,48.5" stroke="#c9a227" stroke-width="1.2"/></g>`;
    case 'tintaviator': return `<g><linearGradient id="tint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c2566b"/><stop offset="1" stop-color="#e8a04c"/></linearGradient><path d="M42.5,48.5 h16 c0,8.5 -3.2,12 -8,12 c-5.3,0 -8,-5.5 -8,-12Z M61.5,48.5 h16 c0,6.5 -2.7,12 -8,12 c-4.8,0 -8,-3.5 -8,-12Z" fill="url(#tint)" opacity=".92" stroke="#c9a227" stroke-width=".8"/><path d="M58.5,49.5 L61.5,49.5 M42.5,49.5 L38,48 M77.5,49.5 L82,48" stroke="#c9a227" stroke-width=".9"/><path d="M45,51 l5,0 M64,51 l5,0" stroke="#fff" stroke-width=".9" opacity=".5"/></g>`;
    case 'horn': return `<g><g fill="#ffffff22" stroke="${c}" stroke-width="2"><rect x="43.5" y="48.5" width="14" height="10" rx="2.6"/><rect x="62.5" y="48.5" width="14" height="10" rx="2.6"/></g><path d="M43,49.5 C47,46.8 54,46.8 58,49.5 M62,49.5 C66,46.8 73,46.8 77,49.5" stroke="${c}" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M57.5,52 Q60,50.6 62.5,52 M43.5,51 L38.5,49.5 M76.5,51 L81.5,49.5" stroke="${c}" stroke-width="2" fill="none"/></g>`;
    case 'wire': return `<g transform="translate(0,3.2)" fill="#ffffff1a" stroke="${c}" stroke-width=".9"><rect x="44.5" y="50.5" width="12" height="6.4" rx="1"/><rect x="63.5" y="50.5" width="12" height="6.4" rx="1"/><path d="M56.5,52.5 Q60,51 63.5,52.5 M44.5,52 L39,49.5 M75.5,52 L81,49.5" fill="none"/></g>`;
    case 'mirror': return `<g><linearGradient id="mirr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2c94c"/><stop offset=".5" stop-color="#6fbf73"/><stop offset="1" stop-color="#1f5f4a"/></linearGradient><path d="M38,49.5 C46,46 74,46 82,49.5 L80.5,56.5 C72,60 63,59 60,55.5 C57,59 48,60 39.5,56.5Z" fill="url(#mirr)" stroke="#111" stroke-width="1.2"/><path d="M44,50.5 C52,49 58,49 61,50.5" stroke="#ffffff" stroke-width="1.1" opacity=".7" fill="none"/></g>`;
    case 'wrap': return `<g><path d="M39,50 C46,47 74,47 81,50 L80,56 C72,59 63,58 60,55 C57,58 48,59 40,56Z" fill="${c}"/><path d="M45,51 C52,49.5 66,49.5 74,51" stroke="#ffffff" stroke-width="1" opacity=".45" fill="none"/></g>`;
    case 'onhead': return `<g transform="translate(0,-17)"><path d="M43,49 h15 v5 a6,4 0 0 1 -15,0Z M62,49 h15 v5 a6,4 0 0 1 -15,0Z" fill="${c}"/><path d="M58,50.5 L62,50.5" stroke="${c}" stroke-width="1.6"/></g>`;
    default: return '';
  }
}

function hat(kind, c, L, R, T) {
  const d = mix(c, '#000000', 0.25), l = mix(c, '#ffffff', 0.3);
  const crown = `M${L - 2},${T + 13} C${L - 2},${T - 6} 50,${T - 9} 60,${T - 9} C70,${T - 9} ${R + 2},${T - 6} ${R + 2},${T + 13}Z`;
  switch (kind) {
    case 'cap': return `<path d="${crown}" fill="${c}"/><path d="M${L - 2},${T + 13} C${L + 8},${T + 9} ${R - 8},${T + 9} ${R + 2},${T + 13} L${R + 2},${T + 16} C${R - 8},${T + 11} ${L + 8},${T + 11} ${L - 2},${T + 16}Z" fill="${d}"/><path d="M${L},${T + 15} C${L + 10},${T + 12} ${R - 10},${T + 12} ${R},${T + 15} C${R + 4},${T + 20} ${L - 4},${T + 20} ${L},${T + 15}Z" fill="${d}"/><circle cx="60" cy="${T - 8}" r="1.6" fill="${d}"/><path d="M60,${T - 8} L60,${T + 11}" stroke="${d}" stroke-width=".8" opacity=".6"/>`;
    case 'backcap': return `<path d="${crown}" fill="${c}"/><path d="M${L - 2},${T + 13} C${L + 8},${T + 9} ${R - 8},${T + 9} ${R + 2},${T + 13} L${R + 2},${T + 15} C${R - 8},${T + 11} ${L + 8},${T + 11} ${L - 2},${T + 15}Z" fill="${d}"/><path d="M${R - 6},${T - 4} C${R + 4},${T - 10} ${R + 14},${T - 6} ${R + 14},${T - 2} C${R + 8},${T - 4} ${R},${T - 1} ${R - 4},${T + 2}Z" fill="${d}"/><rect x="54" y="${T + 6}" width="12" height="5" rx="2" fill="${l}" opacity=".7"/>`;
    case 'beanie': return `<path d="M${L - 2},${T + 14} C${L - 3},${T - 10} 48,${T - 13} 60,${T - 13} C72,${T - 13} ${R + 3},${T - 10} ${R + 2},${T + 14}Z" fill="${c}"/><rect x="${L - 3}" y="${T + 8}" width="${R - L + 6}" height="8" rx="3" fill="${d}"/><circle cx="60" cy="${T - 14}" r="5" fill="${l}"/><g stroke="${d}" stroke-width=".9" opacity=".6">${[48, 54, 60, 66, 72].map(x => `<path d="M${x},${T - 6} L${x},${T + 7}"/>`).join('')}</g>`;
    case 'flatcap': return `<path d="M${L - 3},${T + 12} C${L - 2},${T - 3} 50,${T - 7} 62,${T - 7} C76,${T - 7} ${R + 4},${T - 1} ${R + 3},${T + 10}Z" fill="${c}"/><path d="M${L},${T + 12} C${L + 14},${T + 6} ${R - 2},${T + 6} ${R + 7},${T + 13} C${R - 4},${T + 16} ${L + 10},${T + 16} ${L},${T + 12}Z" fill="${d}"/><path d="M48,${T - 4} L53,${T + 9} M60,${T - 6} L62,${T + 8}" stroke="${l}" stroke-width=".8" opacity=".6"/>`;
    case 'crown': return `<path d="M${L},${T + 9} L${L + 2},${T - 13} L${L + 11},${T - 3} L60,${T - 17} L${R - 11},${T - 3} L${R - 2},${T - 13} L${R},${T + 9}Z" fill="#f2c230" stroke="#b8860b" stroke-width="1"/><circle cx="60" cy="${T + 2}" r="2.6" fill="#d62839"/><circle cx="${L + 8}" cy="${T + 3}" r="2" fill="#2a7fff"/><circle cx="${R - 8}" cy="${T + 3}" r="2" fill="#2e8b57"/><circle cx="60" cy="${T - 17}" r="1.8" fill="#f2c230"/>`;
    case 'captain': return `<path d="M${L - 3},${T + 8} C${L - 3},${T - 9} ${R + 3},${T - 9} ${R + 3},${T + 8}Z" fill="#fbfbfb" stroke="#cfcfcf"/><rect x="${L - 3}" y="${T + 6}" width="${R - L + 6}" height="6" fill="#1b1f2a"/><path d="M${L},${T + 12} C${L + 10},${T + 18} ${R - 10},${T + 18} ${R},${T + 12}Z" fill="#111"/><circle cx="60" cy="${T + 3}" r="3.2" fill="#e8b923"/><path d="M${L},${T + 11} L${R},${T + 11}" stroke="#e8b923" stroke-width="1"/>`;
    case 'fedora': return `<ellipse cx="60" cy="${T + 9}" rx="${R - L + 6}" ry="5" fill="${d}"/><path d="M${L + 1},${T + 9} C${L},${T - 10} 52,${T - 13} 56,${T - 9} Q60,${T - 6} 64,${T - 9} C68,${T - 13} ${R},${T - 10} ${R - 1},${T + 9}Z" fill="${c}"/><rect x="${L + 1}" y="${T + 2}" width="${R - L - 2}" height="5" fill="${p_band(c)}"/>`;
    case 'cowboy': return `<path d="M${L - 16},${T + 6} C${L - 8},${T + 16} ${R + 8},${T + 16} ${R + 16},${T + 6} C${R + 6},${T + 10} ${L - 6},${T + 10} ${L - 16},${T + 6}Z" fill="${d}"/><path d="M${L + 1},${T + 10} C${L},${T - 12} 52,${T - 14} 56,${T - 9} Q60,${T - 5} 64,${T - 9} C68,${T - 14} ${R},${T - 12} ${R - 1},${T + 10}Z" fill="${c}"/>`;
    case 'headphones': return `<path d="M${L - 2},56 C${L - 4},${T - 10} ${R + 4},${T - 10} ${R + 2},56" fill="none" stroke="${c}" stroke-width="4.2"/><rect x="${L - 6}" y="47" width="9" height="17" rx="4" fill="${c}"/><rect x="${R - 3}" y="47" width="9" height="17" rx="4" fill="${c}"/><rect x="${L - 5}" y="50" width="3" height="11" rx="1.5" fill="${l}"/>`;
    case 'viking': return `<path d="M${L - 2},${T + 14} C${L - 2},${T - 8} ${R + 2},${T - 8} ${R + 2},${T + 14}Z" fill="#8d99a6"/><rect x="${L - 3}" y="${T + 10}" width="${R - L + 6}" height="6" rx="2" fill="#6c7782"/><path d="M60,${T - 6} L60,${T + 10}" stroke="#6c7782" stroke-width="3"/><path d="M${L},${T + 4} C${L - 12},${T + 2} ${L - 14},${T - 10} ${L - 10},${T - 16} C${L - 8},${T - 8} ${L - 3},${T - 4} ${L + 3},${T - 3}Z" fill="#f3ead6" stroke="#cfc3a6"/><path d="M${R},${T + 4} C${R + 12},${T + 2} ${R + 14},${T - 10} ${R + 10},${T - 16} C${R + 8},${T - 8} ${R + 3},${T - 4} ${R - 3},${T - 3}Z" fill="#f3ead6" stroke="#cfc3a6"/>`;
    case 'jester': return `<path d="M${L - 2},${T + 12} L${L - 12},${T - 12} L52,${T - 2} L60,${T - 20} L68,${T - 2} L${R + 12},${T - 12} L${R + 2},${T + 12}Z" fill="${c}"/><path d="M52,${T - 2} L60,${T - 20} L68,${T - 2}Z" fill="${l}"/><rect x="${L - 3}" y="${T + 8}" width="${R - L + 6}" height="6" rx="2" fill="#f2c230"/><circle cx="${L - 12}" cy="${T - 12}" r="3" fill="#f2c230"/><circle cx="60" cy="${T - 20}" r="3" fill="#f2c230"/><circle cx="${R + 12}" cy="${T - 12}" r="3" fill="#f2c230"/>`;
    case 'sunhat': return `<ellipse cx="60" cy="${T + 9}" rx="${R - L + 16}" ry="7" fill="${c}"/><path d="M${L + 1},${T + 9} C${L},${T - 10} ${R},${T - 10} ${R - 1},${T + 9}Z" fill="${c}"/><rect x="${L + 1}" y="${T + 3}" width="${R - L - 2}" height="5" fill="${d}"/><circle cx="${R - 4}" cy="${T + 5}" r="3.4" fill="#e85d75"/>`;
    case 'hijab': return `<path fill-rule="evenodd" d="M${L - 6},90 C${L - 9},62 ${L - 6},${T - 8} 60,${T - 8} C${R + 6},${T - 8} ${R + 9},62 ${R + 6},90 C${R - 2},96 ${L + 2},96 ${L - 6},90Z M60,${T + 4} C${R - 3},${T + 4} ${R - 1},50 ${R - 1.5},58 C${R - 2},72 68,79.5 60,79.5 C52,79.5 ${L + 2},72 ${L + 1.5},58 C${L + 1},50 ${L + 3},${T + 4} 60,${T + 4}Z" fill="${c}"/><path d="M${L - 2},64 C${L + 2},80 52,88 60,88 C68,88 ${R - 2},80 ${R + 2},64" fill="none" stroke="${d}" stroke-width="1" opacity=".6"/><path d="M${L + 2},${T + 4} C50,${T - 1} 70,${T - 1} ${R - 2},${T + 4}" fill="none" stroke="${l}" stroke-width="1.2" opacity=".6"/>`;
    case 'turban': return `<path d="M${L - 2},${T + 13} C${L - 4},${T - 4} 48,${T - 13} 60,${T - 13} C72,${T - 13} ${R + 4},${T - 4} ${R + 2},${T + 13} C${R - 6},${T + 9} ${L + 6},${T + 9} ${L - 2},${T + 13}Z" fill="${c}"/><g fill="none" stroke="${d}" stroke-width="1.3" opacity=".7"><path d="M${L},${T + 8} C${L + 10},${T - 4} 64,${T - 10} ${R - 2},${T - 2}"/><path d="M${L + 2},${T + 2} C${L + 12},${T - 9} 66,${T - 13} ${R - 6},${T - 7}"/><path d="M${R},${T + 9} C${R - 10},${T + 1} 56,${T - 4} ${L + 6},${T - 3}"/></g><path d="M56,${T + 6} L60,${T - 2} L64,${T + 6}Z" fill="${l}" opacity=".5"/>`;
    case 'visor': return `<path d="M${L - 2},${T + 12} C${L + 8},${T + 8} ${R - 8},${T + 8} ${R + 2},${T + 12} L${R + 2},${T + 16} C${R - 8},${T + 12} ${L + 8},${T + 12} ${L - 2},${T + 16}Z" fill="${c}"/><path d="M${L},${T + 15} C${L + 10},${T + 12} ${R - 10},${T + 12} ${R},${T + 15} C${R + 5},${T + 21} ${L - 5},${T + 21} ${L},${T + 15}Z" fill="${c}" opacity=".75"/>`;
    default: return '';
  }
}
function p_band(c) { return mix(c, '#000000', 0.55); }

function card(x, y, rot, label) {
  const red = /[♥♦]/.test(label);
  return `<g transform="translate(${x},${y}) rotate(${rot})"><rect x="-7" y="-10" width="14" height="20" rx="2" fill="#ffffff" stroke="#00000033"/><text x="0" y="3" font-family="Figtree, sans-serif" font-size="8" font-weight="700" fill="${red ? '#d62839' : '#1a1a1a'}" text-anchor="middle">${label}</text></g>`;
}

function props(p, id) {
  const out = [];
  const a = k => p.acc.includes(k);
  if (a('tie')) out.push(`<path d="M58,92 L62,92 L63.5,96 L61.5,112 L60,114 L58.5,112 L56.5,96Z" fill="${p.tieC || '#c0392b'}"/>`);
  if (a('bowtie')) out.push(`<path d="M60,94 L51,90 L51,99Z M60,94 L69,90 L69,99Z" fill="${p.tieC || '#8e1b2e'}"/><circle cx="60" cy="94.5" r="2" fill="${mix(p.tieC || '#8e1b2e', '#000000', 0.3)}"/>`);
  if (a('chain')) out.push(`<path d="M47,91 Q60,110 73,91" fill="none" stroke="#e8b923" stroke-width="2.4" stroke-dasharray="2 1"/><circle cx="60" cy="101.5" r="3.6" fill="#e8b923" stroke="#b8860b"/><text x="60" y="103.4" font-size="4.4" font-weight="700" text-anchor="middle" fill="#7a5a00" font-family="Figtree, sans-serif">$</text>`);
  if (a('collar')) out.push(`<g><path d="M52,88.5 Q60,93 68,88.5 L68,91.5 Q60,96 52,91.5Z" fill="#eef4fb" stroke="#9fb3c8" stroke-width=".5"/>${[54, 57, 60, 63, 66].map(x => `<circle cx="${x}" cy="${x === 60 ? 93.6 : 92.6}" r=".8" fill="#ffffff"/>`).join('')}</g>`);
  if (a('braceletarm')) {
    // `gloveC` sheathes the arm in an opera glove, bracelet worn over it.
    const sk = p.gloveC || SKIN[p.skin] || p.skin, ln = p.gloveC ? mix(sk, '#ffffff', 0.25) : mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M96,120 C94,112 90,109 84,108 L80,114 C84,115 87,117 88,120Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<path d="M84,108 C78,107 72,108 70,110 C69,112 71,114 74,114 L80,114Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<g fill="#ffffff" stroke="#9fb3c8" stroke-width=".4">${[[85, 108.6], [85.8, 110.6], [86.4, 112.6], [86.8, 114.6]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1"/>`).join('')}</g></g>`);
  }
  if (a('diamonds')) out.push(`<g><path d="M50.5,90.5 Q60,98 69.5,90.5" fill="none" stroke="#e8eef6" stroke-width="1.2"/>${[[52, 92], [55, 94.2], [58, 95.4], [62, 95.4], [65, 94.2], [68, 92]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="#ffffff" stroke="#b9c6d6" stroke-width=".4"/>`).join('')}<path d="M60,96 l-1.8,2.6 l1.8,2.6 l1.8,-2.6Z" fill="#cfe6ff" stroke="#8fb1d6" stroke-width=".4"/></g>`);
  if (a('goldchains')) out.push(`<g fill="none" stroke="#d4af37" stroke-width=".8"><path d="M50,91 Q60,101 70,91"/><path d="M48.5,91 Q60,106 71.5,91"/><circle cx="60" cy="104.3" r="1.2" fill="#d4af37"/></g>`);
  if (a('pearls')) out.push(`<g fill="#fbf6ee" stroke="#d8cfc0" stroke-width=".4">${[...Array(9)].map((_, i) => { const t = i / 8; const x = 47 + 26 * t; const y = 91 + 12 * Math.sin(Math.PI * t); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7"/>`; }).join('')}</g>`);
  if (a('medals')) out.push(`<g>${[40, 49, 58].map((x, i) => `<path d="M${x},92 L${x + 2},100 L${x + 4},92" fill="none" stroke="${['#d62839', '#2a7fff', '#2e8b57'][i]}" stroke-width="2"/><circle cx="${x + 2}" cy="103" r="3.4" fill="#f2c230" stroke="#b8860b" stroke-width=".6"/>`).join('')}</g>`);
  if (a('bracelets')) out.push(`<g>${[0, 1, 2, 3, 4, 5].map(i => `<rect x="${30 + i * 10}" y="106" width="8" height="5" rx="2.5" fill="#f2c230" stroke="#b8860b" stroke-width=".6"/>`).join('')}</g>`);
  if (a('clover')) out.push(`<g fill="#2e8b57"><circle cx="76" cy="101" r="2.3"/><circle cx="79" cy="103.5" r="2.3"/><circle cx="73.5" cy="104" r="2.3"/><path d="M76,104 L77,109" stroke="#2e8b57" stroke-width="1"/></g>`);
  if (a('flagpin')) out.push(`<rect x="72" y="100" width="10" height="7" fill="#1d5fa8"/><rect x="75" y="100" width="2" height="7" fill="#f5c400"/><rect x="72" y="102.5" width="10" height="2" fill="#f5c400"/>`);
  if (a('nametag')) out.push(`<g><rect x="35" y="99" width="34" height="18" rx="2" fill="#ffffff" stroke="#00000022"/><rect x="35" y="99" width="34" height="6" rx="2" fill="#d62839"/><text x="52" y="103.6" font-size="3.6" font-weight="700" fill="#fff" text-anchor="middle" font-family="Figtree, sans-serif">HELLO my name is</text><text x="52" y="113" font-size="6" fill="#1a1a1a" text-anchor="middle" font-family="Figtree, sans-serif" font-style="italic">${esc(p.name || 'Vanessa')}</text></g>`);
  if (a('mug')) out.push(`<g><rect x="84" y="94" width="18" height="20" rx="3" fill="${p.mugC || '#f4f1ea'}" stroke="#00000033"/><path d="M102,98 q7,0 7,6 q0,6 -7,6" fill="none" stroke="${p.mugC || '#f4f1ea'}" stroke-width="3"/><ellipse cx="93" cy="95" rx="8" ry="2" fill="#5a3a22"/><path d="M89,90 q-2,-3 0,-6 M95,90 q-2,-3 0,-6" stroke="#ffffff" stroke-width="1.3" fill="none" opacity=".85"/></g>`);
  if (a('milk')) out.push(`<g><path d="M86,90 L102,90 L100,118 L88,118Z" fill="#ffffff" stroke="#c9d6e0"/><ellipse cx="94" cy="90" rx="8" ry="2" fill="#f7fbff" stroke="#c9d6e0"/><path d="M88,96 L100,96" stroke="#e3edf5"/></g>`);
  if (a('cocktail')) out.push(`<g><path d="M86,84 L100,84 L99,118 L87,118Z" fill="#fff8d6" opacity=".9" stroke="#d4c37a"/><path d="M87,92 L99,92" stroke="#ffffff" opacity=".7"/><circle cx="100" cy="85" r="6" fill="#f7e463" stroke="#d6b800"/><circle cx="100" cy="85" r="3.6" fill="none" stroke="#fff5a8" stroke-width=".8"/><path d="M92,84 L96,70" stroke="#e85d75" stroke-width="1.8"/><circle cx="91" cy="100" r="2" fill="#ffffff" opacity=".7"/></g>`);
  if (a('phone')) out.push(`<g><rect x="16" y="96" width="13" height="22" rx="2.4" fill="#1a1a1e"/><rect x="17.5" y="98.5" width="10" height="16" rx="1" fill="#6ad1ff" opacity=".85"/><path d="M19,103 h6 M19,106 h4 M19,109 h6" stroke="#1a1a1e" stroke-width=".8"/></g>`);
  if (a('chips')) out.push(`<g>${[[86, '#d62839'], [97, '#1d1d1f'], [108, '#2a7fff']].map(([x, col], j) => [...Array(4 + j)].map((_, i) => `<ellipse cx="${x}" cy="${116 - i * 3}" rx="5.2" ry="2" fill="${col}" stroke="#ffffff" stroke-width=".7" stroke-dasharray="1.5 1.5"/>`).join('')).join('')}</g>`);
  if (a('calculator')) out.push(`<g><rect x="84" y="92" width="20" height="26" rx="2.5" fill="#3d4450"/><rect x="87" y="95" width="14" height="6" rx="1" fill="#b9d8a8"/><text x="100" y="99.8" font-size="4.6" text-anchor="end" fill="#2d3a24" font-family="IBM Plex Mono, monospace">0.33</text>${[0, 1, 2].map(r => [0, 1, 2].map(c => `<rect x="${87 + c * 5}" y="${104 + r * 4.4}" width="4" height="3.2" rx=".6" fill="#c9ced6"/>`).join('')).join('')}</g>`);
  if (a('camera')) out.push(`<g><rect x="82" y="94" width="22" height="15" rx="2.5" fill="#25272b"/><circle cx="90" cy="101.5" r="5.2" fill="#46494f" stroke="#111"/><circle cx="90" cy="101.5" r="2.6" fill="#7aa5d8"/><circle cx="100" cy="97.5" r="1.4" fill="#d62839"/><rect x="88" y="109" width="4" height="9" fill="#25272b"/></g>`);
  if (a('bills')) out.push(`<g>${[0, 1, 2].map(i => `<g transform="translate(${92},${108}) rotate(${-24 + i * 14})"><rect x="-11" y="-6" width="22" height="12" rx="1" fill="#7dbb6a" stroke="#4d8a3c" stroke-width=".6"/><circle cx="0" cy="0" r="3" fill="none" stroke="#4d8a3c" stroke-width=".6"/></g>`).join('')}</g>`);
  if (a('clap')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35), sl = mix(p.topC, '#000000', 0.1);
    out.push(`<g><path d="M24,120 C30,108 40,102 50,100 L54,106 C46,110 40,114 38,120Z" fill="${sl}"/><path d="M96,120 C90,108 80,102 70,100 L66,106 C74,110 80,114 82,120Z" fill="${sl}"/>`,
      `<path d="M50,99 C52,90 57,86 60,86 L60,107 C55,107 51,104 50,99Z" fill="${sk}" stroke="${ln}" stroke-width=".7"/>`,
      `<path d="M70,99 C68,90 63,86 60,86 L60,107 C65,107 69,104 70,99Z" fill="${sk}" stroke="${ln}" stroke-width=".7"/>`,
      `<path d="M60,87 L60,106" stroke="${ln}" stroke-width=".8"/>`,
      `<g fill="#2e8b57">${[...Array(6)].map((_, i) => `<circle cx="${48.5 + i * 1.6}" cy="${103.5 + (i % 2) * 0.6}" r="1"/>`).join('')}</g>`,
      `<rect x="66" y="101" width="7" height="5" rx="1.2" fill="#8a8f96"/><circle cx="69.5" cy="103.5" r="2.2" fill="#d9d9d9" stroke="#555" stroke-width=".5"/>`,
      `<g stroke="#f2c230" stroke-width="1.4" stroke-linecap="round"><path d="M44,86 l-5,-4 M42,92 l-6,0 M76,86 l5,-4 M78,92 l6,0"/></g></g>`);
  }
  if (a('clasped')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M36,120 C40,112 48,106 56,104 L64,104 C72,106 80,112 84,120Z" fill="${mix(p.topC, '#000000', 0.08)}"/>`,
      `<path d="M50,106 C52,99 58,97 60,98 C62,97 68,99 70,106 C68,112 52,112 50,106Z" fill="${sk}" stroke="${ln}" stroke-width=".7"/>`,
      `<path d="M53,104 q7,3 14,0 M54,107 q6,2.6 12,0" stroke="${ln}" stroke-width=".6" fill="none"/></g>`);
  }
  if (a('rail')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><rect x="0" y="112" width="120" height="8" fill="#3b2a20"/><rect x="0" y="112" width="120" height="2" fill="#5a4030"/>`,
      `<path d="M2,112 C10,106 30,105 44,108 C47,109 47,113 44,113.5 L2,114Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<path d="M118,112 C110,106 90,105 76,108 C73,109 73,113 76,113.5 L118,114Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<rect x="88" y="105.5" width="7" height="8" rx="1.6" fill="#1b1b1e"/><rect x="89.2" y="106.7" width="4.6" height="5.6" rx="1" fill="#2d6cdf"/><path d="M90,108.5 h3 M90,110.3 h2" stroke="#fff" stroke-width=".5"/></g>`);
  }
  if (a('clock')) out.push(`<g><circle cx="95" cy="104" r="11" fill="#fafafa" stroke="#2b2b2b" stroke-width="2"/>${[...Array(12)].map((_, i) => { const t = i * Math.PI / 6; return `<circle cx="${(95 + 8.4 * Math.sin(t)).toFixed(1)}" cy="${(104 - 8.4 * Math.cos(t)).toFixed(1)}" r=".7" fill="#2b2b2b"/>`; }).join('')}<path d="M95,104 L95,97.5 M95,104 L100,106" stroke="#2b2b2b" stroke-width="1.4" stroke-linecap="round"/><rect x="92" y="90" width="6" height="3" rx="1" fill="#2b2b2b"/></g>`);
  if (a('reachhand')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M28,120 C34,112 46,108 58,108 L59,115 C48,116 42,118 40,120Z" fill="${p.topC}"/>`,
      `<path d="M57,107.5 C64,106.5 72,107 77,109 C79,110.5 78,113.5 75,114 L59,115Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<g transform="translate(90,111) rotate(-6)"><rect x="-8" y="-6" width="11" height="15" rx="1.5" fill="#fafafa" stroke="#00000033"/><rect x="0" y="-6" width="11" height="15" rx="1.5" fill="#fafafa" stroke="#00000033"/></g></g>`);
  }
  if (a('trophy')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M14,92 C14,104 20,108 26,108 C32,108 38,104 38,92Z" fill="#f2c230" stroke="#b8860b" stroke-width=".8"/><path d="M14,95 C8,95 8,103 15,103 M38,95 C44,95 44,103 37,103" fill="none" stroke="#f2c230" stroke-width="2"/><rect x="23" y="108" width="6" height="5" fill="#d9a520"/><rect x="18" y="113" width="16" height="5" rx="1" fill="#7a5a10"/><path d="M19,94 q2,7 6,10" stroke="#fff6c8" stroke-width="1.4" fill="none" opacity=".8"/>`,
      `<path d="M30,120 C34,114 40,110 46,110 L46,117 C42,118 40,119 39,120Z" fill="${p.topC}"/><ellipse cx="36" cy="111" rx="6" ry="4.2" fill="${sk}" stroke="${ln}" stroke-width=".6"/><rect x="33.5" y="108.8" width="3" height="1.8" rx=".8" fill="#c9ced6" stroke="#8a8f96" stroke-width=".4"/></g>`);
  }
  if (a('leanarm')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><rect x="0" y="112" width="120" height="8" fill="#3b2a20"/><rect x="0" y="112" width="120" height="2" fill="#5a4030"/>`,
      `<path d="M0,104 C6,100 14,99 18,101 L20,112 L0,113Z" fill="${p.topC}"/>`,
      `<path d="M16,104 C28,102 42,103 50,106 C53,107.5 53,111.5 50,112.5 L18,113Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/></g>`);
  }
  if (a('nailhand')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M30,120 C34,112 44,108 56,108 L58,115 C48,116 42,118 40,120Z" fill="${p.topC}"/>`,
      `<path d="M55,107.5 C62,106 70,107 74,109.5 C76,111 75,114 72,114.5 L57,115Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<g fill="#3b1530">${[[70.5, 108.6], [73, 110.6], [72.4, 113.2]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.3" ry=".9"/>`).join('')}</g></g>`);
  }
  if (a('bandhand')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35);
    out.push(`<g><path d="M120,104 L100,107 C97,108 96,113 99,115 L120,116Z" fill="${p.topC}" stroke="#d9d9d9" stroke-width=".6"/>`,
      `<path d="M101,107.5 C92,107 84,108 80,111 C77,113 78,117 82,117.5 L101,117Z" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<rect x="92" y="106.6" width="5.5" height="11" rx="1.2" fill="#111"/></g>`);
  }
  // Burly forearms on the rail, fiddling a chip stack: wristbands left, gold watch right, ink on both arms.
  if (a('grinderarms')) {
    const sk = SKIN[p.skin] || p.skin, ln = mix(sk, '#000000', 0.35), ink = '#3b4656';
    const armL = 'M2,120 C10,111 30,102.5 48,100.5 C54,100 56,106 53,110 C44,112.5 34,116 28,120Z';
    const armR = 'M118,120 C110,111 90,102.5 72,100.5 C66,100 64,106 67,110 C76,112.5 86,116 92,120Z';
    out.push(`<g><clipPath id="${id}gl"><path d="${armL}"/></clipPath><clipPath id="${id}gr"><path d="${armR}"/></clipPath>`,
      `<path d="${armL}" fill="${sk}" stroke="${ln}" stroke-width=".6"/><path d="${armR}" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<g clip-path="url(#${id}gl)"><path d="M37.5,100 L43,116" stroke="#141414" stroke-width="3"/><path d="M41.2,99 L46.6,115" stroke="#f2c230" stroke-width="2.4"/><g fill="none" stroke="${ink}" stroke-width=".9" stroke-linecap="round" opacity=".75"><path d="M16,113 l3,3 M19.5,111 l2.4,3.8"/></g></g>`,
      `<g clip-path="url(#${id}gr)"><path d="M82.5,100 L77,116" stroke="#c9a227" stroke-width="4.2"/><g fill="none" stroke="${ink}" stroke-width=".9" stroke-linecap="round" opacity=".75"><path d="M94,108 q4,1.2 7,4 M96,113 q3,-2.4 6,-1 M99,116 l4,-1"/></g></g>`,
      `<circle cx="80" cy="107.8" r="3.4" fill="#d9b44a" stroke="#8a6b1c" stroke-width=".7"/><circle cx="80" cy="107.8" r="2.2" fill="#f4ecd0"/><path d="M80,107.8 V106.3 M80,107.8 l1,.5" stroke="#3a3a3a" stroke-width=".4"/>`,
      `<g>${[0, 1, 2, 3].map(i => `<rect x="55.5" y="${108.6 - i * 1.9}" width="9" height="1.9" rx=".6" fill="${i % 2 ? '#f4f4f4' : '#2d6cdf'}" stroke="#00000033" stroke-width=".3"/>`).join('')}</g>`,
      `<ellipse cx="52" cy="105.6" rx="6.4" ry="5.2" fill="${sk}" stroke="${ln}" stroke-width=".6"/><ellipse cx="68" cy="105.6" rx="6.4" ry="5.2" fill="${sk}" stroke="${ln}" stroke-width=".6"/>`,
      `<path d="M54.4,102.6 v4.6 M56.6,103.4 v3.6 M65.6,102.6 v4.6 M63.4,103.4 v3.6" stroke="${ln}" stroke-width=".5" opacity=".7"/></g>`);
  }
  if (a('watchhand')) {
    const sk = SKIN[p.skin] || p.skin, sl = mix(p.topC, '#000000', 0.1);
    out.push(`<g><path d="M120,102 L96,108 C93,109 92,114 95,116 L120,116Z" fill="${sl}"/>`,
      `<path d="M98,107.5 C90,107 82,108 78,111 C75,113 76,117 80,117.5 L98,117Z" fill="${sk}" stroke="${mix(sk, '#000000', 0.35)}" stroke-width=".6"/>`,
      `<path d="M80,111.5 h-3 M80,114 h-3.5" stroke="${mix(sk, '#000000', 0.35)}" stroke-width=".6"/>`,
      `<rect x="89" y="106" width="5" height="12" rx="1" fill="#8a8f96"/><circle cx="91.5" cy="112" r="4.4" fill="#d9b44a" stroke="#8a6b1c" stroke-width=".8"/><circle cx="91.5" cy="112" r="3" fill="#1b2a3a"/><path d="M91.5,112 L91.5,110 M91.5,112 L93,112.6" stroke="#f2f2f2" stroke-width=".5"/></g>`);
  }
  if (a('maple')) out.push(`<path transform="translate(60,108) scale(.42)" d="M0,-22 L4,-12 L9,-15 L7,-3 L15,-9 L13,-4 L21,-3 L17,3 L19,6 L6,7 L7,14 L1,10 L1,22 L-1,22 L-1,10 L-7,14 L-6,7 L-19,6 L-17,3 L-21,-3 L-13,-4 L-15,-9 L-7,-3 L-9,-15 L-4,-12Z" fill="${p.mapleC || '#d62839'}"/>`);
  if (a('basketball')) out.push(`<g><circle cx="95" cy="104" r="11" fill="#e8772e" stroke="#7a3a10" stroke-width=".8"/><path d="M84,104 h22 M95,93 v22 M87,96 q8,8 0,16 M103,96 q-8,8 0,16" fill="none" stroke="#7a3a10" stroke-width=".9"/></g>`);
  if (a('cone')) out.push(`<g><path d="M88,98 L100,98 L94,118Z" fill="#d9a35b" stroke="#a8743a" stroke-width=".6"/><path d="M89,101 l9,5 M90,106 l7,4 M98,101 l-9,5" stroke="#a8743a" stroke-width=".5"/><path d="M87,98 C86,91 91,88 94,88 C97,88 102,91 101,98Z" fill="#fffaf2" stroke="#e6dccc"/><path d="M94,88 C93,84 95,82 96,80" stroke="#fffaf2" stroke-width="3" stroke-linecap="round"/><path d="M88,94 q6,3 12,0" stroke="#e85d75" stroke-width="1.8" fill="none"/></g>`);
  if (a('book')) out.push(`<g transform="rotate(-8 94 106)"><rect x="83" y="92" width="22" height="27" rx="1.5" fill="#1f3b5c"/><rect x="83" y="92" width="3" height="27" fill="#132538"/><text x="95.5" y="103" font-size="4" font-weight="700" fill="#f2c230" text-anchor="middle" font-family="Figtree, sans-serif">THEORY</text><text x="95.5" y="108" font-size="3.4" fill="#f2c230" text-anchor="middle" font-family="Figtree, sans-serif">of the game</text></g>`);
  if (a('stream')) out.push(`<g><rect x="80" y="92" width="30" height="20" rx="2" fill="#18181b"/><rect x="82" y="94" width="26" height="14" rx="1" fill="#9146ff"/><circle cx="86" cy="97.5" r="1.4" fill="#ff4d4d"/><text x="89" y="99" font-size="3.6" font-weight="700" fill="#fff" font-family="Figtree, sans-serif">LIVE</text><path d="M84,102 h18 M84,105 h12" stroke="#ffffff" stroke-width=".9" opacity=".7"/><rect x="93" y="112" width="4" height="6" fill="#18181b"/></g>`);
  if (a('dice')) out.push(`<g><rect x="80" y="100" width="12" height="12" rx="2" fill="#ffffff" stroke="#00000033" transform="rotate(-12 86 106)"/><rect x="95" y="104" width="12" height="12" rx="2" fill="#d62839" transform="rotate(10 101 110)"/><g fill="#1a1a1a"><circle cx="83" cy="103.5" r="1"/><circle cx="86" cy="106" r="1"/><circle cx="89" cy="108.5" r="1"/></g><g fill="#ffffff"><circle cx="98.5" cy="107.5" r="1"/><circle cx="103.5" cy="112.5" r="1"/><circle cx="103.5" cy="107.5" r="1"/><circle cx="98.5" cy="112.5" r="1"/></g></g>`);
  if (p.cards) {
    const n = p.cards.length, spread = n > 2 ? 8 : 10, step = n > 2 ? 9 : 14, x0 = 112 - 7 - step * (n - 1);
    p.cards.forEach((cd, i) => out.push(card(x0 + i * step, 106, -spread * (n - 1) / 2 + i * spread, cd)));
  }
  return out.join('');
}

// Each bot: a base look, then variations. Traits nod to the inspiration without copying anyone.

export { SKIN, mix, avatar, seatAvatar };

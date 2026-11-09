// Seat and location signals at an always-on club's tables (#581): players
// physically close to each other, on the same network, behind a VPN or
// hosting network, or whose location looks faked. Worked out on the relay
// (club-room.js) from each connected player's latest reading and their
// connection; a flag means "look into it", not proof. A determined cheater
// can fake a location in ways a web page can't detect.
//
// What's kept: only the latest reading of each player, in the club room's
// memory, while they're connected (club-room.js drops it when they leave).
// What goes out: only the flags ('near', 'network', 'vpn', 'fake',
// 'hidden'), never a location or a distance. Same city alone isn't flagged.
//
// A reading, from the player's page (src/table-location.js) over their
// proven, unlocked connection: {type: 'location', lat, lon, acc, off}
// (degrees, metres, the browser's UTC offset in minutes), or {type:
// 'location', shared: false} when they said no or the browser can't.

// ---- the thresholds, all here ----
export const LIMITS = {
  // Two players this close (metres) are "within 100 m"...
  NEAR_M: 100,
  // ... when both readings are at least this accurate (metres): a browser
  // that only knows the city reports kilometres, and the same city alone
  // isn't flagged.
  NEAR_ACC_M: 250,
  // A GPS reading this far (km) from where the network says it is.
  FAR_KM: 1000,
  // The browser's UTC offset this many hours from what the longitude gives
  // (time zones stray up to about 3 hours from it, e.g. western China).
  TZ_HOURS: 3.5,
  // Accuracy under this (metres) isn't something a phone or browser reports.
  MIN_ACC_M: 1,
  // The same whole-number accuracy this many readings in a row while the
  // position moves: a made-up reading, not a measured one.
  SAME_ACC_RUN: 5,
  // Faster than this (m/s, about an airliner's speed) between readings...
  JUMP_MPS: 300,
  // ... over more than this (km) beyond both readings' accuracy.
  JUMP_KM: 5,
};

// A connection's trust level (#583): how much its client can be believed.
// Every connection is from the website today; the app, and the app with
// an attested device and a checked location, come later, and a table may
// then require one.
export const TRUST = ['website', 'app', 'attested app'];
export const trustOf = level => (TRUST.includes(level) ? level : 'website');

// Hosting, data-centre, VPN and proxy networks: by Cloudflare's ASN for the
// connection, and by words in the network's name. Home and mobile networks
// aren't here.
const HOSTING_ASNS = new Set([
  16509, 14618, 8987, // Amazon
  396982, 15169, 19527, // Google Cloud
  8075, 8068, // Microsoft Azure
  31898, // Oracle Cloud
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  14061, // DigitalOcean
  16276, // OVH
  24940, 213230, // Hetzner
  63949, // Linode
  20473, // Vultr (Choopa)
  51167, // Contabo
  60781, 28753, 16265, // Leaseweb
  9009, // M247 (many VPNs)
  60068, // Datacamp (CDN77, many VPNs)
  12876, // Scaleway
  8560, // IONOS
  47583, // Hostinger
  54290, // Hostwinds
  36352, // ColoCrossing
  40676, // Psychz
  8100, // QuadraNet
  62240, // Clouvider
  212238, // Datacamp
  39351, // 31173 Services (Mullvad)
  209854, // Surfshark
  136787, // PacketHub (NordVPN)
  62371, // Proton
  62044, 53813, // Zscaler
]);
const HOSTING_WORDS = /\b(hosting|host|cloud|data ?cent(er|re)|datacamp|server|servers|vps|vpn|proxy|colo|colocation|m247|digitalocean|linode|vultr|choopa|hetzner|ovh|amazon|aws|azure|oracle|alibaba|tencent|leaseweb|contabo|scaleway|ionos|zscaler|mullvad|nordvpn|surfshark|expressvpn|proton)\b/i;

// Consumer privacy relays: iCloud Private Relay (egress through Akamai,
// Cloudflare and Fastly) and Cloudflare WARP. They hide the address from
// sites, not where the phone is, so they get a milder flag of their own
// ('relay'), and not a Fair play one.
const RELAY_ASNS = new Set([13335, 36183, 54113]);
const RELAY_WORDS = /\b(private relay|icloud|warp|cloudflare|akamai|fastly)\b/i;

// Is network (asn, asOrg) a consumer privacy relay?
export function privateRelay(asn, asOrg) {
  if (asn != null && RELAY_ASNS.has(Number(asn))) return true;
  return !!asOrg && RELAY_WORDS.test(String(asOrg));
}

// Is network (asn, asOrg) a hosting, VPN or proxy network? (A privacy
// relay isn't: privateRelay.)
export function hostingNetwork(asn, asOrg) {
  if (privateRelay(asn, asOrg)) return false;
  if (asn != null && HOSTING_ASNS.has(Number(asn))) return true;
  return !!asOrg && HOSTING_WORDS.test(String(asOrg));
}

// The network part of an IP address: an IPv4 address whole, an IPv6
// address's first 64 bits (a home's devices share them), lower case.
export function ipNetwork(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return '';
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [], b = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map(g => (g.replace(/^0+/, '') || '0')).join(':');
}

// Metres between two points (haversine).
export function metres(a, b) {
  const R = 6371e3, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const fin = v => v !== null && v !== '' && Number.isFinite(Number(v));

// A location message's reading: {shared: false}, {shared: true, lat, lon,
// acc, off}, or null if it isn't one.
export function readingOf(m) {
  if (!m || m.type !== 'location') return null;
  if (m.shared === false) return {shared: false};
  if (![m.lat, m.lon, m.acc].every(fin)) return null;
  const lat = Number(m.lat), lon = Number(m.lon), acc = Number(m.acc);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || acc < 0) return null;
  return {shared: true, lat, lon, acc, off: fin(m.off) && Math.abs(Number(m.off)) <= 16 * 60 ? Number(m.off) : null};
}

// A connected player's live state, from their connection (club-room.js
// connSnapshot: `snap`, hashed; and Cloudflare's rough place for the
// network, `net`: {latitude, longitude}). No reading yet.
export function liveOf(snap = null, net = null) {
  const s = snap || {};
  const netLoc = net && fin(net.latitude) && fin(net.longitude) ? {lat: Number(net.latitude), lon: Number(net.longitude)} : null;
  return {
    ip: s.ip || null, ipNet: s.ipNet || null, hosting: hostingNetwork(s.asn, s.asOrg), relay: privateRelay(s.asn, s.asOrg), trust: trustOf(s.trust), netLoc,
    shared: null, loc: null, fake: [], accRun: null,
  };
}

// Takes reading `r` (readingOf) into live state `L` at `now`: the latest
// reading replaces the one before, and any sign of a faked location is
// noted (for as long as they're connected): 'far' (far from their
// network), 'timezone' (the browser's time zone isn't the place's),
// 'accuracy' (accuracy no real reading gives), 'jump' (moved impossibly
// fast since the last reading).
export function takeReading(L, r, now = Date.now()) {
  if (!r) return L;
  if (!r.shared) {
    L.shared = false;
    L.loc = null;
    L.accRun = null;
    return L;
  }
  const why = new Set(L.fake);
  const prev = L.loc;
  if (L.netLoc && !L.hosting && metres(r, L.netLoc) > LIMITS.FAR_KM * 1000) why.add('far');
  if (r.off != null) {
    let d = (r.off - (r.lon / 15) * 60) % 1440;
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    if (Math.abs(d) > LIMITS.TZ_HOURS * 60) why.add('timezone');
  }
  if (r.acc < LIMITS.MIN_ACC_M) why.add('accuracy');
  const moved = prev && metres(prev, r) > 1;
  if (prev && Number.isInteger(r.acc) && r.acc === prev.acc && moved) {
    L.accRun = (L.accRun || 1) + 1;
    if (L.accRun >= LIMITS.SAME_ACC_RUN) why.add('accuracy');
  } else if (!prev || r.acc !== prev.acc) L.accRun = 1;
  if (prev && now > prev.at) {
    const d = metres(prev, r);
    const beyond = d - prev.acc - r.acc;
    if (beyond > LIMITS.JUMP_KM * 1000 && d / ((now - prev.at) / 1000) > LIMITS.JUMP_MPS) why.add('jump');
  }
  L.shared = true;
  L.loc = {lat: r.lat, lon: r.lon, acc: r.acc, at: now};
  L.fake = [...why].sort();
  return L;
}

// The signals among players `players` ([{id, live}], `live` from liveOf,
// or null for someone not connected): {seats: {id: [kind]}, flags: [{kind,
// ids, why?}]}. Kinds: 'near' (within NEAR_M of each other), 'network' (the
// same network), 'vpn' (a hosting, VPN or proxy network), 'relay' (a
// consumer privacy relay: iCloud Private Relay, WARP), 'fake' (location
// may be faked; `why`), 'hidden' (connected, location not shared). No
// location in it.
const KINDS = ['near', 'network', 'vpn', 'relay', 'fake', 'hidden'];
const PAIRED = ['near', 'network'];
export function tableSignals(players) {
  const seats = {}, flags = [];
  const add = (id, kind) => { (seats[id] ||= []).includes(kind) || seats[id].push(kind); };
  const on = (players || []).filter(p => p?.id && p.live);
  for (const {id, live: L} of on) {
    if (L.hosting) { add(id, 'vpn'); flags.push({kind: 'vpn', ids: [id]}); }
    if (L.relay) { add(id, 'relay'); flags.push({kind: 'relay', ids: [id]}); }
    if (L.fake.length) { add(id, 'fake'); flags.push({kind: 'fake', ids: [id], why: [...L.fake]}); }
    if (L.shared !== true) { add(id, 'hidden'); flags.push({kind: 'hidden', ids: [id]}); }
  }
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i], b = on[j], A = a.live, B = b.live;
      const ids = [a.id, b.id].sort();
      if ((A.ipNet && A.ipNet === B.ipNet) || (A.ip && A.ip === B.ip)) {
        add(a.id, 'network'); add(b.id, 'network');
        flags.push({kind: 'network', ids});
      }
      if (A.loc && B.loc && A.loc.acc <= LIMITS.NEAR_ACC_M && B.loc.acc <= LIMITS.NEAR_ACC_M && metres(A.loc, B.loc) <= LIMITS.NEAR_M) {
        add(a.id, 'near'); add(b.id, 'near');
        flags.push({kind: 'near', ids});
      }
    }
  }
  const order = KINDS;
  for (const k of Object.keys(seats)) seats[k].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return {seats, flags};
}

// What each player at one table is sent (#581), from the table's seats
// (`seats`: [{seat, id}], the engine's seat numbers) and their signals
// (`sig`, tableSignals): forViewer(id) → {seats: {seat: [kind]}, groups:
// [{letter, seats: [seat], links: [{kind, seats: [a, b]}]}]}.
// Players linked by 'near' or 'network', directly or through each other,
// make one group, lettered A, B... by their lowest seat, the same for
// everyone. A player is never sent a group they're in: knowing where
// they are, "Bo is within 100 m of you" would tell them where Bo is. So
// for them the group, and its members' 'near' and 'network', are left
// out; one-player flags ('vpn', 'relay', 'fake', 'hidden') go to everyone.
export function seatPayloads(seats, sig) {
  const seatOf = new Map((seats || []).filter(s => s?.id != null).map(s => [s.id, s.seat]));
  const root = new Map([...seatOf.keys()].map(id => [id, id]));
  const find = id => { while (root.get(id) !== id) id = root.get(id); return id; };
  const links = (sig?.flags || []).filter(f => PAIRED.includes(f.kind) && f.ids.length === 2 && f.ids.every(id => seatOf.has(id)));
  for (const f of links) root.set(find(f.ids[0]), find(f.ids[1]));
  const by = new Map();
  for (const f of links) {
    const r = find(f.ids[0]);
    if (!by.has(r)) by.set(r, {ids: new Set(), links: []});
    const g = by.get(r);
    f.ids.forEach(id => g.ids.add(id));
    g.links.push({kind: f.kind, seats: f.ids.map(id => seatOf.get(id)).sort((a, b) => a - b)});
  }
  const groups = [...by.values()]
    .map(g => ({ids: g.ids, seats: [...g.ids].map(id => seatOf.get(id)).sort((a, b) => a - b), links: g.links}))
    .sort((a, b) => a.seats[0] - b.seats[0])
    .map((g, i) => ({...g, letter: String.fromCharCode(65 + (i % 26))}));
  return viewer => {
    const mine = groups.find(g => g.ids.has(viewer));
    const out = {};
    for (const [id, seat] of seatOf) {
      const kinds = (sig?.seats?.[id] || []).filter(k => !(mine?.ids.has(id) && PAIRED.includes(k)));
      if (kinds.length) out[seat] = kinds;
    }
    return {seats: out, groups: groups.filter(g => g !== mine).map(({letter, seats: ss, links: ls}) => ({letter, seats: ss, links: ls}))};
  };
}

// The browser's location at a club table (#581): asked for when the player
// sits down, and sent to the club's room on the relay with its accuracy, so
// the relay can flag players within 100 m of each other or whose location
// looks faked (relay/src/proximity.js). Nothing else sees it: the relay
// keeps only the latest reading while the player is connected, and others
// see only the flags. If the player says no (or the browser can't), the
// relay hears {shared: false} and their seat shows "location not shared".
//
// watchLocation(send) starts it: send(msg) gets each message to pass on
// ({type: 'location', lat, lon, acc, off} or {type: 'location', shared:
// false}). New readings go at most every MIN_MS; the latest goes again every
// EVERY_MS (the relay forgets it if its room sleeps). Returns {again() (send
// the latest now: reconnected), stop()}.

export const MIN_MS = 15_000;
export const EVERY_MS = 60_000;

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export function watchLocation(send, {geo = typeof navigator !== 'undefined' ? navigator.geolocation : null, now = () => Date.now(), timers = globalThis} = {}) {
  let last = null, sentAt = 0, watchId = null, stopped = false;
  const out = (force = false) => {
    if (stopped || !last) return;
    if (!force && last.shared !== false && now() - sentAt < MIN_MS) return;
    sentAt = now();
    try { send(last); } catch (e) { console.warn('location not sent:', e); }
  };
  const refused = () => {
    const was = last?.shared === false;
    last = {type: 'location', shared: false};
    if (!was) out(true);
  };
  if (!geo?.watchPosition) refused();
  else {
    watchId = geo.watchPosition(pos => {
      const c = pos.coords;
      const first = !last || last.shared === false;
      // Rounded to about a metre: no more is needed for 100 m.
      last = {type: 'location', lat: round(c.latitude, 5), lon: round(c.longitude, 5), acc: round(c.accuracy, 1), off: -new Date().getTimezoneOffset()};
      out(first);
    }, err => {
      // Said no; or no position (no signal, timed out) and none before.
      if (err?.code === 1 || !last) refused();
    }, {enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000});
  }
  const tick = timers.setInterval(() => out(true), EVERY_MS);
  return {
    again: () => out(true),
    stop() {
      stopped = true;
      timers.clearInterval(tick);
      if (watchId != null) geo.clearWatch(watchId);
    },
  };
}

// Scheduled cash games (#599): ducy-play's club scheduled games, through
// club-rules.js, and their times.
//
// club.scheduled = [{id, game: {key, game, sb, bb, …}, startAt, players,
// minPlayers, checkInMs, status: 'upcoming' | 'short' | 'started' |
// 'cancelled', signups: [{member, at, checkedIn?, promoted?, result?,
// table?}], …}]. The first `players` signed up have seats, the rest wait.
// Check-in opens checkInMs before startAt; at the start, checked-in players
// are seated (no-shows' seats going to the checked-in waitlist), tables open
// and seats are held for them (club-server.js times and sends it).
//
// Times: each start is an exact instant (ms, UTC). The owner enters a date
// and time in their own time zone (localToUtc); everyone sees it in theirs,
// the zone named (whenText: "Thu 7:00 PM CST").

import { rules } from './club-rules.js';

export const CHECK_IN_MS = 60 * 60_000;

// ---- the owner's ----
export const scheduleGame = (club, spec, now = Date.now()) => rules(club, {op: 'scheduleGame', spec}, now);
export const editScheduled = (club, id, spec, now = Date.now()) => rules(club, {op: 'editScheduled', id, spec}, now);
export const cancelScheduled = (club, id, now = Date.now()) => rules(club, {op: 'cancelScheduled', id}, now);
// Start it now, short if need be; `most`: the plan's tables open at once.
export const startScheduled = (club, id, most = null, now = Date.now()) => rules(club, {op: 'startScheduled', id, most}, now);

// ---- a member's ----
export const schedSignUp = (club, id, who, now = Date.now()) => rules(club, {op: 'schedSignUp', id, who}, now);
export const schedLeave = (club, id, who, now = Date.now()) => rules(club, {op: 'schedLeave', id, who}, now);
export const schedCheckIn = (club, id, who, now = Date.now()) => rules(club, {op: 'schedCheckIn', id, who}, now);

// ---- the clock ----
// Check-in opening and starts due now: {sends, opened, afterOpen, listsTo}.
export const scheduledDue = (club, most = null, now = Date.now()) => rules(club, {op: 'scheduledDue', most}, now);
// When that's next, or null.
export const nextScheduledDue = club => rules(club, {op: 'nextScheduledDue'});
// What member `id` is told: {type: 'scheduled', club, games}.
export const scheduledFor = (club, id, now = Date.now()) => rules(club, {op: 'scheduledFor', id}, now);

// The owner's lists for game `g`: {signedUp, checkedIn, waitlist, noShows}
// (member ids). After the start, from what each got.
export function roster(g) {
  const ups = g.signups || [];
  const seats = ups.slice(0, g.players), wait = ups.slice(g.players);
  if (g.status === 'started') {
    const r = k => ups.filter(s => s.result === k).map(s => s.member);
    return {signedUp: seats.map(s => s.member), checkedIn: ups.filter(s => s.checkedIn).map(s => s.member), waitlist: r('waitlist'), noShows: r('noShow')};
  }
  return {
    signedUp: seats.map(s => s.member),
    checkedIn: ups.filter(s => s.checkedIn).map(s => s.member),
    waitlist: wait.map(s => s.member),
    noShows: Date.now() >= g.startAt ? seats.filter(s => !s.checkedIn).map(s => s.member) : [],
  };
}

// ---- times ----

// The wall-clock parts of instant `ms` in time zone `timeZone`.
function wall(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

// The instant a date and time ("2026-11-12T19:00", as a datetime-local
// input gives it) is in time zone `timeZone` (default: this browser's).
// NaN if it isn't one. A time a clock change skips reads as an hour later.
export function localToUtc(text, timeZone = undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // The zone's offset at the guess, then at the answer (across a change);
  // a skipped time keeps the first answer, an hour on.
  const t = guess - (wall(guess, timeZone) - guess);
  const t2 = guess - (wall(t, timeZone) - t);
  return wall(t2, timeZone) === guess ? t2 : t;
}

// Instant `ms` as a datetime-local input shows it in `timeZone`.
export function utcToLocal(ms, timeZone = undefined) {
  return new Date(wall(ms, timeZone)).toISOString().slice(0, 16);
}

// Instant `ms` in the viewer's time zone (or `timeZone`), the zone named:
// "Thu 7:00 PM CST"; more than six days off, with the date: "Thu, Nov 19,
// 7:00 PM CST".
export function whenText(ms, {timeZone = undefined, now = Date.now()} = {}) {
  const far = Math.abs(ms - now) > 6 * 864e5;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).formatToParts(ms).map(x => [x.type, x.value]));
  const time = `${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
  return far ? `${p.weekday}, ${p.month} ${p.day}, ${time}` : `${p.weekday} ${time}`;
}

// Time left until `at`, in words: "2h 5m", "4m", "now".
export function timeLeft(at, now = Date.now()) {
  const m = Math.ceil((at - now) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

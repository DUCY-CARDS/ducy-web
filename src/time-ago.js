// When something happened, for lists (#193): relative ("5 min ago") while
// recent, the date after a week.
export function ago(t, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

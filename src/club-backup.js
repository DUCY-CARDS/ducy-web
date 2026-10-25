// A club's backup file (#152) and proving it works (#395).
//
// The file is a player ID backup (identity.js, locked with a password) with
// the club's code and name added: restoring it (player-settings.js) brings
// back the ID that owns the club, and the club manager reopens the club.
//
// Proving it: right after saving the file, the owner opens it again with
// its password. That unlocks it the same way a restore does, but only to
// check it is this club and this owner's player ID; the browser's own ID is
// left as it is. Until a backup is proved the club is temporary (#395).

import { exportLockedIdentity, importIdentity } from './identity.js';

// The backup file's text: `ident` locked with `password`, and the club.
export async function clubBackupText(ident, password, {code, name = ''}) {
  const locked = JSON.parse(await exportLockedIdentity(ident, password));
  return JSON.stringify({...locked, club: {code, name}});
}

// Opens a backup file (a club's or a plain player ID's) as a restore does:
// {ident, club}, where club is {code, name} or null. Throws why not.
export async function openBackup(text, password = '') {
  const ident = await importIdentity(text, password);
  let club = null;
  try {
    const c = JSON.parse(text).club;
    if (c && typeof c.code === 'string') club = {code: c.code, name: String(c.name || '')};
  } catch {}
  return {ident, club};
}

// Checks that backup `text`, opened with `password`, would bring back club
// `code` for owner `ownerId`. Resolves once it does; throws, in words for
// the owner, why not.
export async function proveClubBackup(text, password, {code, ownerId}) {
  const {ident, club} = await openBackup(text, password);
  if (!club) throw new Error('That’s a player ID backup, not this club’s. Choose the file you just saved.');
  if (club.code !== code) throw new Error(`That’s the backup of another club (${club.name || club.code}). Choose this club’s file.`);
  if (ident.id !== ownerId) throw new Error('That backup holds another player ID, not the one that owns this club.');
}

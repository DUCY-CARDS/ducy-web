// A club's backup file (#152) and proving it works (#395).
//
// The file is a player ID backup (identity.js, locked with a password) with
// the club's code and name added: restoring it (player-settings.js) brings
// back the ID that owns the club, and the club manager reopens the club.
// The file's format and the checks are ducy-identity's (#460).
//
// Proving it: right after saving the file, the owner opens it again with
// its password. That unlocks it the same way a restore does, but only to
// check it is this club and this owner's player ID; the browser's own ID is
// left as it is. Until a backup is proved the club is temporary (#395).

import * as ducy from '../wasm/ducy_wasm.js';
import { exportLockedIdentity, importIdentity } from './identity.js';

// The backup file's text: `ident` locked with `password`, and the club.
export async function clubBackupText(ident, password, {code, name = ''}) {
  return ducy.backupWithClub(await exportLockedIdentity(ident, password, {name}), code, name);
}

// Opens a backup file (a club's or a plain player ID's) as a restore does:
// {ident, club}, where club is {code, name} or null. Throws why not.
export async function openBackup(text, password = '') {
  const ident = await importIdentity(text, password);
  const r = ducy.readBackup(String(text));
  return {ident, club: r.ok ? r.value.club : null};
}

// Checks that backup `text`, opened with `password`, would bring back club
// `code` for owner `ownerId`. Resolves once it does; throws, in words for
// the owner, why not.
export async function proveClubBackup(text, password, {code, ownerId}) {
  const {ident, club} = await openBackup(text, password);
  const why = ducy.proveClubBackup(JSON.stringify(club), ident.id, code, ownerId);
  if (why) throw new Error(why);
}

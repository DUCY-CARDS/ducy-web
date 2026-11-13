// A club's backup file (#152), an option beside the passkey (#654).
//
// The file is a player ID backup (identity.js, locked with a password) with
// the club's code and name added: restoring it (player-settings.js) brings
// back the ID that owns the club, and the club manager reopens the club.
// The file's format is ducy-identity's (#460).

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

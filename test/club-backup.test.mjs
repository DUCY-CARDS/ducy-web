// A club's backup file (src/club-backup.js): it opens with its password, as
// a restore would, with the club's code and name.
import test from 'node:test';
import assert from 'node:assert/strict';
import './wasm.mjs';
import { createIdentity, exportLockedIdentity } from '../src/identity.js';
import { clubBackupText, openBackup } from '../src/club-backup.js';

const PW = 'correct horse';

test('a club’s backup opens with its password, with the club', async () => {
  const ann = await createIdentity();
  const text = await clubBackupText(ann, PW, {code: 'AAAA-AAAA', name: 'Night Owls'});
  const {ident, club} = await openBackup(text, PW);
  assert.equal(ident.id, ann.id);
  assert.deepEqual(club, {code: 'AAAA-AAAA', name: 'Night Owls'});
  await assert.rejects(openBackup(text, 'wrong password'), /Wrong password/);
  await assert.rejects(openBackup(text, ''), /locked with a password/);
  await assert.rejects(openBackup('not a file', PW), /isn’t a ducy identity file/);
});

test('a player ID backup opens with no club', async () => {
  const ann = await createIdentity();
  const {ident, club} = await openBackup(await exportLockedIdentity(ann, PW), PW);
  assert.equal(ident.id, ann.id);
  assert.equal(club, null);
});

test('a club’s backup needs a strong password, and not the club’s name (#436)', async () => {
  const ann = await createIdentity();
  await assert.rejects(clubBackupText(ann, 'owls', {code: 'AAAA-AAAA', name: 'Night Owls'}), /at least 12/);
  await assert.rejects(clubBackupText(ann, 'Night Owls 1!', {code: 'AAAA-AAAA', name: 'Night Owls'}), /club’s name/);
  await assert.rejects(clubBackupText(ann, 'pokerclub2026', {code: 'AAAA-AAAA', name: 'Night Owls'}), /too common/);
});

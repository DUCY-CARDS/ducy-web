// A club's backup file and proving it works (#395, src/club-backup.js): it
// opens with its password, as a restore would, and must be this club's and
// hold its owner's player ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, exportLockedIdentity } from '../src/identity.js';
import { clubBackupText, openBackup, proveClubBackup } from '../src/club-backup.js';

const PW = 'correct horse';

test('a club’s backup opens with its password and proves this club and owner', async () => {
  const ann = await createIdentity();
  const text = await clubBackupText(ann, PW, {code: 'AAAA-AAAA', name: 'Night Owls'});
  const {ident, club} = await openBackup(text, PW);
  assert.equal(ident.id, ann.id);
  assert.deepEqual(club, {code: 'AAAA-AAAA', name: 'Night Owls'});
  await proveClubBackup(text, PW, {code: 'AAAA-AAAA', ownerId: ann.id});
});

test('a club’s backup needs a strong password, and not the club’s name (#436)', async () => {
  const ann = await createIdentity();
  await assert.rejects(clubBackupText(ann, 'owls', {code: 'AAAA-AAAA', name: 'Night Owls'}), /at least 12/);
  await assert.rejects(clubBackupText(ann, 'Night Owls 1!', {code: 'AAAA-AAAA', name: 'Night Owls'}), /club’s name/);
  await assert.rejects(clubBackupText(ann, 'pokerclub2026', {code: 'AAAA-AAAA', name: 'Night Owls'}), /too common/);
});

test('a proof fails, saying why: wrong password, another club, another ID, or no club', async () => {
  const ann = await createIdentity(), bob = await createIdentity();
  const text = await clubBackupText(ann, PW, {code: 'AAAA-AAAA', name: 'Night Owls'});
  const club = {code: 'AAAA-AAAA', ownerId: ann.id};
  await assert.rejects(proveClubBackup(text, 'wrong password', club), /Wrong password/);
  await assert.rejects(proveClubBackup(text, '', club), /locked with a password/);
  await assert.rejects(proveClubBackup(text, PW, {...club, code: 'BBBB-BBBB'}), /another club \(Night Owls\)/);
  await assert.rejects(proveClubBackup(text, PW, {...club, ownerId: bob.id}), /another player ID/);
  await assert.rejects(proveClubBackup(await exportLockedIdentity(ann, PW), PW, club), /player ID backup, not this club’s/);
  await assert.rejects(proveClubBackup('not a file', PW, club), /isn’t a ducy identity file/);
});

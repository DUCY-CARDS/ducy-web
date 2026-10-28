// Backups of always-on clubs (#97): encrypted, HMAC-signed snapshots sent to
// an endpoint like relay/hostrocket/backup.php (a Node stand-in here, same
// protocol), and a club rebuilt from one with balances intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { backupConfig, decrypt, dropBackups, encrypt, pullBackup, pushBackup, signature } from '../relay/src/backup.js';
import { createClub, openClub } from '../relay/src/club-room.js';
import { createIdentity, signMessage } from '../src/identity.js';

const WASM = new URL('../wasm/ducy_wasm_bg.wasm', import.meta.url);
const haveWasm = existsSync(WASM);
const SECRET = 'test-secret';
const KEY = randomBytes(32).toString('base64');

// The endpoint, as backup.php does it: same checks, kept in memory.
function endpoint() {
  const rows = new Map(); // club → [body]
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const club = u.searchParams.get('club') || '';
      const time = req.headers['x-ducy-time'] || '';
      const sig = String(req.headers['x-ducy-sig'] || '');
      const out = (status, text) => { res.writeHead(status); res.end(text); };
      if (!/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(club)) return out(400, 'bad club code');
      if (!/^\d+$/.test(time) || Math.abs(Number(time) - Date.now()) > 300_000) return out(403, 'stale or missing time');
      const bodyHash = body ? createHash('sha256').update(body).digest('hex') : '';
      const expected = createHmac('sha256', SECRET).update(`${time}\n${req.method}\n${club}\n${bodyHash}`).digest('hex');
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return out(403, 'bad signature');
      seen.push(body);
      if (req.method === 'POST') { rows.set(club, [...(rows.get(club) || []), body].slice(-10)); return out(200, '{"ok":true}'); }
      if (req.method === 'GET') { const r = rows.get(club); return r ? out(200, r.at(-1)) : out(404, 'no backup'); }
      if (req.method === 'DELETE') { rows.delete(club); return out(200, '{"ok":true}'); }
      out(405, '');
    });
  });
  return new Promise(resolve => server.listen(0, () => resolve({server, rows, seen, url: `http://127.0.0.1:${server.address().port}/backup.php`})));
}

function memoryStorage() {
  const m = new Map();
  return {get: async k => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); }, keys: () => [...m.keys()]};
}

test('backups are off unless the URL, secret and key are all set', () => {
  assert.equal(backupConfig({}), null);
  assert.equal(backupConfig({BACKUP_URL: 'x', BACKUP_SECRET: 'y'}), null);
  assert.deepEqual(backupConfig({BACKUP_URL: 'x', BACKUP_SECRET: 'y', BACKUP_KEY: 'z'}), {url: 'x', secret: 'y', key: 'z'});
});

test('snapshots are encrypted: a wrong key or a changed byte fails', async () => {
  const box = await encrypt(KEY, {hello: 'club'});
  assert.deepEqual(await decrypt(KEY, box), {hello: 'club'});
  await assert.rejects(decrypt(randomBytes(32).toString('base64'), box));
  const ct = Buffer.from(box.ct, 'base64');
  ct[0] ^= 1;
  await assert.rejects(decrypt(KEY, {...box, ct: ct.toString('base64')}));
  // Big snapshots too (a long ledger).
  const big = {ledger: 'x'.repeat(300_000)};
  assert.deepEqual(await decrypt(KEY, await encrypt(KEY, big)), big);
});

test('the signature matches what backup.php computes', async () => {
  const body = '{"v":1}';
  const expected = createHmac('sha256', 's').update(`123\nPOST\nABCD-EFGH\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
  assert.equal(await signature('s', '123', 'POST', 'ABCD-EFGH', body), expected);
  assert.equal(await signature('s', '123', 'GET', 'ABCD-EFGH'), createHmac('sha256', 's').update('123\nGET\nABCD-EFGH\n').digest('hex'));
});

test('a club whose storage is lost is rebuilt from its backup, balances intact; bad signatures are refused', {skip: !haveWasm && 'no wasm build'}, async () => {
  const ep = await endpoint();
  try {
    const cfg = {url: ep.url, secret: SECRET, key: KEY};
    const m = await import('../wasm/ducy_wasm.js');
    m.initSync({module: readFileSync(WASM)});
    const owner = await createIdentity(), ann = await createIdentity();
    const code = 'BACK-UPPP';
    const storage = memoryStorage();
    const {hostId, invite} = await createClub(storage, await signMessage(owner, {type: 'create_club', club: code, name: 'Backed Up'}), code);
    const server = await openClub({storage, send() {}, online: [owner.id, ann.id]});
    const say = async (who, body) => server.message({from: who.id, data: await signMessage(who, {club: code, ...body})});
    await say(ann, {type: 'join', invite, name: 'Ann'});
    await say(owner, {type: 'owner_cmd', op: 'approve', args: {id: ann.id}, id: 1});
    await say(owner, {type: 'owner_cmd', op: 'give', args: {id: ann.id, amount: 750}, id: 2});
    await server.flush();
    await pushBackup(cfg, storage, code);
    assert.ok(!ep.rows.get(code)[0].includes('Backed Up'), 'the endpoint only sees ciphertext');

    // The room's storage is gone; a fresh room rebuilds the club.
    const fresh = memoryStorage();
    assert.equal(await pullBackup(cfg, fresh, code), true);
    const again = await openClub({storage: fresh, send() {}, online: []});
    assert.equal(again.club.members[ann.id].balance, 750);
    assert.equal(again.club.hostId, hostId, 'same signing identity, so members still trust it');
    assert.equal(again.club.ownerId, owner.id);

    // Wrong secret: refused. Unknown club: nothing to rebuild. Deleted: gone.
    await assert.rejects(pushBackup({...cfg, secret: 'nope'}, storage, code), /403/);
    assert.equal(await pullBackup(cfg, memoryStorage(), 'NNNN-NNNN'), false);
    await dropBackups(cfg, code);
    assert.equal(await pullBackup(cfg, memoryStorage(), code), false);
  } finally {
    ep.server.close();
  }
});

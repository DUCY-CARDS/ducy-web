// Club grants for the browser tests (#636): a test admin for a relay of the
// test's own (its ADMINS_FILE), and the one-time link the admin site would
// make for a browser's player, so that browser can start a club. The signing
// runs in admin-cli.mjs, a process of its own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./admin-cli.mjs', import.meta.url));
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [CLI, ...args])).stdout);

// {file, key}: an admins.json for the relay, and the admin's key.
export const grantAdmin = () => cli('new');

// The relay's answer to admin request `path` with `data`: {status, body}.
export const adminCall = (admin, port, path, data = {}) => cli('call', admin.key, String(port), path, JSON.stringify(data));

// A new grant's token for player `id`.
export async function grantFor(admin, port, id) {
  const r = await adminCall(admin, port, '/admin/grant', {id});
  if (r.status !== 200) throw new Error(`grant: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

// Opens the club manager in `page` on relay `relay` (ws://localhost:<port>),
// reads its player ID, grants it a club as `admin`, and returns the link's
// address (#clubs/start/<token>, as the admin site makes it for a local page).
export async function grantLink(page, relay, admin) {
  await page.goto(`/manage.html?relay=${relay}#clubs`);
  // Drawn once ducy's engine is in: player IDs need it.
  await page.locator('#clubs .cl-pass, #clubs .pl-head').first().waitFor();
  const id = await page.evaluate(() => import('/src/identity.js').then(m => m.loadIdentity()).then(i => i.id));
  const token = await grantFor(admin, new URL(relay).port, id);
  return `/manage.html?relay=${relay}#clubs/start/${token}`;
}

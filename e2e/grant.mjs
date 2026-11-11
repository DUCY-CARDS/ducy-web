// Club grants for the browser tests (#636): a test admin for a relay of the
// test's own (its ADMINS_FILE), and the one-time link the admin site would
// make for a browser's player, so that browser can start a club.
import '../test/wasm.mjs';
import { granter, testAdmin } from '../test/admin-helper.mjs';

export const grantAdmin = () => testAdmin('E2E admin');

// Opens the club manager in `page` on relay `relay` (ws://localhost:<port>),
// reads its player ID, grants it a club as `admin`, and returns the link's
// address (#clubs/start/<token>, as the admin site makes it).
export async function grantLink(page, relay, admin) {
  await page.goto(`/manage.html?relay=${relay}#clubs`);
  const id = await page.evaluate(() => import('/src/identity.js').then(m => m.loadIdentity()).then(i => i.id));
  const token = await granter(Number(new URL(relay).port), admin.ident)(id);
  return `/manage.html?relay=${relay}#clubs/start/${token}`;
}

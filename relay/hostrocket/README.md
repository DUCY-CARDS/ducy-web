# Club backups on HostRocket (#97)

Always-on clubs run in the relay on Cloudflare. Each club's room also sends
a snapshot of the club here after changes (at most every 5 minutes), and a
room that should hold a club but finds its storage empty rebuilds it from
the latest snapshot. Snapshots are encrypted by the relay before they're
sent, so this server and its database only ever hold ciphertext.

## Setup (once)

1. **Database.** In cPanel → MySQL Databases, create a database and a user
   with all privileges on it. Run `schema.sql` in phpMyAdmin.
2. **Secrets.** Make two random values, for example with
   `openssl rand -base64 32` (run it twice):
   - the **HMAC secret**, shared by the relay and this endpoint;
   - the **encryption key** (32 bytes, base64), which only the relay has.
3. **Endpoint.** Upload `backup.php` to `ducy-backup/` in the site's root
   folder, the one the site deploy writes to. The deploy leaves that folder
   alone (`scripts/deploy.sh`); any other name would be deleted on the next
   deploy. Next to it, copy
   `config.example.php` to `config.php` and fill in the HMAC secret and the
   database details. Add an `.htaccess` there with `Options -Indexes`.
   The endpoint is then e.g. `https://ducy.cards/ducy-backup/backup.php`.
4. **Relay.** Set three secrets on the Worker (run from `relay/`):
   ```
   npx wrangler secret put BACKUP_URL     # the endpoint's URL
   npx wrangler secret put BACKUP_SECRET  # the HMAC secret
   npx wrangler secret put BACKUP_KEY     # the encryption key
   ```
   Backups stay off until all three are set.

**Keep the encryption key somewhere safe too** (a password manager): with
the database alone, the snapshots can't be read.

## Checking it

`node relay/hostrocket/check.mjs <endpoint> <hmac secret>` saves, reads
back and deletes a test snapshot for the club code `TEST-TEST`, and checks
that a request with a wrong signature is refused.

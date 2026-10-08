-- Backups of always-on clubs (#97): encrypted snapshots from the relay.
CREATE TABLE IF NOT EXISTS club_backups (
  id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  club CHAR(9)         NOT NULL,          -- the club code, e.g. ABCD-EFGH
  at   BIGINT          NOT NULL,          -- when the relay sent it (ms)
  data MEDIUMTEXT      NOT NULL,          -- {v, iv, ct}: AES-GCM ciphertext, base64
  KEY club_id (club, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

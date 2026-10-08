<?php
// Copy to config.php next to backup.php (it's not in git) and fill in.
// DUCY_BACKUP_SECRET must match the Worker's BACKUP_SECRET secret.
define('DUCY_BACKUP_SECRET', 'paste a long random secret here');
define('DUCY_DB_DSN', 'mysql:host=localhost;dbname=YOUR_DB;charset=utf8mb4');
define('DUCY_DB_USER', 'YOUR_DB_USER');
define('DUCY_DB_PASS', 'YOUR_DB_PASSWORD');

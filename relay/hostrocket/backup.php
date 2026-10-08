<?php
// Backups of ducy's always-on clubs (#97), kept on ducy.cards' host. The
// relay's club rooms send encrypted snapshots here (relay/src/backup.js);
// this endpoint never sees a club's contents, only ciphertext.
//
// Setup: see README.md in this folder. config.php (not in git) defines
// DUCY_BACKUP_SECRET and the database.
//
//   POST   backup.php?club=CODE  body: ciphertext JSON   save a snapshot
//   GET    backup.php?club=CODE                          the latest, or 404
//   DELETE backup.php?club=CODE                          drop them all
// Headers: X-Ducy-Time (ms) and X-Ducy-Sig, the hex HMAC-SHA-256 with the
// shared secret of "time\nMETHOD\nclub\n<hex sha-256 of the body, or ''>".

declare(strict_types=1);
require __DIR__ . '/config.php';

const KEEP = 10;                    // snapshots kept per club
const MAX_BODY = 4 * 1024 * 1024;   // bytes
const SKEW_MS = 5 * 60 * 1000;      // how far X-Ducy-Time may be off

function out(int $status, string $body = '', string $type = 'text/plain'): void {
    http_response_code($status);
    header('Content-Type: ' . $type);
    header('Cache-Control: no-store');
    echo $body;
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'POST', 'DELETE'], true)) out(405, 'method not allowed');
$club = (string)($_GET['club'] ?? '');
if (!preg_match('/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/', $club)) out(400, 'bad club code');

$body = $method === 'POST' ? (string)file_get_contents('php://input', false, null, 0, MAX_BODY + 1) : '';
if (strlen($body) > MAX_BODY) out(413, 'too big');

// Authenticate: a fresh time, and the HMAC over it, the method, the club
// and the body's hash.
$time = (string)($_SERVER['HTTP_X_DUCY_TIME'] ?? '');
$sig = strtolower((string)($_SERVER['HTTP_X_DUCY_SIG'] ?? ''));
if (!ctype_digit($time) || abs(intval($time) - intval(round(microtime(true) * 1000))) > SKEW_MS) out(403, 'stale or missing time');
$bodyHash = $body === '' ? '' : hash('sha256', $body);
$expected = hash_hmac('sha256', "$time\n$method\n$club\n$bodyHash", DUCY_BACKUP_SECRET);
if (!hash_equals($expected, $sig)) out(403, 'bad signature');

$db = new PDO(DUCY_DB_DSN, DUCY_DB_USER, DUCY_DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

if ($method === 'POST') {
    $box = json_decode($body, true);
    if (!is_array($box) || !isset($box['iv'], $box['ct'])) out(400, 'not a snapshot');
    $db->beginTransaction();
    $db->prepare('INSERT INTO club_backups (club, at, data) VALUES (?, ?, ?)')
       ->execute([$club, intval($time), $body]);
    // Keep the newest KEEP for this club.
    $old = $db->prepare('SELECT id FROM club_backups WHERE club = ? ORDER BY id DESC LIMIT 1000 OFFSET ' . KEEP);
    $old->execute([$club]);
    $ids = $old->fetchAll(PDO::FETCH_COLUMN);
    if ($ids) {
        $in = implode(',', array_fill(0, count($ids), '?'));
        $db->prepare("DELETE FROM club_backups WHERE id IN ($in)")->execute($ids);
    }
    $db->commit();
    out(200, '{"ok":true}', 'application/json');
}

if ($method === 'GET') {
    $q = $db->prepare('SELECT data FROM club_backups WHERE club = ? ORDER BY id DESC LIMIT 1');
    $q->execute([$club]);
    $data = $q->fetchColumn();
    if ($data === false) out(404, 'no backup');
    out(200, (string)$data, 'application/json');
}

$db->prepare('DELETE FROM club_backups WHERE club = ?')->execute([$club]);
out(200, '{"ok":true}', 'application/json');

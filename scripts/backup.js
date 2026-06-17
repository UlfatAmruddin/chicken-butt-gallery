'use strict';
/* Zero-dependency snapshot of all mutable state (data/ + assets/) into a
   timestamped folder under backups/, pruning to the most recent N. Run from
   cron / a systemd timer / Task Scheduler. Honours the same PG_DATA_DIR
   override as the server.

   Usage:  node scripts/backup.js
   Env:    BACKUP_DIR  (default <root>/backups)
           BACKUP_KEEP (default 14) */
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const BACKUP_ROOT = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(config.ROOT, 'backups');
const KEEP = Number.parseInt(process.env.BACKUP_KEEP, 10) || 14;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(BACKUP_ROOT, stamp);

fs.mkdirSync(dest, { recursive: true });
for (const [label, src] of [['data', config.DATA_DIR], ['assets', config.ASSETS_DIR]]) {
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(dest, label), { recursive: true });
  }
}

// Prune oldest backups beyond KEEP (folder names sort lexicographically by time).
const existing = fs.readdirSync(BACKUP_ROOT)
  .filter(n => /^\d{4}-/.test(n))
  .sort();
for (const old of existing.slice(0, Math.max(0, existing.length - KEEP))) {
  fs.rmSync(path.join(BACKUP_ROOT, old), { recursive: true, force: true });
}

console.log(`backup written to ${dest} (keeping ${KEEP})`);

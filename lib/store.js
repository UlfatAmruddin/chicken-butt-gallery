'use strict';
/* Data layer: filesystem paths, atomic JSON persistence, and the in-memory
   collections every other module shares. Required once; Node caches the module
   so all consumers see the same array/object instances. */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const { ROOT, DATA_DIR, ASSETS_DIR } = config;
const UPLOAD_DIR = path.join(ASSETS_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  const target = path.join(DATA_DIR, file);
  const tmp = path.join(DATA_DIR, `${file}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

module.exports = {
  ROOT, DATA_DIR, ASSETS_DIR, UPLOAD_DIR,
  loadJSON, saveJSON,
  users: loadJSON('users.json', {}),
  sessions: loadJSON('sessions.json', {}),
  posts: loadJSON('posts.json', []),
  albums: loadJSON('albums.json', []),
  communities: loadJSON('communities.json', []),
  invites: loadJSON('invites.json', []),
  auditEvents: loadJSON('audit_events.json', []),
  devices: loadJSON('devices.json', {}),   // trusted-device tokens that skip 2FA
  ADMIN_USERNAMES: config.ADMIN_USERNAMES,
  KING_BOB_ID: config.KING_BOB_ID,
  config,
};

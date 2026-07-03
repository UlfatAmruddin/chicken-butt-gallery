'use strict';
/* Data layer: the in-memory collections every other module shares, plus a
   pluggable persistence driver so the same app runs on a normal disk (local
   dev) or on a stateless serverless host (Vercel).

   Two drivers, chosen by STORE_DRIVER:
     - 'file'     (default): reads/writes data/*.json on local disk. Same on-disk
                   format as before; note writes are now deferred to flush() at
                   end of request rather than written on each saveJSON call.
     - 'supabase' : stores each collection as one JSONB blob in a Supabase
                   Postgres table (KV style), reached over the REST API with
                   fetch. No local filesystem, so it survives Vercel's read-only,
                   per-invocation function sandbox.

   The rest of the app keeps mutating the shared in-memory arrays/objects and
   calling saveJSON('x.json', x). saveJSON no longer writes immediately; it marks
   that collection dirty, and flush() persists everything at the end of the
   request (see server.js). init() loads the collections once per process / cold
   start, filling the SAME exported references in place so existing requires stay
   valid.

   NOTE (concurrency): the supabase driver writes whole-collection blobs, so two
   instances mutating the same collection at the exact same moment can lose an
   update (last writer wins). That is fine for a personal-scale gallery; a
   higher-traffic deployment would move to row-level Postgres tables. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ASSETS_DIR = path.join(ROOT, 'assets');
const UPLOAD_DIR = path.join(ASSETS_DIR, 'uploads');

const DRIVER = (process.env.STORE_DRIVER || 'file').toLowerCase();

/* The eight collections, as stable references the whole app shares. They start
   empty and are filled in place by init(); never reassign these. */
const FILES = ['users.json', 'sessions.json', 'posts.json', 'albums.json', 'communities.json', 'invites.json', 'audit_events.json', 'notifications.json'];
const OBJECT_FILES = new Set(['users.json', 'sessions.json']);
const collections = {};
for (const f of FILES) collections[f] = OBJECT_FILES.has(f) ? {} : [];

/* ---------------- file driver (local dev) ---------------- */
function fileLoad(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return null; }
}
function fileSave(file, obj) {
  const target = path.join(DATA_DIR, file);
  const tmp = path.join(DATA_DIR, `${file}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

/* ---------------- supabase KV driver (Vercel) ---------------- */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const SB_TABLE = process.env.SUPABASE_KV_TABLE || 'kv';
const kvKey = (file) => file.replace(/\.json$/, '');

async function supaLoad(file) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(kvKey(file))}&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`kv load ${file}: HTTP ${r.status}`);
  const rows = await r.json();
  return rows && rows[0] ? rows[0].value : null;
}
async function supaSave(file, obj) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: kvKey(file), value: obj }),
  });
  if (!r.ok) throw new Error(`kv save ${file}: HTTP ${r.status} ${await r.text().catch(() => '')}`);
}

/* ---------------- unified load / persist ---------------- */
function fillInPlace(target, src) {
  if (Array.isArray(target)) {
    target.length = 0;
    if (Array.isArray(src)) target.push(...src);
  } else {
    for (const k of Object.keys(target)) delete target[k];
    if (src && typeof src === 'object') Object.assign(target, src);
  }
}

let inited = false;
let initing = null;
function init() {
  if (inited) return Promise.resolve();
  if (initing) return initing;
  initing = (async () => {
    if (DRIVER === 'file') {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    for (const file of FILES) {
      const loaded = DRIVER === 'supabase' ? await supaLoad(file) : fileLoad(file);
      if (loaded != null) fillInPlace(collections[file], loaded);
    }
    inited = true;
  })().catch((e) => { initing = null; throw e; });   // clear the latch on failure so the next
  return initing;                                     // request retries (a load blip must not wedge)
}

/* Mark a collection dirty. The object passed IS the shared in-memory collection,
   so flush() persists its current state. No I/O here - persistence happens once
   per request in flush(). */
const dirty = new Map();
function saveJSON(file, obj) {
  dirty.set(file, obj || collections[file]);
}

async function flush() {
  if (!dirty.size) return;
  const pending = [...dirty.entries()];
  dirty.clear();
  const failed = [];
  for (const [file, obj] of pending) {
    try { DRIVER === 'supabase' ? await supaSave(file, obj) : fileSave(file, obj); }
    catch (e) { dirty.set(file, obj); failed.push(`${file}: ${e.message}`); }   // keep dirty for a retry
  }
  if (failed.length) throw new Error(`store flush failed - ${failed.join('; ')}`);
}

module.exports = {
  ROOT, DATA_DIR, ASSETS_DIR, UPLOAD_DIR,
  init, flush, saveJSON,
  users: collections['users.json'],
  sessions: collections['sessions.json'],
  posts: collections['posts.json'],
  albums: collections['albums.json'],
  communities: collections['communities.json'],
  invites: collections['invites.json'],
  auditEvents: collections['audit_events.json'],
  notifications: collections['notifications.json'],
  ADMIN_USERNAMES: new Set(['ulfatamruddin']),
  KING_BOB_ID: 'king-bob',
};

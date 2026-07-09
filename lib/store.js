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
// null-prototype for the username-keyed maps (users, sessions) so a user-supplied
// key like "constructor" / "__proto__" can never resolve through Object.prototype.
for (const f of FILES) collections[f] = OBJECT_FILES.has(f) ? Object.create(null) : [];

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
// Cap every KV fetch: a stalled Supabase socket would otherwise hang init()/flush()
// (both awaited in the request path) until the platform timeout, turning a transient
// blip into a stuck request + opaque 500. A timeout aborts into the retry/503 path.
const KV_FETCH_TIMEOUT_MS = 8000;
const kvKey = (file) => file.replace(/\.json$/, '');

async function supaLoad(file) {
  const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?key=eq.${encodeURIComponent(kvKey(file))}&select=value`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    signal: AbortSignal.timeout(KV_FETCH_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(KV_FETCH_TIMEOUT_MS),
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
  // Snapshot the collection NOW (deep clone) rather than storing the shared live
  // reference. Otherwise the bytes eventually persisted reflect whatever the shared
  // object holds when the async write resolves - which, with two concurrent requests
  // mutating the same collection, may be a different (newer or older) request's
  // state, silently dropping a write. Cloning here pins the bytes to this request's
  // state. The clone is throwaway (only serialized), so a lost null-prototype on it
  // is harmless.
  dirty.set(file, structuredClone(obj || collections[file]));
}

// flushChain serializes the actual I/O so one flush's awaited write can't interleave
// with (and clobber) a later flush of the same collection. CRUCIALLY, each flush()
// call captures ITS OWN batch synchronously (like the original code) and the promise
// it returns is tied ONLY to that batch's outcome - the chain is used purely for
// ordering. This is what stops one request's write failure from rejecting an
// unrelated concurrent request's res._flushDone (which would 503 a successful write
// or a pure read). A caller with nothing pending resolves immediately rather than
// riding - and inheriting the failures of - the shared tail.
let flushChain = Promise.resolve();
let retryTimer = null;
function flush() {
  if (!dirty.size) return Promise.resolve();
  const batch = [...dirty.entries()];   // this caller owns exactly these files
  dirty.clear();
  const run = () => persistBatch(batch);
  const mine = flushChain.then(run, run);   // run after any in-flight flush settles (ordering only)
  flushChain = mine.catch(() => {});        // the chain continues regardless of THIS batch's result
  return mine;                              // caller is judged only on its own batch
}
async function persistBatch(batch) {
  const failed = [];
  for (const [file, obj] of batch) {
    try { DRIVER === 'supabase' ? await supaSave(file, obj) : fileSave(file, obj); }
    // keep the snapshot for retry, but never overwrite a newer snapshot a concurrent
    // saveJSON already queued for this file.
    catch (e) { if (!dirty.has(file)) dirty.set(file, obj); failed.push(`${file}: ${e.message}`); }
  }
  if (failed.length) { scheduleRetry(); throw new Error(`store flush failed - ${failed.join('; ')}`); }
}
// A failed write is re-queued, but would otherwise only retry when the NEXT mutating
// request happens to call flush(); on a quiet server that can be never. Drive an
// explicit background retry so a transient store blip is not silent data loss.
// Unref'd so it never keeps the process alive on its own.
function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush().catch(() => {}); }, 3000);
  if (retryTimer.unref) retryTimer.unref();
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

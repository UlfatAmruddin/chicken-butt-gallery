'use strict';
/* One-time seed: copy the local data/*.json collections into the Supabase KV
   table so a fresh Vercel deploy starts with your existing gallery. Safe to
   re-run (upserts by key).

   Usage (from the project root, with your Supabase creds available):
     SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-supabase-kv.js
   It also reads .supabase.json (url/key) as a fallback for convenience.

   Create AND lock down the table first (full SQL in DEPLOY.md, step 1): it holds
   password hashes and session tokens, so it must have RLS enabled with no policies
   (alter table kv enable row level security; revoke all ... from anon, authenticated)
   so only the service-role key can read it. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let cfg = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY };
if (!cfg.url || !cfg.key) {
  try { const f = JSON.parse(fs.readFileSync(path.join(ROOT, '.supabase.json'), 'utf8')); cfg = { url: f.url, key: f.key }; } catch {}
}
const TABLE = process.env.SUPABASE_KV_TABLE || 'kv';
if (!cfg.url || !cfg.key) { console.error('Missing SUPABASE_URL / SUPABASE_KEY (or .supabase.json).'); process.exit(1); }
const URL = cfg.url.replace(/\/+$/, '');

const FILES = ['users.json', 'sessions.json', 'posts.json', 'albums.json', 'communities.json', 'invites.json', 'audit_events.json', 'notifications.json'];

async function upsert(key, value) {
  const r = await fetch(`${URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key, Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key, value }),
  });
  if (!r.ok) throw new Error(`${key}: HTTP ${r.status} ${await r.text().catch(() => '')}`);
}

(async () => {
  for (const file of FILES) {
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8')); }
    catch { console.log(`skip ${file} (no local file)`); continue; }
    await upsert(file.replace(/\.json$/, ''), value);
    const n = Array.isArray(value) ? value.length : Object.keys(value).length;
    console.log(`seeded ${file} (${n} entries)`);
  }
  console.log('done.');
})().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });

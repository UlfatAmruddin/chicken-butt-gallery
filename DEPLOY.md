# Deploying to Vercel

This app was originally a single always-on Node process that kept all state in
`data/*.json` and uploads on local disk. It now supports a stateless, serverless
deployment (Vercel) through a pluggable data driver and Supabase.

- **Data** (users, posts, communities, sessions, ...) -> Supabase Postgres, one
  JSONB blob per collection in a `kv` table (`STORE_DRIVER=supabase`).
- **Uploads** (photos, avatars, covers) -> Supabase Storage (already supported).
- **API** -> one serverless function (`api/[[...path]].js`) wrapping the existing
  handler. **Static** frontend -> Vercel's CDN.

Local dev is unchanged: `node server.js` still uses the file driver and disk.

## 1. Create the KV table in Supabase (and lock it down)

This table holds your entire database as blobs, **including password hashes and
live session tokens**. Every table in Supabase's `public` schema is auto-exposed
through the REST API, and RLS is OFF by default, so without the lock-down below
anyone with the project's anon key could read `/rest/v1/kv` and dump those
secrets. The server uses the **service-role** key, which bypasses RLS, so turning
RLS on with no policies denies everyone else while the app keeps working.

In the Supabase SQL editor, run all of this:

```sql
create table if not exists kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- REQUIRED: deny anon/authenticated; only the service-role key (server) may touch it.
alter table kv enable row level security;   -- RLS on + zero policies = deny all non-service roles
revoke all on table kv from anon, authenticated;
```

Verify the lock-down after setup (must return a permission error or `[]`, never rows):

```bash
curl -s "https://YOUR-PROJECT.supabase.co/rest/v1/kv?select=key" -H "apikey: YOUR-ANON-KEY"
```

## 2. Seed it with your existing data (optional but recommended)

From the project root, with your Supabase creds set:

```bash
SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_KEY=YOUR-SERVICE-ROLE-KEY node scripts/seed-supabase-kv.js
```

(It also reads `.supabase.json` if present.) Re-runnable; it upserts by key.

## 3. Set Environment Variables in Vercel

Project Settings -> Environment Variables (Production + Preview):

| Name | Value |
|------|-------|
| `STORE_DRIVER` | `supabase` |
| `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_KEY` | your service-role key (secret, server-only) |
| `SUPABASE_BUCKET` | `photos` |
| `TRUST_PROXY` | `1` |
| `SUPABASE_KV_TABLE` | `kv` (only if you named it differently) |

Never set these with a client-exposed prefix and never commit `.supabase.json`.

## 4. Deploy

```bash
npm i -g vercel
vercel        # preview
vercel --prod # production
```

Vercel auto-detects: static files at the root are served by the CDN, and
`api/[[...path]].js` handles `/api/*`. `vercel.json` reapplies the CSP/security
headers to the static routes and gives the function a 15s timeout (the geocode
call can take up to 5s).

## What to verify after the first deploy

1. The site loads and you can register / log in (proves the Supabase KV data path
   and cross-instance sessions).
2. Upload a photo (proves Supabase Storage; the image URL should be
   `https://*.supabase.co/...`).
3. Reload after a change (proves writes persisted to Supabase, not lost).

## Known limitations / notes

- **Whole-blob writes (last-writer-wins).** The KV driver writes an entire
  collection per change, so two people mutating the same collection at the exact
  same moment can lose one update. Fine for personal scale; move to row-level
  Postgres tables if you need real concurrency.
- **Per-instance rate limits and geocode cache.** These live in each function
  instance's memory, so limits are per-instance and the geocode cache is cold on
  new instances. Acceptable for low traffic; move to a shared KV/Redis otherwise.
- **Cold-start load.** Each new function instance loads all collections once. Fine
  while the dataset is small.
- **Photo URLs are public.** Uploaded images live in a public Supabase Storage
  bucket (and, on the file driver, under `/assets/`), so a photo URL is readable by
  anyone who has the link (filenames are random, not enumerable). This matches the
  original disk behaviour and is the app's existing model. Truly members-only photos
  would require serving image bytes through the authenticated API instead.
- **Writes are confirmed after the response.** A mutating request sends its result,
  then flushes to the store; if that flush fails (e.g. Supabase is down) the client
  sees success but the change may not persist until a later request retries. Fine at
  personal scale; flush-before-respond would be needed for stronger durability.

## Alternative: a host that runs a real process (simpler, no rewrite)

If you would rather not depend on serverless, Render / Railway / Fly.io run
`node server.js` as a persistent process. Keep `STORE_DRIVER=file` with a
persistent disk mounted at `data/` (and Supabase Storage for uploads), set
`PORT`/`HOST` from the platform, and you are done with almost no other changes.

# Deploying

The app runs as **one long-lived Node process** (`node server.js`) on Render, with
state in Supabase so a deploy or restart never loses anything.

- **Data** (users, posts, communities, sessions, ...) -> Supabase Postgres, one
  JSONB blob per collection in a `kv` table (`STORE_DRIVER=supabase`).
- **Uploads** (photos, avatars, covers) -> Supabase Storage.
- **Static frontend + API** -> both served by the same process. Security headers
  and the CSP are set in `lib/static.js`, so they travel with the app rather than
  living in a host config file.

Local dev is unchanged: `node server.js` with no env set uses the file driver and
local disk (`data/*.json`, `assets/uploads/`).

## 1. Create the KV table in Supabase (and lock it down)

This table holds your entire database as blobs, **including live session tokens**.
Every table in Supabase's `public` schema is auto-exposed through the REST API, and
RLS is OFF by default, so without the lock-down below anyone with the project's anon
key could read `/rest/v1/kv` and dump them. The server uses the **service-role** key,
which bypasses RLS, so turning RLS on with no policies denies everyone else while the
app keeps working.

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

## 2. Seed it with your existing data (optional)

From the project root, with your Supabase creds set:

```bash
SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_KEY=YOUR-SERVICE-ROLE-KEY node scripts/seed-supabase-kv.js
```

(It also reads `.supabase.json` if present.) Re-runnable; it upserts by key.

## 3. Render service settings

Create a **Web Service** from the repo.

| Setting | Value |
|---|---|
| Build command | *(none - there is no build step)* |
| Start command | `node server.js` |
| Instances | **1** (see the warning below) |

Environment variables:

| Name | Value |
|------|-------|
| `STORE_DRIVER` | `supabase` |
| `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_KEY` | your service-role key (secret, server-only) |
| `SUPABASE_BUCKET` | `photos` |
| `SUPABASE_ANON_KEY` | your **public** anon / publishable key (required for login) |
| `ADMIN_EMAIL` | the site owner's Google address (required to keep owner/admin) |
| `TRUST_PROXY` | `1` |
| `SUPABASE_KV_TABLE` | `kv` (only if you named it differently) |
| `ADMIN_PROVIDER` | `google` (default; the provider trusted for the owner link) |

`PORT` is supplied by Render automatically; the server reads it.

**The two Supabase keys are not interchangeable.** `SUPABASE_KEY` is the
service-role **secret** (server-only, bypasses RLS). `SUPABASE_ANON_KEY` is the
**public** key and is deliberately served to browsers by `GET /api/config` - that is
how Supabase Auth is designed. Putting the service-role key in `SUPABASE_ANON_KEY`
would hand every visitor full database access; the server detects and refuses to
serve a key that looks secret, but do not rely on that.

`ADMIN_EMAIL` links the owner's Google account to the reserved admin username on
first sign-in. The link also requires the address to be **confirmed** and to come
from the trusted provider (`ADMIN_PROVIDER`, default `google`), so knowing the
address is not enough to claim admin. For that to hold, the Supabase project should
keep **Confirm email ON** and ideally disable the email/password provider so Google
is the only way in.

Never commit `.supabase.json` or a real `.env`.

`TRUST_PROXY=1` tells the app to read the client IP for rate-limiting from the
rightmost `X-Forwarded-For` hop Render appends. Do **not** set `TRUST_CF_IP=1`
unless a real Cloudflare edge actually fronts the app: without one,
`CF-Connecting-IP` is raw client input, so trusting it would let anyone forge a new
IP per request and bypass every per-IP rate limit.

## 4. Keep it at a single instance

The KV driver writes an **entire collection** per change and each process holds its
own in-memory copy. Two instances would each flush their own stale snapshot and
silently overwrite each other's writes. Do not enable horizontal autoscaling. If you
outgrow one instance, move to row-level Postgres tables first.

## What to verify after a deploy

1. The site loads and you can sign in with Google (proves the Supabase KV data path).
2. Upload a photo (proves Supabase Storage; the image URL should be
   `https://*.supabase.co/...`).
3. Reload after a change (proves writes persisted to Supabase, not just memory).

## Known limitations / notes

- **Whole-blob writes (last-writer-wins).** The KV driver writes an entire
  collection per change, so two people mutating the same collection at the exact
  same moment can lose one update. Fine for personal scale; move to row-level
  Postgres tables if you need real concurrency.
- **Photo URLs are public.** Uploaded images live in a public Supabase Storage
  bucket (and, on the file driver, under `/assets/`), so a photo URL is readable by
  anyone who has the link (filenames are random, not enumerable). This matches the
  original disk behaviour and is the app's existing model. Truly members-only photos
  would require serving image bytes through the authenticated API instead.
- **Writes are confirmed after the response.** A mutating request sends its result,
  then flushes to the store; if that flush fails (e.g. Supabase is down) the client
  sees success but the change may not persist until a later request retries. The
  process also drains pending writes on `SIGTERM`, which is what Render sends on
  every deploy, so a normal restart does not drop queued writes.

## Running it somewhere else

Any host that runs a persistent Node process works the same way - Railway, Fly.io, a
VPS. Set the same environment variables and start `node server.js`. To run without
Supabase entirely, leave `STORE_DRIVER` unset (file driver) and mount a persistent
disk at `data/`; uploads then land in `assets/uploads/` and must be on that disk too.

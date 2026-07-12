'use strict';
/* Supabase Auth bridge (zero-dependency, no SDK).

   Login is handled entirely by Supabase Auth (Google OAuth) on the client. Every
   API request then arrives with a Supabase *access token* (a JWT) in the
   Authorization header. This module validates that token the way Supabase
   documents for servers: it asks Supabase `GET /auth/v1/user`, which works
   regardless of the project's signing method (legacy HS256 secret OR the new
   asymmetric signing keys). The result is cached briefly so we are not making an
   outbound call on every single request - only once per token per ~minute. */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const CONFIGURED = !!(SB_URL && SB_ANON);

// token -> { user: { id, email }, at: ms, exp: ms }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;   // re-check with Supabase at most once/min per token
const CACHE_MAX = 5000;

/* Read the `exp` claim without verifying the signature (Supabase itself verifies
   on /auth/v1/user). Lets us skip the network call for an already-expired token
   and bound how long a cache entry is trusted. */
function tokenExpiryMs(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

async function validateAccessToken(token) {
  if (!CONFIGURED || !token) return null;
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < CACHE_TTL_MS && (!hit.exp || now < hit.exp)) return hit.user;
  const exp = tokenExpiryMs(token);
  if (exp && now >= exp) { cache.delete(token); return null; }   // expired: don't bother asking
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    if (!u || !u.id) return null;
    const user = { id: String(u.id), email: String(u.email || '').toLowerCase() };
    if (cache.size > CACHE_MAX) cache.clear();
    cache.set(token, { user, at: now, exp });
    return user;
  } catch { return null; }   // network/timeout: treat as unauthenticated, never throw into the request
}

function isConfigured() { return CONFIGURED; }
// only the PUBLIC values ever leave the server (safe to embed in the browser)
function publicConfig() { return { supabaseUrl: SB_URL, supabaseAnonKey: SB_ANON }; }

/* Best-effort delete of the Supabase auth user (used by account deletion). Needs
   the service-role key (SUPABASE_KEY) - never the anon key. Ignores failure. */
async function deleteAuthUser(supabaseId) {
  const svc = process.env.SUPABASE_KEY || '';
  if (!CONFIGURED || !svc || !supabaseId) return false;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(supabaseId)}`, {
      method: 'DELETE',
      headers: { apikey: svc, Authorization: `Bearer ${svc}` },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch { return false; }
}

module.exports = { validateAccessToken, isConfigured, publicConfig, deleteAuthUser };

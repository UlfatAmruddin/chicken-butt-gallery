'use strict';
/* Supabase Auth bridge (zero-dependency, no SDK).

   Login is handled entirely by Supabase Auth (Google OAuth) on the client. Every
   API request then arrives with a Supabase *access token* (a JWT) in the
   Authorization header. This module validates that token the way Supabase
   documents for servers: it asks Supabase `GET /auth/v1/user`, which works
   regardless of the project's signing method (legacy HS256 secret OR the new
   asymmetric signing keys). Results are cached so we are not making an outbound
   call on every request.

   Alongside the identity it carries the two signals needed to decide whether an
   email may be TRUSTED (see linkOwnerAccount in helpers.js): whether Supabase has
   confirmed the address, and which provider(s) the account authenticated with. An
   email string alone is not proof of identity. */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const CONFIGURED = !!(SB_URL && SB_ANON);

// token -> { user: {id,email,emailVerified,providers} | null, at: ms, exp: ms }
// A null user is a REMEMBERED REJECTION: without it, every request bearing a junk
// token forced a fresh outbound Supabase call, letting anyone amplify cheap inbound
// requests into Supabase Auth rate-limit exhaustion (which would also start failing
// real users' logins).
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;        // positive result: re-check at most once/min
const NEG_CACHE_TTL_MS = 15 * 1000;    // rejected token: remembered briefly
const CACHE_MAX = 5000;

/* Cheap structural check. Supabase access tokens are always JWTs, so anything that
   isn't three base64url segments is rejected WITHOUT touching the network. */
function looksLikeJwt(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);
}

/* Read the `exp` claim without verifying the signature (Supabase itself verifies
   on /auth/v1/user). Only used to SKIP work for an already-expired token and to
   bound how long a cache entry is trusted - never to authenticate. */
function tokenExpiryMs(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

/* Every provider this account has authenticated with, from whichever shape the
   Supabase user object exposes (app_metadata.provider / .providers / identities[]). */
function identityProviders(u) {
  const out = new Set();
  const am = u && u.app_metadata;
  if (am) {
    if (am.provider) out.add(String(am.provider).toLowerCase());
    if (Array.isArray(am.providers)) am.providers.forEach(p => p && out.add(String(p).toLowerCase()));
  }
  if (Array.isArray(u && u.identities)) {
    u.identities.forEach(i => i && i.provider && out.add(String(i.provider).toLowerCase()));
  }
  return [...out];
}

function remember(token, user, exp, now) {
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(token, { user, at: now, exp });
}

async function validateAccessToken(token) {
  if (!CONFIGURED || !token) return null;
  if (!looksLikeJwt(token)) return null;          // junk bearer: no network call at all
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < (hit.user ? CACHE_TTL_MS : NEG_CACHE_TTL_MS)) {
    if (!hit.user) return null;                   // remembered rejection
    if (!hit.exp || now < hit.exp) return hit.user;
    cache.delete(token);                          // token expired while cached
    return null;
  }
  const exp = tokenExpiryMs(token);
  if (exp && now >= exp) { cache.delete(token); return null; }   // expired: don't bother asking
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      // Only remember DEFINITIVE rejections. A 429/5xx is transient (Supabase busy or
      // down) - caching those would sign valid users out for the negative TTL.
      if (r.status === 401 || r.status === 403) remember(token, null, 0, now);
      return null;
    }
    const u = await r.json().catch(() => null);
    if (!u || !u.id) return null;
    const user = {
      id: String(u.id),
      email: String(u.email || '').toLowerCase(),
      emailVerified: !!(u.email_confirmed_at || u.confirmed_at),
      providers: identityProviders(u),
    };
    remember(token, user, exp, now);
    return user;
  } catch { return null; }   // network/timeout: treat as unauthenticated, never throw into the request
}

function isConfigured() { return CONFIGURED; }

/* Guardrail: SUPABASE_ANON_KEY is served to every browser, so if a service-role key
   is ever pasted into it by mistake the whole database would be handed out (it
   bypasses RLS). Refuse to serve anything that looks secret. Covers both key
   formats: legacy JWTs with role=service_role, and the newer sb_secret_* keys. */
function looksLikeSecretKey(key) {
  const k = String(key || '');
  if (/^sb_secret_/i.test(k)) return true;
  try {
    const p = JSON.parse(Buffer.from(k.split('.')[1] || '', 'base64url').toString('utf8'));
    return !!p && p.role === 'service_role';
  } catch { return false; }
}
const ANON_IS_SECRET = looksLikeSecretKey(SB_ANON);
if (ANON_IS_SECRET) {
  console.error('[auth] SUPABASE_ANON_KEY looks like a SERVICE-ROLE/secret key. Refusing to expose it. Set the public anon/publishable key instead.');
}

// only the PUBLIC values ever leave the server (safe to embed in the browser)
function publicConfig() {
  return { supabaseUrl: SB_URL, supabaseAnonKey: ANON_IS_SECRET ? '' : SB_ANON };
}

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

module.exports = { validateAccessToken, isConfigured, publicConfig, deleteAuthUser, looksLikeSecretKey };

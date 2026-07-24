'use strict';
/* Supabase Auth bridge (zero-dependency, no SDK).

   Login is handled entirely by Supabase Auth (Google OAuth) on the client. Every
   API request then arrives with a Supabase *access token* (a JWT) in the
   Authorization header. This module validates that token the way Supabase
   documents for servers: it asks Supabase `GET /auth/v1/user`, which works
   regardless of the project's signing method. Results are cached so we are not
   making an outbound call on every request.

   validateAccessToken has THREE outcomes, and callers must tell them apart:
     - a user object  -> the token is valid
     - null           -> the token is definitively invalid/expired (answer 401)
     - UPSTREAM       -> we could not check (Supabase down/slow/throttled). The
                         caller must answer 503, NOT 401: reporting "not logged in"
                         makes every client wipe its session, so an upstream blip
                         would mass-log-out the whole site.

   It also carries the signals needed to decide whether an email may be TRUSTED
   (see linkOwnerAccount in helpers.js): the per-identity provider/email/verified
   triple, not just an account-level union. */

const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_ANON = (process.env.SUPABASE_ANON_KEY || '').trim();
const CONFIGURED = !!(SB_URL && SB_ANON);

/* Sentinel for "could not verify" - deliberately not null. */
const UPSTREAM = Object.freeze({ upstreamUnavailable: true });

/* Positive and negative results live in SEPARATE maps. Sharing one map let a flood
   of junk bearers consume the whole budget and evict every validated user, which
   forced a fresh Supabase round-trip for real traffic - the opposite of the point.
   Both maps evict oldest-first (insertion order) instead of clearing wholesale. */
const posCache = new Map();   // token -> { user, at, exp }
const negCache = new Map();   // token -> { at }
const POS_MAX = 5000;
const NEG_MAX = 1000;
const CACHE_TTL_MS = 60 * 1000;        // validated token: re-check at most once/min
const NEG_CACHE_TTL_MS = 15 * 1000;    // rejected token: remembered briefly

/* Global ceiling on outbound validation calls, so no traffic pattern can drive
   unbounded requests at Supabase Auth (whose rate limit also gates real logins).
   Exceeding it degrades to UPSTREAM (503 + retry), never to a false 401. */
const OUTBOUND_MAX_PER_MIN = 300;
let outboundWindowStart = 0;
let outboundCount = 0;
function outboundBudgetOk(now) {
  if (now - outboundWindowStart >= 60 * 1000) { outboundWindowStart = now; outboundCount = 0; }
  outboundCount += 1;
  return outboundCount <= OUTBOUND_MAX_PER_MIN;
}

function evictOldest(map, n) {
  let i = 0;
  for (const k of map.keys()) { map.delete(k); if (++i >= n) break; }   // Map keeps insertion order
}
function setPos(token, user, exp, now) {
  if (posCache.size >= POS_MAX) evictOldest(posCache, Math.ceil(POS_MAX / 10));
  posCache.set(token, { user, at: now, exp });
}
function setNeg(token, now) {
  if (negCache.size >= NEG_MAX) evictOldest(negCache, Math.ceil(NEG_MAX / 10));
  negCache.set(token, { at: now });
}

/* Cheap structural check. Supabase access tokens are always JWTs, so anything that
   isn't three base64url segments is rejected WITHOUT touching the network. */
function looksLikeJwt(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);
}

/* Decode the payload without verifying the signature (Supabase itself verifies on
   /auth/v1/user). Used ONLY to skip pointless work - never to authenticate. */
function decodePayload(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1] || '', 'base64url').toString('utf8'));
  } catch { return null; }
}
function tokenExpiryMs(jwt) {
  const p = decodePayload(jwt);
  return p && typeof p.exp === 'number' ? p.exp * 1000 : 0;
}

/* Per-identity view: which provider, which address, and whether THAT address is
   verified. linkOwnerAccount needs this - an account-level union only proves "some
   identity is Google", not that the Google identity owns the admin address. */
function identityList(u) {
  if (!Array.isArray(u && u.identities)) return [];
  return u.identities.map((i) => {
    const d = (i && i.identity_data) || {};
    return {
      provider: String((i && i.provider) || '').toLowerCase(),
      email: String(d.email || '').toLowerCase(),
      emailVerified: d.email_verified === true || d.email_verified === 'true',
    };
  }).filter((i) => i.provider);
}
function providerNames(u, identities) {
  const out = new Set(identities.map((i) => i.provider));
  const am = u && u.app_metadata;
  if (am) {
    if (am.provider) out.add(String(am.provider).toLowerCase());
    if (Array.isArray(am.providers)) am.providers.forEach((p) => p && out.add(String(p).toLowerCase()));
  }
  return [...out];
}

async function validateAccessToken(token) {
  if (!CONFIGURED || !token) return null;
  if (!looksLikeJwt(token)) return null;          // junk bearer: no network call at all
  const now = Date.now();

  const hit = posCache.get(token);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    if (!hit.exp || now < hit.exp) return hit.user;
    posCache.delete(token);                       // token expired while cached
    return null;
  }
  const neg = negCache.get(token);
  if (neg && now - neg.at < NEG_CACHE_TTL_MS) return null;

  const exp = tokenExpiryMs(token);
  if (exp && now >= exp) { posCache.delete(token); return null; }   // expired: don't bother asking
  if (!outboundBudgetOk(now)) return UPSTREAM;    // protect Supabase; caller answers 503

  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      // 401/403 = the token is genuinely bad -> remember it and report invalid.
      // Anything else (429, 5xx) is transient: never cache, never claim "invalid".
      if (r.status === 401 || r.status === 403) { setNeg(token, now); return null; }
      return UPSTREAM;
    }
    const u = await r.json().catch(() => null);
    if (!u || !u.id) return UPSTREAM;             // malformed body: upstream problem, not a bad token
    const identities = identityList(u);
    const user = {
      id: String(u.id),
      email: String(u.email || '').toLowerCase(),
      emailVerified: !!(u.email_confirmed_at || u.confirmed_at),
      providers: providerNames(u, identities),
      identities,
    };
    setPos(token, user, exp, now);
    return user;
  } catch {
    return UPSTREAM;   // network/timeout: unknown, not invalid
  }
}

function isConfigured() { return CONFIGURED; }

/* Guardrail: SUPABASE_ANON_KEY is served to every browser, so if a service-role key
   is ever pasted into it by mistake the whole database would be handed out (it
   bypasses RLS). Use an ALLOW-LIST of known-public shapes so an unrecognised key
   fails safe: a deny-list would not survive the next key format. Values are trimmed
   and unquoted first, so stray whitespace from a dashboard copy can't slip past. */
function looksLikeSecretKey(key) {
  const k = String(key || '').trim().replace(/^["']|["']$/g, '');
  if (!k) return false;
  if (/^sb_publishable_/i.test(k)) return false;            // known public
  if (/^sb_/i.test(k)) return true;                         // any other sb_* (incl. sb_secret_)
  const p = decodePayload(k);
  if (p && typeof p.role === 'string') return p.role.toLowerCase() !== 'anon';   // legacy JWT keys
  return false;                                             // unrecognised: leave as-is
}
const ANON_IS_SECRET = looksLikeSecretKey(SB_ANON);
if (ANON_IS_SECRET) {
  console.error('[auth] SUPABASE_ANON_KEY does not look like a public key (expected the anon/publishable key). Refusing to expose it.');
}

// only the PUBLIC values ever leave the server (safe to embed in the browser)
function publicConfig() {
  return { supabaseUrl: SB_URL, supabaseAnonKey: ANON_IS_SECRET ? '' : SB_ANON };
}

/* Best-effort delete of the Supabase auth user (used by account deletion). Needs
   the service-role key (SUPABASE_KEY) - never the anon key. Ignores failure. */
async function deleteAuthUser(supabaseId) {
  const svc = (process.env.SUPABASE_KEY || '').trim();
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

module.exports = {
  validateAccessToken, isConfigured, publicConfig, deleteAuthUser, looksLikeSecretKey, UPSTREAM,
};

/* Fetch wrapper for the JSON API. Holds the bearer token and auto-scopes
   community-scoped routes with ?community=<id>. The active community is
   supplied by the app via api.communityResolver (dependency injection) so
   this module stays decoupled from shared UI state. */
export const api = {
  token: localStorage.getItem('pg_token') || '',
  communityResolver: () => null,
  async call(method, url, body) {
    const r = await fetch(addCommunityParam(url, this.communityResolver()), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  setToken(t) {
    this.token = t || '';
    if (t) localStorage.setItem('pg_token', t);
    else localStorage.removeItem('pg_token');
  },
};

function addCommunityParam(url, community) {
  if (!community) return url;
  const parsed = new URL(url, location.origin);
  const path = parsed.pathname;
  const scoped =
    path === '/api/photos' || path.startsWith('/api/photos/') ||
    path === '/api/users' || path.startsWith('/api/user/') ||
    path === '/api/albums' || path.startsWith('/api/albums/');
  if (!scoped || parsed.searchParams.has('community')) return url;
  parsed.searchParams.set('community', community.id);
  return parsed.pathname + parsed.search + parsed.hash;
}

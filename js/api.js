/* Fetch wrapper for the JSON API. Auth is a Supabase session (Google sign-in):
   we hold the access + refresh tokens, attach the access token as a Bearer, and
   transparently refresh it when it is about to expire (or on a 401). Community-
   scoped routes are auto-tagged with ?community=<id> via api.communityResolver. */
export const api = {
  // Public Supabase values, fetched once from /api/config at startup. Safe to expose.
  supabaseUrl: '',
  supabaseAnonKey: '',

  // Session lives in localStorage (cookie-free by design -> no CSRF surface). The
  // strict CSP (script-src 'self', no unsafe-inline) is the control against token
  // theft; do not relax it.
  access: localStorage.getItem('sb_access') || '',
  refresh: localStorage.getItem('sb_refresh') || '',
  expiresAt: Number(localStorage.getItem('sb_expires') || 0),   // ms epoch

  communityResolver: () => null,
  // set by main.js. fired only when a refresh is genuinely REJECTED, so the UI can
  // drop back to signed-out instead of looking logged in while every call 401s.
  // deliberately not fired on a network blip or an explicit logout.
  onSessionRejected: () => {},

  hasSession() { return !!this.refresh; },

  setSession(s) {
    this.access = s.access_token || '';
    this.refresh = s.refresh_token || '';
    this.expiresAt = s.expires_at ? s.expires_at * 1000
      : (s.expires_in ? Date.now() + Number(s.expires_in) * 1000 : 0);
    const put = (k, v) => { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); };
    put('sb_access', this.access);
    put('sb_refresh', this.refresh);
    put('sb_expires', this.expiresAt ? String(this.expiresAt) : '');
  },
  clearSession() { this.setSession({}); },
  // the auth host said no: clear, then let the UI know so it can stop looking signed in
  _reject() { this.clearSession(); try { this.onSessionRejected(); } catch { /* never break the refresh */ } },

  async loadConfig() {
    try {
      const c = await fetch('/api/config').then(r => r.json());
      this.supabaseUrl = String(c.supabaseUrl || '').replace(/\/+$/, '');
      this.supabaseAnonKey = c.supabaseAnonKey || '';
    } catch { /* leave blank -> the UI shows "sign-in not configured" */ }
  },

  googleLoginUrl() {
    const redirect = location.origin + location.pathname;   // back to the app (allowlisted in Supabase)
    return `${this.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
  },

  // in-flight refresh shared by concurrent callers, and the earliest time a new
  // attempt may run after a network failure
  _refreshing: null,
  _retryAfter: 0,
  // true when the last refresh attempt never reached the auth host, so a following
  // 401 means "could not check", not "logged out"
  _refreshOffline: false,

  refreshSession() {
    if (!this.refresh || !this.supabaseUrl) return Promise.resolve(false);
    // one request per burst: ensureFresh runs before every API call, so a view
    // firing several requests at once would otherwise send several identical
    // refreshes, and an unreachable auth host would be retried on every call.
    if (this._refreshing) return this._refreshing;
    // the cooldown is only ever set after an unanswered attempt, so hitting it is
    // itself evidence the host is unreachable
    if (Date.now() < this._retryAfter) { this._refreshOffline = true; return Promise.resolve(false); }
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  },

  async _doRefresh() {
    try {
      const r = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.supabaseAnonKey },
        body: JSON.stringify({ refresh_token: this.refresh }),
      });
      this._refreshOffline = false;   // the auth host answered, whatever it said
      if (!r.ok) { this._reject(); return false; }
      const j = await r.json().catch(() => ({}));
      if (!j.access_token) { this._reject(); return false; }
      this._retryAfter = 0;
      this.setSession(j);
      return true;
    } catch {
      // network blip: keep the session (a dead upstream must not log anyone out)
      // but back off so the next few calls do not each retry.
      this._refreshOffline = true;
      this._retryAfter = Date.now() + 5000;
      return false;
    }
  },
  // refresh proactively when the access token is within a minute of expiring
  async ensureFresh() {
    if (!this.refresh) return;
    if (!this.access || (this.expiresAt && Date.now() > this.expiresAt - 60000)) await this.refreshSession();
  },

  async supabaseLogout() {
    if (this.access && this.supabaseUrl) {
      try {
        await fetch(`${this.supabaseUrl}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: this.supabaseAnonKey, Authorization: 'Bearer ' + this.access },
        });
      } catch { /* ignore */ }
    }
    this.clearSession();
  },

  async call(method, url, body) {
    await this.ensureFresh();
    const doFetch = () => fetch(addCommunityParam(url, this.communityResolver()), {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.access ? { Authorization: 'Bearer ' + this.access } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await doFetch();
    // token expired between ensureFresh and the request? refresh once and retry.
    if (r.status === 401 && this.refresh && await this.refreshSession()) r = await doFetch();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 503 = the server could not CHECK the token (Supabase blip), which is not the
      // same as being logged out. Flag it so callers never clear a valid session.
      const err = new Error(j.error || r.statusText);
      err.status = r.status;
      if (r.status === 503) err.transient = true;
      // 401 while our own refresh never reached the auth host: unknown, not logged
      // out. a genuine rejection clears the session inside _doRefresh first, so
      // this.refresh is still set only when the attempt went unanswered.
      if (r.status === 401 && this.refresh && this._refreshOffline) err.transient = true;
      if (j && j.needsConfirmation) { err.needsConfirmation = true; err.details = j; }
      throw err;
    }
    return j;
  },
};

function addCommunityParam(url, community) {
  if (!community) return url;
  const parsed = new URL(url, location.origin);
  const path = parsed.pathname;
  const scoped =
    path === '/api/photos' || path.startsWith('/api/photos/') ||
    path === '/api/users' || path.startsWith('/api/user/') ||
    path === '/api/albums' || path.startsWith('/api/albums/') ||
    path === '/api/saved' || path.startsWith('/api/saved/');
  if (!scoped || parsed.searchParams.has('community')) return url;
  parsed.searchParams.set('community', community.id);
  return parsed.pathname + parsed.search + parsed.hash;
}

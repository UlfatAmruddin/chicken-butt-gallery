'use strict';
/* Centralized, environment-driven configuration. Every tunable that differs
   between local dev and a public deployment lives here so nothing sensitive or
   environment-specific is hardcoded in the request path. All values have safe
   defaults that reproduce the original single-user behaviour. */
const path = require('path');

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function envBool(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}
function envList(name, def) {
  const v = process.env[name];
  if (!v) return def;
  return v.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

const ROOT = path.join(__dirname, '..');

const config = {
  // ---- paths ----
  // PG_DATA_DIR may point data/ at an external volume or a temp dir (tests).
  // Assets are always under ROOT/assets: write, serve, and unlink all resolve
  // against the same base, so there is no split-brain to misconfigure.
  ROOT,
  DATA_DIR: process.env.PG_DATA_DIR ? path.resolve(process.env.PG_DATA_DIR) : path.join(ROOT, 'data'),
  ASSETS_DIR: path.join(ROOT, 'assets'),

  // ---- network ----
  // Bind to loopback by default: in production the TLS reverse proxy connects
  // to 127.0.0.1, so the Node port is never directly reachable from the internet.
  HOST: process.env.HOST || '127.0.0.1',
  PORT: envInt('PORT', 8173),
  // Only trust X-Forwarded-For when a known proxy sits in front; otherwise a
  // client could spoof the header to evade per-IP rate limiting.
  TRUST_PROXY: envBool('TRUST_PROXY', false),
  ENABLE_HSTS: envBool('ENABLE_HSTS', true),

  // ---- identity / auth ----
  ADMIN_USERNAMES: new Set(envList('ADMIN_USERNAMES', [])),  // set via env (.env), e.g. ADMIN_USERNAMES=alice,bob
  KING_BOB_ID: 'king-bob',
  MIN_PASSWORD_LEN: envInt('MIN_PASSWORD_LEN', 8),
  SESSION_TTL_MS: envInt('SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,

  // ---- rate limiting (per rolling window) ----
  AUTH_WINDOW_MS: envInt('AUTH_WINDOW_MIN', 10) * 60 * 1000,
  AUTH_MAX_ATTEMPTS: envInt('AUTH_MAX_ATTEMPTS', 25),   // per (IP, username)
  AUTH_IP_MAX: envInt('AUTH_IP_MAX', 100),              // per IP across all usernames (anti-spray)
  AUTH_FAIL_WINDOW_MS: envInt('AUTH_FAIL_WINDOW_MIN', 15) * 60 * 1000,
  AUTH_FAIL_MAX: envInt('AUTH_FAIL_MAX', 50),           // failed logins per account, all IPs (anti distributed brute force)
  WRITE_WINDOW_MS: envInt('WRITE_WINDOW_MIN', 5) * 60 * 1000,
  WRITE_MAX: envInt('WRITE_MAX', 300),         // any mutating request, per IP
  UPLOAD_WINDOW_MS: envInt('UPLOAD_WINDOW_MIN', 10) * 60 * 1000,
  UPLOAD_MAX: envInt('UPLOAD_MAX', 40),        // photo uploads, per user
  MAINT_INTERVAL_MS: envInt('MAINT_INTERVAL_MIN', 10) * 60 * 1000, // rate-limit/session sweep cadence

  // ---- email + 2FA ----
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',           // empty => dev console mode (codes logged)
  MAIL_FROM: process.env.MAIL_FROM || 'Chicken Butt Gallery <onboarding@resend.dev>',
  APP_NAME: process.env.APP_NAME || 'Chicken Butt Gallery',
  CODE_TTL_MS: envInt('CODE_TTL_MIN', 10) * 60 * 1000,
  CODE_MAX_ATTEMPTS: envInt('CODE_MAX_ATTEMPTS', 5),
  CODE_SEND_WINDOW_MS: envInt('CODE_SEND_WINDOW_MIN', 15) * 60 * 1000,
  CODE_SEND_MAX: envInt('CODE_SEND_MAX', 5),                   // code emails per account per window
  DEVICE_TTL_MS: envInt('DEVICE_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,

  // ---- abuse caps ----
  MAX_COMMUNITIES_PER_USER: envInt('MAX_COMMUNITIES_PER_USER', 25),
  MAX_PHOTOS_PER_USER: envInt('MAX_PHOTOS_PER_USER', 1000),
  MAX_COMMENTS_PER_POST: envInt('MAX_COMMENTS_PER_POST', 500),
  MAX_AUDIT_EVENTS: envInt('MAX_AUDIT_EVENTS', 5000),
  MAX_IMAGE_BYTES: envInt('MAX_IMAGE_MB', 12) * 1024 * 1024,
};

module.exports = config;

# Chicken Butt Gallery

An invite-only photo gallery rendered as the **interior of a 3D sphere**
(Three.js). Friends create private communities, share an invite link, and build
the sphere together - uploading photos, liking, commenting, and curating albums.

The backend is a **zero-dependency Node.js HTTP server** that persists to flat
JSON files, with images stored on disk. No framework, no database, no build step.
Three.js and GSAP are vendored locally, so the running app has no third-party
runtime dependencies.

## Run locally

```bash
node server.js
# -> serving at http://127.0.0.1:8173
```

Open <http://127.0.0.1:8173>. To reach it from other devices on your LAN, run
with `HOST=0.0.0.0`.

## Test

```bash
npm test          # node --test - RBAC, image sniffing, password hashing
```

## Deploy to the internet

See **[DEPLOY.md](DEPLOY.md)** - TLS reverse proxy, systemd, firewall, backups.
The app **must** run behind an HTTPS reverse proxy; the Node port binds to
loopback by default.

## Configuration

All tunables are environment variables with safe defaults - see
[`.env.example`](.env.example) and [`lib/config.js`](lib/config.js). Highlights:
`HOST`, `PORT`, `TRUST_PROXY`, `ADMIN_USERNAMES`, `MIN_PASSWORD_LEN`, the rate
limits, and abuse caps.

## Architecture

Client (browser, ES modules):

- `main.js` - app state, routing, the 3D render loop
- `js/` - textures, images, util, api, toast
- `js/vendor/` - three and gsap, self-hosted

The client talks to the server over `/api/*` (JSON, Bearer token) and loads
images from `/assets/*`.

Server (Node, `server.js` plus `lib/`):

- `lib/config.js` - env-driven config
- `lib/static.js` - static file serving, CSP and security headers
- `lib/helpers.js` - auth, RBAC, rate limits, image I/O, audit
- `lib/store.js` - in-memory data with atomic JSON persistence

State lives in `data/*.json` and uploaded images in `assets/uploads`,
`assets/avatars`, and `assets/community`.

- **`lib/config.js`** - single source of truth for every environment-dependent value.
- **`lib/store.js`** - loads all JSON into memory at boot; `saveJSON` does atomic temp-file + rename. All data access goes through here (see [ADR-001](docs/adr/ADR-001-persistence.md)).
- **`lib/helpers.js`** - sessions, the RBAC matrix, rate limiting, image validation, audit log, and the boot-time schema migration.
- **`lib/static.js`** - allow-listed static serving with a strict CSP and security headers.
- **`server.js`** - the HTTP entry point and API router.

## Security posture

- Passwords: `scrypt` + per-user salt; logins use a constant-time compare.
- Auth, write, and upload **rate limiting** (IP spoofing prevented via `TRUST_PROXY`).
- Uploads validated by **magic bytes**, size-capped, and stored with sanitized names; path-traversal-safe deletes.
- Strict **CSP** (`script-src 'self'`, self-hosted libs), `HSTS`, `X-Frame-Options: DENY`, `nosniff`, no-referrer.
- Bearer-token auth (not cookies) -> no CSRF surface.
- Per-user caps on communities and uploads to limit abuse.

See [DEPLOY.md](DEPLOY.md) for the full pre-launch checklist.

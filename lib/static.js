'use strict';
/* Static file serving + security headers. Only an explicit allow-list of files
   and whitelisted /assets/* extensions are ever served - data/ and source files
   are never reachable. */
const fs = require('fs');
const path = require('path');
const { ROOT, ASSETS_DIR } = require('./store');

const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2',
};
const PUBLIC_FILES = new Set(['/index.html', '/main.js', '/styles.css']);
const PUBLIC_ASSET_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.woff2']);
const PUBLIC_CODE_DIRS = ['/js/'];   // client ES modules

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // HTTPS-only site: pin the browser to HTTPS so a first-hop SSL-strip can't
    // capture the bearer token in the Authorization header.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      // scripts are all self-hosted modules now (Three.js/GSAP vendored, no inline
      // scripts), so no 'unsafe-inline' and no CDN origin - a real XSS containment.
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob: https://*.supabase.co",
      // fetch() to the public Supabase bucket so the photo-download button can pull
      // the image into a Blob and save it with a filename (a cross-origin <a download>
      // is otherwise ignored). Same host already trusted for img-src; no credentials
      // and the service key never reaches the client, so this adds no real capability.
      "connect-src 'self' https://*.supabase.co",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    ...extra,
  };
}

/* Resolve a request path to an on-disk file, or '' if not allowed. */
function resolvePublicFile(routePath) {
  if (PUBLIC_FILES.has(routePath)) return path.resolve(ROOT, `.${routePath}`);
  if (routePath.startsWith('/assets/') && PUBLIC_ASSET_EXTENSIONS.has(path.extname(routePath).toLowerCase())) {
    const f = path.resolve(ROOT, `.${routePath}`);
    return f.startsWith(ASSETS_DIR + path.sep) ? f : '';
  }
  if (PUBLIC_CODE_DIRS.some(d => routePath.startsWith(d)) && path.extname(routePath).toLowerCase() === '.js') {
    const f = path.resolve(ROOT, `.${routePath}`);
    // confine to the js/ directory itself: without this, a traversal like
    // /js/../server.js resolves under ROOT and would leak backend source.
    const jsDir = path.join(ROOT, 'js');
    return f.startsWith(jsDir + path.sep) ? f : '';
  }
  return '';
}

/* Cache policy per route. The HTML entry point must always revalidate so a deploy
   is picked up immediately; the vendored libs and fonts never change so they cache
   hard; uploaded media has stable, uniquely-named URLs so it is effectively
   immutable; the app's own JS/CSS keep fixed filenames across deploys, so they must
   revalidate (via ETag) rather than be cached blindly. */
function cacheControlFor(routePath, ext) {
  if (routePath === '/index.html') return 'no-store';
  if (routePath.startsWith('/js/vendor/') || ext === '.woff2') return 'public, max-age=31536000, immutable';
  if (routePath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end('method not allowed');
    return;
  }
  const routePath = pathname === '/' ? '/index.html' : pathname;
  const f = resolvePublicFile(routePath);
  const notFound = () => {
    res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end('not found');
  };
  if (!f) return notFound();
  // stat first so HEAD (and a conditional GET that 304s) never reads the whole file
  // into memory just to discard it.
  fs.stat(f, (statErr, st) => {
    if (statErr || !st.isFile()) return notFound();
    const ext = path.extname(f).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers = securityHeaders({
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(routePath, ext),
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
    });
    // 304 when the client's cached copy is still current (revalidation path)
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': String(st.size) });
      res.end();
      return;
    }
    fs.readFile(f, (err, data) => {
      if (err) return notFound();
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

module.exports = { securityHeaders, serveStatic, mime };

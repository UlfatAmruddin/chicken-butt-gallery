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
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co",
      "connect-src 'self'",
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
    return f.startsWith(ROOT + path.sep) ? f : '';
  }
  return '';
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('method not allowed');
    return;
  }
  const routePath = pathname === '/' ? '/index.html' : pathname;
  const f = resolvePublicFile(routePath);
  if (!f) {
    res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end('not found');
    return;
  }
  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
      res.end('not found');
      return;
    }
    res.writeHead(200, securityHeaders({
      'Content-Type': mime[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }));
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

module.exports = { securityHeaders, serveStatic, mime };

'use strict';
/* Vercel serverless entry: one function that handles every /api/* route (wired
   up by the rewrite in vercel.json). Requiring server.js INSIDE the handler and
   wrapping in try/catch means even a module-load failure surfaces as a readable
   500 (and is logged) instead of an opaque FUNCTION_INVOCATION_FAILED.
   server.js does not call listen() when imported (require.main !== module).
   Static files (index.html, main.js, styles.css, js/**, assets/fonts/**) are
   served by Vercel's CDN, not this function. */
module.exports = async (req, res) => {
  try {
    const onRequest = require('../server.js').onRequest;
    await onRequest(req, res);
  } catch (err) {
    console.error('[fn] crash:', (err && err.stack) || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Server error: ' + ((err && err.message) || 'unknown'));
    }
  }
};

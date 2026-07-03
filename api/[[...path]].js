'use strict';
/* Vercel serverless entry. A catch-all so every /api/* request reaches the one
   Node handler exported by server.js. Requiring INSIDE the handler and wrapping
   everything in try/catch means even a module-load failure surfaces as a
   readable 500 (and is logged) instead of an opaque FUNCTION_INVOCATION_FAILED.
   server.js does not call listen() when imported (require.main !== module). */
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

'use strict';
/* Vercel serverless entry. A catch-all so every /api/* request reaches the one
   Node handler exported by server.js. The handler reads the original req.url,
   so all existing routes work unchanged; server.js does not call listen() when
   imported (require.main !== module), so no port is bound here. Static files
   (index.html, main.js, styles.css, js/**, assets/fonts/**) are served by
   Vercel's CDN, not this function. */
module.exports = require('../server.js').onRequest;

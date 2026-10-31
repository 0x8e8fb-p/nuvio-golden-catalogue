'use strict';

/**
 * Local development entry point.
 *
 * Serves the same Express app used on Vercel (api/index.js) so local behaviour
 * — landing page, default manifest, and preset routes — matches production.
 *
 * Start with:  npm start   (or npm run dev)
 * Then open:   http://127.0.0.1:7000/
 */

const app = require('../api/index');

const port = Number(process.env.PORT) || 7000;

const server = app.listen(port, () => {
  const url = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console
  console.log(`Addon running at ${url}`);
  // eslint-disable-next-line no-console
  console.log(`Landing page:   ${url}/`);
  // eslint-disable-next-line no-console
  console.log(`Default manifest: ${url}/manifest.json`);
});

module.exports = server;

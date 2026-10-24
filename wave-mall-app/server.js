'use strict';

// Entry file for Hostinger (Node.js web app). Hostinger sets PORT.
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`The Wave site listening on :${port} (${process.env.NODE_ENV || 'development'})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

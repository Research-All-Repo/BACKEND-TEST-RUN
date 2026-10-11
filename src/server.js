'use strict';
require('./load-env');
const config = require('./config');
const { createApp } = require('./app');

config.validate();

let mockEdge = null;
if (config.mockEdge.enabled) {
  const { MockEdge, createOnRequestEdge } = require('./mock/edge-simulator');
  const log = (...a) => console.log('[mock-edge]', ...a);
  mockEdge = config.mockEdge.mode === 'on-request' ? createOnRequestEdge({ log }) : new MockEdge({ log });
}

const app = createApp({ mockEdge });
const server = app.listen(config.port, () => {
  console.log(`AquaCast backend listening on :${config.port} (${config.isProduction ? 'production' : 'development'})`);
  if (mockEdge && mockEdge.mode === 'background') mockEdge.start();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  if (mockEdge) mockEdge.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

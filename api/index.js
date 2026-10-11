'use strict';
// Vercel entry point: the same Express app as src/server.js, exported as one
// Vercel Function (no listen(), no timers). vercel.json rewrites /api/* here;
// public/ is served by Vercel's CDN.
const config = require('../src/config');
const { createApp } = require('../src/app');

config.validate();

// Serverless has no long-running process, so the mock Raspberry Pi runs in
// "on-request" mode: a throttled catch-up tick on signed-in API requests.
let mockEdge = null;
if (config.mockEdge.enabled) {
  const { createOnRequestEdge } = require('../src/mock/edge-simulator');
  mockEdge = createOnRequestEdge({ log: (...a) => console.log('[mock-edge]', ...a) });
}

module.exports = createApp({ mockEdge });

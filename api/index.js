'use strict';
// Vercel entry point (for a later move from Render). Same Express app, no listen().
// Note: the in-process mock edge simulator cannot run on serverless; run
// `npm run simulate` elsewhere or rely on the real Raspberry Pi.
const { createApp } = require('../src/app');
module.exports = createApp();

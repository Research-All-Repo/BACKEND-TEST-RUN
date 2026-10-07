'use strict';
// Run the mock Raspberry Pi as its own process (alternative to MOCK_EDGE_ENABLED=true in the web service).
require('./_env');
const config = require('../src/config');
config.validate();
const { MockEdge } = require('../src/mock/edge-simulator');
const edge = new MockEdge({ log: (...a) => console.log(new Date().toISOString(), '[mock-edge]', ...a) });
edge.start();
process.on('SIGINT', () => { edge.stop(); process.exit(0); });

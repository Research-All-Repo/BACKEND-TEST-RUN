'use strict';
// Local development convenience: read ./.env if present. On Render the
// variables come from the dashboard and no .env file exists.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);

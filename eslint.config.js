'use strict';
// ESLint (flat config). Run: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

const shared = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'public/css/**', 'public/img/**', 'public/js/icons.js', '.vercel/**'] },
  js.configs.recommended,
  { // server (Node, CommonJS)
    files: ['src/**/*.js', 'api/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: shared,
  },
  { // dashboard (browser, ES modules)
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: shared,
  },
  { // service worker + the tiny theme script loaded before the app
    files: ['public/sw.js', 'public/js/theme-boot.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.serviceworker, ...globals.browser } },
    rules: { ...shared, 'no-var': 'off' },
  },
];

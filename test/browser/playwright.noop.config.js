// The #247 no-op corpus (specs-deploy/math-output-noop.spec.js), and its
// positive control math-output.spec.js, against any deploy INCLUDING
// production.
//
// It is the deploy config minus globalSetup/globalTeardown. ephemeral-setup.js
// refuses production before any test runs (trinket.gopicup.org throws), and on
// a Firebase trial it mints two identities; the specs this config is for never
// sign in, so they need neither. Every other spec in specs-deploy/ that needs
// an identity skips here for want of SMOKE_EMAIL.
//
//   TRINKET_BASE_URL=https://trinket.gopicup.org TRINKET_CORPUS=abc123,def456 \
//     npx playwright test -c playwright.noop.config.js math-output-noop math-output
const base = require('./playwright.deploy.config.js');

const { globalSetup, globalTeardown, ...rest } = base;
module.exports = rest;

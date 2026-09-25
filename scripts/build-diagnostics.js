'use strict';
const { build } = require('esbuild');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function buildDiagnostics(outfile, loggers = false) {
  return build({
    absWorkingDir: root, entryPoints: ['scripts/diagnostics-entry.js'], outfile,
    bundle: true, platform: 'browser', format: 'iife', target: ['safari26'], minify: true,
    define: { __JAA_LOGGERS__: loggers === true ? 'true' : 'false' }
  });
}
function loggerFlag(args) {
  if (args.some(arg => arg !== '--loggers')) throw new Error('Unknown build argument. Supported flag: --loggers');
  return args.includes('--loggers');
}
module.exports = { buildDiagnostics, loggerFlag };

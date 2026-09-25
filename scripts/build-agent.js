'use strict';
const { build } = require('esbuild');
const path = require('node:path');
const { buildDiagnostics, loggerFlag } = require('./build-diagnostics');
const loggers = loggerFlag(process.argv.slice(2));
const root = path.resolve(__dirname, '..');
build({
  absWorkingDir: root,
  entryPoints: ['scripts/agent-graph-entry.mjs'],
  outfile: 'ApplyOnce Extension/Resources/vendor/agent/graph.mjs',
  bundle: true, platform: 'browser', format: 'esm', target: ['safari26'],
  minify: true, legalComments: 'linked',
  metafile: true
}).then(async result => {
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
  if (imports.some(entry => entry.external)) throw new Error('Agent bundle contains external runtime imports.');
  await buildDiagnostics(path.join(root, 'ApplyOnce Extension/Resources/diagnostics.js'), loggers);
  console.log('Safari 26+ agent bundle built without external runtime imports.');
}).catch(error => { console.error(error); process.exitCode = 1; });

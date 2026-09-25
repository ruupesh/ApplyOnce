'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { loggerFlag } = require('./build-diagnostics');
const root = path.resolve(__dirname, '..');
const loggers = loggerFlag(process.argv.slice(2));
execFileSync(process.execPath, [path.join(__dirname, 'build-agent.js')], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'build-extension.js'), ...(loggers ? ['--loggers'] : [])], { cwd: root, stdio: 'inherit' });
execFileSync('zip', ['-qr', '../ApplyOnce-chromium.zip', '.'], { cwd: path.join(root, 'dist/chromium'), stdio: 'inherit' });

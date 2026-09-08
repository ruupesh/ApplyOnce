"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "ApplyOnce Extension", "Resources");
const output = path.join(root, "dist", "chromium");
const manifestPath = path.join(source, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function requireResource(relativePath) {
  if (!relativePath || !fs.existsSync(path.join(source, relativePath))) {
    throw new Error(`Manifest references a missing resource: ${relativePath}`);
  }
}

if (manifest.manifest_version !== 3) {
  throw new Error("The shared extension manifest must use Manifest V3.");
}

const resources = [
  ...Object.values(manifest.icons || {}),
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.action?.default_icon,
  manifest.options_ui?.page
];

for (const entry of manifest.content_scripts || []) {
  resources.push(...(entry.js || []), ...(entry.css || []));
}
resources.filter(Boolean).forEach(requireResource);

fs.rmSync(output, { force: true, recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.cpSync(source, output, {
  recursive: true,
  filter(file) {
    return path.basename(file) !== ".DS_Store";
  }
});

console.log(`Chromium extension staged at ${path.relative(root, output)}`);

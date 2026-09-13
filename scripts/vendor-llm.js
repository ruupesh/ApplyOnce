"use strict";

/*
Copies the Transformers.js runtime into Resources/vendor/transformers/ so the
extension can run local models without fetching code at runtime (MV3 forbids
remote code execution).

This is opt-in on purpose: the WebGPU + CPU runtime is ~36 MB and would
otherwise be added to every install. Run it only when you want a build with
local-model support; `npm run vendor:llm:clean` removes it again. The vendor
directory is gitignored, so the repo size never changes.

  npm run vendor:llm          WebGPU + CPU (~36 MB)
  npm run vendor:llm -- --cpu CPU only      (~12 MB)
*/

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "ApplyOnce Extension", "Resources", "vendor", "transformers");
const cpuOnly = process.argv.includes("--cpu");

// transformers.min.js is the self-contained browser bundle. The .web. variant
// looks smaller but leaves `onnxruntime-web/webgpu` as a bare import specifier,
// which a browser cannot resolve without a bundler or an import map.
//
// v4's runtime asks for the plain build (CPU) and the asyncify build (WebGPU).
// The jsep files belong to the older v3 backend and are not used.
const sources = [["@huggingface/transformers/dist", "transformers.min.js"]];

const ortFiles = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
if (!cpuOnly) {
  ortFiles.push("ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm");
}
ortFiles.forEach((file) => sources.push(["onnxruntime-web/dist", file]));

function resolveFrom(pkgDir, file) {
  const candidate = path.join(root, "node_modules", pkgDir, file);
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Missing ${pkgDir}/${file}.\nRun: npm install --no-save @huggingface/transformers@4.2.0 pdfjs-dist@6.3.289`
    );
  }
  return candidate;
}

// Validate everything before replacing a working runtime.
sources.forEach(([pkgDir, file]) => resolveFrom(pkgDir, file));
const transformers = require(path.join(root, "node_modules/@huggingface/transformers/package.json"));
const ort = require(path.join(root, "node_modules/onnxruntime-web/package.json"));
if (transformers.version !== "4.2.0" || ort.version !== transformers.dependencies["onnxruntime-web"]) {
  throw new Error("Use Transformers.js 4.2.0 and its exact onnxruntime-web dependency to avoid incompatible WASM binaries.");
}
fs.rmSync(outDir, { force: true, recursive: true });
fs.mkdirSync(outDir, { recursive: true });

let total = 0;
for (const [pkgDir, file] of sources) {
  const from = resolveFrom(pkgDir, file);
  const to = path.join(outDir, file);
  fs.copyFileSync(from, to);
  const size = fs.statSync(to).size;
  total += size;
  console.log(`  ${file} — ${(size / 1024 / 1024).toFixed(1)} MB`);
}

for (const [pkg, name] of [["@huggingface/transformers", "LICENSE-transformers"]]) {
  fs.copyFileSync(path.join(root, "node_modules", pkg, "LICENSE"), path.join(outDir, name));
}
fs.copyFileSync(path.join(__dirname, "licenses/onnxruntime.txt"), path.join(outDir, "LICENSE-onnxruntime"));

console.log(
  `\nVendored ${(total / 1024 / 1024).toFixed(1)} MB to ${path.relative(root, outDir)}` +
    `${cpuOnly ? " (CPU only)" : " (WebGPU + CPU)"}`
);

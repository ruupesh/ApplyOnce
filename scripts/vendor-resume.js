"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/pdfjs-dist");
const output = path.join(root, "ApplyOnce Extension/Resources/vendor/pdfjs");
const files = ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "LICENSE"];
for (const file of files) {
  if (!fs.existsSync(path.join(source, file))) throw new Error("Install pdfjs-dist@6.3.289 before running vendor:resume.");
}
fs.mkdirSync(output, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(source, file), path.join(output, path.basename(file)));
console.log("PDF resume reader staged (about 1.8 MB; loaded only when a PDF is attached).");

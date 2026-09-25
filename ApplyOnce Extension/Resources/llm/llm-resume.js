/* Read resume text locally. No resume bytes are uploaded to parse a file. */
async function jaaLlmReadResume(record, options) {
  var complete = options && options.complete;
  var bytes = Uint8Array.from(atob(record.data || ""), function (c) { return c.charCodeAt(0); });
  if (/pdf/i.test(record.type || "") || /\.pdf$/i.test(record.name || "")) {
    var url = jaaBrowser.runtime.getURL("vendor/pdfjs/pdf.min.mjs");
    var available = await fetch(url, { method: "HEAD" }).catch(function () { return null; });
    if (!available || !available.ok) throw new Error("This build has no PDF reader. Attach a text resume or use a build with PDF support.");
    var pdfjs = await import(url);
    pdfjs.GlobalWorkerOptions.workerSrc = jaaBrowser.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
    var task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWasm: false, useSystemFonts: true });
    var text = "";
    try {
      var pdf = await task.promise;
      for (var i = 1; i <= (complete ? pdf.numPages : Math.min(pdf.numPages, 20)) && (complete || text.length < JAA_LLM_TOOL_BUDGET); i++) {
        var page = await pdf.getPage(i);
        var content = await page.getTextContent();
        text += content.items.map(function (item) { return (item.str || "") + (item.hasEOL ? "\n" : " "); }).join("") + "\n";
      }
      if (!text.trim()) throw new Error("This PDF contains no readable text. Scanned resumes need OCR; attach a text version.");
      return complete ? text : jaaLlmTruncate(text);
    } finally { await task.destroy(); }
  }
  if (/wordprocessingml/i.test(record.type || "") || /\.docx$/i.test(record.name || "")) {
    var text = await jaaLlmDocxText(bytes);
    return complete ? text : jaaLlmTruncate(text);
  }
  if (/^text\/|json|markdown/i.test(record.type || "") || /\.(txt|md|csv)$/i.test(record.name || "")) {
    var text = new TextDecoder().decode(bytes);
    return complete ? text : jaaLlmTruncate(text);
  }
  throw new Error("Unsupported resume format. Use PDF, DOCX, or a text file.");
}

// DOCX is a ZIP. Read only its document XML using the browser's decompressor,
// avoiding a ZIP/Word library and ignoring macros, links, and embedded objects.
async function jaaLlmDocxText(bytes) {
  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error("Invalid DOCX archive.");
  var cursor = view.getUint32(end + 16, true);
  var count = view.getUint16(end + 10, true);
  for (var i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Invalid DOCX directory.");
    var method = view.getUint16(cursor + 10, true);
    var size = view.getUint32(cursor + 20, true);
    var length = view.getUint16(cursor + 28, true);
    var name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + length));
    if (name === "word/document.xml") {
      if (view.getUint16(cursor + 8, true) & 1) throw new Error("Encrypted DOCX files are not supported.");
      if (view.getUint32(cursor + 24, true) > 4 * 1024 * 1024) throw new Error("Resume document is too large to read.");
      var offset = view.getUint32(cursor + 42, true);
      if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("Invalid DOCX entry.");
      var start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      if (start + size > bytes.length) throw new Error("Incomplete DOCX file.");
      var stream = new Blob([bytes.slice(start, start + size)]).stream();
      if (method === 8) stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
      else if (method !== 0) throw new Error("Unsupported DOCX compression.");
      var reader = stream.getReader();
      var chunks = [], total = 0;
      try {
        for (;;) {
          var next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          if (total > 4 * 1024 * 1024) throw new Error("Resume document is too large to read.");
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      var xml = await new Blob(chunks).text();
      if (/<!DOCTYPE/i.test(xml)) throw new Error("Unsupported DOCX XML declarations.");
      var doc = new DOMParser().parseFromString(xml, "application/xml");
      if (doc.querySelector("parsererror")) throw new Error("Invalid DOCX text.");
      var paragraphs = Array.from(doc.getElementsByTagNameNS("*", "p"));
      var text = paragraphs.map(function (p) { return Array.from(p.getElementsByTagNameNS("*", "t")).map(function (t) { return t.textContent; }).join(""); }).join("\n");
      if (!text.trim()) throw new Error("No readable text found in this DOCX.");
      return text;
    }
    cursor += 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  throw new Error("This DOCX has no document text.");
}

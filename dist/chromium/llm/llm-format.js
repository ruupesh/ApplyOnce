/* Safe assistant-output formatting. Markdown is built with DOM nodes so model
   text never becomes executable HTML. */

function jaaLlmSplitReasoning(value) {
  var text = String(value || "");
  var gemmaOpen = text.indexOf("<|channel>thought");
  var gemmaClose = text.indexOf("<channel|>");
  function gemmaAnswer(value) { return value.replace(/(?:<turn\|>|<\|turn\|>|<\|eos\|>)\s*$/, "").trim(); }
  if (gemmaOpen !== -1) {
    var lineEnd = text.indexOf("\n", gemmaOpen);
    var start = lineEnd === -1 ? text.length : lineEnd + 1;
    if (gemmaClose === -1 || gemmaClose < start) {
      return { answer: gemmaAnswer(text.slice(0, gemmaOpen)), reasoning: text.slice(start).trim(), thinking: true, incomplete: true };
    }
    return {
      answer: gemmaAnswer(text.slice(0, gemmaOpen) + text.slice(gemmaClose + 10)),
      reasoning: text.slice(start, gemmaClose).trim(),
      thinking: false,
      incomplete: false
    };
  }
  if (text.startsWith("<|channel") && gemmaClose === -1) {
    return { answer: "", reasoning: "", thinking: true, incomplete: true };
  }
  if (gemmaClose !== -1) {
    return { answer: gemmaAnswer(text.slice(gemmaClose + 10)), reasoning: text.slice(0, gemmaClose).trim(), thinking: false, incomplete: false };
  }
  var open = text.indexOf("<think>");
  var close = text.indexOf("</think>");
  if (open !== -1) {
    if (close === -1 || close < open) {
      return { answer: text.slice(0, open).trim(), reasoning: text.slice(open + 7).trim(), thinking: true, incomplete: true };
    }
    return {
      answer: (text.slice(0, open) + text.slice(close + 8)).trim(),
      reasoning: text.slice(open + 7, close).trim(),
      thinking: false,
      incomplete: false
    };
  }
  // Some tokenizers omit the opening token from streamed output.
  if (close !== -1) {
    return { answer: text.slice(close + 8).trim(), reasoning: text.slice(0, close).trim(), thinking: false, incomplete: false };
  }
  return { answer: gemmaAnswer(text), reasoning: "", thinking: false, incomplete: false };
}

function jaaMarkdownAppendInline(parent, source) {
  var text = String(source || "");
  var token = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  var cursor = 0;
  var match;
  while ((match = token.exec(text))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    var raw = match[0];
    var node;
    if (/^(\*\*|__)/.test(raw)) {
      node = document.createElement("strong");
      node.textContent = raw.slice(2, -2);
    } else if (raw[0] === "`") {
      node = document.createElement("code");
      node.textContent = raw.slice(1, -1);
    } else if (raw[0] === "[") {
      var parts = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      var href = parts && parts[2];
      if (href && /^(https?:|mailto:)/i.test(href)) {
        node = document.createElement("a");
        node.href = href;
        node.target = "_blank";
        node.rel = "noreferrer noopener";
        node.textContent = parts[1];
      } else {
        node = document.createTextNode(raw);
      }
    } else {
      node = document.createElement("em");
      node.textContent = raw.slice(1, -1);
    }
    parent.appendChild(node);
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function jaaRenderMarkdown(container, source) {
  container.textContent = "";
  var lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (/^```/.test(line)) {
      var language = line.slice(3).trim();
      var codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) codeLines.push(lines[i++]);
      if (i < lines.length) i += 1;
      var pre = document.createElement("pre");
      var code = document.createElement("code");
      if (language) code.className = "language-" + language.replace(/[^a-z0-9_-]/gi, "");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }
    var heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      var h = document.createElement("h" + heading[1].length);
      jaaMarkdownAppendInline(h, heading[2]);
      container.appendChild(h);
      i += 1;
      continue;
    }
    var list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (list) {
      var ordered = !!list[2];
      var listNode = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        var item = lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
        if (!item || !!item[2] !== ordered) break;
        var li = document.createElement("li");
        jaaMarkdownAppendInline(li, item[3]);
        listNode.appendChild(li);
        i += 1;
      }
      container.appendChild(listNode);
      continue;
    }
    if (/^>\s?/.test(line)) {
      var quote = document.createElement("blockquote");
      jaaMarkdownAppendInline(quote, line.replace(/^>\s?/, ""));
      container.appendChild(quote);
      i += 1;
      continue;
    }
    var paragraph = document.createElement("p");
    var paragraphLines = [];
    while (i < lines.length && lines[i].trim() && !/^(?:```|#{1,4}\s|\s*(?:[-+*]|\d+\.)\s+|>\s?)/.test(lines[i])) {
      paragraphLines.push(lines[i++]);
    }
    paragraphLines.forEach(function (part, index) {
      if (index) paragraph.appendChild(document.createElement("br"));
      jaaMarkdownAppendInline(paragraph, part);
    });
    container.appendChild(paragraph);
  }
}

if (typeof window !== "undefined") {
  window.jaaLlmSplitReasoning = jaaLlmSplitReasoning;
  window.jaaRenderMarkdown = jaaRenderMarkdown;
}

/* Portable DOM tools: no debugger API, eval, generated scripts or page bridge.
 * Refs identify actual nodes in this document, including open shadow roots.
 * Replaced nodes fail closed rather than silently resolving to a new target.
 */
function jaaCreatePageTools(options) {
  var documentId = crypto.randomUUID();
  var sequence = 0;
  var refs = new Map();
  var ids = new WeakMap();
  var sensitive = /password|passwd|\bssn\b|social security|passport|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|routing.?number|bank.?account|account.?number|pin.?code|pin.?number|token|secret|authorization/i;
  var blockedClick = /\b(submit|confirm|purchase|pay|checkout|place\s+order|delete|remove\s+all)\b/i;
  var interactive = 'button,a[href],input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="tab"],[role="link"],[contenteditable="true"]';
  function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max || 160); }
  function int(value, fallback, max) { return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback; }
  function ref(el) {
    if (!ids.has(el)) {
      // Prune disconnected nodes and bound retained references on long-lived SPAs.
      if (refs.size >= 2000) refs.forEach(function (node, key) { if (!node.isConnected) refs.delete(key); });
      if (refs.size >= 2000) refs.delete(refs.keys().next().value);
      ids.set(el, documentId.slice(0, 8) + ":" + (++sequence));
    }
    refs.set(ids.get(el), el);
    return ids.get(el);
  }
  function node(id) {
    var el = refs.get(id);
    if (!el || !el.isConnected) throw new Error("Stale element ref. Find the element again.");
    return el;
  }
  function label(el) {
    var labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).map(function (id) {
      var root = el.getRootNode();
      var label = root.getElementById ? root.getElementById(id) : null; return label ? label.textContent : "";
    }).join(" ");
    return clean(el.getAttribute("aria-label") || labelled.trim() ||
      (el.labels && Array.from(el.labels).map(function (label) { return label.textContent; }).join(" ")) ||
      el.getAttribute("alt") || el.getAttribute("title") ||
      (/^(button|submit|reset)$/.test(el.type) ? el.value : ""));
  }
  function isSensitive(el) {
    return el.type === "password" || el.type === "hidden" ||
      sensitive.test([el.id, el.getAttribute("name"), el.getAttribute("autocomplete"), label(el)].join(" "));
  }
  function textContent(el) {
    if (el.matches("script,style,input,textarea,select") || isSensitive(el)) return "";
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (child) {
        if (child.nodeType === 1 && (child.matches("script,style,input,textarea,select") || isSensitive(child))) return NodeFilter.FILTER_REJECT;
        return child.nodeType === 3 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    var result = [], child;
    while ((child = walker.nextNode())) result.push(child.textContent);
    return result.join(" ");
  }
  function name(el) { return label(el) || clean(textContent(el)); }
  function role(el) {
    return el.getAttribute("role") || ({ BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox" })[el.tagName] ||
      (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" })[el.type] || "textbox" : "");
  }
  function visible(el) {
    var style = getComputedStyle(el);
    return !el.closest('[hidden],[inert],[aria-hidden="true"]') && style.display !== "none" && style.visibility !== "hidden" &&
      !!el.getClientRects().length;
  }
  function describe(el) {
    var entry = { ref: ref(el), tag: el.localName, role: role(el), name: isSensitive(el) ? "[sensitive]" : name(el), visible: visible(el) };
    // Include a compact revision to detect changes beyond the displayed label
    // and value. This is a staleness check, not an authorization credential.
    var activation = el.closest("button,a,label") || el;
    var revision = el.outerHTML + "|" + (el.value || "") + "|" + activation.outerHTML;
    var hash = 2166136261;
    for (var h = 0; h < revision.length; h++) hash = Math.imul(hash ^ revision.charCodeAt(h), 16777619);
    entry.revision = (hash >>> 0).toString(36);
    if (el.id) entry.id = clean(el.id);
    if (el.type) entry.type = el.type;
    if (el.href) entry.href = clean(el.href, 300);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
    if (el.matches("input,textarea,select")) entry.value = isSensitive(el) || el.type === "file" ? "[redacted]" : clean(el.value, 200);
    if (/^(checkbox|radio)$/.test(el.type)) entry.checked = el.checked;
    return entry;
  }
  function roots() {
    var result = [document];
    for (var i = 0; i < result.length; i++) {
      result[i].querySelectorAll("*").forEach(function (el) { if (el.shadowRoot) result.push(el.shadowRoot); });
    }
    return result;
  }
  function find(args) {
    var selector = args.selector || (args.text || args.role ? "*" : interactive);
    if (typeof selector !== "string" || selector.length > 500) throw new Error("Use a CSS selector under 500 characters.");
    var scope = args.ref ? [node(args.ref)] : roots();
    var matches = [];
    scope.forEach(function (root) {
      Array.from(root.querySelectorAll(selector)).forEach(function (el) {
        if (args.role && role(el) !== args.role) return;
        if (args.text) {
          var actual = (args.exact || isSensitive(el) ? name(el) : label(el) + " " + textContent(el)).toLowerCase(), wanted = String(args.text).toLowerCase();
          if (args.exact ? actual !== wanted : actual.indexOf(wanted) === -1) return;
        }
        if (args.visible === true && !visible(el)) return;
        matches.push(el);
      });
    });
    var offset = int(args.offset, 0, matches.length), limit = Math.max(1, int(args.limit, 15, 25));
    return { elements: matches.slice(offset, offset + limit).map(describe), total: matches.length,
      nextOffset: offset + limit < matches.length ? offset + limit : null };
  }
  function chunk(text, args) {
    var limit = Math.max(1, int(args.limit, 3000, 6000));
    var offset = int(args.offset, 0, text.length);
    if (args.query) {
      var found = text.toLowerCase().indexOf(String(args.query).toLowerCase(), offset);
      if (found < 0) return { text: "", totalChars: text.length, nextOffset: null, found: false };
      offset = Math.max(offset, found - 150);
      // The next search starts after this occurrence even when a tiny limit is used.
      var nextSearch = Math.max(offset + limit, found + String(args.query).length);
    }
    var end = Math.min(text.length, offset + limit);
    return { text: text.slice(offset, end), offset: offset, totalChars: text.length,
      nextOffset: end < text.length ? (nextSearch || end) : null };
  }
  function html(el) {
    var copy = el.cloneNode(true);
    var nodes = [copy].concat(Array.from(copy.querySelectorAll("*")));
    var originals = [el].concat(Array.from(el.querySelectorAll("*")));
    nodes.forEach(function (item, index) {
      if (item.matches("script,style")) { item.textContent = "/* Read with read_page_code kind javascript/css. */"; }
      var privateField = isSensitive(originals[index]);
      Array.from(item.attributes).forEach(function (attr) {
        if (/^on/i.test(attr.name) || sensitive.test(attr.name) || attr.name === "srcdoc" ||
            attr.name === "value" && (privateField || item.type === "file")) item.setAttribute(attr.name, "[redacted]");
      });
      if (privateField && item.matches("input,textarea,select,[contenteditable]")) {
        item.textContent = ""; item.setAttribute("value", "[redacted]");
      }
    });
    return copy.outerHTML;
  }
  function resources(kind) {
    var list = [];
    roots().forEach(function (root) {
      root.querySelectorAll(kind === "javascript" ? "script" : 'style,link[rel~="stylesheet"]').forEach(function (el) {
        list.push({ ref: ref(el), tag: el.localName, url: clean(el.src || el.href || "", 240), inline: !(el.src || el.href) });
      });
    });
    return list;
  }
  async function source(el, kind) {
    if (kind === "javascript" ? !el.matches("script") : !el.matches('style,link[rel~="stylesheet"]')) {
      throw new Error("Use a script/style resource ref from the resource list.");
    }
    if (kind === "css" && el.sheet) {
      try { return Array.from(el.sheet.cssRules).map(function (rule) { return rule.cssText; }).join("\n"); } catch (ignore) {}
    }
    var url = el.src || el.href;
    if (!url) return el.textContent || "";
    if (!/^https?:/.test(url)) throw new Error("Only HTTP(S) source resources can be read.");
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 8000);
    try {
      // Fetch source as data only. Cross-origin access follows page CORS.
      var response = await fetch(url, { credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var reader = response.body.getReader(), decoder = new TextDecoder(), parts = [], size = 0;
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Source exceeds the 2 MiB read limit."); }
        parts.push(decoder.decode(part.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } catch (error) { throw new Error("Source unavailable (site access/CORS/network or size limit): " + error.message); }
    finally { clearTimeout(timer); }
  }
  async function read(args) {
    var kind = args.kind || "html";
    if (["html", "css", "javascript"].indexOf(kind) < 0) throw new Error("kind must be html, css or javascript.");
    var el = args.ref ? node(args.ref) : null;
    if (kind === "html") return Object.assign({ kind: kind, redacted: true, note: "Live DOM; open shadow roots searchable separately; frame documents excluded." }, chunk(html(el || document.documentElement), args));
    if (!el) {
      var list = resources(kind), offset = int(args.offset, 0, list.length), limit = Math.max(1, int(args.limit, 15, 25));
      return { kind: kind, resources: list.slice(offset, offset + limit), total: list.length, nextOffset: offset + limit < list.length ? offset + limit : null };
    }
    if (kind === "css" && !el.matches('style,link[rel~="stylesheet"]')) {
      var style = getComputedStyle(el), declarations = [], matched = [], inaccessible = 0;
      for (var i = 0; i < style.length; i++) declarations.push(style[i] + ": " + style.getPropertyValue(style[i]) + ";");
      function rulesText(rules) {
        var lines = [];
        Array.from(rules).forEach(function (rule) {
          if (rule.selectorText) {
            try { if (el.matches(rule.selectorText)) lines.push(rule.cssText); } catch (ignore) {}
          } else if (rule.cssRules) {
            var nested = rulesText(rule.cssRules);
            if (nested) lines.push(rule.cssText.slice(0, rule.cssText.indexOf("{")) + "{\n" + nested + "\n}");
          }
        });
        return lines.join("\n");
      }
      var scope = el.getRootNode();
      var sheets = scope === document ? Array.from(document.styleSheets) : Array.from(scope.querySelectorAll('style,link[rel~="stylesheet"]')).map(function (item) { return item.sheet; }).filter(Boolean);
      sheets.concat(Array.from(scope.adoptedStyleSheets || [])).forEach(function (sheet) {
        try { matched.push(rulesText(sheet.cssRules)); } catch (ignore) { inaccessible++; }
      });
      var code = "/* Inline style */\n" + (el.getAttribute("style") || "") + "\n/* Matching selectors (conditions preserved) */\n" + matched.filter(Boolean).join("\n") +
        "\n/* Computed style */\n" + declarations.join("\n");
      return Object.assign({ kind: kind, computed: true, inaccessibleStylesheets: inaccessible }, chunk(code, args));
    }
    if (kind === "javascript" && !el.matches("script")) {
      var handlers = Array.from(el.attributes).filter(function (attr) { return /^on/i.test(attr.name); }).map(function (attr) { return attr.name + "=" + attr.value; });
      return Object.assign({ kind: kind, note: "Inline handlers only. addEventListener handlers and framework closures are not exposed by portable DOM APIs. List page script resources for their source." }, chunk(handlers.join("\n"), args));
    }
    return Object.assign({ kind: kind }, chunk(await source(el, kind), args));
  }
  // A search submit is navigation, not an application submission. Require
  // independent form evidence; button text alone must never grant an exception.
  function isSearchSubmit(control) {
    var form = control.form;
    if (control.type !== "submit" || !form || !/^(search|search jobs|find jobs)$/i.test(name(control))) return false;
    var method = control.getAttribute("formmethod") || form.getAttribute("method") || "get";
    if (method.toLowerCase() !== "get") return false;
    var action;
    try { action = new URL(control.getAttribute("formaction") || form.action, document.baseURI); }
    catch (error) { return false; }
    if (!/^https?:$/.test(action.protocol) || action.origin !== location.origin) return false;
    var fields = Array.from(form.elements);
    return fields.some(function (field) { return field.type === "search" && !field.disabled; }) &&
      !fields.some(function (field) { return field.type === "file" || (isSensitive(field) && !(field.type === "hidden" && /^(pagesize|page|offset|sort)$/i.test(field.name) && !sensitive.test(field.id))); });
  }
  function validateAction(args) {
    if (!args || ["click", "fill", "select", "check", "scroll"].indexOf(args.action) < 0) throw new Error("Use click, fill, select, check or scroll.");
    var el = node(args.ref);
    if (!visible(el) || el.disabled || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") throw new Error("Target is hidden or disabled.");
    if (isSensitive(el) || el.type === "file") throw new Error("Sensitive inputs and file uploads cannot be acted on.");
    if (args.action === "click") {
      var activation = el.closest('button,input,a,label,[role="button"],[role="link"]') || el;
      var control = activation.control || activation;
      if (control.disabled || control.matches(":disabled") || isSensitive(control) || /^(reset|file|image)$/.test(control.type) || control.type === "submit" && !isSearchSubmit(control) ||
          blockedClick.test(name(activation)) || (activation.href && !/^https?:/.test(activation.href))) {
        throw new Error("Submission, destructive/payment controls and script links are blocked.");
      }
    }
    if (args.action === "fill" && (!el.matches('input,textarea,[contenteditable="true"]') ||
        el.readOnly || /^(button|submit|reset|checkbox|radio|range|color|image)$/.test(el.type))) throw new Error("Target is not an editable text control.");
    if (args.action === "select" && !el.matches("select")) throw new Error("Use select on a native select element.");
    if (args.action === "check" && (!/^(checkbox|radio)$/.test(el.type) || typeof args.checked !== "boolean" || el.type === "radio" && !args.checked)) throw new Error("Use check with a boolean on a checkbox or check a radio.");
    if (/^(fill|select)$/.test(args.action) && (typeof args.value !== "string" || args.value.length > 4000)) throw new Error("value must be a string of at most 4000 characters.");
    if (args.action === "select" && !Array.from(el.options).some(function (opt) { return opt.value === args.value && !opt.disabled && !(opt.parentElement.tagName === "OPTGROUP" && opt.parentElement.disabled); })) throw new Error("Choose an enabled option value.");
    return el;
  }
  async function act(args, preview) {
    await options.authorize();
    var el = validateAction(args);
    var before = describe(el);
    if (preview) return { target: before, action: args.action };
    if (!args.expected || JSON.stringify(args.expected) !== JSON.stringify(before)) throw new Error("Target changed after review. Inspect and review it again.");
    // No await between the final validation and the DOM operation.
    if (options.ownField && args.action !== "scroll" && el.matches('input,textarea,select,[contenteditable="true"]')) {
      options.ownField(el, args.action === "check" ? args.checked ? "Yes" : "No" : args.value);
    }
    if (args.action === "click") el.click();
    else if (args.action === "scroll") el.scrollIntoView({ block: "center", behavior: "instant" });
    else if (args.action === "check") { if (el.checked !== args.checked) el.click(); }
    else {
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") el.textContent = args.value;
      else {
        var proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, args.value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
    await new Promise(function (resolve) { setTimeout(resolve, 150); });
    var after = el.isConnected ? describe(el) : null;
    var retained = args.action === "fill" || args.action === "select" ? !!after &&
      (el.isContentEditable || el.getAttribute("contenteditable") === "true" ? el.textContent : el.value) === args.value : args.action === "check" ? !!after && el.checked === args.checked : null;
    return { action: args.action, dispatched: true, retained: retained, target: after,
      note: retained === null ? "Event dispatched; inspect to verify the requested effect." : retained ? "Value read back." : "Value not retained or target replaced; inspect again." };
  }
  return {
    run: async function (tool, args) {
      args = args || {};
      if (args.documentId && args.documentId !== documentId) throw new Error("The document changed. Start a new page inspection.");
      if (args.url && args.url !== location.href) throw new Error("The page URL changed. Start a new page inspection.");
      var result;
      if (tool === "find_elements") result = find(args);
      else if (tool === "read_page_code") result = await read(args);
      else if (tool === "page_action") result = await act(args, false);
      else if (tool === "preview_action") result = await act(args, true);
      else throw new Error("Unknown page tool.");
      return Object.assign({ ok: true, documentId: documentId, url: location.href }, result);
    }
  };
}

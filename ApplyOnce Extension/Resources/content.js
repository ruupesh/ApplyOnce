/*
Job Application Autofill — content script.

On every page: scans standard form fields, matches each one to a saved
profile key by its label (via storage.js's alias matching), fills matches,
and listens for user edits so both corrections to matched fields and
brand-new unmapped fields get saved back into the profile automatically.

Safety: fields whose label looks like a password, government ID, or payment
detail are never read, filled, or saved — see SENSITIVE_LABEL_RE below.
*/

(function () {
  var FILLED_MARK = "data-jaa-filled-value";
  var SENSITIVE_LABEL_RE =
    /(password|passwd|\bssn\b|social security|passport number|driver'?s?\s*licen[cs]e|credit card|card number|\bcvv\b|\bcvc\b|security code|routing number|bank account|account number|pin code|pin number)/i;
  // Text custom-widget buttons show before anything is chosen — never a real answer.
  var PLACEHOLDER_TEXT_RE = /^(select one|select\.\.\.|select an? option|choose one|choose\.\.\.|please select|search|\d+\s*items?\s*selected|0\s*items?\s*selected)$/i;

  var state = null;
  var enabled = true; // "is ApplyOnce allowed to act on this host right now?"
  var scanningStarted = false;
  var scanTimer = null;
  var badgeEl = null;
  var badgeTimer = null;
  var saveQueue = Promise.resolve();
  var customFillQueue = Promise.resolve();
  var oracleFillQueue = Promise.resolve();
  var automatedContainer = null;
  // Page-only edits belong to the reviewed task, even after React replaces
  // their input nodes. Passive profile autofill must not overwrite them.
  var agentOwnedFields = new Set();
  var agentWriteActive = false;
  var pendingDateFills = new Set();
  var agentActionsAllowed = false;
  var agentPassiveWrite = false;
  var pageTools = jaaCreatePageTools({
    authorize: requireAgentActions,
    ownField: function (el, value) {
      var label = getElementLabelAliases(el)[0];
      if (el.type === "radio") {
        var group = getRadioGroups().find(function (radios) { return radios.indexOf(el) !== -1; });
        if (group) label = getGroupLabel(group);
      }
      agentOwnedFields.add(getAgentFieldRef(el, label));
      el.setAttribute(FILLED_MARK, String(value || ""));
    }
  });

  init();

  async function init() {
    state = await getState();
    enabled = jaaShouldRunOnHost(state, location.hostname);

    if (enabled) startScanning();

    jaaBrowser.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.jaaPageActionsAllowed) agentActionsAllowed = changes.jaaPageActionsAllowed.newValue === true;
      if (area === "local" && changes[JAA_STORAGE_KEY]) {
        var wasEnabled = enabled;
        state = changes[JAA_STORAGE_KEY].newValue || jaaDefaultState();
        enabled = jaaShouldRunOnHost(state, location.hostname);
        // Site was just allowed (blocklist edit, mode switch, master toggle) —
        // start filling now instead of waiting for the next page load.
        if (enabled && !wasEnabled) {
          startScanning();
          scanAndFill(true);
        }
      }
    });

    jaaBrowser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return false;
      // Only extension pages may invoke the assistant interface. Content
      // scripts have sender.tab; no webpage postMessage bridge is installed.
      if (/^JAA_AGENT_/.test(msg.type) && (sender.tab || sender.id && sender.id !== jaaBrowser.runtime.id)) {
        sendResponse({ ok: false, error: "Agent requests must originate in the extension." });
        return false;
      }
      if (msg.type === "JAA_AGENT_PAGE_TOOL") {
        runPageTool(msg.tool, msg.args).then(sendResponse).catch(function (error) {
          if (typeof jaaDiagnostics !== 'undefined') jaaDiagnostics.log('page_tool_error', { tool: msg.tool, code: error.code || 'TOOL_ERROR' });
          sendResponse({ ok: false, error: String(error.message || error), code: error.code || 'TOOL_ERROR' });
        });
        return true;
      }
      if (msg.type === "JAA_RESCAN") {
        if (enabled) {
          startScanning();
          scanAndFill(true);
        }
        sendResponse({ ok: enabled });
      } else if (msg.type === "JAA_GET_PAGE_SUMMARY") {
        sendResponse(getPageSummary());
      } else if (msg.type === "JAA_GET_APPLICATION_CONTEXT") {
        // Tracking is deliberately independent of the per-site on/off switch:
        // blocking a site stops autofill, it shouldn't stop you logging that
        // you applied there.
        sendResponse(getApplicationContext());
      } else if (msg.type === "JAA_GET_PAGE_TEXT") {
        sendResponse(getReadablePageText());
      } else if (msg.type === "JAA_PAGE_IMAGE_STATE") {
        var scrolling = document.scrollingElement || document.documentElement;
        if (typeof msg.y === "number") window.scrollTo({ top: msg.y, behavior: "instant" });
        setTimeout(function () {
          sendResponse({ y: window.scrollY, height: scrolling.scrollHeight, viewport: window.innerHeight });
        }, typeof msg.y === "number" ? 180 : 0);
        return true;
      } else if (msg.type === "JAA_AGENT_INSPECT_FORM") {
        sendResponse(getAgentFormSnapshot());
      } else if (msg.type === "JAA_AGENT_FILL_FORM") {
        agentFillForm().then(sendResponse).catch(function (error) {
          sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
        return true;
      } else if (msg.type === "JAA_AGENT_SET_FIELDS") {
        agentSetFields(msg.fields, msg.scoped === true).then(sendResponse).catch(function (error) {
          sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
        return true;
      } else if (msg.type === "JAA_AGENT_GET_VALIDATION") {
        sendResponse(getAgentValidation());
      } else if (msg.type === "JAA_AGENT_CLICK_ELEMENT") {
        agentClickElement(msg).then(sendResponse).catch(function (error) {
          sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
        return true;
      } else if (msg.type === "JAA_AGENT_SCROLL_TO") {
        requireAgentActions().then(function () { return agentScrollTo(msg); }).then(sendResponse).catch(function (error) {
          sendResponse({ ok: false, error: String(error.message || error) });
        });
        return true;
      }
      return false; // always responded synchronously above
    });
  }

  async function requireAgentActions() {
    var current = await getState();
    if (!jaaShouldRunOnHost(current, location.hostname)) {
      var reason = current.enabled === false ? 'ApplyOnce is switched off for all websites.' :
        current.siteMode === 'allowlist' ? 'This site is missing from your allowed websites list.' : 'This site is in your blocked websites list.';
      var error = new Error("ApplyOnce actions are disabled for this website. " + reason);
      error.code = 'SITE_ACTIONS_DISABLED';
      throw error;
    }
    await jaaRequirePageActions();
    agentActionsAllowed = true;
  }

  function checkAgentActionInProgress() {
    if (agentWriteActive && !agentPassiveWrite && !agentActionsAllowed) throw new Error("Page actions were disabled while editing.");
  }

  async function runPageTool(tool, args) {
    if (tool !== "page_action") return pageTools.run(tool, args);
    if (agentWriteActive) throw new Error("A page edit is already running.");
    agentWriteActive = true;
    try { return await pageTools.run(tool, args); }
    finally { agentWriteActive = false; }
  }

  // Kick off the first scan and watch the page for later changes. Held back
  // until the site is actually allowed, so blocked sites do no work at all.
  function startScanning() {
    if (scanningStarted) return;
    scanningStarted = true;
    scheduleScan(300);
    var observer = new MutationObserver(function () {
      scheduleScan(600);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanAndFill(false);
    }, delay);
  }

  // ---------- Field discovery ----------

  function isOraclePage() {
    return /(^|\.)fa\.oraclecloud\.com$/i.test(location.hostname);
  }

  function isOracleFieldActive(el) {
    if (!isOraclePage()) return true;
    var rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    if (el.type !== "file") return false;
    var wrapper = el.closest(".file-form-element, .apply-flow-profile-import-awli__button--file-upload");
    if (!wrapper) return false;
    var wrapperRect = wrapper.getBoundingClientRect();
    return wrapperRect.width > 0 && wrapperRect.height > 0;
  }

  var ORACLE_FIELD_KEYS = {
    firstname: "first_name",
    middlenames: "middle_name",
    lastname: "family_name",
    country: "country",
    addressline1: "address_line_1",
    addressline2: "address_line_2",
    postalcode: "postal_code",
    city: "city",
    region2: "state",
    preferredlocations: "location",
    employername: "company",
    employercity: "city",
    achievements: "role_description",
    contentitemid: "degree",
    educationalestablishment: "school_or_university",
    areaofstudy: "field_of_study"
  };

  function findOracleNativeKey(st, el, labelAliases) {
    var stableName = normalizeLabel(el.name || el.id || "").replace(/\s+/g, "");
    var canonicalKey = ORACLE_FIELD_KEYS[stableName];
    if (/^country-codes-dropdown/i.test(el.id || "")) canonicalKey = "country_phone_code";
    if (el.type === "tel" && /phone number/i.test(el.getAttribute("aria-label") || "")) {
      canonicalKey = "phone_number";
    }
    if (canonicalKey && st.fields && st.fields[canonicalKey]) return canonicalKey;
    return findMatchingKeyForAliases(st, labelAliases);
  }

  function findOracleFileKey(st, labelAliases) {
    var labelText = labelAliases.map(normalizeLabel).join(" ");
    if (!/(^| )(resume|cv)( |$)/.test(labelText)) return null;
    return (
      Object.keys((st && st.fields) || {}).find(function (key) {
        var field = st.fields[key];
        if (field.type !== "file") return false;
        if (field.fileRole === "resume") return true;
        var names = [key].concat(field.aliases || []).map(normalizeLabel).join(" ");
        return /(^| )(resume|cv)( |$)/.test(names);
      }) || null
    );
  }

  function getOracleDerivedNativeValue(st, el) {
    var stableName = normalizeLabel(el.name || "").replace(/\s+/g, "");
    if (stableName !== "fullname") return "";
    var first = st.fields && st.fields.first_name && st.fields.first_name.value;
    var family = st.fields && st.fields.family_name && st.fields.family_name.value;
    return cleanText([first, family].filter(Boolean).join(" "));
  }

  function isFillable(el) {
    if (el.disabled || el.closest && el.closest('[aria-disabled="true"]')) return false;
    if (el.readOnly && !isWorkdayDateSectionInput(el)) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      var t = (el.type || "text").toLowerCase();
      // Deliberately excludes password/hidden/image/submit/button/reset.
      return [
        "text",
        "email",
        "tel",
        "number",
        "url",
        "search",
        "date",
        "datetime-local",
        "month",
        "time",
        "week",
        "color",
        "range",
        "checkbox",
        "radio",
        "file"
      ].indexOf(t) !== -1;
    }
    return false;
  }

  function getFormFields() {
    return Array.prototype.slice
      .call(document.querySelectorAll("input, textarea, select"))
      .filter(isFillable)
      .filter(isOracleFieldActive)
      .filter(function (el) {
        return !isOraclePage() || el.getAttribute("role") !== "combobox";
      })
      .filter(function (el) {
        return !isInsideCustomWidget(el);
      });
  }

  // An element inside a formField-* container whose value never reflects the
  // real answer (e.g. the "Search" box inside a chip/button-based widget) is
  // handled entirely by handleWorkdayContainer instead — counting or
  // listening on it here would just double up on the same logical field.
  function isInsideCustomWidget(el) {
    // Workday hides a real file input inside a button-based attachment
    // wrapper. The browser input remains the authoritative upload control.
    if (el.type === "file") return false;
    var container = el.closest && el.closest('[data-automation-id^="formField-"]');
    return !!container && !isPlainNativeContainer(container);
  }

  function getRadioGroups() {
    var radios = Array.prototype.slice
      .call(document.querySelectorAll('input[type="radio"]'))
      .filter(isFillable)
      .filter(isOracleFieldActive);
    var groups = new Map();
    radios.forEach(function (r) {
      var name = r.name || "unnamed";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    });
    return groups;
  }

  // Workday (and similar design systems) render dropdowns/multiselects as
  // custom widgets, not native <select>/<input>. The selected answer lives
  // in sibling DOM (a "chip" list, or a button's own text) rather than in
  // any element's .value, so the generic input/select handling above never
  // sees it. These wrap every such field in a `data-automation-id="formField-*"`
  // container, which gives us a reliable, reusable hook.
  function getWorkdayFieldContainers() {
    return Array.prototype.slice.call(
      document.querySelectorAll('[data-automation-id^="formField-"]')
    );
  }

  // True once a container's own field (radio/select/plain text input with a
  // real value) is already handled by the generic paths above, so we don't
  // double-process it here.
  function isPlainNativeContainer(container) {
    if (container.querySelector('input[type="file"]')) return true;
    // A date picker's calendar button is an alternative way to edit the
    // same date, not a dropdown answer. Keep its individual segments visible.
    if (container.querySelector('input[data-automation-id="dateSectionMonth-input"], input[data-automation-id="dateSectionDay-input"], input[data-automation-id="dateSectionYear-input"]')) return true;
    if (container.querySelector('[data-automation-id="promptOption"]')) return false;
    if (container.querySelector("button")) return false;
    var input = container.querySelector("input, select, textarea");
    if (!input) return false;
    if (input.tagName === "INPUT" && /^search$/i.test(input.placeholder || "")) return false;
    return true;
  }

  function readWorkdayContainerValue(container) {
    var chips = container.querySelectorAll('[data-automation-id="promptOption"]');
    if (chips.length) {
      return Array.prototype.map
        .call(chips, function (c) {
          return cleanText(c.textContent);
        })
        .filter(Boolean)
        .join(", ");
    }
    var buttons = container.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var t = cleanText(buttons[i].textContent);
      if (t && !PLACEHOLDER_TEXT_RE.test(t)) return t;
    }
    return "";
  }

  // Workday uses at least two markups for a field's question text:
  //   <label>            — My Information fields (Country, Phone Type, ...)
  //   <fieldset><legend> — Application Questions (the per-posting ones)
  // Missing the legend case meant those fields fell through to the
  // automation-id, which for Application Questions is a random per-posting
  // GUID (formField-21e8358308c8100011df2cd1a0360000) — so the same question
  // on the next job posting never matched what was saved from the last one.
  function getContainerLabel(container) {
    var legend = container.querySelector("legend");
    if (legend) {
      var lt = cleanText(legend.textContent);
      if (lt) return lt;
    }
    var label = container.querySelector("label");
    if (label) {
      var t = cleanText(label.textContent);
      if (t) return t;
    }
    var nearby = findNearbyLabel(container);
    if (nearby) return nearby;
    var aid = (container.getAttribute("data-automation-id") || "").replace(/^formField-/, "");
    // A bare hex blob is a per-posting id, not a name — worse than useless as
    // a key, since it would mint a new junk field on every application.
    if (/^[0-9a-f]{16,}$/i.test(aid)) return "";
    return humanize(aid);
  }

  // ---------- Label extraction ----------

  function cleanText(t) {
    if (!t) return "";
    return t.replace(/\s+/g, " ").trim();
  }

  function humanize(raw) {
    return (raw || "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stableTechnicalLabel(raw) {
    var value = cleanText(raw);
    if (!value) return "";
    value = value.replace(/^formField-/, "");
    if (/^[0-9a-f]{16,}$/i.test(value)) return "";
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return "";

    var repeatedParts = value.split(/--+/).filter(Boolean);
    if (
      repeatedParts.length > 1 &&
      repeatedParts.every(function (part) {
        return normalizeLabel(part) === normalizeLabel(repeatedParts[0]);
      })
    ) {
      value = repeatedParts[0];
    }

    value = humanize(value);
    if (/^(field|input|select|search|search box)$/i.test(value)) return "";
    return value;
  }

  function uniqueLabelAliases(primary, technicalValues) {
    var aliases = [];
    function add(value) {
      var text = cleanText(value);
      if (!text) return;
      var norm = normalizeLabel(text);
      if (!norm) return;
      var exists = aliases.some(function (alias) {
        return normalizeLabel(alias) === norm;
      });
      if (!exists) aliases.push(text);
    }

    add(primary);
    (technicalValues || []).forEach(function (value) {
      add(stableTechnicalLabel(value));
    });
    return aliases;
  }

  function getElementLabelAliases(el) {
    return uniqueLabelAliases(getLabelText(el), [
      el.getAttribute("name"),
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-fkit-id"),
      el.id
    ]);
  }

  function getContainerLabelAliases(container) {
    var input = container.querySelector("input, select, textarea");
    return uniqueLabelAliases(getContainerLabel(container), [
      container.getAttribute("data-automation-id"),
      container.getAttribute("data-fkit-id"),
      input && input.getAttribute("name"),
      input && input.getAttribute("data-automation-id"),
      input && input.id
    ]);
  }

  // Workday repeats generic labels such as "Job Title" and "Month" for every
  // experience row. Give the Assistant a stable, human-readable reference so
  // it can target one row without changing every field with the same label.
  function getAgentFieldRef(control, label) {
    var scope = "";
    var node = control;
    for (var depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      if (node.getAttribute && node.getAttribute("role") === "group") {
        var heading = node.querySelector("h5");
        var headingText = heading ? cleanText(heading.textContent) : "";
        if (/^(?:Work Experience|Education|Certifications|Languages)\s+\d+$/i.test(headingText)) {
          scope = headingText;
          break;
        }
      }
    }

    var detail = String(label || "").replace(/\*+\s*$/, "").trim();
    if (/^(?:Month|Day|Year)$/i.test(detail) && control.closest) {
      var dateContainer = control.closest('[data-automation-id^="formField-"]');
      var dateLabel = dateContainer ? getContainerLabel(dateContainer).replace(/\*+\s*$/, "").trim() : "";
      if (dateLabel && !/^(?:Month|Day|Year)$/i.test(dateLabel)) detail = dateLabel + " " + detail;
    }
    return slugify((scope ? scope + " " : "") + detail);
  }

  function findAgentFieldKey(st, control, label, aliases) {
    var scopedKey = getAgentFieldRef(control, label);
    if (scopedKey && st.fields && st.fields[scopedKey]) return scopedKey;
    return findMatchingKeyForAliases(st, aliases);
  }

  function findMatchingKeyForAliases(st, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var key = findMatchingKey(st, aliases[i]);
      if (key) return key;
    }
    return null;
  }

  function findMatchingFileKeyForAliases(st, aliases) {
    var fileState = { fields: {} };
    Object.keys((st && st.fields) || {}).forEach(function (key) {
      if (st.fields[key].type === "file") fileState.fields[key] = st.fields[key];
    });
    return findMatchingKeyForAliases(fileState, aliases);
  }

  function isLabelLike(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "label") return true;
    var cls = (el.className || "").toString().toLowerCase();
    if (/label/.test(cls)) return true;
    return false;
  }

  function findNearbyLabel(el) {
    var node = el;
    for (var depth = 0; depth < 4 && node; depth++) {
      var parent = node.parentElement;
      if (!parent) break;
      var sib = node.previousElementSibling;
      while (sib) {
        if (isLabelLike(sib) && !sib.querySelector("input, select, textarea")) {
          var t = cleanText(sib.textContent);
          if (t) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = parent;
    }
    return null;
  }

  function getLabelText(el) {
    if (el.labels && el.labels.length) {
      var t = cleanText(el.labels[0].textContent);
      if (t) return t;
    }
    if (el.getAttribute("aria-label")) return cleanText(el.getAttribute("aria-label"));
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = labelledBy
        .split(/\s+/)
        .map(function (id) {
          return document.getElementById(id);
        })
        .filter(Boolean);
      var joined = cleanText(parts.map(function (p) { return p.textContent; }).join(" "));
      if (joined) return joined;
    }
    // Same fieldset/legend case as getContainerLabel — e.g. the "desired
    // annual compensation" textarea has no <label> at all, only a legend.
    var fs = el.closest ? el.closest("fieldset") : null;
    if (fs) {
      var lg = fs.querySelector("legend");
      if (lg) {
        var lgt = cleanText(lg.textContent);
        if (lgt) return lgt;
      }
    }
    if (el.placeholder) return cleanText(el.placeholder);
    var nearby = findNearbyLabel(el);
    if (nearby) return nearby;
    return humanize(el.name || el.getAttribute("data-automation-id") || el.id || "");
  }

  function getGroupLabel(radios) {
    var first = radios[0];
    var node = first;
    for (var depth = 0; depth < 6 && node; depth++) {
      var parent = node.parentElement;
      if (!parent) break;
      var legend = parent.querySelector ? parent.querySelector("legend") : null;
      if (legend) {
        var lt = cleanText(legend.textContent);
        if (lt) return lt;
      }
      var sib = node.previousElementSibling;
      while (sib) {
        if (isLabelLike(sib) && !sib.querySelector("input")) {
          var t = cleanText(sib.textContent);
          if (t) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = parent;
    }
    return humanize(radios[0].name);
  }

  // ---------- Value get/set ----------

  function elementType(el) {
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.type === "file") return "file";
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radio";
    if (["date", "datetime-local", "month", "time", "week", "color", "range"].indexOf(el.type) !== -1) {
      return el.type;
    }
    return "text";
  }

  function getElementValue(el) {
    if (el.type === "file") {
      return Array.prototype.map
        .call(el.files || [], function (file) {
          return file.name;
        })
        .join(", ");
    }
    if (el.tagName === "SELECT") {
      if (el.multiple) {
        return Array.prototype.filter
          .call(el.options, function (option) {
            return option.selected;
          })
          .map(function (option) {
            return cleanText(option.textContent);
          })
          .join(", ");
      }
      var opt = el.options[el.selectedIndex];
      if (!opt || opt.value === "") return "";
      var optionText = cleanText(opt.textContent);
      return PLACEHOLDER_TEXT_RE.test(optionText) ? "" : optionText;
    }
    if (el.type === "checkbox") return el.checked ? "Yes" : "No";
    return el.value;
  }

  function setNativeValue(el, value) {
    checkAgentActionInProgress();
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function fireEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function storedFileMatchesAccept(fileRecord, accept) {
    if (!accept) return true;
    var fileName = String(fileRecord.name || "").toLowerCase();
    var mimeType = String(fileRecord.type || "").toLowerCase();
    return accept
      .split(",")
      .map(function (part) {
        return part.trim().toLowerCase();
      })
      .filter(Boolean)
      .some(function (rule) {
        if (rule.charAt(0) === ".") return fileName.endsWith(rule);
        if (rule.endsWith("/*")) return mimeType.indexOf(rule.slice(0, -1)) === 0;
        return mimeType === rule;
      });
  }

  function decodeBase64Bytes(data) {
    var binary = atob(data || "");
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function setFileInputValue(el, fileRecord) {
    if (!fileRecord || !fileRecord.data || !storedFileMatchesAccept(fileRecord, el.accept)) {
      return false;
    }
    var bytes = decodeBase64Bytes(fileRecord.data);
    if (fileRecord.size != null && bytes.length !== fileRecord.size) return false;

    var file = new File([bytes], fileRecord.name, {
      type: fileRecord.type || "application/octet-stream",
      lastModified: fileRecord.lastModified || Date.now()
    });
    var transfer = new DataTransfer();
    transfer.items.add(file);
    el.files = transfer.files;
    el.setAttribute(FILLED_MARK, file.name);
    fireEvents(el);
    return !!(el.files && el.files.length === 1 && el.files[0].name === file.name);
  }

  function fileToStoredRecord(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error("No file selected"));
        return;
      }
      if (file.size > JAA_MAX_STORED_FILE_BYTES) {
        reject(new Error("File exceeds the 20 MB local-storage limit"));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        reject(reader.error || new Error("Could not read the selected file"));
      };
      reader.onload = function () {
        var result = String(reader.result || "");
        resolve({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          lastModified: file.lastModified || Date.now(),
          data: result.slice(result.indexOf(",") + 1),
          storedAt: Date.now()
        });
      };
      reader.readAsDataURL(file);
    });
  }

  function handleFileField(el, label, labelAliases, key) {
    if (!key || !state.fields[key] || el.dataset.jaaFilePending) return false;
    var currentValue = getElementValue(el);
    var filledMark = el.getAttribute(FILLED_MARK);
    if (currentValue && currentValue === filledMark) return false;
    if (currentValue && currentValue !== filledMark) return false;

    el.dataset.jaaFilePending = "1";
    getStoredFile(key)
      .then(function (fileRecord) {
        if (!fileRecord) {
          if (el.dataset.jaaFileFailure !== "missing") {
            el.dataset.jaaFileFailure = "missing";
            logActivity("file-fail", label, "No local file is stored for this field");
          }
          return;
        }
        if (!storedFileMatchesAccept(fileRecord, el.accept)) {
          if (el.dataset.jaaFileFailure !== "accept") {
            el.dataset.jaaFileFailure = "accept";
            logActivity(
              "file-fail",
              label,
              fileRecord.name + " is not accepted by this upload control (" + el.accept + ")"
            );
          }
          return;
        }
        if (!setFileInputValue(el, fileRecord)) {
          throw new Error("The page rejected the reconstructed file");
        }
        delete el.dataset.jaaFileFailure;
        logActivity("filled", label, fileRecord.name);
        showBadge(1);
      })
      .catch(function (error) {
        if (el.dataset.jaaFileFailure !== "error") {
          el.dataset.jaaFileFailure = "error";
          logActivity("file-fail", label, String((error && error.message) || error));
        }
      })
      .finally(function () {
        delete el.dataset.jaaFilePending;
      });
    return false;
  }

  function choiceMatchesValue(choice, value) {
    var wanted = normalizeLabel(value);
    if (!wanted) return false;
    var candidates = [
      choice.textContent,
      choice.value,
      choice.getAttribute && choice.getAttribute("data-value"),
      choice.getAttribute && choice.getAttribute("data-automation-label"),
      choice.getAttribute && choice.getAttribute("aria-label")
    ];
    return candidates.some(function (candidate) {
      return normalizeLabel(candidate) === wanted;
    });
  }

  function radioMatchesValue(radio, value) {
    return (
      normalizeLabel(getLabelText(radio)) === normalizeLabel(value) ||
      choiceMatchesValue(radio, value)
    );
  }

  function isWorkdayDateSectionInput(el) {
    return !!(
      el &&
      el.getAttribute && /^(?:dateSectionMonth|dateSectionDay|dateSectionYear)-input$/.test(el.getAttribute("data-automation-id") || "") &&
      el.parentElement
    );
  }

  // Passive autofill uses the same asynchronous date editor as reviewed
  // actions. Synchronous keyboard bursts lose digits during React updates.
  function setWorkdayDateSectionValue(el, value) {
    var text = String(value == null ? "" : value).trim();
    var ref = getAgentFieldRef(el, getElementLabelAliases(el)[0]);
    if (/^\d+$/.test(el.value) && /^\d+$/.test(text) && Number(el.value) === Number(text)) return false;
    if (!/^\d+$/.test(text) || pendingDateFills.has(ref)) return false;
    pendingDateFills.add(ref);
    customFillQueue = customFillQueue.then(async function () {
      if (agentWriteActive || agentOwnedFields.has(ref)) return;
      var input = getFormFields().find(function (candidate) { return getAgentFieldRef(candidate, getElementLabelAliases(candidate)[0]) === ref; });
      if (!input || input.dataset.jaaUserEdited || input.value && input.value !== input.getAttribute(FILLED_MARK)) return;
      // Keep failed automatic writes from being retried by every mutation
      // scan. A reviewed action can still explicitly retry this field.
      var result = await agentSetFields([{ field: ref, value: text }], true, true);
      if (result.updatedCount) {
        var current = getFormFields().find(function (candidate) { return getAgentFieldRef(candidate, getElementLabelAliases(candidate)[0]) === ref; });
        if (current) current.setAttribute(FILLED_MARK, current.value);
        agentOwnedFields.delete(ref);
      }
    }).catch(function (error) {
      logActivity("replay-fail", ref, String(error.message || error));
    }).finally(function () {
      pendingDateFills.delete(ref);
    });
    return false; // Completion is reported asynchronously by the editor.
  }

  async function setAgentDateSectionValue(el, value) {
    var token = "jaa_date_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    el.setAttribute("data-jaa-date-edit", token);
    try {
      var result = await jaaBrowser.runtime.sendMessage({ type: "JAA_MAIN_SET_DATE_SECTION", token: token, value: String(value), agent: agentWriteActive && !agentPassiveWrite });
      return result || { ok: false, error: "The date editor returned no result. Reload ApplyOnce and the webpage." };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    } finally {
      el.removeAttribute("data-jaa-date-edit");
    }
  }

  function setElementValue(el, value) {
    checkAgentActionInProgress();
    if (el.type === "file") return false;
    if (isWorkdayDateSectionInput(el)) return setWorkdayDateSectionValue(el, value);
    if (el.tagName === "SELECT") {
      if (el.multiple) {
        var requested = Array.isArray(value)
          ? value
          : String(value)
              .split(",")
              .map(function (part) {
                return part.trim();
              })
              .filter(Boolean);
        var options = Array.prototype.slice.call(el.options);
        var allRequestedExist = requested.every(function (requestedValue) {
          return options.some(function (option) {
            return choiceMatchesValue(option, requestedValue);
          });
        });
        if (!allRequestedExist) return false;
        Array.prototype.forEach.call(el.options, function (option) {
          var shouldSelect = requested.some(function (requestedValue) {
            return choiceMatchesValue(option, requestedValue);
          });
          option.selected = shouldSelect;
        });
        fireEvents(el);
        return true;
      }
      var opt = Array.prototype.find.call(el.options, function (o) {
        return choiceMatchesValue(o, value);
      });
      if (!opt) return false;
      el.value = opt.value;
      fireEvents(el);
      return true;
    }
    if (el.type === "checkbox") {
      var want = /^(yes|true|1|on)$/i.test(String(value).trim());
      if (el.checked !== want) el.click();
      return true;
    }
    setNativeValue(el, value);
    fireEvents(el);
    return true;
  }

  // ---------- Autofill pass ----------

  function handleField(el) {
    if (el.type === "radio") return false; // radios are handled as groups
    var labelAliases = getElementLabelAliases(el);
    var label = labelAliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return false;

    var key;
    if (isOraclePage()) {
      key = findOracleNativeKey(state, el, labelAliases);
      if (el.type === "file") {
        key =
          findMatchingFileKeyForAliases(state, labelAliases) ||
          findOracleFileKey(state, labelAliases) ||
          key;
      }
    } else {
      key =
        el.type === "file"
          ? findMatchingFileKeyForAliases(state, labelAliases) ||
            findMatchingKeyForAliases(state, labelAliases)
          : findAgentFieldKey(state, el, label, labelAliases);
    }

    if (!el.dataset.jaaListener) {
      el.dataset.jaaListener = "1";
      var eventName =
        el.tagName === "SELECT" || el.type === "checkbox" || el.type === "file"
          ? "change"
          : "input";
      var debounceT = null;
      el.addEventListener(eventName, function (evt) {
        // A real keystroke, paste, or clear hands ownership of this field to
        // the user. Mark it now (isTrusted rules out our own synthetic fill
        // events) so the next scan won't restore what they just backspaced.
        if (evt && evt.isTrusted && !agentWriteActive) {
          el.dataset.jaaUserEdited = "1";
          agentOwnedFields.delete(getAgentFieldRef(el, label));
        }
        clearTimeout(debounceT);
        debounceT = setTimeout(function () {
          if (isOraclePage()) {
            var currentAliases = getElementLabelAliases(el);
            var currentLabel = currentAliases[0];
            onUserEdit(
              el,
              currentLabel,
              findOracleNativeKey(state, el, currentAliases),
              currentAliases
            );
          } else {
            onUserEdit(el, label, key, labelAliases);
          }
        }, eventName === "input" ? 700 : 0);
      });
      if (el.type !== "file") {
        el.addEventListener("blur", function () {
          if (isOraclePage()) {
            var currentAliases = getElementLabelAliases(el);
            onUserEdit(
              el,
              currentAliases[0],
              findOracleNativeKey(state, el, currentAliases),
              currentAliases
            );
          } else {
            onUserEdit(el, label, key, labelAliases);
          }
        });
      }
    }

    if (el.type === "file") return handleFileField(el, label, labelAliases, key);

    // Once the user has typed into or cleared this field, it's theirs — never
    // autofill it again this page visit. Without this, backspacing an
    // autofilled value just gets it restored on the next scan, and the
    // edit-save never wins the race.
    if (el.dataset.jaaUserEdited || agentOwnedFields.has(getAgentFieldRef(el, label))) return false;

    var filled = false;
    var oracleDerivedValue = isOraclePage() ? getOracleDerivedNativeValue(state, el) : "";
    if ((key && state.fields[key] && state.fields[key].value) || oracleDerivedValue) {
      var wantValue = oracleDerivedValue || state.fields[key].value;
      var currentVal = getElementValue(el);
      var isEmpty = currentVal === "" || currentVal == null;
      var filledMark = el.getAttribute(FILLED_MARK);
      var isUnchangedSinceOurFill = filledMark !== null && String(currentVal) === filledMark;
      var isInitialNativeDefault =
        (el.type === "checkbox" && filledMark === null) ||
        ((el.type === "range" || el.type === "color") &&
          !el.hasAttribute("value") &&
          filledMark === null);
      if (
        (isEmpty || isUnchangedSinceOurFill || isInitialNativeDefault) &&
        String(currentVal) !== String(wantValue)
      ) {
        if (isOraclePage()) el.setAttribute(FILLED_MARK, String(wantValue));
        var ok = setElementValue(el, wantValue);
        if (ok) {
          el.setAttribute(FILLED_MARK, String(wantValue));
          if (isOraclePage() && key) learnFieldAliases(key, label, labelAliases);
          filled = true;
          logActivity("filled", label, wantValue);
        } else if (isOraclePage()) {
          el.removeAttribute(FILLED_MARK);
        }
      }
    }
    return filled;
  }

  function onUserEdit(el, label, matchedKeyAtScanTime, labelAliases) {
    if (SENSITIVE_LABEL_RE.test(label)) return;
    if (agentWriteActive || agentOwnedFields.has(getAgentFieldRef(el, label))) return;
    if (el.type === "file") {
      var selectedFile = el.files && el.files[0];
      if (!selectedFile) return;
      var fileMark = el.getAttribute(FILLED_MARK);
      if (fileMark != null && selectedFile.name === fileMark) return;
      fileToStoredRecord(selectedFile)
        .then(function (fileRecord) {
          saveSelectedFile(matchedKeyAtScanTime, label, labelAliases, fileRecord);
        })
        .catch(function (error) {
          logActivity("file-fail", label, String((error && error.message) || error));
        });
      return;
    }
    var val = getElementValue(el);
    if (val === "" || val == null) return;
    var filledMark = el.getAttribute(FILLED_MARK);
    if (filledMark != null && String(val) === filledMark) return; // our own fill echoing back
    var key = matchedKeyAtScanTime || findMatchingKeyForAliases(state, labelAliases);
    saveFieldValue(key, label, val, elementType(el), null, labelAliases);
  }

  function handleRadioGroup(radios) {
    var groupLabel = getGroupLabel(radios);
    var labelAliases = uniqueLabelAliases(groupLabel, [radios[0].name]);
    if (!groupLabel || SENSITIVE_LABEL_RE.test(groupLabel)) return false;
    var key = findMatchingKeyForAliases(state, labelAliases);
    if (agentOwnedFields.has(getAgentFieldRef(radios[0], groupLabel))) return false;

    radios.forEach(function (r) {
      if (r.dataset.jaaListener) return;
      r.dataset.jaaListener = "1";
      r.addEventListener("change", function () {
        if (!r.checked) return;
        var answer = cleanText(getLabelText(r));
        var freshKey = key || findMatchingKeyForAliases(state, labelAliases);
        saveFieldValue(freshKey, groupLabel, answer, "radio", null, labelAliases);
      });
    });

    var filled = false;
    if (key && state.fields[key] && state.fields[key].value) {
      var want = String(state.fields[key].value).trim().toLowerCase();
      var already = radios.some(function (r) {
        return r.checked && radioMatchesValue(r, want);
      });
      if (!already) {
        var target = radios.find(function (r) {
          return radioMatchesValue(r, want);
        });
        if (target) {
          target.click();
          filled = true;
          logActivity("filled", groupLabel, state.fields[key].value);
        }
      }
    }
    return filled;
  }

  // Best-effort support for non-native "combobox" widgets (Workday-style
  // click-to-open dropdowns). Fragile by nature since markup varies wildly
  // across sites, so this only runs on a manual rescan, never passively.
  function handleCustomComboboxes() {
    var combos = document.querySelectorAll('[role="combobox"], [role="listbox"]');
    combos.forEach(function (combo) {
      try {
        var labelAliases = getElementLabelAliases(combo);
        var label = labelAliases[0];
        if (!label || SENSITIVE_LABEL_RE.test(label)) return;
        var key = findMatchingKeyForAliases(state, labelAliases);
        if (!key || !state.fields[key] || !state.fields[key].value) return;
        var want = state.fields[key].value;
        if (cleanText(combo.textContent).toLowerCase().indexOf(String(want).toLowerCase()) !== -1) return;

        combo.click();
        setTimeout(function () {
          var input = combo.querySelector("input") || document.activeElement;
          if (input && input.tagName === "INPUT") {
            setNativeValue(input, want);
            fireEvents(input);
          }
          setTimeout(function () {
            var options = document.querySelectorAll('[role="option"]');
            var match = Array.prototype.find.call(options, function (o) {
              return choiceMatchesValue(o, want);
            });
            if (match) match.click();
          }, 250);
        }, 150);
      } catch (e) {
        // best-effort only
      }
    });
  }

  // ---------- Oracle Candidate Experience controls ----------

  function getOraclePillRows() {
    if (!isOraclePage()) return [];
    return Array.prototype.filter.call(
      document.querySelectorAll(".input-row--has-picker"),
      function (row) {
        var rect = row.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          row.querySelector("button.cx-select-pill-section")
        );
      }
    );
  }

  function getOracleRowLabelAliases(row) {
    var label = row.querySelector("label, legend");
    var labelText = cleanText(label && label.textContent);
    var qaOwner = row.querySelector("[data-qa]");
    var qa = qaOwner && qaOwner.getAttribute("data-qa");
    var technical = qa && !/^\d+$/.test(qa) ? [qa] : [];
    return uniqueLabelAliases(labelText, technical);
  }

  function findOraclePickerKey(st, labelAliases) {
    var label = normalizeLabel(labelAliases[0]);
    if (label === "title" && st.fields && st.fields.prefix) return "prefix";
    if (/require sponsorship.*employment.*visa/.test(label)) {
      var sponsorshipKey = Object.keys((st && st.fields) || {}).find(function (key) {
        return /require_sponsorship|sponsorship_for_employ/.test(key);
      });
      if (sponsorshipKey) return sponsorshipKey;
    }
    return findMatchingKeyForAliases(st, labelAliases);
  }

  function getOracleSelectedPill(row) {
    return Array.prototype.find.call(
      row.querySelectorAll("button.cx-select-pill-section"),
      function (button) {
        return (
          button.getAttribute("aria-pressed") === "true" ||
          button.classList.contains("cx-select-pill-section--selected")
        );
      }
    );
  }

  function handleOraclePillRow(row) {
    var labelAliases = getOracleRowLabelAliases(row);
    var label = labelAliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return false;

    var key = findOraclePickerKey(state, labelAliases);
    var buttons = Array.prototype.slice.call(
      row.querySelectorAll("button.cx-select-pill-section")
    );

    buttons.forEach(function (button) {
      if (button.dataset.jaaOracleListener) return;
      button.dataset.jaaOracleListener = "1";
      button.addEventListener("click", function () {
        if (row.dataset.jaaOracleAutomated) return;
        setTimeout(function () {
          var currentAliases = getOracleRowLabelAliases(row);
          var selected = getOracleSelectedPill(row);
          if (!selected || !currentAliases[0]) return;
          var freshKey = findOraclePickerKey(state, currentAliases);
          saveFieldValue(
            freshKey,
            currentAliases[0],
            cleanText(selected.textContent),
            "custom-widget",
            null,
            currentAliases
          );
        }, 50);
      });
    });

    var selected = getOracleSelectedPill(row);
    if (selected) {
      var currentValue = cleanText(selected.textContent);
      if (row.dataset.jaaOracleLastValue !== currentValue) {
        row.dataset.jaaOracleLastValue = currentValue;
        if (key) {
          learnFieldAliases(key, label, labelAliases);
        } else {
          saveFieldValue(null, label, currentValue, "custom-widget", null, labelAliases);
        }
      }
      return false;
    }

    if (!key || !state.fields[key] || !state.fields[key].value) return false;
    var wanted = state.fields[key].value;
    var target = buttons.find(function (button) {
      return normalizeLabel(button.textContent) === normalizeLabel(wanted);
    });
    if (!target) return false;
    row.dataset.jaaOracleAutomated = "1";
    target.click();
    setTimeout(function () {
      delete row.dataset.jaaOracleAutomated;
    }, 100);
    row.dataset.jaaOracleLastValue = cleanText(target.textContent);
    learnFieldAliases(key, label, labelAliases);
    logActivity("filled", label, wanted);
    return true;
  }

  function getOracleComboboxes() {
    if (!isOraclePage()) return [];
    return Array.prototype.filter.call(
      document.querySelectorAll('input[role="combobox"][aria-controls]'),
      function (input) {
        return isOracleFieldActive(input) && !isOracleMultiSelect(input);
      }
    );
  }

  function isOracleMultiSelect(input) {
    return !!(
      input &&
      (input.classList.contains("cx-multi-select-input") ||
        input.closest(".cx-multi-select"))
    );
  }

  function getOracleMultiSelects() {
    if (!isOraclePage()) return [];
    return Array.prototype.filter.call(
      document.querySelectorAll('input[role="combobox"][aria-controls]'),
      function (input) {
        return isOracleFieldActive(input) && isOracleMultiSelect(input);
      }
    );
  }

  function getOracleMultiLabelAliases(input) {
    var label = getLabelText(input);
    var technical = /^\d+$/.test(input.name || "") ? [] : [input.name];
    return uniqueLabelAliases(label, technical);
  }

  function getOracleMultiSelectedValues(input) {
    var row = input.closest(".input-row");
    var values = [];
    Array.prototype.forEach.call(
      row ? row.querySelectorAll(".cx-multi-select-pill__value-text") : [],
      function (pill) {
        var value = cleanText(pill.textContent);
        if (
          value &&
          !values.some(function (saved) {
            return normalizeLabel(saved) === normalizeLabel(value);
          })
        ) {
          values.push(value);
        }
      }
    );
    return values;
  }

  function getOracleMultiLimit(label) {
    var match = String(label || "").match(
      /(?:top|choose(?:\s+your)?|select(?:\s+up\s+to)?)\s*(\d+)/i
    );
    return match ? Number(match[1]) : Infinity;
  }

  function oracleProgrammingLanguageKey(value) {
    var text = String(value || "").toLowerCase();
    if (text.indexOf("c++") !== -1) return "cpp";
    if (text.indexOf(".net") !== -1) return "dotnet";
    if (text.indexOf("pl/sql") !== -1) return "plsql";
    if (/\bjava\b/.test(text)) return "java";
    if (/\bpython\b/.test(text)) return "python";
    if (/structured query language|\bsql\b/.test(text)) return "sql";
    if (/\bcobol\b/.test(text)) return "cobol";
    if (/\bmatlab\b/.test(text)) return "matlab";
    if (/\bscala\b/.test(text)) return "scala";
    if (/\bsas\b/.test(text)) return "sas";
    if (/visual basic/.test(text)) return "visualbasic";
    if (/^\s*r\s*$/i.test(value || "")) return "r";
    return "";
  }

  function oracleMultiOptionMatches(label, optionText, wanted) {
    if (normalizeLabel(optionText) === normalizeLabel(wanted)) return true;
    if (/programming languages/i.test(label || "")) {
      var optionKey = oracleProgrammingLanguageKey(optionText);
      return !!optionKey && optionKey === oracleProgrammingLanguageKey(wanted);
    }
    return false;
  }

  function parseOracleMultiValues(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value || "")
      .split(",")
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);
  }

  function deriveOracleMultiValues(label, options, limit) {
    if (!/programming languages/i.test(label || "")) return [];
    var skillsField = state.fields && state.fields.type_to_add_skills;
    var skills = parseOracleMultiValues(skillsField && skillsField.value);
    var values = [];
    skills.forEach(function (skill) {
      if (values.length >= limit) return;
      var match = options.find(function (option) {
        return oracleMultiOptionMatches(label, cleanText(option.textContent), skill);
      });
      var text = cleanText(match && match.textContent);
      if (
        text &&
        !values.some(function (saved) {
          return normalizeLabel(saved) === normalizeLabel(text);
        })
      ) {
        values.push(text);
      }
    });
    return values;
  }

  function saveOracleMultiValue(input) {
    var aliases = getOracleMultiLabelAliases(input);
    var label = aliases[0];
    var values = getOracleMultiSelectedValues(input);
    if (!label || !values.length) return;
    input.dataset.jaaOracleMultiLastValue = values.map(normalizeLabel).join("|");
    var key = findMatchingKeyForAliases(state, aliases);
    saveFieldValue(key, label, values.join(", "), "custom-widget", null, aliases);
  }

  function attachOracleMultiListener(input) {
    var row = input.closest(".input-row");
    if (!row || row.dataset.jaaOracleMultiListener) return;
    row.dataset.jaaOracleMultiListener = "1";
    row.addEventListener("click", function (event) {
      if (input.dataset.jaaOracleMultiAutomated) return;
      var changed = event.target.closest(
        '[role="option"], .cx-multi-select-pill__value-remove'
      );
      if (!changed) return;
      input.dataset.jaaOracleMultiManualPending = "1";
      setTimeout(function () {
        saveOracleMultiValue(input);
        delete input.dataset.jaaOracleMultiManualPending;
      }, 100);
    });
  }

  function queueOracleMultiFill(input, label, aliases, key, limit) {
    if (input.dataset.jaaOracleMultiPending) return false;
    input.dataset.jaaOracleMultiPending = "1";
    oracleFillQueue = oracleFillQueue
      .catch(function () {})
      .then(async function () {
        input.dataset.jaaOracleMultiAutomated = "1";
        if (input.getAttribute("aria-expanded") !== "true") input.click();
        var popup = await oracleWaitFor(function () {
          var target = document.getElementById(input.getAttribute("aria-controls") || "");
          if (!target) return null;
          var rect = target.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? target : null;
        }, 2500);
        if (!popup) {
          logActivity("oracle-fail", label, "Multi-select list did not open");
          return;
        }

        var options = Array.prototype.slice.call(popup.querySelectorAll('[role="option"]'));
        var requested = key
          ? parseOracleMultiValues(state.fields[key].value)
          : deriveOracleMultiValues(label, options, limit);
        var selected = getOracleMultiSelectedValues(input);

        for (var i = 0; i < requested.length && selected.length < limit; i++) {
          var wanted = requested[i];
          if (
            selected.some(function (value) {
              return oracleMultiOptionMatches(label, value, wanted);
            })
          ) {
            continue;
          }
          var option = options.find(function (candidate) {
            return oracleMultiOptionMatches(label, cleanText(candidate.textContent), wanted);
          });
          if (!option || option.getAttribute("aria-selected") === "true") continue;
          option.click();
          await oracleWaitFor(function () {
            var current = getOracleMultiSelectedValues(input);
            return current.length > selected.length ? current : null;
          }, 1500);
          selected = getOracleMultiSelectedValues(input);
        }

        await closeOracleCombobox(input);
        selected = getOracleMultiSelectedValues(input).slice(0, limit);
        if (!selected.length) {
          logActivity("oracle-fail", label, "No exact multi-select options matched");
          return;
        }
        input.dataset.jaaOracleMultiLastValue = selected.map(normalizeLabel).join("|");
        if (key) {
          learnFieldAliases(key, label, aliases);
        } else {
          await saveFieldValue(
            null,
            label,
            selected.join(", "),
            "custom-widget",
            null,
            aliases
          );
        }
        logActivity("filled", label, selected.join(", "));
        showBadge(1);
      })
      .finally(function () {
        delete input.dataset.jaaOracleMultiAutomated;
        delete input.dataset.jaaOracleMultiPending;
      });
    return true;
  }

  function handleOracleMultiSelect(input, force) {
    var aliases = getOracleMultiLabelAliases(input);
    var label = aliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return false;
    attachOracleMultiListener(input);

    var key = findMatchingKeyForAliases(state, aliases);
    var selected = getOracleMultiSelectedValues(input);
    var limit = getOracleMultiLimit(label);
    if (input.dataset.jaaOracleMultiManualPending) return false;
    if (selected.length >= limit) {
      var signature = selected.map(normalizeLabel).join("|");
      if (input.dataset.jaaOracleMultiLastValue === signature) return false;
      input.dataset.jaaOracleMultiLastValue = signature;
      if (key) {
        learnFieldAliases(key, label, aliases);
      } else {
        saveOracleMultiValue(input);
      }
      return false;
    }

    if (!key && !/programming languages/i.test(label)) {
      if (selected.length) saveOracleMultiValue(input);
      return false;
    }
    var lastAttempt = Number(input.dataset.jaaOracleMultiLastAttempt || 0);
    if (!force && Date.now() - lastAttempt < 10000) return false;
    input.dataset.jaaOracleMultiLastAttempt = String(Date.now());
    return queueOracleMultiFill(input, label, aliases, key, limit);
  }

  function getOracleComboboxLabelAliases(input) {
    if (/^country-codes-dropdown/i.test(input.id || "")) {
      return uniqueLabelAliases("Country Phone Code", ["countryPhoneCode"]);
    }
    return uniqueLabelAliases(getLabelText(input), [input.name]);
  }

  function findOracleComboboxKey(st, input, labelAliases) {
    var canonicalKey = null;
    var stableName = normalizeLabel(input.name || "").replace(/\s+/g, "");
    if (/^country-codes-dropdown/i.test(input.id || "")) {
      canonicalKey = "country_phone_code";
    } else if (stableName === "countrycode") {
      canonicalKey = "country";
    } else if (stableName === "startdate") {
      canonicalKey = "start_date";
    } else if (stableName === "enddate") {
      canonicalKey = "end_date";
    } else {
      canonicalKey = ORACLE_FIELD_KEYS[stableName];
    }
    if (canonicalKey && st.fields && st.fields[canonicalKey]) return canonicalKey;
    return findMatchingKeyForAliases(st, labelAliases);
  }

  function oracleDateParts(value) {
    var text = String(value || "").trim();
    var match = text.match(/^(\d{4})[-/](\d{1,2})/) || text.match(/^(\d{1,2})[-/](\d{4})/);
    if (!match) return null;
    var year = match[1].length === 4 ? match[1] : match[2];
    var month = match[1].length === 4 ? match[2] : match[1];
    var monthNumber = Number(month);
    if (monthNumber < 1 || monthNumber > 12) return null;
    return { year: year, month: monthNumber };
  }

  function oracleComboboxWantedValue(input, storedValue) {
    if (input.name === "contentItemId" && /^(b s|bs)$/i.test(normalizeLabel(storedValue))) {
      return "Bachelor's Degree";
    }
    var parts = oracleDateParts(storedValue);
    if (/^month-/.test(input.id || "") && parts) {
      return [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
      ][parts.month - 1];
    }
    if (/^year-/.test(input.id || "") && parts) return parts.year;
    return storedValue;
  }

  function oracleOptionMatches(input, optionText, wanted) {
    if (normalizeLabel(optionText) === normalizeLabel(wanted)) return true;
    if (/^country-codes-dropdown/i.test(input.id || "")) {
      var optionCode = String(optionText).match(/\+\d+/);
      var wantedCode = String(wanted).match(/\+\d+/);
      return !!(optionCode && wantedCode && optionCode[0] === wantedCode[0]);
    }
    return false;
  }

  function getOracleDateValue(input) {
    var name = input.name;
    if (name !== "startDate" && name !== "endDate") return null;
    var activeInputs = getOracleComboboxes().filter(function (candidate) {
      return candidate.name === name;
    });
    var monthInput = activeInputs.find(function (candidate) {
      return /^month-/.test(candidate.id || "");
    });
    var yearInput = activeInputs.find(function (candidate) {
      return /^year-/.test(candidate.id || "");
    });
    if (!monthInput || !yearInput || !monthInput.value || !yearInput.value) return null;
    var monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december"
    ];
    var monthIndex = monthNames.indexOf(normalizeLabel(monthInput.value));
    if (monthIndex === -1) return null;
    return String(monthIndex + 1).padStart(2, "0") + "/" + yearInput.value;
  }

  function saveOracleComboboxValue(input) {
    var labelAliases = getOracleComboboxLabelAliases(input);
    var label = labelAliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return;
    var key = findOracleComboboxKey(state, input, labelAliases);
    var value = getOracleDateValue(input) || cleanText(input.value);
    if (!value) return;
    saveFieldValue(key, label, value, "custom-widget", null, labelAliases);
  }

  function oracleWaitFor(getter, timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + timeoutMs;
      (function poll() {
        var value = getter();
        if (value) {
          resolve(value);
        } else if (Date.now() < deadline) {
          setTimeout(poll, 100);
        } else {
          resolve(null);
        }
      })();
    });
  }

  function oraclePointerClick(el) {
    var rect = el.getBoundingClientRect();
    var options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", options));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", options));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", options));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", options));
    el.dispatchEvent(new MouseEvent("click", options));
  }

  async function closeOracleCombobox(input) {
    ["keydown", "keyup"].forEach(function (eventName) {
      input.dispatchEvent(
        new KeyboardEvent(eventName, { key: "Escape", code: "Escape", bubbles: true })
      );
    });
    await new Promise(function (resolve) {
      setTimeout(resolve, 100);
    });
    if (input.getAttribute("aria-expanded") === "true") {
      var container = input.closest(".input-field-container");
      var arrow = container && container.querySelector("button.icon-dropdown-arrow");
      if (arrow) {
        oraclePointerClick(arrow);
      } else {
        input.click();
      }
    }
  }

  function queueOracleComboboxFill(input, label, wanted) {
    if (input.dataset.jaaOraclePending) return false;
    input.dataset.jaaOraclePending = "1";
    oracleFillQueue = oracleFillQueue
      .catch(function () {})
      .then(async function () {
        var originalValue = input.value;
        input.click();
        var popup = await oracleWaitFor(function () {
          var target = document.getElementById(input.getAttribute("aria-controls") || "");
          if (!target) return null;
          var rect = target.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? target : null;
        }, 2500);
        if (!popup) {
          logActivity("oracle-fail", label, "Option grid did not open");
          return;
        }
        function findExactOption() {
          return Array.prototype.find.call(
            popup.querySelectorAll('[role="gridcell"], [role="option"]'),
            function (candidate) {
              return oracleOptionMatches(input, cleanText(candidate.textContent), wanted);
            }
          );
        }
        var option = findExactOption();
        if (!option) {
          setNativeValue(input, wanted);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          option = await oracleWaitFor(function () {
            popup = document.getElementById(input.getAttribute("aria-controls") || "") || popup;
            return findExactOption();
          }, 2500);
          if (!option) {
            await new Promise(function (resolve) {
              setTimeout(resolve, 100);
            });
          }
        }
        if (!option) {
          setNativeValue(input, originalValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await closeOracleCombobox(input);
          logActivity("oracle-fail", label, 'No exact option matched "' + wanted + '"');
          return;
        }
        option.click();
        var selected = await oracleWaitFor(function () {
          return input.value && oracleOptionMatches(input, input.value, wanted) ? input.value : null;
        }, 2500);
        if (selected) {
          input.dataset.jaaOracleLastValue = selected;
          var currentAliases = getOracleComboboxLabelAliases(input);
          var currentKey = findOracleComboboxKey(state, input, currentAliases);
          if (currentKey) learnFieldAliases(currentKey, currentAliases[0], currentAliases);
          logActivity("filled", label, selected);
          showBadge(1);
        } else {
          await closeOracleCombobox(input);
          logActivity("oracle-fail", label, 'Clicked "' + wanted + '" but no value registered');
        }
      })
      .finally(function () {
        delete input.dataset.jaaOraclePending;
      });
    return true;
  }

  function handleOracleCombobox(input, force) {
    var labelAliases = getOracleComboboxLabelAliases(input);
    var label = labelAliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return false;
    var key = findOracleComboboxKey(state, input, labelAliases);

    if (!input.dataset.jaaOracleComboListener) {
      input.dataset.jaaOracleComboListener = "1";
      input.addEventListener("change", function () {
        if (input.dataset.jaaOraclePending) return;
        setTimeout(function () {
          saveOracleComboboxValue(input);
        }, 50);
      });
    }

    if (input.value) {
      if (input.dataset.jaaOracleLastValue !== input.value) {
        input.dataset.jaaOracleLastValue = input.value;
        if (key) {
          learnFieldAliases(key, label, labelAliases);
        } else {
          saveOracleComboboxValue(input);
        }
      }
      return false;
    }
    if (!key || !state.fields[key] || !state.fields[key].value) return false;
    var lastAttempt = Number(input.dataset.jaaOracleLastAttempt || 0);
    if (!force && Date.now() - lastAttempt < 10000) return false;
    input.dataset.jaaOracleLastAttempt = String(Date.now());
    var wanted = oracleComboboxWantedValue(input, state.fields[key].value);
    return queueOracleComboboxFill(input, label, wanted);
  }

  var WORKDAY_LAST_VALUE_MARK = "data-jaa-wd-last-value";
  // A row is a `menuItem`; `promptLeafNode` is its inner clickable child.
  // Matching on both (as an earlier version did) double-counts every row.
  var MENU_ROW_SELECTOR = '[data-automation-id="menuItem"]';

  // ---------- Click-path recording ----------
  //
  // Nested-category widgets (e.g. "How Did You Hear About Us?" -> Social
  // Media -> LinkedIn) have no flat text search, so there is no reliable
  // generic way to guess which top-level category a given leaf answer
  // lives under -- blind heuristics end up clicking the wrong thing
  // entirely. Instead: the first time you pick an answer by hand, every
  // click you make while that dropdown is open gets recorded as a path of
  // menu-item labels. Next time, autofill replays that exact click
  // sequence instead of guessing.

  var recordingSession = null; // { container, label, path: [], startValue }

  function attachRecordingTrigger(container) {
    if (container.dataset.jaaRecTrigger) return;
    var opener = container.querySelector("button, input");
    if (!opener) return;
    container.dataset.jaaRecTrigger = "1";
    opener.addEventListener("mousedown", function () {
      if (automatedContainer === container) return;
      var labelAliases = getContainerLabelAliases(container);
      var label = labelAliases[0];
      if (!label || SENSITIVE_LABEL_RE.test(label)) return;
      recordingSession = {
        container: container,
        label: label,
        labelAliases: labelAliases,
        path: [],
        startValue: readWorkdayContainerValue(container)
      };
    });
  }

  // Polls (rather than guessing a fixed sleep) because Workday's render time
  // for a submenu is unpredictable -- can be near-instant or take a couple
  // of seconds depending on load. Checks every 150ms for up to timeoutMs.
  function waitFor(getter, timeoutMs, callback) {
    var deadline = Date.now() + timeoutMs;
    (function poll() {
      var val = getter();
      if (val) {
        callback(val);
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(poll, 150);
      } else {
        callback(null);
      }
    })();
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // The open dropdown lives in ONE `activeListContainer` (a ReactVirtualized
  // grid), portaled outside the field's own container. Scoping to it matters:
  // a document-wide search also picks up rows belonging to *other* widgets
  // on the page (e.g. the phone-code list), which is how earlier versions
  // ended up clicking the wrong option entirely.
  function getActiveGrid() {
    var grids = document.querySelectorAll('[data-automation-id="activeListContainer"]');
    for (var i = 0; i < grids.length; i++) {
      var r = grids[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return grids[i];
    }
    return null;
  }

  // Verified against Workday: a bare .click() on a row does nothing, and even
  // a full event sequence on the `menuItem` wrapper does nothing. The handler
  // lives on the inner `promptLeafNode`, and it wants a real pointer/mouse
  // sequence rather than a synthetic click alone.
  function realClick(el) {
    checkAgentActionInProgress();
    var r = el.getBoundingClientRect();
    var o = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", o));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", o));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", o));
    } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
  }

  function clickMenuRow(row) {
    realClick(row.querySelector('[data-automation-id="promptLeafNode"]') || row);
  }

  // Workday ships (at least) two popup flavours:
  //   A. virtualized  — `activeListContainer` grid of `menuItem` rows, used by
  //      the big taxonomy pickers. Only the rows in view exist in the DOM, so
  //      anything below the fold must be scrolled to before it can be found.
  //   B. plain listbox — `[role="listbox"]` of `<li role="option">`, used by
  //      the short Application Questions dropdowns. Not virtualized.
  // Handle both, preferring whichever is actually on screen.
  function getOpenListbox() {
    var boxes = document.querySelectorAll('[role="listbox"]');
    for (var i = 0; i < boxes.length; i++) {
      var r = boxes[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // Selected-value chip lists live inside the field and are always
      // visible; the actual option popup is portaled outside it.
      if (boxes[i].closest('[data-automation-id^="formField-"]')) continue;
      if (/items? selected/i.test(boxes[i].getAttribute("aria-label") || "")) continue;
      return boxes[i];
    }
    return null;
  }

  function getOpenMenu() {
    return getActiveGrid() || getOpenListbox();
  }

  async function waitForAsync(getter, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      var value = getter();
      if (value) return value;
      await sleep(120);
    }
    return null;
  }

  function menuRowHasChildren(row) {
    var leaf = row.querySelector('[data-automation-id="promptLeafNode"]');
    return !!(
      (leaf && leaf.getAttribute("data-uxi-multiselectlistitem-hassidecharm") === "true") ||
      row.getAttribute("aria-haspopup") === "true" ||
      row.querySelector('.wd-icon-chevron-right-small')
    );
  }

  function describeMenuRow(row) {
    return {
      text: cleanText(row.textContent),
      hasChildren: menuRowHasChildren(row)
    };
  }

  async function collectMenuRowsByScroll(timeoutMs) {
    var menu = await waitForAsync(getOpenMenu, timeoutMs || 3000);
    if (!menu) return [];

    if (menu.getAttribute("data-automation-id") !== "activeListContainer") {
      return Array.prototype.map.call(menu.querySelectorAll('[role="option"]'), describeMenuRow);
    }

    var found = {};
    function collectVisibleRows() {
      Array.prototype.forEach.call(menu.querySelectorAll(MENU_ROW_SELECTOR), function (row) {
        var item = describeMenuRow(row);
        if (item.text) found[normalizeLabel(item.text)] = item;
      });
    }

    menu.scrollTop = 0;
    menu.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(180);
    collectVisibleRows();

    var step = Math.max(80, (menu.clientHeight || 100) - 40);
    for (var pos = step; pos <= menu.scrollHeight + step; pos += step) {
      menu.scrollTop = pos;
      menu.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(180);
      collectVisibleRows();
      if (menu.scrollTop >= menu.scrollHeight - menu.clientHeight - 1) break;
    }
    return Object.keys(found).map(function (key) {
      return found[key];
    });
  }

  async function closeOpenWorkdayMenu(container) {
    if (!getOpenMenu()) return;
    var dismissTarget = container.querySelector("label") || container;
    realClick(dismissTarget);
    await waitForAsync(function () {
      return getOpenMenu() ? null : true;
    }, 1500);
  }

  async function openWorkdayMenuAtPath(container, path) {
    await closeOpenWorkdayMenu(container);
    openWorkdayWidget(container);
    if (!(await waitForAsync(getOpenMenu, 3000))) return false;

    for (var i = 0; i < path.length; i++) {
      var row = await findMenuRowByScroll(path[i], 3000);
      if (!row || !menuRowHasChildren(row)) return false;
      clickMenuRow(row);
      await sleep(450);
    }
    return !!getOpenMenu();
  }

  function queueCustomFill(container, task, force) {
    if (container.dataset.jaaFillPending) return false;
    var lastAttempt = Number(container.dataset.jaaLastFillAttempt || 0);
    if (!force && Date.now() - lastAttempt < 10000) return false;
    container.dataset.jaaFillPending = "1";
    container.dataset.jaaLastFillAttempt = String(Date.now());
    customFillQueue = customFillQueue
      .catch(function () {})
      .then(async function () {
        automatedContainer = container;
        recordingSession = null;
        try {
          await task();
        } finally {
          automatedContainer = null;
          delete container.dataset.jaaFillPending;
        }
      });
    return true;
  }

  async function findMenuRowByScroll(text, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 3000);
    var wanted = String(text).toLowerCase();

    var grid = null;
    var listbox = null;
    while (Date.now() < deadline) {
      grid = getActiveGrid();
      listbox = grid ? null : getOpenListbox();
      if (grid || listbox) break;
      await sleep(150);
    }

    // Flavour B: everything is already in the DOM, just match it.
    if (!grid && listbox) {
      return (
        Array.prototype.find.call(listbox.querySelectorAll('[role="option"]'), function (el) {
          return cleanText(el.textContent).toLowerCase() === wanted;
        }) || null
      );
    }
    if (!grid) return null;

    // Flavour A: scroll until the row renders in.
    function scan() {
      return (
        Array.prototype.find.call(grid.querySelectorAll(MENU_ROW_SELECTOR), function (el) {
          return cleanText(el.textContent).toLowerCase() === wanted;
        }) || null
      );
    }

    var hit = scan();
    if (hit) return hit;

    var step = Math.max(80, (grid.clientHeight || 100) - 40);
    for (var pos = 0; pos <= grid.scrollHeight + step && Date.now() < deadline; pos += step) {
      grid.scrollTop = pos;
      grid.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(180);
      hit = scan();
      if (hit) return hit;
      if (grid.scrollTop >= grid.scrollHeight - grid.clientHeight - 1 && pos > 0) break;
    }
    return null;
  }

  function openWorkdayWidget(container) {
    var opener = container.querySelector("button, input") || container;
    opener.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opener.click();
    if (opener.focus) opener.focus();
  }

  function isWorkdayMultiSelectContainer(container, label) {
    return !!(
      container.querySelector(
        '[data-automation-id="multiSelectContainer"], [data-automation-id="multiSelectInputContainer"], [role="listbox"][aria-label*="selected"]'
      ) || /skills/i.test(String(label || ""))
    );
  }

  function workdaySelectedValueMatches(current, wanted) {
    var currentLabel = normalizeLabel(current);
    var wantedLabel = normalizeLabel(wanted);
    var parentheticalAliases = String(current || "").match(/\(([^)]+)\)/g) || [];
    return !!(
      wantedLabel &&
      (currentLabel === wantedLabel ||
        (currentLabel.indexOf(wantedLabel) === 0 && currentLabel.length <= wantedLabel.length + 40) ||
        parentheticalAliases.some(function (part) {
          return normalizeLabel(part.slice(1, -1)) === wantedLabel;
        }))
    );
  }

  document.addEventListener(
    "click",
    function (e) {
      if (!recordingSession || automatedContainer) return;
      var menuItem = e.target.closest ? e.target.closest(MENU_ROW_SELECTOR) : null;
      if (!menuItem) return;
      var text = cleanText(menuItem.textContent);
      if (!text) return;
      var session = recordingSession;
      session.path.push(text);
      waitFor(
        function () {
          var newValue = readWorkdayContainerValue(session.container);
          return newValue && newValue !== session.startValue ? newValue : null;
        },
        3000,
        function (newValue) {
          if (recordingSession !== session) return; // superseded by a newer session
          if (newValue) {
            recordingSession = null;
            var key = findAgentFieldKey(state, session.container, session.label, session.labelAliases);
            saveFieldValue(
              key,
              session.label,
              newValue,
              "custom-widget",
              session.path.slice(),
              session.labelAliases
            );
          }
          // otherwise this was a navigation click into a submenu -- keep recording
        }
      );
    },
    true
  );

  async function replayRecordedPath(container, path, want) {
    var label = getContainerLabel(container);
    logActivity("replay-attempt", label, path.join(" → "));
    await closeOpenWorkdayMenu(container);
    openWorkdayWidget(container);

    for (var i = 0; i < path.length; i++) {
      var stepText = path[i];
      var row = await findMenuRowByScroll(stepText, 3000);
      if (!row) {
        logActivity(
          "replay-fail",
          label,
          'stuck at step ' + (i + 1) + "/" + path.length + ' ("' + stepText + '") — path so far: ' + path.slice(0, i).join(" → ")
        );
        return false;
      }
      clickMenuRow(row);
      await sleep(450);
    }

    // Confirm it actually landed, rather than reporting success just because
    // the clicks were dispatched.
    var finalValue = "";
    for (var t = 0; t < 12 && !finalValue; t++) {
      finalValue = readWorkdayContainerValue(container);
      if (!finalValue) await sleep(150);
    }
    if (finalValue && normalizeLabel(finalValue) === normalizeLabel(want)) {
      logActivity("replay-success", label, path.join(" → ") + "  ⇒  " + finalValue);
      return true;
    } else {
      logActivity(
        "replay-fail",
        label,
        "clicked all steps but did not get " + want + ": " + path.join(" → ")
      );
      return false;
    }
  }

  // Safely discovers an unknown nested path by traversing category rows only.
  // Leaf rows are never clicked unless their text exactly matches the value,
  // so exploring cannot accidentally choose a different answer.
  async function discoverAndFillNestedPath(container, key, want, labelAliases) {
    var label = labelAliases[0];
    var wanted = normalizeLabel(want);
    var queue = [[]];
    var seen = {};
    var inspected = 0;
    var maxDepth = 5;
    var maxMenus = 60;

    logActivity("replay-attempt", label, 'discovering path to "' + want + '"');

    // Workday autocomplete and chip controls do not populate their portal
    // until text is entered. execCommand follows the browser's editing path,
    // which Workday observes; a synthetic InputEvent alone leaves Skills at
    // "No Items." Fall back to the native setter elsewhere. The school picker
    // additionally requires Enter per its own guidance.
    var searchInput = container.querySelector('input:not([type]), input[type="text"], input[type="search"]');
    if (searchInput) {
      await closeOpenWorkdayMenu(container);
      realClick(searchInput);
      if (searchInput.focus) searchInput.focus();
      var edited = false;
      try {
        var editToken = "jaa" + Date.now().toString(36) + Math.random().toString(36).slice(2);
        searchInput.setAttribute("data-jaa-main-edit", editToken);
        var mainEdit = await jaaBrowser.runtime.sendMessage({
          type: "JAA_MAIN_REPLACE_TEXT",
          agent: agentWriteActive && !agentPassiveWrite,
          token: editToken,
          value: String(want)
        });
        searchInput.removeAttribute("data-jaa-main-edit");
        edited = !!(mainEdit && mainEdit.ok && searchInput.value === String(want));
      } catch (mainEditError) {
        searchInput.removeAttribute("data-jaa-main-edit");
      }
      if (!edited) {
        try {
          if (searchInput.select) searchInput.select();
          document.execCommand("delete", false);
          edited = document.execCommand("insertText", false, String(want));
        } catch (editingError) {}
      }
      if (!edited || searchInput.value !== String(want)) {
        setNativeValue(searchInput, String(want));
        try {
          searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(want) }));
        } catch (error) {
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      if (/school|university/i.test(label)) {
        await sleep(120);
        ["keydown", "keypress", "keyup"].forEach(function (type) {
          searchInput.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
        });
      }
      await sleep(1200);
      var searchRows = await collectMenuRowsByScroll(3000);
      var searchMatch = searchRows.find(function (row) {
        return workdaySelectedValueMatches(row.text, want);
      });
      if (searchMatch) {
        var searchTarget = await findMenuRowByScroll(searchMatch.text, 3000);
        if (searchTarget) {
          clickMenuRow(searchTarget);
          var searchSelected = await waitForAsync(function () {
            var values = readWorkdayContainerValue(container).split(",").map(function (value) { return normalizeLabel(value); });
            return values.indexOf(normalizeLabel(searchMatch.text)) !== -1 ? readWorkdayContainerValue(container) : null;
          }, 3000);
          if (searchSelected) {
            await learnFieldAliases(key, label, labelAliases);
            logActivity("replay-success", label, searchMatch.text + "  ⇒  " + searchSelected);
            return true;
          }
        }
      }
      await closeOpenWorkdayMenu(container);
      logActivity("replay-fail", label, 'no autocomplete option matched "' + want + '"');
      return false;
    }

    while (queue.length && inspected < maxMenus) {
      var path = queue.shift();
      var pathKey = path.map(normalizeLabel).join(" > ");
      if (seen[pathKey]) continue;
      seen[pathKey] = true;
      inspected++;

      if (!(await openWorkdayMenuAtPath(container, path))) continue;
      var rows = await collectMenuRowsByScroll(3000);
      var match = rows.find(function (row) {
        return normalizeLabel(row.text) === wanted;
      });

      if (match) {
        var target = await findMenuRowByScroll(match.text, 3000);
        if (target) {
          clickMenuRow(target);
          var selected = await waitForAsync(function () {
            var value = readWorkdayContainerValue(container);
            return normalizeLabel(value) === wanted ? value : null;
          }, 3000);
          if (selected) {
            var discoveredPath = path.concat(match.text);
            await learnFieldAliases(key, label, labelAliases);
            logActivity("replay-success", label, discoveredPath.join(" → ") + "  ⇒  " + selected);
            return true;
          }
        }
      }

      if (path.length >= maxDepth) continue;
      rows.forEach(function (row) {
        if (row.hasChildren) queue.push(path.concat(row.text));
      });
    }

    await closeOpenWorkdayMenu(container);
    logActivity("replay-fail", label, 'no nested option matched "' + want + '"');
    return false;
  }

  // Handles a single Workday-style custom widget container: saves whatever
  // is currently selected whenever it changes (this is what fixes fields
  // like "How Did You Hear About Us?" and the nested-menu "radio" options
  // that live inside it), and -- only on a manual rescan -- attempts to
  // fill it from a saved value, preferring a recorded click path when one
  // exists.
  function handleWorkdayContainer(container, force) {
    if (isPlainNativeContainer(container)) return false;
    var labelAliases = getContainerLabelAliases(container);
    var label = labelAliases[0];
    if (!label || SENSITIVE_LABEL_RE.test(label)) return false;
    if (agentOwnedFields.has(getAgentFieldRef(container, label))) return false;

    attachRecordingTrigger(container);

    var currentValue = readWorkdayContainerValue(container);
    var lastSeen = container.getAttribute(WORKDAY_LAST_VALUE_MARK);

    if (currentValue && currentValue !== lastSeen) {
      container.setAttribute(WORKDAY_LAST_VALUE_MARK, currentValue);
      var key = findAgentFieldKey(state, container, label, labelAliases);
      // A pre-filled site value is page state, not a profile edit. Preserve
      // the user's reusable profile fact and only learn this site's aliases.
      // A real user selection is saved by the recording listener above.
      if (key) {
        learnFieldAliases(key, label, labelAliases);
      } else {
        saveFieldValue(null, label, currentValue, "custom-widget", null, labelAliases);
      }
      return false;
    }

    var key2 = findAgentFieldKey(state, container, label, labelAliases);
    if (!key2 || !state.fields[key2] || !state.fields[key2].value) return false;
    var field = state.fields[key2];
    var want = field.value;
    if (currentValue && currentValue.trim().toLowerCase() === String(want).trim().toLowerCase()) return false;
    // Generic autofill fills blanks. Replacing an existing custom selection
    // is reserved for an explicit, reviewed set_field action.
    if (currentValue) return false;

    // Background mutation scans only observe/save custom widgets. Opening a
    // Workday menu steals keyboard focus, so filling is restricted to an
    // explicit rescan or Assistant action.
    if (!force) return false;

    var isChipWidget = isWorkdayMultiSelectContainer(container, label);
    if (isChipWidget) {
      return queueCustomFill(container, async function () {
        var values = String(want).split(",").map(function (part) { return part.trim(); }).filter(Boolean);
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
          var currentValues = readWorkdayContainerValue(container).split(",");
          if (currentValues.some(function (current) { return workdaySelectedValueMatches(current, values[valueIndex]); })) continue;
          await discoverAndFillNestedPath(container, key2, values[valueIndex], labelAliases);
        }
      }, force);
    }

    if (field.recordedPath && field.recordedPath.length) {
      return queueCustomFill(container, async function () {
        var replayed = await replayRecordedPath(container, field.recordedPath, want);
        if (!replayed) await discoverAndFillNestedPath(container, key2, want, labelAliases);
      }, force);
    }

    // No recorded path yet. Multiselect/chip widgets have no reliable
    // flat-text shortcut and have proven unsafe to guess (can select the
    // wrong option outright) -- leave those for you to pick once, which
    // records the path for every time after. Simple button-based
    // single-selects (e.g. "Country") are lower-risk, so still attempt the
    // type-and-match fallback for those specifically.
    return queueCustomFill(container, function () {
      return attemptFillWorkdaySingleSelect(container, want);
    }, force);
  }

  // Fallback for flat (non-nested) single-selects with no recorded path yet,
  // e.g. Country. Same open/scroll/click mechanics as replay -- the only
  // difference is there's one target instead of a recorded sequence.
  async function attemptFillWorkdaySingleSelect(container, want) {
    var label = getContainerLabel(container);
    try {
      logActivity("replay-attempt", label, want);
      openWorkdayWidget(container);
      var row = await findMenuRowByScroll(String(want), 3000);
      if (!row) {
        logActivity("replay-fail", label, 'no option matched "' + want + '"');
        return;
      }
      clickMenuRow(row);
      await sleep(450);
      var got = readWorkdayContainerValue(container);
      if (got && got.toLowerCase().indexOf(String(want).toLowerCase()) !== -1) {
        logActivity("replay-success", label, want);
      } else {
        logActivity("replay-fail", label, 'clicked "' + want + '" but value did not register');
      }
    } catch (e) {
      logActivity("replay-fail", label, String(e && e.message));
    }
  }

  function scanAndFill(force, nativeOnly, fromAgent) {
    if (agentWriteActive && !fromAgent) return;
    if (!enabled && !force) return;
    var fields = getFormFields();
    var workdayContainers = getWorkdayFieldContainers();
    var oraclePillRows = getOraclePillRows();
    var oracleComboboxes = getOracleComboboxes();
    var oracleMultiSelects = getOracleMultiSelects();
    if (
      !force &&
      fields.length +
        workdayContainers.length +
        oraclePillRows.length +
        oracleComboboxes.length +
        oracleMultiSelects.length <
        3
    ) return;

    var filledCount = 0;
    fields.forEach(function (el) {
      if (handleField(el)) filledCount++;
    });

    var groups = getRadioGroups();
    groups.forEach(function (radios) {
      if (handleRadioGroup(radios)) filledCount++;
    });

    if (!nativeOnly) {
      oraclePillRows.forEach(function (row) {
        if (handleOraclePillRow(row)) filledCount++;
      });

      oracleComboboxes.forEach(function (input) {
        if (handleOracleCombobox(input, force)) filledCount++;
      });

      oracleMultiSelects.forEach(function (input) {
        if (handleOracleMultiSelect(input, force)) filledCount++;
      });

      workdayContainers.forEach(function (container) {
        if (handleWorkdayContainer(container, force)) filledCount++;
      });

      if (force && !isOraclePage()) handleCustomComboboxes();
    }
    if (filledCount > 0 || force) showBadge(filledCount);
  }

  function isRequiredControl(control, label) {
    if (isWorkdayDateSectionInput(control)) {
      var dateContainer = control.closest('[data-automation-id^="formField-"]');
      if (dateContainer && isRequiredControl(dateContainer, getContainerLabel(dateContainer))) return true;
    }
    return !!(
      (control && (control.required || control.getAttribute("aria-required") === "true")) ||
      /\*\s*$/.test(String(label || ""))
    );
  }

  // One shared inventory powers the popup counts, Assistant context, action
  // review, and targeted edits, so all four agree about the page's state.
  function getPageFieldInventory() {
    var items = [];
    function add(labelAliases, type, current, required, key, ref, formatHint, options, datePart) {
      var label = labelAliases[0];
      if (!label || SENSITIVE_LABEL_RE.test(label)) return;
      var matchedKey = key || findMatchingKeyForAliases(state, labelAliases);
      var saved = matchedKey && state.fields[matchedKey] ? state.fields[matchedKey].value : "";
      var value = current == null ? "" : String(current).trim();
      items.push({
        label: label,
        ref: ref || slugify(label),
        key: matchedKey || "",
        type: type,
        current: value,
        saved: saved == null ? "" : String(saved).slice(0, 300),
        required: !!required,
        formatHint: formatHint || "",
        options: options || [],
        datePart: datePart || "",
        empty: !value,
        fillable: !!saved && !value
      });
    }

    getFormFields().forEach(function (el) {
      if (el.type === "radio") return;
      var aliases = getElementLabelAliases(el);
      var label = aliases[0];
      var key;
      if (isOraclePage()) {
        key = findOracleNativeKey(state, el, aliases);
        if (el.type === "file") key = findMatchingFileKeyForAliases(state, aliases) || findOracleFileKey(state, aliases) || key;
      } else {
        key = el.type === "file"
          ? findMatchingFileKeyForAliases(state, aliases) || findMatchingKeyForAliases(state, aliases)
          : findAgentFieldKey(state, el, label, aliases);
      }
      var current = el.type === "file" ? (el.files && el.files[0] ? el.files[0].name : "") : getElementValue(el);
      var describedBy = (el.getAttribute("aria-describedby") || "").split(/\s+/).map(function (id) {
        var description = id && document.getElementById(id);
        return description ? cleanText(description.textContent) : "";
      }).filter(Boolean).join(" ");
      var formatHint = [el.getAttribute("placeholder"), el.getAttribute("pattern"), describedBy].filter(Boolean).join("; ");
      var choices = el.tagName === "SELECT" ? Array.from(el.options).filter(function (option) { return !option.disabled; }).map(function (option) {
        return { value: option.value, label: cleanText(option.textContent) };
      }) : el.type === "checkbox" ? [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }] : [];
      var segment = (el.getAttribute("data-automation-id") || "").match(/^dateSection(Month|Day|Year)-input$/);
      if (segment) formatHint = "Separate " + segment[1].toLowerCase() + " segment (" + (segment[1] === "Year" ? "YYYY" : segment[1] === "Month" ? "MM" : "DD") + ")";
      add(aliases, elementType(el), current, isRequiredControl(el, label), key, getAgentFieldRef(el, label), formatHint.slice(0, 160), choices, segment ? segment[1].toLowerCase() : "");
    });
    getRadioGroups().forEach(function (radios) {
      // Workday radio groups are also represented by their formField
      // container below; count the logical question once.
      if (isInsideCustomWidget(radios[0])) return;
      var label = getGroupLabel(radios);
      var aliases = uniqueLabelAliases(label, [radios[0].name]);
      var key = findMatchingKeyForAliases(state, aliases);
      var checked = radios.find(function (radio) { return radio.checked; });
      add(aliases, "radio", checked ? cleanText(getLabelText(checked)) : "", radios.some(function (radio) { return isRequiredControl(radio, label); }), key, getAgentFieldRef(radios[0], label), "", radios.map(function (radio) {
        return { value: radio.value, label: cleanText(getLabelText(radio)) };
      }));
    });
    getOraclePillRows().forEach(function (row) {
      var aliases = getOracleRowLabelAliases(row);
      var selected = getOracleSelectedPill(row);
      add(aliases, "custom-widget", selected ? cleanText(selected.textContent) : "", isRequiredControl(row, aliases[0]), findOraclePickerKey(state, aliases));
    });
    getOracleComboboxes().forEach(function (input) {
      var aliases = getOracleComboboxLabelAliases(input);
      add(aliases, "custom-widget", getOracleDateValue(input) || cleanText(input.value), isRequiredControl(input, aliases[0]), findOracleComboboxKey(state, input, aliases));
    });
    getOracleMultiSelects().forEach(function (input) {
      var aliases = getOracleMultiLabelAliases(input);
      add(aliases, "custom-widget", getOracleMultiSelectedValues(input).join(", "), isRequiredControl(input, aliases[0]));
    });
    getWorkdayFieldContainers().filter(function (container) {
      return !isPlainNativeContainer(container);
    }).forEach(function (container) {
      var aliases = getContainerLabelAliases(container);
      add(aliases, "custom-widget", readWorkdayContainerValue(container), isRequiredControl(container, aliases[0]), findAgentFieldKey(state, container, aliases[0], aliases), getAgentFieldRef(container, aliases[0]));
    });

    // Empty Workday repeatable sections contain no controls yet. Surface the
    // section itself so Assistant can report that saved experience or
    // education has not been added, and can offer it to Fill this form.
    if (/myworkday(?:jobs|site)\.com$/i.test(location.hostname)) {
      [
        { heading: "Work Experience", prefix: "work_experience_" },
        { heading: "Education", prefix: "education_" },
        { heading: "Certifications", prefix: "certifications_" },
        { heading: "Languages", prefix: "languages_" }
      ].forEach(function (section) {
        var heading = Array.prototype.find.call(document.querySelectorAll("h4"), function (candidate) {
          return normalizeLabel(candidate.textContent) === normalizeLabel(section.heading);
        });
        if (!heading) return;
        var group = heading.closest('[role="group"]');
        var hasRows = group && Array.prototype.some.call(group.querySelectorAll("h5"), function (rowHeading) {
          return new RegExp("^" + section.heading + "\\s+\\d+$", "i").test(cleanText(rowHeading.textContent));
        });
        if (hasRows) return;
        var savedKey = Object.keys((state && state.fields) || {}).find(function (candidate) {
          return candidate.indexOf(section.prefix) === 0 && state.fields[candidate] && state.fields[candidate].value;
        });
        add([section.heading], "repeatable-section", "", false, savedKey || null, slugify(section.heading));
      });
    }
    return items;
  }

  // Read-only form plan for the Assistant. Current values are exposed only
  // for non-sensitive fields and the form is never submitted.
  function getAgentFormSnapshot() {
    var items = getPageFieldInventory();
    // Enhance with validation and visibility state for the agent loop.
    items.forEach(function (item) {
      // Note: items don't directly reference DOM elements, so validation
      // is gathered separately via JAA_AGENT_GET_VALIDATION.
      item.isVisible = true; // All items from getPageFieldInventory are already filtered to visible.
    });
    return { ok: true, title: document.title || location.hostname, url: location.href, fields: items };
  }

  async function agentFillForm() {
    await requireAgentActions();
    state = await getState();
    var before = getAgentFormSnapshot();
    var savedPageFields = [];
    var currentByRef = {};
    before.fields.forEach(function (field) { currentByRef[field.ref] = field; });
    var isWorkday = /myworkday(?:jobs|site)\.com$/i.test(location.hostname);
    if (isWorkday) {
      var includedFields = {};
      Object.keys(state.fields || {}).forEach(function (key) {
        if (!/^(?:work_experience|education)_\d+_/.test(key) && key !== "type_to_add_skills") return;
        var field = state.fields[key];
        if (!field || field.value == null || field.value === "") return;
        var targetField = key;
        if (/_current_job$/.test(targetField)) {
          targetField = targetField.replace(/_current_job$/, "_i_currently_work_here");
        } else if (/_currently_work_here$/.test(targetField) && !/_i_currently_work_here$/.test(targetField)) {
          targetField = targetField.replace(/_currently_work_here$/, "_i_currently_work_here");
        }
        // The generic Fill action only fills blanks. An explicit set_field
        // action can still replace a populated value after its normal review.
        if ((currentByRef[targetField] && currentByRef[targetField].current) || includedFields[targetField]) return;
        includedFields[targetField] = true;
        savedPageFields.push({
          field: targetField,
          value: field.value
        });
      });
    }
    // Native text, checkbox, and radio controls still use the regular profile
    // matcher. Workday custom widgets are handled only by the scoped actions
    // below, avoiding races with their portaled menus.
    scanAndFill(true, isWorkday);
    if (savedPageFields.length) {
      await agentSetFields(savedPageFields);
    } else {
      // Workday/Oracle/custom selects finish after their menus render.
      await new Promise(function (resolve) { setTimeout(resolve, 1600); });
    }
    var after = getAgentFormSnapshot();
    var filled = [];
    var beforeByRef = {};
    before.fields.forEach(function (field) { beforeByRef[field.ref] = field; });
    after.fields.forEach(function (field) {
      var old = beforeByRef[field.ref];
      if ((!old || !old.current) && field.current) filled.push(field.label);
    });
    var failed = [];
    after.fields.forEach(function (field) {
      if (field.empty && field.fillable) failed.push(field.label);
    });
    return { ok: true, title: after.title, url: after.url, filled: filled, filledCount: filled.length, failed: failed, failedCount: failed.length, fields: after.fields };
  }

  async function ensureWorkdayAgentSections(requested) {
    var sections = [
      { prefix: "work_experience_", heading: "Work Experience" },
      { prefix: "education_", heading: "Education" },
      { prefix: "certifications_", heading: "Certifications" },
      { prefix: "languages_", heading: "Languages" }
    ];
    for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      var section = sections[sectionIndex];
      var wantedCount = 0;
      requested.forEach(function (change) {
        var match = String(change.field || "").match(new RegExp("^" + section.prefix + "(\\d+)_"));
        if (match) wantedCount = Math.max(wantedCount, Number(match[1]));
      });
      if (!wantedCount) continue;

      function rowCount() {
        return Array.prototype.filter.call(document.querySelectorAll("h5"), function (heading) {
          return new RegExp("^" + section.heading + "\\s+\\d+$", "i").test(cleanText(heading.textContent));
        }).length;
      }
      while (rowCount() < wantedCount) {
        var sectionHeading = Array.prototype.find.call(document.querySelectorAll("h4"), function (heading) {
          return normalizeLabel(heading.textContent) === normalizeLabel(section.heading);
        });
        var group = sectionHeading && sectionHeading.closest('[role="group"]');
        var addButton = group && group.querySelector('[data-automation-id="add-button"]');
        if (!addButton) break;
        var before = rowCount();
        realClick(addButton);
        var added = await waitForAsync(function () { return rowCount() > before; }, 5000);
        if (!added) break;
      }
    }
  }

  async function agentSetFields(changes, scoped, passive) {
    if (!passive) await requireAgentActions();
    if (agentWriteActive) throw new Error("A page edit is already running. Wait for verification before applying again.");
    agentWriteActive = true;
    agentPassiveWrite = passive === true;
    try {
      return await applyAgentFields(changes, scoped);
    } finally {
      agentWriteActive = false;
      agentPassiveWrite = false;
    }
  }

  async function applyAgentFields(changes, scoped) {
    state = await getState();
    var requested = Array.isArray(changes) ? changes.slice(0, 30) : [];
    var updated = [];
    var attempts = new Map();
    if (scoped) requested.forEach(function (change) { agentOwnedFields.add(change.field); });
    if (!scoped) await ensureWorkdayAgentSections(requested);
    for (var el of getFormFields()) {
      if (el.type === "radio" || el.type === "file") continue;
      var aliases = getElementLabelAliases(el);
      var label = aliases[0];
      if (!label || SENSITIVE_LABEL_RE.test(label)) continue;
      var key = findAgentFieldKey(state, el, label, aliases);
      var ref = getAgentFieldRef(el, label);
      var match = requested.find(function (change) {
        if (scoped) return change.field === ref;
        var wanted = normalizeLabel(change.field).replace(/\s+/g, "");
        return wanted && ([ref, key].concat(aliases)).filter(Boolean).some(function (candidate) {
          return normalizeLabel(candidate).replace(/\s+/g, "") === wanted;
        });
      });
      if (!match) continue;
      if (!agentPassiveWrite) await requireAgentActions();
      if (el.isConnected === false) {
        el = getFormFields().find(function (candidate) { return getAgentFieldRef(candidate, getElementLabelAliases(candidate)[0]) === ref; });
        if (!el) continue;
      }
      delete el.dataset.jaaUserEdited;
      el.setAttribute(FILLED_MARK, String(match.value));
      var attempt;
      try {
        attempt = isWorkdayDateSectionInput(el)
          ? await setAgentDateSectionValue(el, match.value)
          : { ok: setElementValue(el, match.value), method: "native-input" };
      } catch (error) {
        attempt = { ok: false, error: String(error.message || error) };
      }
      attempts.set(match.field, Object.assign({ ref: ref, label: label }, attempt));
      if (attempt.ok) {
        updated.push(label);
        logActivity("filled", label, match.value);
      } else {
        el.removeAttribute(FILLED_MARK);
      }
    }

    if (scoped) getRadioGroups().forEach(function (radios) {
      checkAgentActionInProgress();
      var label = getGroupLabel(radios);
      var ref = getAgentFieldRef(radios[0], label);
      var change = requested.find(function (item) { return item.field === ref; });
      if (!change || SENSITIVE_LABEL_RE.test(label)) return;
      var target = radios.find(function (radio) {
        return !radio.disabled && (radio.value === change.value || cleanText(getLabelText(radio)) === change.value);
      });
      if (target && !target.checked) { target.click(); fireEvents(target); updated.push(label); }
      attempts.set(change.field, { ref: ref, label: label, ok: !!target && target.checked, method: "radio" });
    });

    // Target Workday's button/autocomplete widgets directly. This is needed
    // for resume fields such as Degree, School, Languages, and Skills, whose
    // visible controls are not native selects. Exact option matching remains
    // mandatory; a different option is never chosen as a guess.
    var workdayContainers = getWorkdayFieldContainers().filter(function (container) {
      return !isPlainNativeContainer(container);
    });
    for (var i = 0; i < workdayContainers.length; i++) {
      var container = workdayContainers[i];
      var widgetAliases = getContainerLabelAliases(container);
      var widgetLabel = widgetAliases[0];
      var widgetRef = getAgentFieldRef(container, widgetLabel);
      var widgetKey = findAgentFieldKey(state, container, widgetLabel, widgetAliases);
      var widgetMatch = requested.find(function (change) {
        if (scoped) return change.field === widgetRef;
        var wanted = normalizeLabel(change.field).replace(/\s+/g, "");
        return wanted && ([widgetRef, widgetKey].concat(widgetAliases)).filter(Boolean).some(function (candidate) {
          return normalizeLabel(candidate).replace(/\s+/g, "") === wanted;
        });
      });
      if (!widgetMatch) continue;
      if (!agentPassiveWrite) await requireAgentActions();

      var before = readWorkdayContainerValue(container);
      var isMulti = isWorkdayMultiSelectContainer(container, widgetLabel);
      var values = isMulti
        ? String(widgetMatch.value).split(",").map(function (part) { return part.trim(); }).filter(Boolean)
        : [String(widgetMatch.value).trim()];
      for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
        var wantedValue = values[valueIndex];
        var currentValues = readWorkdayContainerValue(container).split(",");
        if (currentValues.some(function (current) { return workdaySelectedValueMatches(current, wantedValue); })) continue;
        var selected = await discoverAndFillNestedPath(container, widgetMatch.field, wantedValue, widgetAliases);
        if (!selected && !isMulti && before && readWorkdayContainerValue(container) !== before) {
          await discoverAndFillNestedPath(container, widgetMatch.field, before, widgetAliases);
        }
      }
      if (readWorkdayContainerValue(container) !== before) updated.push(widgetLabel);
      attempts.set(widgetMatch.field, { ref: widgetRef, label: widgetLabel, ok: values.every(function (value) {
        return readWorkdayContainerValue(container).split(",").some(function (current) { return workdaySelectedValueMatches(current, value); });
      }), method: "workday-options", error: "No matching option was committed by the control" });
    }
    // Custom widgets use their existing exact-match adapters after the saved
    // profile values above have changed.
    if (scoped || /myworkday(?:jobs|site)\.com$/i.test(location.hostname)) {
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    } else {
      scanAndFill(true, false, true);
      await new Promise(function (resolve) { setTimeout(resolve, 1600); });
    }
    var afterFields = getPageFieldInventory();
    var results = requested.map(function (change) {
      var attempt = attempts.get(change.field);
      var field = afterFields.find(function (entry) { return entry.ref === (attempt ? attempt.ref : change.field); });
      var actual = field ? field.current : "";
      var matches = actual === String(change.value).trim() || !!field && field.datePart && /^\d+$/.test(actual) && /^\d+$/.test(String(change.value)) && Number(actual) === Number(change.value) ||
        !!field && (field.options || []).some(function (option) { return option.value === change.value && option.label === actual; });
      var ok = !!attempt && attempt.ok && !!matches;
      return { field: change.field, label: field ? field.label : attempt ? attempt.label : change.field,
        status: ok ? "filled" : "failed", value: change.value, actual: actual,
        method: attempt && attempt.method || "unavailable",
        error: ok ? "" : !attempt ? "No supported editable control matched this field" :
          !attempt.ok ? attempt.error || "The control rejected the value" : "The value changed after editing" };
    });
    var verified = results.filter(function (result) { return result.status === "filled"; });
    return { ok: true, updated: verified.map(function (result) { return result.label; }), updatedCount: verified.length, results: results, fields: afterFields };
  }

  // ---------- Saving (fills the profile, including brand-new fields) ----------

  function saveFieldValue(existingKey, label, value, type, recordedPath, labelAliases) {
    if (agentWriteActive) return saveQueue;
    saveQueue = saveQueue.then(function () {
      return doSaveFieldValue(existingKey, label, value, type, recordedPath, labelAliases);
    });
    return saveQueue;
  }

  function learnFieldAliases(existingKey, label, labelAliases) {
    if (!existingKey) return saveQueue;
    saveQueue = saveQueue.then(async function () {
      state = await getState();
      var field = state.fields && state.fields[existingKey];
      if (!field) return;
      var beforeCount = (field.aliases || []).length;
      addFieldAliases(field, cleanText(label), labelAliases);
      if ((field.aliases || []).length === beforeCount) return;
      await setState(state);
    });
    return saveQueue;
  }

  async function doSaveFieldValue(existingKey, label, value, type, recordedPath, labelAliases) {
    state = await getState();
    var key = existingKey;
    if (!key) {
      var base = slugify(label);
      key = uniqueKey(state, base);
      state.fields[key] = { value: "", aliases: [], type: type, createdAt: Date.now() };
    }
    var field = state.fields[key] || (state.fields[key] = { value: "", aliases: [], type: type });
    field.value = value;
    field.type = type || field.type;
    field.updatedAt = Date.now();
    if (recordedPath && recordedPath.length) field.recordedPath = recordedPath;
    var cleanLabel = cleanText(label);
    addFieldAliases(field, cleanLabel, labelAliases);
    appendLogEntry(state, recordedPath && recordedPath.length ? "recorded" : "saved", cleanLabel, value);
    await setState(state);
  }

  function addFieldAliases(field, cleanLabel, labelAliases) {
    if (!field.aliases) field.aliases = [];
    [cleanLabel].concat(labelAliases || []).forEach(function (alias) {
      alias = cleanText(alias);
      if (!alias) return;
      var already = field.aliases.some(function (savedAlias) {
        return normalizeLabel(savedAlias) === normalizeLabel(alias);
      });
      if (!already) field.aliases.push(alias);
    });
  }

  function saveSelectedFile(existingKey, label, labelAliases, fileRecord) {
    saveQueue = saveQueue.then(async function () {
      state = await getState();
      var key = existingKey || findMatchingKeyForAliases(state, labelAliases);
      if (!key) {
        key = uniqueKey(state, slugify(label));
        state.fields[key] = { value: "", aliases: [], type: "file", createdAt: Date.now() };
      }
      var field = state.fields[key] || (state.fields[key] = { value: "", aliases: [], type: "file" });
      field.value = fileRecord.name;
      field.type = "file";
      field.fileName = fileRecord.name;
      field.fileSize = fileRecord.size;
      field.fileMime = fileRecord.type;
      field.updatedAt = Date.now();
      addFieldAliases(field, cleanText(label), labelAliases);
      await setStoredFile(key, fileRecord);
      appendLogEntry(state, "file-saved", cleanText(label), fileRecord.name);
      await setState(state);
    });
    return saveQueue;
  }

  // Dashboard/activity log, viewable in the full editor. Every save already
  // goes through the queue above so it's logged inline there; this is for
  // events that don't otherwise touch storage (an autofill applying a
  // value, or a recorded-path replay attempt/success/failure).
  function appendLogEntry(st, type, label, value) {
    if (!st.activityLog) st.activityLog = [];
    st.activityLog.push({
      ts: Date.now(),
      type: type,
      label: label,
      value: value != null ? String(value).slice(0, 300) : null,
      url: location.hostname
    });
    if (st.activityLog.length > JAA_ACTIVITY_LOG_MAX) {
      st.activityLog = st.activityLog.slice(-JAA_ACTIVITY_LOG_MAX);
    }
  }

  function logActivity(type, label, value) {
    saveQueue = saveQueue.then(async function () {
      state = await getState();
      appendLogEntry(state, type, cleanText(label), value);
      await setState(state);
    });
    return saveQueue;
  }

  // ---------- Popup support ----------

  function getPageSummary() {
    var fields = getPageFieldInventory();
    var mappedFields = fields.filter(function (field) { return !!field.key; });
    var emptyFields = fields.filter(function (field) { return field.empty; });
    var filledFields = fields.filter(function (field) { return !field.empty; });

    return {
      total: fields.length,
      mapped: mappedFields.length,
      unmapped: fields.length - mappedFields.length,
      filled: filledFields.length,
      empty: emptyFields.length,
      filledLabels: filledFields.map(function (field) { return field.label; }),
      emptyLabels: emptyFields.map(function (field) { return field.label; }),
      unmappedLabels: fields.filter(function (field) { return !field.key; }).map(function (field) { return field.label; }),
      enabled: enabled
    };
  }

  // ---------- Application tracking ----------
  //
  // Detection ladder. Company and title rank different sources on purpose:
  // schema.org markup carries the *legal entity* ("I01 Wells Fargo
  // International Solutions Private LTD"), while the Workday tenant site in
  // the URL carries the brand a job seeker recognises ("Wells Fargo"). So the
  // URL wins for company, and the schema wins for the job title.
  //   company: URL -> JSON-LD (legal suffixes stripped) -> og:site_name -> <title> -> hostname
  //   title:   JSON-LD -> URL -> <title> -> og:title
  // Whatever survives is only a prefill; the popup lets the user fix it.

  var ROLE_HINT_RE =
    /\b(engineer|engineering|developer|programmer|manager|analyst|designer|scientist|architect|consultant|specialist|associate|director|lead|intern|internship|administrator|technician|accountant|recruiter|attorney|counsel|officer|representative|coordinator|supervisor|president|sde|swe|qa|devops)\b/i;

  function metaContent(selector) {
    var el = document.querySelector(selector);
    var value = el ? el.getAttribute("content") || "" : "";
    return value.trim();
  }

  function findJobPosting(node, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 6) return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var hit = findJobPosting(node[i], (depth || 0) + 1);
        if (hit) return hit;
      }
      return null;
    }
    var type = node["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.indexOf("JobPosting") !== -1)) {
      return node;
    }
    if (node["@graph"]) return findJobPosting(node["@graph"], (depth || 0) + 1);
    return null;
  }

  function readJobPostingSchema() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data = null;
      try {
        data = JSON.parse(nodes[i].textContent || "null");
      } catch (error) {
        continue; // malformed block — try the next one
      }
      var posting = findJobPosting(data, 0);
      if (posting) return posting;
    }
    return null;
  }

  function schemaOrganizationName(posting) {
    var org = posting && posting.hiringOrganization;
    if (!org) return "";
    if (typeof org === "string") return org.trim();
    if (Array.isArray(org)) org = org[0] || {};
    return String((org && org.name) || "").trim();
  }

  // "Senior Software Engineer | Wells Fargo" -> title + company, either order.
  function splitDocumentTitle() {
    var parts = String(document.title || "")
      .split(/\s*[|–—·•]\s*|\s+-\s+/)
      .map(function (part) {
        return part.trim();
      })
      .filter(Boolean);
    if (parts.length < 2) return { title: "", company: "" };

    var roleIdx = -1;
    for (var i = 0; i < parts.length; i++) {
      if (ROLE_HINT_RE.test(parts[i])) {
        roleIdx = i;
        break;
      }
    }
    if (roleIdx === -1) {
      // No obvious job wording: assume the common "Title | Company" order.
      return { title: parts[0], company: parts[parts.length - 1] };
    }
    var companyIdx = roleIdx === 0 ? parts.length - 1 : 0;
    return { title: parts[roleIdx], company: parts[companyIdx] };
  }

  function getApplicationContext() {
    var url = location.href;
    var fromUrl = jaaGuessFromUrl(url);
    var posting = readJobPostingSchema();
    var fromTitle = splitDocumentTitle();

    var company =
      fromUrl.company ||
      jaaCleanLegalName(schemaOrganizationName(posting)) ||
      metaContent('meta[property="og:site_name"]') ||
      metaContent('meta[name="application-name"]') ||
      fromTitle.company ||
      jaaCompanyFromHost(location.hostname);

    var title =
      String((posting && posting.title) || "").trim() ||
      fromUrl.title ||
      fromTitle.title ||
      metaContent('meta[property="og:title"]') ||
      String(document.title || "").trim();

    return {
      url: url,
      baseUrl: location.origin,
      host: jaaNormalizeHost(location.hostname),
      pageTitle: String(document.title || "").trim(),
      company: String(company || "").slice(0, 120),
      title: String(title || "").slice(0, 160),
      reqId: String(fromUrl.reqId || "").slice(0, 60)
    };
  }

  // ---------- Agent validation and interaction ----------

  function getAgentValidation() {
    var fieldErrors = [];
    var pageErrors = [];
    getFormFields().forEach(function (el) {
      var aliases = getElementLabelAliases(el);
      var label = aliases[0];
      if (!label || SENSITIVE_LABEL_RE.test(label)) return;
      if (!el.checkValidity || el.checkValidity()) return;
      var message = el.validationMessage || "Invalid value";
      fieldErrors.push({
        label: label,
        ref: getAgentFieldRef(el, label),
        message: message,
        required: isRequiredControl(el, label)
      });
    });
    // Scan for visible error elements on the page.
    var errorSelectors = [
      '[role="alert"]',
      '[aria-invalid="true"]',
      '.error-message',
      '.validation-error',
      '.field-error',
      '[data-automation-id*="error"]',
      '[data-automation-id*="Error"]'
    ];
    var errorElements = document.querySelectorAll(errorSelectors.join(", "));
    Array.prototype.forEach.call(errorElements, function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var text = cleanText(el.textContent).slice(0, 300);
      if (!text) return;
      if (pageErrors.some(function (existing) { return existing.text === text; })) return;
      pageErrors.push({ text: text, selector: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(/\s+/)[0] : "") });
    });
    return { ok: true, fieldErrors: fieldErrors, pageErrors: pageErrors };
  }

  async function agentClickElement(msg) {
    await requireAgentActions();
    var found = await pageTools.run("find_elements", {
      selector: msg.selector, text: msg.text, role: msg.role, visible: true, limit: 2
    });
    if (found.total !== 1) throw new Error("Click requires exactly one match. Search and narrow the target first.");
    var args = { action: "click", ref: found.elements[0].ref, documentId: found.documentId, url: found.url };
    var preview = await pageTools.run("preview_action", args);
    args.expected = preview.target;
    return runPageTool("page_action", args);
  }

  function agentScrollTo(msg) {
    var ref = msg.ref || "";
    var selector = msg.selector || "";
    var target = null;

    if (ref) {
      // Find by field ref — search form fields.
      getFormFields().forEach(function (el) {
        if (target) return;
        var aliases = getElementLabelAliases(el);
        var label = aliases[0];
        if (getAgentFieldRef(el, label) === ref || slugify(label) === ref) target = el;
      });
    }
    if (!target && selector) {
      try { target = document.querySelector(selector); } catch (e) {}
    }
    if (!target) return { ok: false, error: "Element not found for scrolling." };

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: true, scrolledTo: ref || selector };
  }

  // ---------- Page text, for the assistant ----------
  //
  // Only runs when the user explicitly attaches "This page" in the Assistant
  // tab — never on its own. Uses innerText so it sees what the user sees:
  // hidden nodes, scripts, and styles are excluded for free.

  function getReadablePageText() {
    var root = document.querySelector("main, article, [role='main']") || document.body;
    var text = root ? root.innerText || "" : "";
    return {
      title: document.title || "",
      url: location.href,
      text: text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 20000)
    };
  }

  // ---------- Feedback badge ----------

  function showBadge(filledCount) {
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "jaa-badge";
      document.documentElement.appendChild(badgeEl);
    }
    badgeEl.textContent =
      filledCount > 0
        ? "ApplyOnce: filled " + filledCount + " field" + (filledCount === 1 ? "" : "s")
        : "ApplyOnce: no new matches on this page";
    badgeEl.classList.add("jaa-badge-show");
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () {
      badgeEl.classList.remove("jaa-badge-show");
    }, 2500);
  }
})();

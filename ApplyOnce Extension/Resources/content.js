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

  init();

  async function init() {
    state = await getState();
    enabled = jaaShouldRunOnHost(state, location.hostname);

    if (enabled) startScanning();

    jaaBrowser.storage.onChanged.addListener(function (changes, area) {
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
      }
      return false; // always responded synchronously above
    });
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
    if (el.disabled || el.readOnly) return false;
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
    return humanize(el.name || el.id || "");
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

  function setElementValue(el, value) {
    if (el.type === "file") return false;
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
          : findMatchingKeyForAliases(state, labelAliases);
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
        if (evt && evt.isTrusted) el.dataset.jaaUserEdited = "1";
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
    if (el.dataset.jaaUserEdited) return false;

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
  var MENU_ITEM_SELECTOR = '[data-automation-id="menuItem"], [data-automation-id="promptLeafNode"]';

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
            var key = findMatchingKeyForAliases(state, session.labelAliases);
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
            await saveFieldValue(
              key,
              label,
              selected,
              "custom-widget",
              discoveredPath,
              labelAliases
            );
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

    attachRecordingTrigger(container);

    var currentValue = readWorkdayContainerValue(container);
    var lastSeen = container.getAttribute(WORKDAY_LAST_VALUE_MARK);

    if (currentValue && currentValue !== lastSeen) {
      container.setAttribute(WORKDAY_LAST_VALUE_MARK, currentValue);
      var key = findMatchingKeyForAliases(state, labelAliases);
      saveFieldValue(key, label, currentValue, "custom-widget", null, labelAliases);
      return false;
    }

    var key2 = findMatchingKeyForAliases(state, labelAliases);
    if (!key2 || !state.fields[key2] || !state.fields[key2].value) return false;
    var field = state.fields[key2];
    var want = field.value;
    if (currentValue && currentValue.trim().toLowerCase() === String(want).trim().toLowerCase()) return false;

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
    var isChipWidget = !!container.querySelector('[data-automation-id="multiSelectContainer"]');
    if (isChipWidget) {
      return queueCustomFill(container, function () {
        return discoverAndFillNestedPath(container, key2, want, labelAliases);
      }, force);
    }

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

  function scanAndFill(force) {
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
    if (filledCount > 0 || force) showBadge(filledCount);
  }

  // ---------- Saving (fills the profile, including brand-new fields) ----------

  function saveFieldValue(existingKey, label, value, type, recordedPath, labelAliases) {
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
    var fields = getFormFields().filter(function (el) {
      return el.type !== "radio";
    });
    var groups = getRadioGroups();
    var oraclePillRows = getOraclePillRows();
    var oracleComboboxes = getOracleComboboxes();
    var oracleMultiSelects = getOracleMultiSelects();
    var workdayContainers = getWorkdayFieldContainers().filter(function (c) {
      return !isPlainNativeContainer(c);
    });
    var mapped = 0;
    var unmapped = 0;
    var unmappedLabels = [];

    function classify(labelAliases) {
      var label = labelAliases[0];
      if (!label || SENSITIVE_LABEL_RE.test(label)) return;
      if (findMatchingKeyForAliases(state, labelAliases)) {
        mapped++;
      } else {
        unmapped++;
        if (unmappedLabels.indexOf(label) === -1) unmappedLabels.push(label);
      }
    }

    fields.forEach(function (el) {
      classify(getElementLabelAliases(el));
    });
    groups.forEach(function (radios) {
      classify(uniqueLabelAliases(getGroupLabel(radios), [radios[0].name]));
    });
    oraclePillRows.forEach(function (row) {
      classify(getOracleRowLabelAliases(row));
    });
    oracleComboboxes.forEach(function (input) {
      classify(getOracleComboboxLabelAliases(input));
    });
    oracleMultiSelects.forEach(function (input) {
      classify(getOracleMultiLabelAliases(input));
    });
    workdayContainers.forEach(function (container) {
      classify(getContainerLabelAliases(container));
    });

    return {
      total: mapped + unmapped,
      mapped: mapped,
      unmapped: unmapped,
      unmappedLabels: unmappedLabels,
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

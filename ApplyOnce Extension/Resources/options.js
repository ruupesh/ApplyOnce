var state = null;
var tbody = document.getElementById("fieldsBody");
var emptyState = document.getElementById("emptyState");
var searchInput = document.getElementById("search");
var enabledToggle = document.getElementById("enabledToggle");
var activityBody = document.getElementById("activityBody");
var activityEmptyState = document.getElementById("activityEmptyState");
var applicationsBody = document.getElementById("applicationsBody");
var applicationsEmptyState = document.getElementById("applicationsEmptyState");
var applicationSearch = document.getElementById("applicationSearch");
var applicationCount = document.getElementById("applicationCount");
var expandedFields = new Set();
var pendingEditorSaves = 0;
var deferredEditorRender = false;

document.addEventListener("input", function (event) {
  if (event.target.matches("#fieldsBody input, #fieldsBody textarea, #applicationsBody input, #applicationsBody textarea")) {
    event.target.dataset.dirty = "true";
    showEditorSaveStatus("unsaved", "Unsaved changes");
  }
});
document.addEventListener("change", function (event) {
  delete event.target.dataset.dirty;
}, true);
document.addEventListener("focusout", function () {
  setTimeout(function () {
    if (deferredEditorRender && !document.activeElement.closest("#fieldsBody, #applicationsBody")) {
      deferredEditorRender = false;
      renderFields();
      renderApplications();
    }
  }, 0);
});

function showEditorSaveStatus(status, message) {
  var indicator = document.getElementById("saveStatus");
  indicator.dataset.state = status;
  indicator.textContent = message;
}

async function saveEditorState(value) {
  pendingEditorSaves++;
  showEditorSaveStatus("saving", "Saving...");
  try {
    await setState(value);
    pendingEditorSaves--;
    if (!pendingEditorSaves) {
      var dirty = document.querySelector('[data-dirty="true"]');
      showEditorSaveStatus(dirty ? "unsaved" : "saved", dirty ? "Unsaved changes" : "Saved");
    }
  } catch (error) {
    pendingEditorSaves--;
    showEditorSaveStatus("error", "Could not save");
    throw error;
  }
}

init();

async function init() {
  state = await getState();
  enabledToggle.checked = state.enabled !== false;
  enabledToggle.addEventListener("change", async function () {
    state.enabled = enabledToggle.checked;
    await saveEditorState(state);
  });

  document.getElementById("addFieldBtn").addEventListener("click", addField);
  document.getElementById("resumeInput").addEventListener("change", addResumeFile);
  document.getElementById("exportBtn").addEventListener("click", exportJSON);
  document.getElementById("importInput").addEventListener("change", importJSON);
  document.getElementById("clearLogBtn").addEventListener("click", clearLog);
  document.getElementById("exportApplicationsBtn").addEventListener("click", exportApplicationsCSV);
  searchInput.addEventListener("input", renderFields);
  applicationSearch.addEventListener("input", renderApplications);

  Array.prototype.forEach.call(document.querySelectorAll(".tabBtn"), function (btn) {
    btn.addEventListener("click", function () {
      switchTab(btn.dataset.tab);
      location.hash = btn.dataset.tab;
    });
  });
  // The popup deep-links here with options.html#applications.
  switchTab(tabFromHash() || "fields");
  window.addEventListener("hashchange", function () { switchTab(tabFromHash() || "fields"); });

  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="siteMode"]'),
    function (radio) {
      radio.addEventListener("change", onSiteModeChange);
    }
  );
  wireSiteAddForm("allowedAddForm", "allowedInput", "allowedSites");
  wireSiteAddForm("blockedAddForm", "blockedInput", "blockedSites");

  // Live dashboard: reflect what the content script is doing on other tabs
  // in real time, without needing to reopen this page.
  jaaBrowser.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes[JAA_STORAGE_KEY]) return;
    state = changes[JAA_STORAGE_KEY].newValue || jaaDefaultState();
    enabledToggle.checked = state.enabled !== false;
    if (document.activeElement.closest("#fieldsBody, #applicationsBody")) {
      deferredEditorRender = true;
    } else {
      renderFields();
      renderApplications();
    }
    renderActivity();
    renderSites();
  });

  renderFields();
  renderActivity();
  renderSites();
  renderApplications();
}

function tabFromHash() {
  var name = String(location.hash || "").replace(/^#/, "");
  if (!/^[a-z]+$/.test(name)) return ""; // keep the hash out of the selector
  return document.querySelector('.tabBtn[data-tab="' + name + '"]') ? name : "";
}

// Every tab owns "<name>Section" and "<name>Toolbar". Deriving the ids from the
// buttons keeps this from growing a line per tab, and tolerating missing nodes
// means an optional feature (the Assistant) can be deleted without editing it.
function switchTab(tab) {
  document.getElementById("fieldCount").hidden = tab !== "fields";
  document.getElementById("saveStatus").hidden = tab === "assistant" || tab === "activity";
  Array.prototype.forEach.call(document.querySelectorAll(".tabBtn"), function (btn) {
    var name = btn.dataset.tab;
    btn.classList.toggle("active", name === tab);
    if (name === tab) {
      document.getElementById("sectionTitle").textContent = btn.textContent;
      document.title = "ApplyOnce - " + btn.textContent;
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
    ["Section", "Toolbar"].forEach(function (suffix) {
      var el = document.getElementById(name + suffix);
      if (el) el.hidden = name !== tab;
    });
  });
}

// ---------- Applications tab ----------

var ADD_CUSTOM_STATUS = "__custom__";

function formatAppliedAt(ts) {
  if (!ts) return "-";
  var when = new Date(ts);
  try {
    return when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (error) {
    return when.toLocaleString();
  }
}

function renderApplications() {
  var query = applicationSearch.value.trim().toLowerCase();
  var all = Array.isArray(state.applications) ? state.applications : [];

  var sorted = all.slice().sort(function (a, b) {
    return (b.appliedAt || 0) - (a.appliedAt || 0);
  });

  var visible = sorted.filter(function (entry) {
    if (!query) return true;
    var haystack = [entry.company, entry.title, entry.notes, entry.status, entry.host, entry.reqId]
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(query) !== -1;
  });

  applicationsBody.innerHTML = "";
  applicationsEmptyState.hidden = all.length !== 0;
  applicationCount.textContent = query
    ? visible.length + " of " + all.length + " tracked"
    : all.length + (all.length === 1 ? " application tracked" : " applications tracked");

  visible.forEach(function (entry) {
    applicationsBody.appendChild(buildApplicationRow(entry));
  });
}

async function updateApplication(id, apply) {
  var entry = (state.applications || []).filter(function (item) {
    return item.id === id;
  })[0];
  if (!entry) return;
  apply(entry);
  entry.updatedAt = Date.now();
  await saveEditorState(state);
}

function buildApplicationRow(entry) {
  var tr = document.createElement("tr");

  var companyTd = document.createElement("td");
  var companyInput = document.createElement("input");
  companyInput.className = "keyInput";
  companyInput.setAttribute("aria-label", "Company");
  companyInput.value = entry.company || "";
  companyInput.addEventListener("change", function () {
    updateApplication(entry.id, function (item) {
      item.company = companyInput.value.trim();
    });
  });
  companyTd.appendChild(companyInput);

  var titleTd = document.createElement("td");
  var titleInput = document.createElement("input");
  titleInput.className = "keyInput";
  titleInput.setAttribute("aria-label", "Job title");
  titleInput.value = entry.title || "";
  titleInput.addEventListener("change", function () {
    updateApplication(entry.id, function (item) {
      item.title = titleInput.value.trim();
    });
  });
  titleTd.appendChild(titleInput);

  var statusTd = document.createElement("td");
  var status = jaaCanonicalStatus(entry.status);
  var statusSelect = document.createElement("select");
  statusSelect.className = "statusSelect " + jaaStatusClass(status);
  statusSelect.setAttribute("aria-label", "Application status");
  jaaApplicationStatusOptions(state).forEach(function (value) {
    var option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    if (value === status) option.selected = true;
    statusSelect.appendChild(option);
  });
  // Escape hatch so a brand-new status can be added without leaving the table.
  var customOption = document.createElement("option");
  customOption.value = ADD_CUSTOM_STATUS;
  customOption.textContent = "+ Add custom status...";
  statusSelect.appendChild(customOption);

  statusSelect.addEventListener("change", async function () {
    var chosen = statusSelect.value;
    if (chosen === ADD_CUSTOM_STATUS) {
      var typed = prompt("Name this status", status);
      chosen = jaaCanonicalStatus(typed || "");
      if (!typed || !typed.trim()) {
        statusSelect.value = status; // cancelled — put the old one back
        return;
      }
    }
    await updateApplication(entry.id, function (item) {
      item.status = chosen;
    });
    renderApplications(); // a new status has to reach every row's dropdown
  });
  statusTd.appendChild(statusSelect);

  var appliedTd = document.createElement("td");
  var when = document.createElement("span");
  when.className = "appliedWhen";
  when.textContent = formatAppliedAt(entry.appliedAt);
  appliedTd.appendChild(when);
  if (entry.reqId) {
    var req = document.createElement("span");
    req.className = "appliedReq";
    req.textContent = "Req " + entry.reqId;
    appliedTd.appendChild(req);
  }

  var notesTd = document.createElement("td");
  var notesInput = document.createElement("textarea");
  notesInput.className = "valueInput";
  notesInput.setAttribute("aria-label", "Application notes");
  notesInput.rows = 1;
  notesInput.value = entry.notes || "";
  notesInput.addEventListener("change", function () {
    updateApplication(entry.id, function (item) {
      item.notes = notesInput.value.trim();
    });
  });
  notesTd.appendChild(notesInput);

  var linkTd = document.createElement("td");
  if (entry.url) {
    var link = document.createElement("a");
    link.className = "appLink";
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = entry.host || entry.baseUrl || "Open";
    link.title = entry.url;
    linkTd.appendChild(link);
  } else {
    linkTd.textContent = "-";
  }

  var deleteTd = document.createElement("td");
  var deleteBtn = document.createElement("button");
  deleteBtn.className = "deleteBtn";
  deleteBtn.textContent = "Delete";
  decorateEditorControl(deleteBtn, "trash", "Delete application", true);
  deleteBtn.addEventListener("click", async function () {
    var name = [entry.company, entry.title].filter(Boolean).join(" — ") || "this application";
    if (!confirm("Delete " + name + "?")) return;
    state.applications = (state.applications || []).filter(function (item) {
      return item.id !== entry.id;
    });
    await saveEditorState(state);
    renderApplications();
  });
  deleteTd.appendChild(deleteBtn);

  tr.appendChild(companyTd);
  tr.appendChild(titleTd);
  tr.appendChild(statusTd);
  tr.appendChild(appliedTd);
  tr.appendChild(notesTd);
  tr.appendChild(linkTd);
  tr.appendChild(deleteTd);
  return tr;
}

function csvCell(value) {
  return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
}

function exportApplicationsCSV() {
  var rows = [["Company", "Title", "Status", "Applied", "Requisition", "Notes", "Site", "URL"]];
  (state.applications || [])
    .slice()
    .sort(function (a, b) {
      return (b.appliedAt || 0) - (a.appliedAt || 0);
    })
    .forEach(function (entry) {
      rows.push([
        entry.company,
        entry.title,
        jaaCanonicalStatus(entry.status),
        formatAppliedAt(entry.appliedAt),
        entry.reqId,
        entry.notes,
        entry.host,
        entry.url
      ]);
    });

  var csv = rows
    .map(function (row) {
      return row.map(csvCell).join(",");
    })
    .join("\r\n");

  var blob = new Blob([csv], { type: "text/csv" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "applyonce-applications.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Sites tab ----------

function renderSites() {
  var mode = state.siteMode === "allowlist" ? "allowlist" : "all";
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="siteMode"]'),
    function (radio) {
      radio.checked = radio.value === mode;
    }
  );

  document.getElementById("allowedBlock").classList.toggle("inactive", mode !== "allowlist");
  document.getElementById("blockedBlock").classList.toggle("inactive", mode !== "all");

  renderSiteList("allowedList", "allowedEmpty", "allowedSites");
  renderSiteList("blockedList", "blockedEmpty", "blockedSites");
}

function renderSiteList(listId, emptyId, key) {
  var ul = document.getElementById(listId);
  var hosts = Array.isArray(state[key]) ? state[key].slice().sort() : [];
  ul.innerHTML = "";
  document.getElementById(emptyId).hidden = hosts.length !== 0;

  hosts.forEach(function (host) {
    var li = document.createElement("li");

    var name = document.createElement("span");
    name.className = "siteName";
    name.textContent = host;
    li.appendChild(name);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "siteRemove";
    remove.textContent = "Remove";
    decorateEditorControl(remove, "close", "Remove " + host, true);
    remove.addEventListener("click", function () {
      updateSiteList(key, host, false);
    });
    li.appendChild(remove);

    ul.appendChild(li);
  });
}

function wireSiteAddForm(formId, inputId, key) {
  var form = document.getElementById(formId);
  var input = document.getElementById(inputId);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    updateSiteList(key, input.value, true);
    input.value = "";
    input.focus();
  });
}

async function updateSiteList(key, host, add) {
  var h = jaaNormalizeHost(host);
  if (!h) return;
  var list = (Array.isArray(state[key]) ? state[key] : []).filter(function (entry) {
    return jaaNormalizeHost(entry) !== h;
  });
  if (add) list.push(h);
  state[key] = list;
  await saveEditorState(state);
  renderSites();
}

async function onSiteModeChange(event) {
  state.siteMode = event.target.value === "allowlist" ? "allowlist" : "all";
  await saveEditorState(state);
  renderSites();
}

// ---------- Fields tab ----------

function renderFields() {
  var q = searchInput.value.trim().toLowerCase();
  var entries = Object.keys(state.fields || {})
    .sort()
    .map(function (k) {
      return [k, state.fields[k]];
    });

  var filtered = entries.filter(function (entry) {
    if (!q) return true;
    var key = entry[0];
    var f = entry[1];
    var hay = [key, f.value, (f.aliases || []).join(" ")].join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  });

  tbody.innerHTML = "";
  emptyState.hidden = filtered.length !== 0;
  emptyState.textContent = entries.length ? "No matching fields." : "No fields saved yet.";
  document.getElementById("fieldCount").textContent = q
    ? filtered.length + " / " + entries.length
    : entries.length + (entries.length === 1 ? " field" : " fields");
  filtered.forEach(function (entry) {
    tbody.appendChild(buildRow(entry[0], entry[1]));
  });
}

function buildRow(key, field) {
  var tr = document.createElement("tr");

  var keyTd = document.createElement("td");
  var keyInput = document.createElement("input");
  keyInput.className = "keyInput";
  keyInput.setAttribute("aria-label", "Field key: " + key);
  keyInput.value = key;
  keyInput.addEventListener("input", function () { keyInput.setCustomValidity(""); });
  keyInput.addEventListener("change", function () {
    var candidate = slugify(keyInput.value) || key;
    if (candidate !== key && state.fields[candidate]) {
      keyInput.setCustomValidity("A field with that key already exists.");
      keyInput.dataset.dirty = "true";
      keyInput.reportValidity();
      showEditorSaveStatus("unsaved", "Unsaved changes");
      return;
    }
    renameKey(key, keyInput.value);
  });
  keyTd.appendChild(keyInput);

  var valTd = document.createElement("td");
  if (field.type === "file") {
    valTd.appendChild(buildFileValueEditor(key, field));
  } else {
    var valInput = document.createElement("textarea");
    valInput.className = "valueInput";
    valInput.setAttribute("aria-label", "Value for " + key);
    valInput.value = field.value || "";
    valInput.rows = 1;
    valInput.addEventListener("change", async function () {
      state.fields[key].value = valInput.value;
      state.fields[key].updatedAt = Date.now();
      await saveEditorState(state);
    });
    valTd.appendChild(valInput);
  }

  var typeTd = document.createElement("td");
  var typeSelect = document.createElement("select");
  typeSelect.className = "typeSelect";
  typeSelect.setAttribute("aria-label", "Type for " + key);
  [
    "text",
    "textarea",
    "select",
    "radio",
    "checkbox",
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
    "color",
    "range",
    "file",
    "custom-widget"
  ].forEach(function (t) {
    var o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    if (field.type === t) o.selected = true;
    typeSelect.appendChild(o);
  });
  typeSelect.addEventListener("change", async function () {
    var nextType = typeSelect.value;
    if (state.fields[key].type === "file" && nextType !== "file") {
      await removeStoredFile(key);
      state.fields[key].value = "";
      delete state.fields[key].fileName;
      delete state.fields[key].fileSize;
      delete state.fields[key].fileMime;
      delete state.fields[key].fileRole;
    }
    if (state.fields[key].type !== "file" && nextType === "file") {
      state.fields[key].value = "";
      delete state.fields[key].fileName;
      delete state.fields[key].fileSize;
      delete state.fields[key].fileMime;
    }
    state.fields[key].type = nextType;
    state.fields[key].updatedAt = Date.now();
    await saveEditorState(state);
    renderFields();
  });
  typeTd.appendChild(typeSelect);

  var pathTd = document.createElement("td");
  if (field.recordedPath && field.recordedPath.length) {
    var wrap = document.createElement("div");
    wrap.className = "pathSteps";
    field.recordedPath.forEach(function (step, i) {
      if (i > 0) {
        var arrow = document.createElement("span");
        arrow.className = "pathArrow";
        arrow.textContent = "→";
        wrap.appendChild(arrow);
      }
      var chip = document.createElement("span");
      chip.className = "pathStep" + (i === field.recordedPath.length - 1 ? " final" : "");
      chip.textContent = step;
      wrap.appendChild(chip);
    });

    var clearBtn = document.createElement("button");
    clearBtn.className = "clearPathBtn";
    clearBtn.textContent = "Clear path";
    clearBtn.title = "Forget these recorded clicks — the next time you pick this field by hand, a fresh path is recorded.";
    clearBtn.addEventListener("click", async function () {
      delete state.fields[key].recordedPath;
      await saveEditorState(state);
      renderFields();
    });
    wrap.appendChild(clearBtn);
    pathTd.appendChild(wrap);
  } else {
    var dash = document.createElement("span");
    dash.className = "noPath";
    dash.textContent = "— not recorded yet";
    pathTd.appendChild(dash);
  }

  var aliasInput = document.createElement("input");
  aliasInput.className = "aliasInput";
  aliasInput.setAttribute("aria-label", "Aliases for " + key);
  aliasInput.value = (field.aliases || []).join(", ");
  aliasInput.addEventListener("change", async function () {
    state.fields[key].aliases = aliasInput.value
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    await saveEditorState(state);
  });

  var updTd = document.createElement("td");
  updTd.textContent = field.updatedAt ? new Date(field.updatedAt).toLocaleDateString() : "-";

  var delTd = document.createElement("td");
  var delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.className = "deleteBtn";
  decorateEditorControl(delBtn, "trash", "Delete field " + key, true);
  delBtn.addEventListener("click", async function () {
    if (!confirm('Delete field "' + key + '"?')) return;
    await removeStoredFile(key);
    delete state.fields[key];
    await saveEditorState(state);
    renderFields();
  });
  delTd.appendChild(delBtn);

  tr.appendChild(keyTd);
  tr.appendChild(valTd);
  tr.appendChild(typeTd);
  var detailsTd = document.createElement("td");
  var details = document.createElement("details");
  details.className = "fieldDetails";
  details.open = expandedFields.has(key);
  var summary = document.createElement("summary");
  summary.textContent = "Details";
  summary.setAttribute("aria-label", "Details for " + key);
  details.appendChild(summary);
  var aliasLabel = document.createElement("label");
  aliasLabel.textContent = "Aliases";
  aliasLabel.appendChild(aliasInput);
  details.appendChild(aliasLabel);
  var pathLabel = document.createElement("div");
  pathLabel.className = "detailLabel";
  pathLabel.textContent = "Recorded path";
  details.appendChild(pathLabel);
  while (pathTd.firstChild) details.appendChild(pathTd.firstChild);
  details.addEventListener("toggle", function () {
    if (details.open) expandedFields.add(key);
    else expandedFields.delete(key);
  });
  detailsTd.appendChild(details);
  tr.appendChild(detailsTd);
  tr.appendChild(updTd);
  tr.appendChild(delTd);
  return tr;
}

function buildFileValueEditor(key, field) {
  var wrap = document.createElement("div");
  wrap.className = "fileValueEditor";

  var picker = document.createElement("label");
  picker.className = "fileBtn filePickerBtn";
  picker.textContent = field.value ? "Replace file" : "Choose file";
  var input = document.createElement("input");
  input.type = "file";
  input.hidden = true;
  input.addEventListener("change", async function () {
    var file = input.files?.[0];
    if (!file) return;
    await saveFileForField(key, file);
    input.value = "";
  });
  picker.appendChild(input);
  picker.tabIndex = 0;
  picker.setAttribute("role", "button");
  picker.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  var name = document.createElement("span");
  name.className = "storedFileName";
  name.textContent = "Checking local file...";

  var remove = document.createElement("button");
  remove.type = "button";
  remove.className = "removeFileBtn";
  remove.textContent = "Remove";
  remove.hidden = !field.value;
  remove.addEventListener("click", function () {
    removeFileFromField(key);
  });

  getStoredFile(key).then(function (fileRecord) {
    if (fileRecord) {
      name.textContent = fileRecord.name + " · " + formatFileSize(fileRecord.size);
      remove.hidden = false;
    } else {
      name.textContent = field.value ? field.value + " · select file again" : "No file stored";
    }
  });

  wrap.appendChild(picker);
  wrap.appendChild(name);
  wrap.appendChild(remove);
  return wrap;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function fileToStoredRecord(file) {
  return new Promise(function (resolve, reject) {
    if (file.size > JAA_MAX_STORED_FILE_BYTES) {
      reject(new Error("Choose a file smaller than 20 MB."));
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () {
      reject(reader.error || new Error("Could not read the selected file."));
    };
    reader.onload = function () {
      var result = typeof reader.result === "string" ? reader.result : "";
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

async function saveFileForField(key, file, configureField) {
  try {
    var fileRecord = await fileToStoredRecord(file);
    var field = state.fields[key];
    if (!field) {
      field = state.fields[key] = {
        value: "",
        aliases: [],
        type: "file",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }
    if (configureField) configureField(field);
    field.value = fileRecord.name;
    field.type = "file";
    field.fileName = fileRecord.name;
    field.fileSize = fileRecord.size;
    field.fileMime = fileRecord.type;
    field.updatedAt = Date.now();
    await setStoredFile(key, fileRecord);
    await saveEditorState(state);
    renderFields();
  } catch (error) {
    alert(String(error?.message || error));
  }
}

async function removeFileFromField(key) {
  await removeStoredFile(key);
  var field = state.fields[key];
  if (!field) return;
  field.value = "";
  delete field.fileName;
  delete field.fileSize;
  delete field.fileMime;
  field.updatedAt = Date.now();
  await saveEditorState(state);
  renderFields();
}

async function addResumeFile(event) {
  var file = event.target.files?.[0];
  if (!file) return;
  var resumeAliases = [
    "Resume",
    "Upload Resume",
    "Resume/CV",
    "CV",
    "Attach Resume",
    "Resume or CV",
    "Resume Attachment",
    "Resume Attachments",
    "Import Resume",
    "Import your profile from resume"
  ];
  var key = findResumeFieldKey();
  if (!key) key = "resume";
  await saveFileForField(key, file, function (field) {
    field.fileRole = "resume";
    if (!field.aliases) field.aliases = [];
    resumeAliases.forEach(function (alias) {
      var normalized = normalizeLabel(alias);
      var exists = field.aliases.some(function (savedAlias) {
        return normalizeLabel(savedAlias) === normalized;
      });
      if (!exists) field.aliases.push(alias);
    });
  });
  event.target.value = "";
}

function findResumeFieldKey() {
  var exact = findMatchingKey(state, "Resume");
  if (exact) return exact;
  return (
    Object.keys(state.fields || {}).find(function (key) {
      var field = state.fields[key];
      if (field.fileRole === "resume") return true;
      var labels = [key].concat(field.aliases || []).map(normalizeLabel).join(" ");
      return /(^| )(resume|curriculum vitae|cv)( |$)/.test(labels);
    }) || null
  );
}

async function renameKey(oldKey, newKeyRaw) {
  var newKey = slugify(newKeyRaw) || oldKey;
  if (newKey === oldKey) {
    renderFields();
    return;
  }
  if (state.fields[newKey]) {
    alert("A field with that key already exists.");
    renderFields();
    return;
  }
  state.fields[newKey] = state.fields[oldKey];
  delete state.fields[oldKey];
  await renameStoredFile(oldKey, newKey);
  await saveEditorState(state);
  renderFields();
}

async function addField() {
  searchInput.value = "";
  var key = uniqueKey(state, "new_field");
  state.fields[key] = { value: "", aliases: [], type: "text", createdAt: Date.now(), updatedAt: Date.now() };
  await saveEditorState(state);
  renderFields();
  Array.from(tbody.querySelectorAll(".keyInput")).some(function (input) {
    if (input.value !== key) return false;
    input.focus();
    input.select();
    return true;
  });
}

function exportJSON() {
  var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "job-autofill-profile.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importJSON(e) {
  var file = e.target.files[0];
  if (!file) return;
  var text = await file.text();
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    alert("Invalid JSON file.");
    e.target.value = "";
    return;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.fields !== "object") {
    alert("That JSON file does not look like a valid profile export (missing a \"fields\" object).");
    e.target.value = "";
    return;
  }
  var merge = confirm(
    'Click "OK" to MERGE these fields into your existing profile (imported values win on conflict).\n' +
      'Click "Cancel" to REPLACE your entire profile with this file instead.'
  );
  if (merge) {
    state.fields = Object.assign({}, state.fields, parsed.fields);
    await Promise.all(Object.keys(parsed.fields).map(removeStoredFile));
  } else {
    await removeAllStoredFiles();
    state = parsed;
    if (typeof state.enabled === "undefined") state.enabled = true;
    if (!state.activityLog) state.activityLog = [];
    if (state.siteMode !== "allowlist") state.siteMode = "all";
    if (!Array.isArray(state.allowedSites)) state.allowedSites = [];
    if (!Array.isArray(state.blockedSites)) state.blockedSites = [];
    if (!Array.isArray(state.applications)) state.applications = [];
  }
  await saveEditorState(state);
  enabledToggle.checked = state.enabled !== false;
  renderFields();
  renderActivity();
  renderSites();
  renderApplications();
  e.target.value = "";
}

// ---------- Activity log tab ----------

var EVENT_LABELS = {
  filled: "Filled",
  saved: "Saved",
  "assistant-update": "Assistant update",
  "file-saved": "File saved",
  "file-fail": "File failed",
  "oracle-fail": "Oracle failed",
  recorded: "Path recorded",
  "replay-attempt": "Replaying...",
  "replay-success": "Replay OK",
  "replay-fail": "Replay failed"
};

function renderActivity() {
  var log = (state.activityLog || []).slice().reverse();
  activityBody.innerHTML = "";
  activityEmptyState.hidden = log.length !== 0;
  log.forEach(function (entry) {
    activityBody.appendChild(buildActivityRow(entry));
  });
}

function buildActivityRow(entry) {
  var tr = document.createElement("tr");

  var timeTd = document.createElement("td");
  timeTd.textContent = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "-";

  var typeTd = document.createElement("td");
  var badge = document.createElement("span");
  badge.className = "eventBadge " + (entry.type || "saved");
  badge.textContent = EVENT_LABELS[entry.type] || entry.type || "-";
  typeTd.appendChild(badge);

  var labelTd = document.createElement("td");
  labelTd.textContent = entry.label || "-";

  var detailTd = document.createElement("td");
  detailTd.textContent = entry.value || "";

  var siteTd = document.createElement("td");
  siteTd.textContent = entry.url || "-";

  tr.appendChild(timeTd);
  tr.appendChild(typeTd);
  tr.appendChild(labelTd);
  tr.appendChild(detailTd);
  tr.appendChild(siteTd);
  return tr;
}

async function clearLog() {
  if (!confirm("Clear the activity log? This does not affect any saved field values.")) return;
  state.activityLog = [];
  await saveEditorState(state);
  renderActivity();
}

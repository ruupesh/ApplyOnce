var state = null;
var tbody = document.getElementById("fieldsBody");
var emptyState = document.getElementById("emptyState");
var searchInput = document.getElementById("search");
var enabledToggle = document.getElementById("enabledToggle");
var activityBody = document.getElementById("activityBody");
var activityEmptyState = document.getElementById("activityEmptyState");

init();

async function init() {
  state = await getState();
  enabledToggle.checked = state.enabled !== false;
  enabledToggle.addEventListener("change", async function () {
    state.enabled = enabledToggle.checked;
    await setState(state);
  });

  document.getElementById("addFieldBtn").addEventListener("click", addField);
  document.getElementById("resumeInput").addEventListener("change", addResumeFile);
  document.getElementById("exportBtn").addEventListener("click", exportJSON);
  document.getElementById("importInput").addEventListener("change", importJSON);
  document.getElementById("clearLogBtn").addEventListener("click", clearLog);
  searchInput.addEventListener("input", renderFields);

  Array.prototype.forEach.call(document.querySelectorAll(".tabBtn"), function (btn) {
    btn.addEventListener("click", function () {
      switchTab(btn.dataset.tab);
    });
  });

  // Live dashboard: reflect what the content script is doing on other tabs
  // in real time, without needing to reopen this page.
  jaaBrowser.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes[JAA_STORAGE_KEY]) return;
    state = changes[JAA_STORAGE_KEY].newValue || jaaDefaultState();
    renderFields();
    renderActivity();
  });

  renderFields();
  renderActivity();
}

function switchTab(tab) {
  Array.prototype.forEach.call(document.querySelectorAll(".tabBtn"), function (btn) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("fieldsSection").hidden = tab !== "fields";
  document.getElementById("activitySection").hidden = tab !== "activity";
  document.getElementById("fieldsToolbar").hidden = tab !== "fields";
  document.getElementById("activityToolbar").hidden = tab !== "activity";
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
  emptyState.hidden = entries.length !== 0;
  filtered.forEach(function (entry) {
    tbody.appendChild(buildRow(entry[0], entry[1]));
  });
}

function buildRow(key, field) {
  var tr = document.createElement("tr");

  var keyTd = document.createElement("td");
  var keyInput = document.createElement("input");
  keyInput.className = "keyInput";
  keyInput.value = key;
  keyInput.addEventListener("change", function () {
    renameKey(key, keyInput.value);
  });
  keyTd.appendChild(keyInput);

  var valTd = document.createElement("td");
  if (field.type === "file") {
    valTd.appendChild(buildFileValueEditor(key, field));
  } else {
    var valInput = document.createElement("textarea");
    valInput.className = "valueInput";
    valInput.value = field.value || "";
    valInput.rows = 1;
    valInput.addEventListener("change", async function () {
      state.fields[key].value = valInput.value;
      state.fields[key].updatedAt = Date.now();
      await setState(state);
    });
    valTd.appendChild(valInput);
  }

  var typeTd = document.createElement("td");
  var typeSelect = document.createElement("select");
  typeSelect.className = "typeSelect";
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
    await setState(state);
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
      await setState(state);
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

  var aliasTd = document.createElement("td");
  var aliasInput = document.createElement("input");
  aliasInput.className = "aliasInput";
  aliasInput.value = (field.aliases || []).join(", ");
  aliasInput.addEventListener("change", async function () {
    state.fields[key].aliases = aliasInput.value
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    await setState(state);
  });
  aliasTd.appendChild(aliasInput);

  var updTd = document.createElement("td");
  updTd.textContent = field.updatedAt ? new Date(field.updatedAt).toLocaleDateString() : "-";

  var delTd = document.createElement("td");
  var delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.className = "deleteBtn";
  delBtn.addEventListener("click", async function () {
    if (!confirm('Delete field "' + key + '"?')) return;
    await removeStoredFile(key);
    delete state.fields[key];
    await setState(state);
    renderFields();
  });
  delTd.appendChild(delBtn);

  tr.appendChild(keyTd);
  tr.appendChild(valTd);
  tr.appendChild(typeTd);
  tr.appendChild(pathTd);
  tr.appendChild(aliasTd);
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
    await setState(state);
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
  await setState(state);
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
  await setState(state);
  renderFields();
}

async function addField() {
  var key = uniqueKey(state, "new_field");
  state.fields[key] = { value: "", aliases: [], type: "text", createdAt: Date.now(), updatedAt: Date.now() };
  await setState(state);
  renderFields();
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
  }
  await setState(state);
  enabledToggle.checked = state.enabled !== false;
  renderFields();
  renderActivity();
  e.target.value = "";
}

// ---------- Activity log tab ----------

var EVENT_LABELS = {
  filled: "Filled",
  saved: "Saved",
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
  await setState(state);
  renderActivity();
}

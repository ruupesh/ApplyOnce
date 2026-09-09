var enabledToggle = document.getElementById("enabledToggle");
var totalFieldsEl = document.getElementById("totalFields");
var pageTotalEl = document.getElementById("pageTotal");
var pageMatchedEl = document.getElementById("pageMatched");
var pageUnmappedEl = document.getElementById("pageUnmapped");
var unmappedSection = document.getElementById("unmappedSection");
var unmappedList = document.getElementById("unmappedList");
var siteHostEl = document.getElementById("siteHost");
var siteStatusEl = document.getElementById("siteStatus");
var siteBtnsEl = document.getElementById("siteBtns");
var siteModeSelect = document.getElementById("siteModeSelect");
var siteHintEl = document.getElementById("siteHint");
var rescanBtn = document.getElementById("rescanBtn");
var mainView = document.getElementById("mainView");
var logView = document.getElementById("logView");
var logToggleBtn = document.getElementById("logToggleBtn");
var logCancelBtn = document.getElementById("logCancelBtn");
var logSaveBtn = document.getElementById("logSaveBtn");
var logFormTitle = document.getElementById("logFormTitle");
var logCompany = document.getElementById("logCompany");
var logTitle = document.getElementById("logTitle");
var logStatus = document.getElementById("logStatus");
var logNotes = document.getElementById("logNotes");
var logMeta = document.getElementById("logMeta");
var logDupe = document.getElementById("logDupe");
var logSavedNote = document.getElementById("logSavedNote");
var companySuggestions = document.getElementById("companySuggestions");
var titleSuggestions = document.getElementById("titleSuggestions");
var statusSuggestions = document.getElementById("statusSuggestions");
var viewAllBtn = document.getElementById("viewAllBtn");

var state = null;
var currentTab = null;
var currentHost = "";
var appContext = null; // what we detected about the page being logged
var editingId = null; // set when this URL is already in the list

init();

async function init() {
  state = await getState();
  currentTab = await getActiveTab();
  currentHost = pageHost(currentTab);

  enabledToggle.checked = state.enabled !== false;
  totalFieldsEl.textContent = Object.keys(state.fields || {}).length;
  enabledToggle.addEventListener("change", onToggle);
  rescanBtn.addEventListener("click", onRescan);
  document.getElementById("openEditorBtn").addEventListener("click", openEditor);
  siteModeSelect.addEventListener("change", onSiteModeChange);
  logToggleBtn.addEventListener("click", openLogForm);
  logCancelBtn.addEventListener("click", closeLogForm);
  logSaveBtn.addEventListener("click", saveApplication);
  viewAllBtn.addEventListener("click", openApplicationsTab);

  renderSiteCard();
  refreshLogButton();
  requestPageSummary();
}

// Only normal http(s) pages can be scoped — never chrome://, about:, the
// new-tab page, or the extension's own pages.
function pageHost(tab) {
  var url = (tab && tab.url) || "";
  if (!/^https?:\/\//i.test(url)) return "";
  return jaaHostFromUrl(url);
}

function listHasExactHost(list, host) {
  var h = jaaNormalizeHost(host);
  return (
    !!h &&
    Array.isArray(list) &&
    list.some(function (entry) {
      return jaaNormalizeHost(entry) === h;
    })
  );
}

function renderSiteCard() {
  siteModeSelect.value = state.siteMode === "allowlist" ? "allowlist" : "all";
  siteBtnsEl.innerHTML = "";

  if (!currentHost) {
    siteHostEl.textContent = "This page";
    siteStatusEl.textContent = "";
    siteStatusEl.className = "siteStatus";
    siteHintEl.textContent = "ApplyOnce only runs on normal web pages.";
    rescanBtn.hidden = true;
    return;
  }

  siteHostEl.textContent = currentHost;

  var runsHere = jaaShouldRunOnHost(state, currentHost);
  siteStatusEl.textContent = runsHere ? "On" : "Off";
  siteStatusEl.className = "siteStatus " + (runsHere ? "on" : "off");
  rescanBtn.hidden = !runsHere;

  if (siteModeSelect.value === "allowlist") {
    if (listHasExactHost(state.allowedSites, currentHost)) {
      addSiteButton("Remove this site", function () {
        return updateSiteList("allowedSites", currentHost, false);
      });
    } else {
      addSiteButton("Always use on this site", function () {
        return updateSiteList("allowedSites", currentHost, true);
      });
    }
    siteHintEl.textContent = "ApplyOnce runs only on sites you pick.";
  } else {
    if (listHasExactHost(state.blockedSites, currentHost)) {
      addSiteButton("Unblock this site", function () {
        return updateSiteList("blockedSites", currentHost, false);
      });
    } else {
      addSiteButton("Block this site", function () {
        return updateSiteList("blockedSites", currentHost, true);
      });
    }
    siteHintEl.textContent = "ApplyOnce runs everywhere except sites you block.";
  }
}

function addSiteButton(label, handler) {
  var btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = label;
  btn.addEventListener("click", handler);
  siteBtnsEl.appendChild(btn);
}

async function updateSiteList(key, host, add) {
  var h = jaaNormalizeHost(host);
  if (!h) return;
  var list = (Array.isArray(state[key]) ? state[key] : []).filter(function (entry) {
    return jaaNormalizeHost(entry) !== h;
  });
  if (add) list.push(h);
  state[key] = list;
  await setState(state);
  renderSiteCard();
  requestPageSummary();
}

async function onSiteModeChange() {
  state.siteMode = siteModeSelect.value === "allowlist" ? "allowlist" : "all";
  await setState(state);
  renderSiteCard();
  requestPageSummary();
}

// ---------- Log an application ----------

function refreshLogButton() {
  var url = (currentTab && currentTab.url) || "";
  var trackable = /^https?:\/\//i.test(url);
  logToggleBtn.hidden = !trackable;
  if (!trackable) return;
  editingId = null;
  var existing = jaaFindApplicationByUrl(state, url);
  if (existing) editingId = existing.id;
  logToggleBtn.textContent = existing ? "Update this application" : "Log this application";
}

function formatTimestamp(ts) {
  var when = new Date(ts);
  try {
    return when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (error) {
    return when.toLocaleString(); // older engines reject the options bag
  }
}

function originFromUrl(url) {
  var parsed = jaaParseUrl(url);
  return parsed ? parsed.origin : "";
}

// Ask the content script (it can read JSON-LD and meta tags). If it isn't
// there — restricted page, script blocked — guess from the URL alone.
async function fetchApplicationContext() {
  var url = (currentTab && currentTab.url) || "";
  if (currentTab) {
    try {
      var resp = await sendPageMessage(currentTab, { type: "JAA_GET_APPLICATION_CONTEXT" });
      if (resp && resp.url) return resp;
    } catch (error) {
      // No receiving content script — fall through to the URL-only guess.
    }
  }
  var guess = jaaGuessFromUrl(url);
  var pageTitle = (currentTab && currentTab.title) || "";
  return {
    url: url,
    baseUrl: originFromUrl(url),
    host: currentHost,
    pageTitle: pageTitle,
    company: guess.company || jaaCompanyFromHost(currentHost),
    title: guess.title || pageTitle,
    reqId: guess.reqId
  };
}

function fillSuggestions(listEl, values) {
  listEl.innerHTML = "";
  values.slice(0, 25).forEach(function (value) {
    var option = document.createElement("option");
    option.value = value;
    listEl.appendChild(option);
  });
}

async function openLogForm() {
  logSavedNote.hidden = true;
  appContext = await fetchApplicationContext();

  var existing = jaaFindApplicationByUrl(state, appContext.url);
  editingId = existing ? existing.id : null;

  // Everything you typed before becomes a one-tap suggestion.
  fillSuggestions(companySuggestions, jaaApplicationSuggestions(state, "company"));
  fillSuggestions(titleSuggestions, jaaApplicationSuggestions(state, "title"));
  fillSuggestions(statusSuggestions, jaaApplicationStatusOptions(state));

  logCompany.value = existing ? existing.company || "" : appContext.company || "";
  logTitle.value = existing ? existing.title || "" : appContext.title || "";
  logNotes.value = existing ? existing.notes || "" : "";
  logStatus.value = jaaCanonicalStatus(existing ? existing.status : "");

  logFormTitle.textContent = existing ? "Update this application" : "Log this application";
  logSaveBtn.textContent = existing ? "Update application" : "Save application";
  logDupe.hidden = !existing;
  if (existing) {
    logDupe.textContent =
      "You logged this one on " + formatTimestamp(existing.appliedAt) + ". Saving updates it.";
  }

  var meta = [appContext.host || "this page", formatTimestamp(Date.now())];
  if (appContext.reqId) meta.push("Req " + appContext.reqId);
  logMeta.textContent = meta.join(" · ");

  mainView.hidden = true;
  logView.hidden = false;
  if (typeof logCompany.focus === "function") logCompany.focus();
}

function closeLogForm() {
  logView.hidden = true;
  mainView.hidden = false;
}

async function saveApplication() {
  if (!appContext) return;
  var now = Date.now();
  if (!Array.isArray(state.applications)) state.applications = [];

  var existing = editingId
    ? state.applications.filter(function (entry) {
        return entry.id === editingId;
      })[0]
    : null;

  var record = existing || {
    id: jaaNewApplicationId(),
    appliedAt: now,
    timeZone: jaaLocalTimeZone()
  };

  record.url = appContext.url;
  record.baseUrl = appContext.baseUrl;
  record.host = appContext.host;
  record.company = logCompany.value.trim();
  record.title = logTitle.value.trim();
  record.reqId = appContext.reqId || record.reqId || "";
  record.notes = logNotes.value.trim();
  record.status = jaaCanonicalStatus(logStatus.value);
  record.updatedAt = now;

  if (!existing) state.applications.push(record);
  await setState(state);

  closeLogForm();
  logSavedNote.hidden = false;
  logSavedNote.textContent = existing
    ? "Updated. " + state.applications.length + " applications tracked."
    : "Logged. " + state.applications.length + " applications tracked.";
  refreshLogButton();
}

async function openApplicationsTab() {
  await jaaBrowser.tabs.create({
    url: jaaBrowser.runtime.getURL("options.html#applications")
  });
}

async function openEditor() {
  if (typeof jaaBrowser.runtime.openOptionsPage === "function") {
    try {
      await jaaBrowser.runtime.openOptionsPage();
      return;
    } catch (error) {
      // Fall back below for Safari versions that reject this API.
    }
  }
  await jaaBrowser.tabs.create({ url: jaaBrowser.runtime.getURL("options.html") });
}

async function onToggle() {
  state.enabled = enabledToggle.checked;
  await setState(state);
  renderSiteCard();
}

async function onRescan() {
  var tab = currentTab || (await getActiveTab());
  if (!tab) return;
  try {
    await sendPageMessage(tab, { type: "JAA_RESCAN" });
  } catch (error) {
    // The page may not allow content scripts (for example, Safari settings).
  }
  requestPageSummary();
}

async function requestPageSummary() {
  var tab = currentTab || (await getActiveTab());
  var resp = null;
  if (tab) {
    try {
      resp = await sendPageMessage(tab, { type: "JAA_GET_PAGE_SUMMARY" });
    } catch (error) {
      // Restricted pages do not have a receiving content script.
    }
  }
  if (!resp) {
    pageTotalEl.textContent = "0";
    pageMatchedEl.textContent = "0";
    pageUnmappedEl.textContent = "0";
    renderUnmappedList([]);
    return;
  }
  pageTotalEl.textContent = resp.total;
  pageMatchedEl.textContent = resp.mapped;
  pageUnmappedEl.textContent = resp.unmapped;
  renderUnmappedList(resp.unmappedLabels || []);
}

function sendPageMessage(tab, message) {
  if (/\.fa\.oraclecloud\.com/i.test(tab.url || "")) {
    return jaaBrowser.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
  return jaaBrowser.tabs.sendMessage(tab.id, message);
}

function renderUnmappedList(labels) {
  unmappedList.innerHTML = "";
  unmappedSection.hidden = labels.length === 0;
  labels.forEach(function (label) {
    var li = document.createElement("li");
    li.textContent = label;
    unmappedList.appendChild(li);
  });
}

async function getActiveTab() {
  var tabs = await jaaBrowser.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  return tab && typeof tab.id !== "undefined" ? tab : null;
}

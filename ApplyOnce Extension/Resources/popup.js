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

var state = null;
var currentTab = null;
var currentHost = "";

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

  renderSiteCard();
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

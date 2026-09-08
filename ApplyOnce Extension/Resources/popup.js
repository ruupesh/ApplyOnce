var enabledToggle = document.getElementById("enabledToggle");
var totalFieldsEl = document.getElementById("totalFields");
var pageTotalEl = document.getElementById("pageTotal");
var pageMatchedEl = document.getElementById("pageMatched");
var pageUnmappedEl = document.getElementById("pageUnmapped");
var unmappedSection = document.getElementById("unmappedSection");
var unmappedList = document.getElementById("unmappedList");

init();

async function init() {
  var state = await getState();
  enabledToggle.checked = state.enabled !== false;
  totalFieldsEl.textContent = Object.keys(state.fields || {}).length;

  enabledToggle.addEventListener("change", onToggle);
  document.getElementById("rescanBtn").addEventListener("click", onRescan);
  document.getElementById("openEditorBtn").addEventListener("click", openEditor);

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
  var state = await getState();
  state.enabled = enabledToggle.checked;
  await setState(state);
}

async function onRescan() {
  var tab = await getActiveTab();
  if (!tab) return;
  try {
    await sendPageMessage(tab, { type: "JAA_RESCAN" });
  } catch (error) {
    // The page may not allow content scripts (for example, Safari settings).
  }
  requestPageSummary();
}

async function requestPageSummary() {
  var tab = await getActiveTab();
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

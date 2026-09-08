"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const extensionRoot = path.join(root, "ApplyOnce Extension");
const resourcesRoot = path.join(extensionRoot, "Resources");

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createStorageAPI(initial = {}) {
  const records = structuredClone(initial);
  const storage = {
    async get(keys) {
      if (keys === null) return structuredClone(records);
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.prototype.hasOwnProperty.call(records, key))
          .map((key) => [key, structuredClone(records[key])])
      );
    },
    async set(values) {
      Object.assign(records, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key];
    }
  };
  return {
    api: {
      storage: {
        local: storage,
        onChanged: { addListener() {} }
      }
    },
    records
  };
}

function loadStorage(namespace, initial) {
  const { api, records } = createStorageAPI(initial);
  const context = vm.createContext({
    [namespace]: api,
    console,
    setTimeout,
    clearTimeout
  });
  vm.runInContext(
    fs.readFileSync(path.join(resourcesRoot, "storage.js"), "utf8"),
    context,
    { filename: "storage.js" }
  );
  return { context, api, records };
}

function collectManifestResources(manifest) {
  const resources = new Set([
    ...Object.values(manifest.icons || {}),
    ...(manifest.background?.scripts || []),
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.action?.default_icon,
    manifest.options_ui?.page
  ]);
  for (const entry of manifest.content_scripts || []) {
    for (const type of ["js", "css"]) {
      for (const file of entry[type] || []) resources.add(file);
    }
  }
  return [...resources].filter(Boolean);
}

test("shared Safari and Chromium manifest uses portable settings", () => {
  const manifest = readJSON(path.join(resourcesRoot, "manifest.json"));
  const messages = readJSON(path.join(resourcesRoot, "_locales", "en", "messages.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.3.1");
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.ok(manifest.permissions.includes("storage"));
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal("persistent" in manifest.background, false);
  assert.deepEqual(manifest.content_scripts[0].js, ["storage.js", "content.js"]);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.options_ui.page, "options.html");
  // The full editor is a wide, multi-column table, so it opens as its own
  // browser tab rather than the cramped fixed-size options popover.
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.match(manifest.action.default_icon, /\.png$/);
  assert.equal("browser_specific_settings" in manifest, false);
  assert.equal(manifest.action.default_title, "ApplyOnce");
  assert.equal(messages.extension_name.message, "ApplyOnce");
});

test("extension pages use the ApplyOnce product name", () => {
  for (const page of ["popup.html", "options.html"]) {
    const html = fs.readFileSync(path.join(resourcesRoot, page), "utf8");
    assert.match(html, /ApplyOnce/, page);
    assert.doesNotMatch(html, /Job (?:Application )?Autofill/, page);
  }
});

test("extension target follows the standard Apple resource layout", () => {
  const targetEntries = fs
    .readdirSync(extensionRoot)
    .filter((entry) => !entry.startsWith("."))
    .sort();
  assert.deepEqual(targetEntries, ["Info.plist", "Resources", "SafariWebExtensionHandler.swift"]);

  const manifest = readJSON(path.join(resourcesRoot, "manifest.json"));

  for (const resource of collectManifestResources(manifest)) {
    assert.equal(
      fs.existsSync(path.join(resourcesRoot, resource)),
      true,
      `missing resource: ${resource}`
    );
  }

  for (const page of ["popup.html", "options.html"]) {
    const html = fs.readFileSync(path.join(resourcesRoot, page), "utf8");
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const resource = match[1];
      assert.equal(
        fs.existsSync(path.join(resourcesRoot, resource)),
        true,
        `${page} references missing ${resource}`
      );
    }
  }
});

test("shared storage works through Safari's browser namespace", async () => {
  const { context, records } = loadStorage("browser");
  const defaults = await context.getState();

  assert.equal(defaults.enabled, true);
  assert.equal(Object.keys(defaults.fields).length, 0);

  defaults.fields.email = {
    value: "person@example.com",
    aliases: ["Email Address"],
    type: "text"
  };
  await context.setState(defaults);
  assert.equal(records.jaaState.fields.email.value, "person@example.com");

  await context.setStoredFile("resume/cv", { name: "resume.pdf", data: "AA==" });
  assert.equal((await context.getStoredFile("resume/cv")).name, "resume.pdf");
  await context.removeStoredFile("resume/cv");
  assert.equal(await context.getStoredFile("resume/cv"), null);
});

test("shared storage falls back to Chrome's chrome namespace", async () => {
  const { context } = loadStorage("chrome", {
    jaaState: { version: 1, enabled: false, fields: {} }
  });

  const state = await context.getState();
  assert.equal(state.enabled, false);
  assert.deepEqual(Array.from(state.activityLog), []);
});

test("getState backfills the per-site policy for older profiles", async () => {
  const { context } = loadStorage("browser", {
    jaaState: { version: 1, enabled: true, fields: {}, activityLog: [] }
  });

  const state = await context.getState();
  assert.equal(state.siteMode, "all");
  assert.deepEqual(Array.from(state.allowedSites), []);
  assert.deepEqual(Array.from(state.blockedSites), []);

  const defaults = context.jaaDefaultState();
  assert.equal(defaults.siteMode, "all");
  assert.deepEqual(Array.from(defaults.allowedSites), []);
  assert.deepEqual(Array.from(defaults.blockedSites), []);
});

test("per-site policy decides where the extension runs", () => {
  const { context } = loadStorage("browser");
  const run = (state, host) => context.jaaShouldRunOnHost(state, host);

  assert.equal(context.jaaNormalizeHost("https://www.Boards.Greenhouse.io/acme"), "boards.greenhouse.io");
  assert.equal(context.jaaHostFromUrl("http://jobs.example:8443/apply?x=1"), "jobs.example");

  // "all" mode: everywhere, minus the blocked list (subdomains included).
  const all = { enabled: true, siteMode: "all", allowedSites: [], blockedSites: ["greenhouse.io"] };
  assert.equal(run(all, "lever.co"), true);
  assert.equal(run(all, "greenhouse.io"), false);
  assert.equal(run(all, "boards.greenhouse.io"), false);

  // "allowlist" mode: only the allowed list.
  const only = { enabled: true, siteMode: "allowlist", allowedSites: ["myworkdayjobs.com"], blockedSites: [] };
  assert.equal(run(only, "lever.co"), false);
  assert.equal(run(only, "acme.myworkdayjobs.com"), true);

  // The master switch still wins over any site rule.
  assert.equal(run({ enabled: false, siteMode: "all", blockedSites: [] }, "lever.co"), false);
});

test("service worker initializes through browser and chrome namespaces", async (t) => {
  for (const namespace of ["browser", "chrome"]) {
    await t.test(namespace, async () => {
      const { api, records } = createStorageAPI();
      let onInstalled;
      api.runtime = {
        onInstalled: {
          addListener(listener) {
            onInstalled = listener;
          }
        }
      };

      let context;
      context = vm.createContext({
        [namespace]: api,
        console,
        importScripts(file) {
          vm.runInContext(fs.readFileSync(path.join(resourcesRoot, file), "utf8"), context, {
            filename: file
          });
        }
      });

      vm.runInContext(
        fs.readFileSync(path.join(resourcesRoot, "background.js"), "utf8"),
        context,
        { filename: "background.js" }
      );

      assert.equal(typeof onInstalled, "function");
      await onInstalled();
      assert.equal(records.jaaState.enabled, true);
      assert.deepEqual(records.jaaState.fields, {});
    });
  }
});

test("popup messaging and Safari editor fallback use Promise APIs", async () => {
  function fakeElement() {
    return {
      checked: false,
      children: [],
      hidden: false,
      listeners: {},
      textContent: "",
      _innerHTML: "",
      get innerHTML() {
        return this._innerHTML;
      },
      set innerHTML(value) {
        this._innerHTML = value;
        if (value === "") this.children = [];
      },
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
      appendChild(child) {
        this.children.push(child);
      }
    };
  }

  const ids = [
    "enabledToggle",
    "totalFields",
    "pageTotal",
    "pageMatched",
    "pageUnmapped",
    "unmappedSection",
    "unmappedList",
    "rescanBtn",
    "openEditorBtn",
    "siteHost",
    "siteStatus",
    "siteBtns",
    "siteModeSelect",
    "siteHint"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  const messages = [];
  let createdTab;
  const api = {
    runtime: {
      async openOptionsPage() {
        throw new Error("not supported");
      },
      getURL(file) {
        return `safari-web-extension://test/${file}`;
      }
    },
    tabs: {
      async query() {
        return [{ id: 7, url: "https://jobs.example/apply" }];
      },
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        if (message.type === "JAA_GET_PAGE_SUMMARY") {
          return { total: 3, mapped: 2, unmapped: 1, unmappedLabels: ["Portfolio"] };
        }
        return { ok: true };
      },
      async create(details) {
        createdTab = details;
      }
    }
  };
  const storageModule = loadStorage("browser").context;
  let savedState = null;
  const context = vm.createContext({
    console,
    URL,
    document: {
      createElement: fakeElement,
      getElementById(id) {
        return elements[id];
      }
    },
    getState: async () => ({
      enabled: true,
      siteMode: "all",
      allowedSites: [],
      blockedSites: [],
      fields: { email: {}, name: {} }
    }),
    jaaBrowser: api,
    setState: async (next) => {
      savedState = next;
    },
    jaaNormalizeHost: storageModule.jaaNormalizeHost,
    jaaHostFromUrl: storageModule.jaaHostFromUrl,
    jaaHostInList: storageModule.jaaHostInList,
    jaaShouldRunOnHost: storageModule.jaaShouldRunOnHost
  });

  vm.runInContext(fs.readFileSync(path.join(resourcesRoot, "popup.js"), "utf8"), context, {
    filename: "popup.js"
  });
  await new Promise(setImmediate);

  assert.equal(elements.totalFields.textContent, 2);
  assert.equal(elements.pageTotal.textContent, 3);
  assert.equal(elements.pageMatched.textContent, 2);
  assert.equal(elements.pageUnmapped.textContent, 1);
  assert.equal(elements.unmappedList.children[0].textContent, "Portfolio");

  // Per-site card reflects the active tab and offers a one-click block.
  assert.equal(elements.siteHost.textContent, "jobs.example");
  assert.equal(elements.siteStatus.textContent, "On");
  assert.equal(elements.siteModeSelect.value, "all");
  assert.equal(elements.siteBtns.children[0].textContent, "Block this site");

  await elements.siteBtns.children[0].listeners.click();
  assert.ok(savedState.blockedSites.includes("jobs.example"));
  assert.equal(elements.siteStatus.textContent, "Off");
  assert.equal(elements.siteBtns.children[0].textContent, "Unblock this site");

  await elements.rescanBtn.listeners.click();
  assert.ok(messages.some(({ message }) => message.type === "JAA_RESCAN"));

  await elements.openEditorBtn.listeners.click();
  assert.equal(createdTab.url, "safari-web-extension://test/options.html");
});

test("file cleanup only removes extension file records", async () => {
  const { context, records } = loadStorage("browser", {
    jaaState: { version: 1, enabled: true, fields: {}, activityLog: [] },
    "jaaFile:resume": { name: "resume.pdf" },
    "jaaFile:cover_letter": { name: "letter.pdf" },
    unrelated: "keep"
  });

  await context.removeAllStoredFiles();
  assert.equal(records.unrelated, "keep");
  assert.ok(records.jaaState);
  assert.equal("jaaFile:resume" in records, false);
  assert.equal("jaaFile:cover_letter" in records, false);
});

test("label matching stays strict for job application questions", () => {
  const { context } = loadStorage("browser");
  const state = {
    fields: {
      country: { value: "India", aliases: ["Country"] },
      email: { value: "person@example.com", aliases: ["Email Address"] }
    }
  };

  assert.equal(context.findMatchingKey(state, "Email Address *"), "email");
  assert.equal(context.findMatchingKey(state, "Your Email Address"), "email");
  assert.equal(
    context.findMatchingKey(
      state,
      "Enter in the currency of the country where this position is located"
    ),
    null
  );
});

test("runtime scripts use the shared WebExtensions API namespace", () => {
  for (const file of ["background.js", "content.js", "options.js", "popup.js"]) {
    const source = fs.readFileSync(path.join(resourcesRoot, file), "utf8");
    assert.doesNotMatch(source, /\bchrome\.(?:runtime|storage|tabs)\b/, file);
  }
});

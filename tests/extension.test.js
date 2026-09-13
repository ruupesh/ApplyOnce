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
    clearTimeout,
    URL
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
  assert.ok(manifest.permissions.includes("scripting"));
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
  assert.deepEqual(Array.from(state.applications), []);

  const defaults = context.jaaDefaultState();
  assert.equal(defaults.siteMode, "all");
  assert.deepEqual(Array.from(defaults.allowedSites), []);
  assert.deepEqual(Array.from(defaults.blockedSites), []);
  assert.deepEqual(Array.from(defaults.applications), []);
});

test("application details are guessed out of job-board URLs", () => {
  const { context } = loadStorage("browser");

  // The case that started this: nothing in the hostname says "Wells Fargo",
  // but the Workday tenant site and job segment carry both fields.
  const workday = context.jaaGuessFromUrl(
    "https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/job/Hyderabad%2C-India/Senior-Software-Engineer_R-572872/apply/useMyLastApplication"
  );
  assert.equal(workday.company, "Wells Fargo");
  assert.equal(workday.title, "Senior Software Engineer");
  assert.equal(workday.reqId, "R-572872");

  // Company lives in the first path segment on these boards.
  assert.equal(
    context.jaaGuessFromUrl("https://boards.greenhouse.io/stripe/jobs/4512345").company,
    "Stripe"
  );
  assert.equal(
    context.jaaGuessFromUrl("https://jobs.lever.co/figma/8a1c-9f2b").company,
    "Figma"
  );
  // Tenant lives in the subdomain here.
  assert.equal(
    context.jaaGuessFromUrl("https://careers-acme.icims.com/jobs/1234/login").company,
    "Acme"
  );
  // Plain career site: strip the "careers." prefix.
  assert.equal(
    context.jaaGuessFromUrl("https://careers.datadoghq.com/detail/99/").company,
    "Datadoghq"
  );
  // Nothing useful to say, rather than something wrong.
  assert.equal(context.jaaGuessFromUrl("not a url").company, "");

  assert.equal(context.jaaCleanCompany("AcmeExternalCareerSite"), "Acme");
  assert.equal(context.jaaCleanCompany("IBMJobs"), "IBM");

  // schema.org gives the legal entity; trim it back toward the brand.
  assert.equal(
    context.jaaCleanLegalName("I01 Wells Fargo International Solutions Private LTD"),
    "Wells Fargo International Solutions"
  );
  assert.equal(context.jaaCleanLegalName("Stripe, Inc."), "Stripe");
  assert.equal(context.jaaCleanLegalName("Cisco"), "Cisco");

  assert.deepEqual(
    { ...context.jaaCleanTitle("Staff-Data-Scientist_JR-88123") },
    { title: "Staff Data Scientist", reqId: "JR-88123" }
  );
});

test("tracked applications dedupe by URL and feed the type-ahead", () => {
  const { context } = loadStorage("browser");
  const state = {
    applications: [
      { id: "a", url: "https://x.test/1", company: "Acme", title: "SDE2", updatedAt: 10 },
      { id: "b", url: "https://x.test/2", company: "Globex", title: "SDE3", updatedAt: 30 },
      { id: "c", url: "https://x.test/3", company: "Acme", title: "SDE2", updatedAt: 20 }
    ]
  };

  assert.equal(context.jaaFindApplicationByUrl(state, "https://x.test/2").id, "b");
  assert.equal(context.jaaFindApplicationByUrl(state, "https://x.test/9"), null);

  // Newest first, no repeats — this is what the popup's datalist shows.
  assert.deepEqual(Array.from(context.jaaApplicationSuggestions(state, "company")), [
    "Globex",
    "Acme"
  ]);
  assert.deepEqual(Array.from(context.jaaApplicationSuggestions(state, "title")), ["SDE3", "SDE2"]);
});

test("application status is free text with the suggested ones canonicalised", () => {
  const { context } = loadStorage("browser");

  // Same status typed three ways stays one status.
  assert.equal(context.jaaCanonicalStatus("applied"), "Applied");
  assert.equal(context.jaaCanonicalStatus("  INTERVIEWING "), "Interviewing");
  assert.equal(context.jaaCanonicalStatus(""), "Applied");
  // Anything else is kept exactly as the user wrote it.
  assert.equal(context.jaaCanonicalStatus("Take-home sent"), "Take-home sent");

  assert.equal(context.jaaStatusClass("offer"), "offer");
  assert.equal(context.jaaStatusClass("Take-home sent"), "custom");

  const state = {
    applications: [
      { id: "a", status: "Take-home sent" },
      { id: "b", status: "applied" },
      { id: "c", status: "Ghosted" }
    ]
  };
  // Suggestions first, then the custom ones already in use, no duplicates.
  assert.deepEqual(Array.from(context.jaaApplicationStatusOptions(state)), [
    "Applied",
    "Saved",
    "Interviewing",
    "Offer",
    "Rejected",
    "Take-home sent",
    "Ghosted"
  ]);
});

test("getState migrates applications written before the title/status rename", async () => {
  const { context } = loadStorage("browser", {
    jaaState: {
      version: 1,
      enabled: true,
      fields: {},
      activityLog: [],
      applications: [{ id: "a", url: "https://x.test/1", company: "Acme", role: "SDE2", status: "interviewing" }]
    }
  });

  const state = await context.getState();
  const entry = state.applications[0];
  assert.equal(entry.title, "SDE2");
  assert.equal("role" in entry, false);
  assert.equal(entry.status, "Interviewing");
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
    "pageFilled",
    "pageEmpty",
    "filledSection",
    "filledList",
    "emptySection",
    "emptyList",
    "unmappedSection",
    "unmappedList",
    "rescanBtn",
    "openEditorBtn",
    "siteHost",
    "siteStatus",
    "siteBtns",
    "siteModeSelect",
    "siteHint",
    "mainView",
    "logView",
    "logToggleBtn",
    "logCancelBtn",
    "logSaveBtn",
    "logFormTitle",
    "logCompany",
    "logTitle",
    "logStatus",
    "logNotes",
    "logMeta",
    "logDupe",
    "logSavedNote",
    "companySuggestions",
    "titleSuggestions",
    "statusSuggestions",
    "viewAllBtn"
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
          return { total: 3, mapped: 2, unmapped: 1, filled: 2, empty: 1, filledLabels: ["Name", "Email"], emptyLabels: ["Portfolio"], unmappedLabels: ["Portfolio"] };
        }
        if (message.type === "JAA_GET_APPLICATION_CONTEXT") {
          return {
            url: "https://jobs.example/apply",
            baseUrl: "https://jobs.example",
            host: "jobs.example",
            pageTitle: "Senior Software Engineer | Wells Fargo",
            company: "Wells Fargo",
            title: "Senior Software Engineer",
            reqId: "R-572872"
          };
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
      applications: [],
      fields: { email: {}, name: {} }
    }),
    jaaBrowser: api,
    setState: async (next) => {
      savedState = next;
    },
    jaaNormalizeHost: storageModule.jaaNormalizeHost,
    jaaHostFromUrl: storageModule.jaaHostFromUrl,
    jaaHostInList: storageModule.jaaHostInList,
    jaaShouldRunOnHost: storageModule.jaaShouldRunOnHost,
    jaaParseUrl: storageModule.jaaParseUrl,
    jaaGuessFromUrl: storageModule.jaaGuessFromUrl,
    jaaCompanyFromHost: storageModule.jaaCompanyFromHost,
    jaaNewApplicationId: storageModule.jaaNewApplicationId,
    jaaLocalTimeZone: storageModule.jaaLocalTimeZone,
    jaaFindApplicationByUrl: storageModule.jaaFindApplicationByUrl,
    jaaApplicationSuggestions: storageModule.jaaApplicationSuggestions,
    jaaApplicationStatusOptions: storageModule.jaaApplicationStatusOptions,
    jaaCanonicalStatus: storageModule.jaaCanonicalStatus
  });

  vm.runInContext(fs.readFileSync(path.join(resourcesRoot, "popup.js"), "utf8"), context, {
    filename: "popup.js"
  });
  await new Promise(setImmediate);

  assert.equal(elements.totalFields.textContent, 2);
  assert.equal(elements.pageTotal.textContent, 3);
  assert.equal(elements.pageMatched.textContent, 2);
  assert.equal(elements.pageUnmapped.textContent, 1);
  assert.equal(elements.pageFilled.textContent, 2);
  assert.equal(elements.pageEmpty.textContent, 1);
  assert.equal(elements.filledList.children[0].textContent, "Name");
  assert.equal(elements.emptyList.children[0].textContent, "Portfolio");
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

  // Logging an application prefills from what the content script detected.
  await elements.logToggleBtn.listeners.click();
  assert.equal(elements.mainView.hidden, true);
  assert.equal(elements.logView.hidden, false);
  assert.equal(elements.logCompany.value, "Wells Fargo");
  assert.equal(elements.logTitle.value, "Senior Software Engineer");
  assert.equal(elements.logStatus.value, "Applied");
  assert.match(elements.logMeta.textContent, /jobs\.example/);
  assert.match(elements.logMeta.textContent, /R-572872/);

  elements.logNotes.value = "Referral from Priya";
  await elements.logSaveBtn.listeners.click();

  assert.equal(savedState.applications.length, 1);
  const logged = savedState.applications[0];
  assert.equal(logged.company, "Wells Fargo");
  assert.equal(logged.title, "Senior Software Engineer");
  assert.equal(logged.notes, "Referral from Priya");
  assert.equal(logged.status, "Applied");
  assert.equal(logged.url, "https://jobs.example/apply");
  assert.equal(logged.baseUrl, "https://jobs.example");
  assert.equal(logged.reqId, "R-572872");
  assert.ok(logged.appliedAt > 0);
  assert.equal(elements.mainView.hidden, false);

  // Same URL again edits the existing row instead of adding a second one.
  assert.equal(elements.logToggleBtn.textContent, "Update this application");
  await elements.logToggleBtn.listeners.click();
  assert.equal(elements.logDupe.hidden, false);
  await elements.logSaveBtn.listeners.click();
  assert.equal(savedState.applications.length, 1);

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

function loadLlmScript(name, extra = {}) {
  const context = vm.createContext({ TextDecoder, Uint8Array, AbortController, ...extra });
  vm.runInContext(fs.readFileSync(path.join(resourcesRoot, 'llm', name), 'utf8'), context);
  return context;
}

test('local model replacement releases the previous pipeline', async () => {
  const calls = [];
  const ctx = loadLlmScript('llm-local.js');
  ctx.jaaLocalDevice = async () => 'wasm';
  ctx.jaaLoadLocalModule = async () => ({ pipeline: async (task, model, options) => {
    calls.push([model, options.dtype]);
    return { dispose: async () => calls.push('disposed') };
  } });
  await ctx.jaaGetLocalPipeline('first', 'q4f16');
  await ctx.jaaGetLocalPipeline('first', 'q4f16');
  await ctx.jaaGetLocalPipeline('second', 'q4f16');
  assert.deepEqual(calls, [['first', 'q4'], 'disposed', ['second', 'q4']]);
});

test('Qwen3 and DeepSeek R1 Qwen use their supported q4f16 graphs on WebGPU', async () => {
  const calls = [];
  const ctx = loadLlmScript('llm-local.js');
  ctx.jaaLocalDevice = async () => 'webgpu';
  ctx.jaaLoadLocalModule = async () => ({ pipeline: async (task, model, options) => {
    calls.push([model, options.dtype, options.device, options.revision]);
    return { dispose: async () => {} };
  } });
  await ctx.jaaGetLocalPipeline('onnx-community/Qwen3-0.6B-ONNX', 'q4');
  await ctx.jaaGetLocalPipeline('onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX', 'q4');
  assert.deepEqual(calls, [
    ['onnx-community/Qwen3-0.6B-ONNX', 'q4f16', 'webgpu', 'main'],
    ['onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX', 'q4f16', 'webgpu', '61425627ba20650f3540d034589d35f00514ba7c']
  ]);
});

test('Qwen3 uses thinking-mode sampling with a browser-safe output budget', () => {
  const ctx = loadLlmScript('llm-local.js');
  const qwen3 = ctx.jaaLocalGenerationOptions('onnx-community/Qwen3-0.6B-ONNX');
  assert.equal(qwen3.max_new_tokens, 4096);
  assert.equal(qwen3.do_sample, true);
  assert.equal(qwen3.temperature, 0.6);
  assert.equal(qwen3.top_p, 0.95);
  assert.equal(qwen3.top_k, 20);
  assert.deepEqual({...ctx.jaaLocalGenerationOptions('onnx-community/Qwen2.5-0.5B-Instruct')}, {
    max_new_tokens: 256, do_sample: false, repetition_penalty: 1.1
  });
});

test('local model parameters allow 64K context and 16K output', () => {
  const ctx = loadLlmScript('llm-local.js');
  const model = 'onnx-community/Qwen3-0.6B-ONNX';
  assert.deepEqual({...ctx.jaaLocalParameterBounds(model)}, {
    contextMin: 512, contextMax: 65536, outputMin: 16, outputMax: 16384
  });
  assert.deepEqual({...ctx.jaaLocalParameterSettings(model, {
    contextWindow: 70000,
    maxNewTokens: 20000,
    doSample: false,
    temperature: 9,
    topP: -1,
    topK: 900,
    repetitionPenalty: 0
  })}, {
    contextWindow: 65536,
    maxNewTokens: 16384,
    doSample: false,
    temperature: 2,
    topP: 0.01,
    topK: 100,
    repetitionPenalty: 0.5
  });
  assert.deepEqual({...ctx.jaaLocalGenerationOptions(model, {doSample:false,maxNewTokens:512})}, {
    max_new_tokens: 512, do_sample: false, repetition_penalty: 1.1
  });
  const deepSeek = 'onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX';
  assert.equal(ctx.jaaLocalParameterDefaults(deepSeek).maxNewTokens, 512);
  assert.equal(ctx.jaaLocalParameterDefaults(deepSeek).doSample, false);
  assert.match(ctx.jaaLocalFriendlyError("Can't create a session. ERROR_MESSAGE: std::bad_alloc", deepSeek), /browser\/export allocation limit/i);
  assert.equal(ctx.jaaLocalRevision(deepSeek), '61425627ba20650f3540d034589d35f00514ba7c');
});

test('reasoning is separated from the final answer and unfinished thinking is detected', () => {
  const ctx = loadLlmScript('llm-format.js');
  const complete = ctx.jaaLlmSplitReasoning('<think>Private analysis</think>\n\n## Missing fields\n- Phone');
  assert.equal(complete.reasoning, 'Private analysis');
  assert.equal(complete.answer, '## Missing fields\n- Phone');
  assert.equal(complete.incomplete, false);
  const unfinished = ctx.jaaLlmSplitReasoning('<think>Still working');
  assert.equal(unfinished.answer, '');
  assert.equal(unfinished.thinking, true);
  assert.equal(unfinished.incomplete, true);
});

test('assistant Markdown creates safe formatting nodes without executable HTML', () => {
  class FakeNode {
    constructor(name, text = '') { this.nodeName = name; this.children = []; this._text = text; }
    appendChild(child) { this.children.push(child); return child; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  }
  const document = {
    createElement: name => new FakeNode(name.toUpperCase()),
    createTextNode: text => new FakeNode('#text', text)
  };
  const ctx = loadLlmScript('llm-format.js', {document});
  const container = new FakeNode('DIV');
  ctx.jaaRenderMarkdown(container, '## Result\n\n- **Name**\n- [Safe](https://example.com)\n- [Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>');
  assert.deepEqual(container.children.map(node => node.nodeName), ['H2', 'UL', 'P']);
  assert.equal(container.children[1].children[0].children[0].nodeName, 'STRONG');
  assert.equal(container.children[1].children[1].children[0].nodeName, 'A');
  assert.match(container.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(container.children.some(node => node.nodeName === 'SCRIPT'), false);
});

test('local generation observes cancellation before loading and during generation', async () => {
  const controller = new AbortController();
  const ctx = loadLlmScript('llm-local.js');
  let interrupted = false;
  ctx.jaaGetLocalPipeline = async () => async () => controller.abort();
  ctx.jaaLoadLocalModule = async () => ({
    TextStreamer: class {},
    InterruptableStoppingCriteria: class { interrupt() { interrupted = true; } }
  });
  await assert.rejects(ctx.sendToLocalLlm({ model: 'test', messages: [], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(interrupted, true);
  ctx.jaaGetLocalPipeline = () => { throw new Error('must not load'); };
  await assert.rejects(ctx.sendToLocalLlm({ signal: controller.signal }), { name: 'AbortError' });
});

test('resume context decodes UTF-8 text', async () => {
  const ctx = loadLlmScript('llm-tools.js', {
    atob,
    getState: async () => ({ fields: { resume: { type: 'file' } } }),
    getStoredFile: async () => ({ name: 'resume.txt', type: 'text/plain', data: Buffer.from('José — résumé').toString('base64') })
  });
  vm.runInContext(fs.readFileSync(path.join(resourcesRoot, 'llm/llm-resume.js'), 'utf8'), ctx);
  assert.match(await ctx.jaaLlmResumeContext(), /José — résumé/);
});

test('provider streams handle split UTF-8, multiple data lines, and a final frame without newline', async () => {
  const encoded = new TextEncoder().encode('data: {"text":\ndata: "résumé"}\r\n\r\ndata: {"text":"done"}');
  const ctx = loadLlmScript('llm-providers.js');
  const events = [];
  const body = new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  await ctx.jaaLlmReadSSE({ body }, event => events.push(event.text));
  assert.deepEqual(events, ['résumé', 'done']);
});

test('provider errors inside a successful HTTP stream remain visible', async () => {
  const ctx = loadLlmScript('llm-providers.js');
  await assert.rejects(ctx.jaaLlmReadSSE(new Response('data: {"error":{"message":"Quota exceeded"}}\n\n'), () => {}), /Quota exceeded/);
});

test('all five provider adapters build requests and extract streamed responses', async () => {
  for (const provider of ['openai', 'groq', 'deepseek', 'anthropic', 'gemini']) {
    const ctx = loadLlmScript('llm-store.js');
    ctx.fetch = async (url, request) => {
      assert.ok(!url.includes('test-key'));
      const body = JSON.parse(request.body);
      if (provider === 'gemini') {
        assert.equal(request.headers['x-goog-api-key'], 'test-key');
        assert.equal(body.contents[0].role, 'user');
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"hidden","thought":true},{"text":"Hello"},{"text":" world"}]}}]}\n\n');
      }
      if (provider === 'anthropic') {
        assert.equal(request.headers['x-api-key'], 'test-key');
        assert.equal(body.system, 'Help me');
        return new Response('data: {"type":"content_block_delta","delta":{"text":"Hello world"}}\n\n');
      }
      assert.equal(request.headers.Authorization, 'Bearer test-key');
      assert.equal(body.messages[0].role, 'system');
      return new Response('data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\ndata: [DONE]\n\n');
    };
    vm.runInContext(fs.readFileSync(path.join(resourcesRoot, 'llm/llm-providers.js'), 'utf8'), ctx);
    assert.equal(await ctx.sendToLlm({providerId:provider,model:'test',key:'test-key',system:'Help me',messages:[{role:'user',content:'Hi'}]}), 'Hello world');
  }
});

test('assistant settings migrate precision and discard invalid conversation entries', async () => {
  const ctx = loadLlmScript('llm-store.js', { jaaBrowser: { storage: { local: { get: async () => ({ jaaLLM: {
    localDtype: 'q4f16',
    localParameters: {
      qwen: {contextWindow:8192,maxNewTokens:2048,doSample:true,temperature:0.4,unknown:'discard'},
      broken: 'discard'
    },
    messages: [{ role: 'system', content: 'bad' }, { role: 'assistant', content: 'orphan' }, {role:'user',content:'Hi'}]
  } }) } } } });
  const settings = await ctx.getLlmSettings();
  assert.equal(settings.localDtype, 'q4');
  assert.deepEqual({...settings.localParameters.qwen}, {
    contextWindow:8192,maxNewTokens:2048,temperature:0.4,doSample:true
  });
  assert.equal('broken' in settings.localParameters, false);
  assert.equal(settings.messages.length, 1);
  assert.equal(settings.messages[0].role, 'user');
});

test('assistant exposes persisted on-device parameter controls', () => {
  const html = fs.readFileSync(path.join(resourcesRoot, 'options.html'), 'utf8');
  const ui = fs.readFileSync(path.join(resourcesRoot, 'llm/llm-ui.js'), 'utf8');
  for (const id of [
    'llmContextWindow', 'llmMaxNewTokens', 'llmDoSample', 'llmTemperature',
    'llmTopP', 'llmTopK', 'llmRepetitionPenalty', 'llmResetParameters'
  ]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(ui, /parameters:\s*jaaLocalParameterSettings/);
  assert.match(ui, /settings\.localParameters\[modelId\] = values/);
});

test('local model history omits an oversized old resume while preserving the latest turn', () => {
  const ctx = loadLlmScript('llm-store.js');
  const messages = [
    {role:'user',content:'R'.repeat(12000)},
    {role:'assistant',content:'Imported.'},
    {role:'user',content:'Check this page'}
  ];
  assert.deepEqual(Array.from(ctx.jaaLlmLocalMessages(messages), message => ({...message})), [
    {role:'user',content:'Check this page'}
  ]);
});

test('page context selects the most recent web tab while the editor is active', async () => {
  const ctx = loadLlmScript('llm-tools.js', { jaaBrowser: { tabs: {
    query: async () => [
      { id: 1, active: true, url: 'chrome-extension://test/options.html' },
      { id: 2, url: 'https://example.com/old', lastAccessed: 10 },
      { id: 3, url: 'https://example.com/job', lastAccessed: 20 }
    ],
    sendMessage: async (id, message) => {
      assert.equal(id, 3);
      if (message.type === 'JAA_AGENT_INSPECT_FORM') return {fields:[
        {label:'First name',type:'text',current:'Alex',saved:'Alex'},
        {label:'Phone',type:'tel',current:'',saved:'555-0100'}
      ]};
      return { title: 'Job', url: 'https://example.com/job', text: 'Engineer' };
    }
  } } });
  const page = await ctx.jaaLlmPageContext();
  assert.match(page, /Engineer/);
  assert.match(page, /First name \(text\): filled: Alex/);
  assert.match(page, /Phone \(tel\): empty; saved profile value available/);
});

test('removing a local model preserves unrelated cached models', async () => {
  const removed = [];
  const urls = [
    'https://huggingface.co/onnx-community/model-a/resolve/main/config.json',
    'https://huggingface.co/onnx-community/model-b/resolve/main/config.json',
    'https://example.com/onnx-community/model-a/resolve/main/config.json'
  ];
  const ctx = loadLlmScript('llm-local.js', { URL, caches: {
    keys: async () => ['transformers-cache'],
    open: async () => ({ keys: async () => urls.map(url => ({url})), delete: async request => removed.push(request.url) })
  } });
  await ctx.removeLocalModelDownload('onnx-community/model-a');
  assert.deepEqual(removed, [urls[0]]);
});

test('only enabled attachments run and extraction failures reach the UI', async () => {
  const ctx = loadLlmScript('llm-tools.js');
  const calls = [];
  ctx.JAA_LLM_TOOLS = [
    {id:'profile',label:'Profile',run:async()=>{calls.push('profile');return 'Known experience';}},
    {id:'resume',label:'Resume',run:async()=>{calls.push('resume');throw new Error('Unreadable PDF');}}
  ];
  assert.match(await ctx.buildLlmContext({profile:true}), /Known experience/);
  assert.deepEqual(calls, ['profile']);
  await assert.rejects(ctx.buildLlmContext({resume:true}), /Resume: Unreadable PDF/);
});

test('worker cancellation terminates pending downloads and releases the worker', async () => {
  let terminated = false;
  const ctx = loadLlmScript('llm-local.js', {
    window: {}, DOMException,
    jaaBrowser: {runtime:{getURL: file => file}},
    Worker: class { addEventListener() {} removeEventListener() {} postMessage() {} terminate() { terminated = true; } }
  });
  const controller = new AbortController();
  const pending = ctx.sendToLocalLlm({model:'test',messages:[],signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(terminated, true);
  assert.equal(ctx.jaaLocalWorker, null);
});

test('agent extracts and validates reviewable field and form actions', () => {
  const ctx = loadLlmScript('llm-agent.js', { slugify: value => String(value).toLowerCase().replace(/\W+/g, '_') });
  const parsed = ctx.jaaAgentExtractActions(
    'I can do that. <applyonce_actions>[{"type":"set_field","field":"First Name","value":"Alex"},{"type":"fill_form"},{"type":"set_field","field":"password","value":"secret"}]</applyonce_actions>',
    'Update my first name and fill the form'
  );
  assert.equal(parsed.text, 'I can do that.');
  assert.deepEqual(Array.from(parsed.actions, action => ({...action})), [
    {type:'set_field',field:'first_name',value:'Alex'}, {type:'fill_form'}
  ]);
  const fallback = ctx.jaaAgentExtractActions('Sure.', 'Set my preferred name to Sam.');
  assert.deepEqual(Array.from(fallback.actions, action => ({...action})), [
    {type:'set_field',field:'preferred_name',value:'Sam'}
  ]);
  const compound = ctx.jaaAgentExtractActions('Sure.', 'Set my preferred name to Sam and fill this form.');
  assert.deepEqual(Array.from(compound.actions, action => ({...action})), [
    {type:'set_field',field:'preferred_name',value:'Sam'}, {type:'fill_form'}
  ]);
  const append = ctx.jaaAgentExtractActions('Sure.', 'In address line 2, add Baner.');
  assert.deepEqual(Array.from(append.actions, action => ({...action})), [
    {type:'append_field',field:'address_line_2',value:'Baner'}
  ]);
});

test('agent recognizes natural empty-field inspection requests', () => {
  const ctx = loadLlmScript('llm-agent.js', { slugify: value => String(value).toLowerCase().replace(/\W+/g, '_') });
  assert.equal(ctx.jaaAgentAsksForMissingPageFields('Which fields are not filled on this page?'), true);
  assert.equal(ctx.jaaAgentAsksForMissingPageFields('Check the empty form inputs'), true);
  assert.equal(ctx.jaaAgentAsksForMissingPageFields('Fill this form'), false);
});

test('agent copies explicit resume facts into scoped form actions without model inference', () => {
  const ctx = loadLlmScript('llm-agent.js', { slugify: value => String(value).toLowerCase().replace(/\W+/g, '_').replace(/^_|_$/g, '') });
  const resume = `Below is my resume, please update the missing fields.
PROFILE SUMMARY
Backend engineer.
SKILLS
Programming Languages: Java, Python
WORK EXPERIENCE
EXAMPLE CO | Engineer
Pune, India | Mar 2025 – Present
• Built reliable services.
EDUCATION
EXAMPLE UNIVERSITY | Bachelor of Engineering - Computer Science
Pune, India | Aug 2018 - May 2022
• CGPA : 9.17/10`;
  const actions = ctx.jaaAgentExtractResumeActions(resume);
  assert.ok(actions.some(action => action.field === 'work_experience_1_job_title' && action.value === 'Engineer'));
  assert.ok(actions.some(action => action.field === 'work_experience_1_i_currently_work_here' && action.value === 'Yes'));
  assert.ok(actions.some(action => action.field === 'education_1_field_of_study' && action.value === 'Computer Science'));
  assert.equal(actions.at(-1).type, 'fill_form');
});

test('agent resolves append commands from the matching page field only', async () => {
  const ctx = loadLlmScript('llm-agent.js', {
    slugify: value => String(value).toLowerCase().replace(/\W+/g, '_').replace(/^_|_$/g, ''),
    getState: async () => ({fields:{address_line_1:{value:'Balewadi'}}}),
    jaaBrowser:{tabs:{sendMessage:async()=>({ok:true,title:'Application',url:'https://jobs.example/apply',fields:[
      {label:'Address Line 1',key:'address_line_1',current:'Balewadi'},
      {label:'Address Line 2',ref:'address_line_2',key:'',current:''}
    ]})}}
  });
  const plan = await ctx.jaaAgentDescribeActions([{type:'append_field',field:'address_line_2',value:'Baner'}], 7);
  assert.deepEqual(Array.from(plan.actions, action => ({...action})), [
    {type:'set_field',field:'address_line_2',value:'Baner'}
  ]);
  assert.equal(plan.fields[0].from, '');
  assert.equal(plan.fields[0].to, 'Baner');
  assert.equal(plan.pageFields[0].label, 'Address Line 2');
});

test('agent profile updates preserve unrelated state and reject file replacement', async () => {
  let state = {fields:{email:{value:'old@example.com',aliases:['Email'],type:'text'},resume:{value:'cv.pdf',type:'file'}},activityLog:[],applications:[{id:'a'}]};
  const ctx = loadLlmScript('llm-agent.js', {
    slugify: value => value, normalizeLabel: value => String(value).toLowerCase(), JAA_ACTIVITY_LOG_MAX:300,
    getState: async () => structuredClone(state), setState: async value => { state = structuredClone(value); },
    jaaBrowser:{tabs:{}}
  });
  await ctx.jaaAgentApplyActions({actions:[{type:'set_field',field:'email',value:'new@example.com'}]});
  assert.equal(state.fields.email.value, 'new@example.com');
  assert.equal(state.applications[0].id, 'a');
  assert.equal(state.activityLog.at(-1).type, 'assistant-update');
  await assert.rejects(ctx.jaaAgentApplyActions({actions:[{type:'set_field',field:'resume',value:'other.pdf'}]}), /file picker/);
});

test('agent refuses to fill a page that navigated after review', async () => {
  const ctx = loadLlmScript('llm-agent.js', {
    slugify:value=>value, normalizeLabel:value=>value, JAA_ACTIVITY_LOG_MAX:300,
    jaaBrowser:{tabs:{get:async()=>({url:'https://changed.example/'}),sendMessage:async()=>{throw new Error('must not fill');}}}
  });
  await assert.rejects(ctx.jaaAgentApplyActions({
    tabId: 3, form:{url:'https://original.example/'}, actions:[{type:'fill_form'}]
  }), /changed after review/);
});

test('agent explains that an extension reload disconnects existing pages', async () => {
  const ctx = loadLlmScript('llm-agent.js', {
    slugify: value => String(value).toLowerCase().replace(/\W+/g, '_').replace(/^_|_$/g, ''),
    getState: async () => ({ fields: {} }),
    jaaBrowser: { tabs: { sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } } }
  });
  await assert.rejects(
    ctx.jaaAgentDescribeActions([{ type: 'fill_form' }], 7),
    /Reload the selected webpage once/
  );
});

test('approved field changes update profile and the matching open page', async () => {
  let state = {fields:{},activityLog:[]};
  const sent = [];
  const ctx = loadLlmScript('llm-agent.js', {
    slugify:value=>value, normalizeLabel:value=>value, JAA_ACTIVITY_LOG_MAX:300,
    getState:async()=>structuredClone(state), setState:async value=>{state=structuredClone(value);},
    jaaBrowser:{tabs:{
      get:async()=>({url:'https://jobs.example/apply'}),
      sendMessage:async(id,message)=>{sent.push(message);return {ok:true,updatedCount:1};}
    }}
  });
  const result = await ctx.jaaAgentApplyActions({
    tabId:7, form:{url:'https://jobs.example/apply'},
    actions:[{type:'set_field',field:'address_line_2',value:'Baner'}],
    pageFields:[{field:'address_line_2',label:'Address Line 2',value:'Baner'}]
  });
  assert.equal(state.fields.address_line_2.value, 'Baner');
  assert.equal(sent[0].type, 'JAA_AGENT_SET_FIELDS');
  assert.equal(result.pageUpdate.updatedCount, 1);
});

test('content script exposes inspect and fill messages without a submit capability', () => {
  const source = fs.readFileSync(path.join(resourcesRoot, 'content.js'), 'utf8');
  assert.match(source, /JAA_AGENT_INSPECT_FORM/);
  assert.match(source, /JAA_AGENT_FILL_FORM/);
  assert.match(source, /JAA_AGENT_SET_FIELDS/);
  assert.match(source, /getAgentFieldRef/);
  assert.doesNotMatch(source, /JAA_AGENT_SUBMIT/);
});

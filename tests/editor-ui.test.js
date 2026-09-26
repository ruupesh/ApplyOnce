"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const resources = path.resolve(__dirname, "../ApplyOnce Extension/Resources");
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

async function editor(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(resources, "options.html"), "utf8"), {
    url: "https://extension.test/options.html", runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const records = { jaaState: {
    enabled: true, fields: {
      email: { value: "alex@example.com", type: "text", aliases: ["Email address"], recordedPath: ["Contact", "Email"] },
      name: { value: "Alex", type: "text", aliases: [] }
    }, applications: [], activityLog: [], allowedSites: [], blockedSites: []
  }};
  let listener;
  let failSave = false;
  w.chrome = { storage: {
    local: {
      get: async key => ({ [key]: structuredClone(records[key]) }),
      set: async values => {
        if (failSave) throw new Error("Storage unavailable");
        Object.assign(records, structuredClone(values));
        listener({ jaaState: { newValue: structuredClone(records.jaaState) } }, "local");
      },
      remove: async key => { delete records[key]; }
    },
    onChanged: { addListener: callback => { listener = callback; } }
  }};
  w.confirm = () => true;
  for (const script of ["storage.js", "editor-icons.js", "options.js"]) {
    w.eval(fs.readFileSync(path.join(resources, script), "utf8"));
  }
  await tick();
  return { w, records, fail: () => { failSave = true; }, emit: () => listener({ jaaState: { newValue: structuredClone(records.jaaState) } }, "local") };
}

test("editor saves aliases in expanded details and keeps focus during storage updates", async t => {
  const { w, records, emit } = await editor(t);
  const details = w.document.querySelector(".fieldDetails");
  details.open = true;
  await tick();
  const aliases = details.querySelector(".aliasInput");
  aliases.focus();
  aliases.value = "Email address, Work email";
  aliases.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(w.document.getElementById("saveStatus").textContent, "Unsaved changes");
  emit();
  assert.equal(w.document.activeElement, aliases);
  assert.equal(aliases.value, "Email address, Work email");
  aliases.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.deepEqual(records.jaaState.fields.email.aliases, ["Email address", "Work email"]);
  assert.equal(w.document.getElementById("saveStatus").textContent, "Saved");
  aliases.blur();
  await tick();
  assert.equal(w.document.querySelector(".fieldDetails").open, true);
  const clearPath = w.document.querySelector(".clearPathBtn");
  clearPath.click();
  await tick();
  assert.equal(records.jaaState.fields.email.recordedPath, undefined);
});

test("editor search, add, navigation, and extension switch remain usable", async t => {
  const { w, records } = await editor(t);
  const search = w.document.getElementById("search");
  search.value = "no match";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(w.document.getElementById("emptyState").hidden, false);
  assert.equal(w.document.getElementById("fieldCount").textContent, "0 / 2");
  w.document.getElementById("addFieldBtn").click();
  await tick();
  assert.equal(search.value, "");
  assert.equal(w.document.activeElement.value, "new_field");
  assert.ok(records.jaaState.fields.new_field);
  w.document.querySelector('[data-tab="sites"]').click();
  assert.equal(w.document.getElementById("sectionTitle").textContent, "Sites");
  assert.equal(w.document.getElementById("fieldsSection").hidden, true);
  assert.equal(w.document.getElementById("sitesSection").hidden, false);
  const toggle = w.document.getElementById("enabledToggle");
  toggle.checked = false;
  toggle.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.equal(records.jaaState.enabled, false);
});

test("editor reports storage failures rather than marking failed writes saved", async t => {
  const { w, fail } = await editor(t);
  fail();
  await assert.rejects(w.saveEditorState(w.state), /Storage unavailable/);
  assert.equal(w.document.getElementById("saveStatus").dataset.state, "error");
  assert.equal(w.document.getElementById("saveStatus").textContent, "Could not save");
});

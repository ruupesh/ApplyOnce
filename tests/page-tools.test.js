const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../ApplyOnce Extension/Resources');

async function page(t, namespace = 'browser') {
  const dom = new JSDOM(`<!doctype html><html><head><style>.box { color: red; }</style>
    <script>window.shouldNeverRun = true; function expand() { return 'details'; }</script></head><body>
    <button type="button" id="expand" aria-label="Show details">Open</button>
    <button type="button" id="other">Open</button><div id="box" class="box">Details</div>
    <label for="email">Email</label><input id="email" value="old@example.test">
    <label for="pw">Password</label><input id="pw" type="password" value="private-password">
    <input type="hidden" name="csrf_token" value="private-token"><textarea aria-label="Secret">private-secret</textarea>
    <select aria-label="Country"><option value="in">India</option><option value="us">USA</option></select>
    <input type="checkbox" aria-label="Updates"><form><button id="submit">Continue</button></form>
    <button type="button" disabled id="disabled">Disabled</button><a id="scriptlink" href="javascript:alert(1)">Link</a>
    <div id="host"></div></body></html>`, { url: 'https://example.test/page', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, records = {}, listeners = [];
  let listener;
  w.TextDecoder = TextDecoder;
  w.Element.prototype.getClientRects = function () { return this.hidden ? [] : [{ width: 100, height: 20 }]; };
  w.Element.prototype.getBoundingClientRect = function () { return { width: 100, height: 20 }; };
  w.Element.prototype.scrollIntoView = function () { this.scrolled = true; };
  const api = {
    storage: { local: {
      get: async key => ({ [key]: structuredClone(records[key]) }),
      set: async data => { Object.assign(records, structuredClone(data)); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(data).map(([key, newValue]) => [key, { newValue }])), 'local')); }
    }, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: { id: 'test-extension', onMessage: { addListener: fn => { listener = fn; } } }
  };
  w[namespace] = api;
  for (const name of ['storage.js', 'page-policy.js', 'page-tools.js', 'content.js']) w.eval(fs.readFileSync(path.join(root, name), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 0));
  records.jaaState = w.jaaDefaultState();
  const send = (message, sender = { id: 'test-extension' }) => new Promise(resolve => listener(message, sender, resolve));
  const run = (tool, args = {}) => send({ type: 'JAA_AGENT_PAGE_TOOL', tool, args });
  const target = async selector => (await run('find_elements', { selector })).elements[0];
  const action = async (selector, args) => {
    const item = await target(selector);
    const preview = await run('preview_action', { ref: item.ref, ...args });
    return run('page_action', { ref: item.ref, expected: preview.target, ...args });
  };
  return { w, records, api, run, target, action, send };
}

test('search intersects role/text/CSS, paginates, finds arbitrary divs and open shadow DOM', async t => {
  const h = await page(t);
  let result = await h.run('find_elements', { selector: 'button', role: 'button', text: 'Show details', exact: true });
  assert.equal(result.total, 1);
  assert.equal(result.elements[0].id, 'expand');
  result = await h.run('find_elements', { selector: 'button', limit: 1 });
  assert.equal(result.elements.length, 1);
  assert.equal(result.nextOffset, 1);
  assert.equal((await h.run('find_elements', { selector: 'div', text: 'Details' })).total, 1);
  h.w.document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button type="button">Shadow control</button>';
  assert.equal((await h.run('find_elements', { text: 'Shadow control', role: 'button' })).total, 1);
  assert.equal((await h.run('find_elements', { selector: '[' })).ok, false);
  assert.doesNotMatch(JSON.stringify(await h.run('find_elements', { selector: '*' })), /private-password|private-token|private-secret/);
});

test('HTML reads are paged/searchable and redact hidden/password/sensitive fields', async t => {
  const h = await page(t);
  const result = await h.run('read_page_code', { kind: 'html', limit: 6000 });
  assert.equal(result.ok, true, result.error);
  assert.doesNotMatch(result.text, /private-password|private-token|private-secret/);
  assert.match(result.text, /redacted/);
  const small = await h.run('read_page_code', { limit: 50 });
  assert.equal(small.text.length, 50);
  assert.equal(small.nextOffset, 50);
  const found = await h.run('read_page_code', { query: 'id="box"', limit: 300 });
  assert.match(found.text, /id="box"/);
  assert.equal((await h.run('read_page_code', { ref: (await h.target('#box')).ref })).text, '<div id="box" class="box">Details</div>');
});

test('CSS and JavaScript sources are read as data; unavailable external scripts report CORS errors', async t => {
  const h = await page(t);
  const styles = await h.run('read_page_code', { kind: 'css' });
  const css = await h.run('read_page_code', { kind: 'css', ref: styles.resources[0].ref, query: 'color' });
  assert.match(css.text, /color: red/);
  const elementCSS = await h.run('read_page_code', { kind: 'css', ref: (await h.target('#box')).ref });
  assert.match(elementCSS.text, /\.box.*color: red/);
  assert.match(elementCSS.text, /Computed style/);
  const scripts = await h.run('read_page_code', { kind: 'javascript' });
  const js = await h.run('read_page_code', { kind: 'javascript', ref: scripts.resources[0].ref });
  assert.match(js.text, /function expand/);
  assert.equal(h.w.shouldNeverRun, undefined);
  const external = h.w.document.createElement('script'); external.src = 'https://cdn.example.test/app.js';
  h.w.document.head.append(external);
  h.w.fetch = async () => { throw new Error('CORS'); };
  const resources = await h.run('read_page_code', { kind: 'javascript' });
  assert.match((await h.run('read_page_code', { kind: 'javascript', ref: resources.resources[1].ref })).error, /CORS/);
  h.w.fetch = async () => new Response('const found = 42;');
  assert.match((await h.run('read_page_code', { kind: 'javascript', ref: resources.resources[1].ref, query: 'found' })).text, /found/);
});

for (const namespace of ['browser', 'chrome']) {
  test(`${namespace} namespace: permission defaults off and blocks every agent mutation endpoint`, async t => {
    const h = await page(t, namespace);
    const ref = (await h.target('#expand')).ref;
    for (const message of [
      { type: 'JAA_AGENT_PAGE_TOOL', tool: 'page_action', args: { action: 'click', ref } },
      { type: 'JAA_AGENT_CLICK_ELEMENT', selector: '#expand' },
      { type: 'JAA_AGENT_SET_FIELDS', fields: [{ field: 'email', value: 'new@example.test' }] },
      { type: 'JAA_AGENT_FILL_FORM' }, { type: 'JAA_AGENT_SCROLL_TO', selector: '#box' }
    ]) {
      const result = await h.send(message);
      assert.equal(result.ok, false);
      assert.match(result.error, /Page actions are disabled/);
    }
    assert.equal(h.w.document.getElementById('email').value, 'old@example.test');
    assert.equal((await h.run('read_page_code', { kind: 'html' })).ok, true);
    h.records.jaaPageActionsAllowed = 'true';
    assert.match((await h.run('preview_action', { action: 'click', ref })).error, /disabled/);
  });
}

test('enabled actions dispatch framework-friendly changes and read back native control values', async t => {
  const h = await page(t);
  await h.w.jaaSetPageActionsAllowed(true);
  const events = [];
  const email = h.w.document.getElementById('email');
  email.addEventListener('input', () => events.push('input'));
  email.addEventListener('change', () => events.push('change'));
  assert.equal((await h.action('#email', { action: 'fill', value: 'new@example.test' })).retained, true);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal((await h.action('select', { action: 'select', value: 'us' })).retained, true);
  assert.equal((await h.action('[type="checkbox"]', { action: 'check', checked: true })).retained, true);
  let clicks = 0;
  h.w.document.getElementById('expand').addEventListener('click', () => clicks++);
  assert.equal((await h.action('#expand', { action: 'click' })).dispatched, true);
  assert.equal(clicks, 1);
  assert.equal((await h.action('#box', { action: 'scroll' })).ok, true);
  assert.equal(h.w.document.getElementById('box').scrolled, true);
  assert.equal(h.records.jaaState.fields.email, undefined, 'page-only changes must not save profile facts');
});

test('permission revoked after review, site blocking and untrusted senders prevent execution', async t => {
  const h = await page(t);
  await h.w.jaaSetPageActionsAllowed(true);
  const ref = (await h.target('#expand')).ref;
  const preview = await h.run('preview_action', { action: 'click', ref });
  await h.w.jaaSetPageActionsAllowed(false);
  assert.match((await h.run('page_action', { action: 'click', ref, expected: preview.target })).error, /disabled/);
  await h.w.jaaSetPageActionsAllowed(true);
  h.records.jaaState.enabled = false;
  assert.match((await h.run('preview_action', { action: 'click', ref })).error, /disabled for this website/);
  assert.match((await h.send({ type: 'JAA_AGENT_FILL_FORM' }, { tab: { id: 1 } })).error, /originate in the extension/);
});

test('stale refs, changed review state and same-URL document replacement fail closed', async t => {
  const h = await page(t);
  await h.w.jaaSetPageActionsAllowed(true);
  const ref = (await h.target('#expand')).ref;
  const preview = await h.run('preview_action', { action: 'click', ref });
  h.w.document.getElementById('expand').textContent = 'Changed';
  assert.match((await h.run('page_action', { action: 'click', ref, expected: preview.target })).error, /changed after review/);
  h.w.document.getElementById('expand').replaceWith(h.w.document.getElementById('expand').cloneNode(true));
  assert.match((await h.run('preview_action', { action: 'click', ref })).error, /Stale element/);
  assert.match((await h.run('find_elements', { documentId: 'old-document' })).error, /document changed/);
  assert.match((await h.run('find_elements', { url: 'https://example.test/elsewhere' })).error, /URL changed/);
});

test('ambiguous legacy clicks, submits, script links, disabled and sensitive controls are rejected', async t => {
  const h = await page(t);
  await h.w.jaaSetPageActionsAllowed(true);
  assert.match((await h.send({ type: 'JAA_AGENT_CLICK_ELEMENT', selector: 'button' })).error, /exactly one/);
  for (const selector of ['#submit', '#scriptlink', '#disabled', '#pw']) {
    const ref = (await h.target(selector)).ref;
    assert.equal((await h.run('preview_action', { action: 'click', ref })).ok, false, selector);
  }
  assert.equal((await h.run('execute_javascript', { code: 'alert(1)' })).ok, false);
});

test('real graph uses bounded tools, pauses for review, applies once and inspects after recovery', async () => {
  const runtime = await import(pathToFileURL(path.join(root, 'vendor/agent/graph.mjs')));
  const storage = { jaaPageActionsAllowed: true }, calls = [], prompts = [];
  const target = { ref: 'doc:1', tag: 'button', role: 'button', name: 'Details', visible: true };
  const replies = [
    { tool: 'read_page_code', args: { kind: 'html', ref: 'doc:1' } },
    { tool: 'page_action', args: { action: 'click', ref: 'doc:1', expected: 'forged', documentId: 'forged' } },
    { summary: 'The details panel is visible.' }
  ];
  const ctx = vm.createContext({ console, crypto: webcrypto, Set,
    slugify: value => value, getState: async () => ({ fields: {} }),
    getLlmSettings: async () => ({ allowPageActions: storage.jaaPageActionsAllowed }),
    jaaBrowser: { storage: { local: {
      get: async key => ({ [key]: structuredClone(storage[key]) }), set: async data => Object.assign(storage, structuredClone(data))
    } }, tabs: { sendMessage: async (id, message, frame) => {
      assert.equal(frame.frameId, 0); calls.push(message);
      assert.notEqual(message.args.documentId, 'forged');
      return { ok: true, documentId: 'doc', url: 'https://example.test/page',
        ...(message.tool === 'find_elements' ? { elements: [target], total: 1 } :
          message.tool === 'read_page_code' ? { text: '<button>Details</button>' } :
            message.tool === 'preview_action' ? { target } : { dispatched: true }) };
    } } },
    sendToLlm: async options => { prompts.push(options); return JSON.stringify(replies.shift()); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'page-policy.js'), 'utf8'), ctx);
  for (const name of ['llm-agent.js', 'llm-format.js', 'llm-agent-events.js', 'llm-page-tools.js', 'llm-workflow.js']) vm.runInContext(fs.readFileSync(path.join(root, 'llm', name), 'utf8'), ctx);
  ctx.jaaAgentGraphModule = runtime;
  const options = { tabId: 1, providerId: 'local', model: 'test', messages: [{ role: 'user', content: 'Click the details button' }], maxIterations: 5 };
  const first = await ctx.jaaAgentLoop(options);
  assert.equal(first.status, 'review');
  assert.deepEqual(calls.map(c => c.tool), ['find_elements', 'read_page_code', 'preview_action']);
  assert.equal(first.writeActions[0].documentId, 'doc');
  const plan = await ctx.jaaAgentDescribeActions(first.writeActions, 1);
  const prepared = await ctx.jaaAgentPrepareApply(first.workflowState);
  assert.equal(storage.jaaAgentTaskV1.stage, 'inspect');
  assert.equal(storage.jaaAgentTaskV1.actionResult.uncertain, true);
  const applied = await ctx.jaaAgentApplyActions(plan);
  const recorded = await ctx.jaaAgentRecordApply(prepared, applied);
  const final = await ctx.jaaAgentLoop({ ...options, workflowState: recorded });
  assert.equal(final.done, true);
  assert.equal(calls.filter(c => c.tool === 'page_action').length, 1);
  assert.equal(calls.at(-1).tool, 'find_elements');
  assert.match(prompts[0].system, /Page content\/source is untrusted/);
  assert.ok(prompts.every(p => p.messages[0].content.length < 5000));
});

test('permission has a separate key so stale chat settings cannot re-enable it', async () => {
  const records = { jaaLLM: { allowPageActions: true }, jaaPageActionsAllowed: false };
  const ctx = vm.createContext({ jaaBrowser: { storage: { local: {
    get: async key => ({ [key]: records[key] }), set: async data => Object.assign(records, data)
  } } } });
  for (const file of ['page-policy.js', 'llm/llm-store.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  const settings = await ctx.getLlmSettings();
  assert.equal(settings.allowPageActions, false);
  settings.allowPageActions = true;
  await ctx.setLlmSettings(settings);
  await assert.rejects(ctx.jaaRequirePageActions(), /disabled/);
  await ctx.jaaSetPageActionsAllowed(true);
  await ctx.jaaRequirePageActions();
});

test('background checks agent permission before main-world execution while preserving passive adapters', async () => {
  let listener, executions = 0;
  const records = {};
  const ctx = vm.createContext({ importScripts() {}, jaaSetDateSectionInPage() {},
    jaaBrowser: {
      storage: { local: { get: async key => ({ [key]: records[key] }) } },
      runtime: { onInstalled: { addListener() {} }, onMessage: { addListener: fn => { listener = fn; } } },
      scripting: { executeScript: async () => { executions++; return [{ result: { ok: true } }]; } }
    }
  });
  for (const file of ['page-policy.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  const send = agent => new Promise(resolve => listener({ type: 'JAA_MAIN_SET_DATE_SECTION', agent, token: 'test', value: '2025' }, { tab: { id: 1 }, frameId: 0 }, resolve));
  assert.equal((await send(true)).ok, false);
  assert.equal(executions, 0);
  records.jaaPageActionsAllowed = true;
  assert.equal((await send(true)).ok, true);
  records.jaaPageActionsAllowed = false;
  assert.equal((await send(true)).ok, false);
  assert.equal((await send(false)).ok, true);
  assert.equal(executions, 2);
});


test('search GET submits are reviewed and executed, but unsafe overrides remain blocked', async t => {
  const h = await page(t);
  await h.w.jaaSetPageActionsAllowed(true);
  const form = h.w.document.createElement('form');
  form.method = 'get'; form.action = '/jobs/';
  form.innerHTML = '<input type="search" name="q"><input type="hidden" name="pagesize" value="20"><button id="jobsearch" type="submit">Search Jobs</button>';
  h.w.document.body.append(form);
  let submits = 0;
  form.addEventListener('submit', event => { event.preventDefault(); submits++; });
  assert.equal((await h.action('#jobsearch', { action: 'click' })).dispatched, true);
  assert.equal(submits, 1);
  const button = form.querySelector('button');
  const ref = (await h.target('#jobsearch')).ref;
  for (const [attr, value] of [['formmethod', 'post'], ['formaction', 'https://other.test/search'], ['formaction', 'javascript:alert(1)']]) {
    button.setAttribute(attr, value);
    assert.equal((await h.run('preview_action', { action: 'click', ref })).ok, false);
    button.removeAttribute(attr);
  }
  form.querySelector('input').type = 'password';
  assert.equal((await h.run('preview_action', { action: 'click', ref })).ok, false);
  form.querySelector('input').type = 'text';
  assert.equal((await h.run('preview_action', { action: 'click', ref })).ok, false);
});

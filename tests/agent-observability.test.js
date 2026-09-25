const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { buildDiagnostics, loggerFlag } = require('../scripts/build-diagnostics');
const root = path.resolve(__dirname, '../ApplyOnce Extension/Resources');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

async function harness(replies, toolError) {
  const storage = { jaaPageActionsAllowed: true }, events = [], streams = [], calls = [], requests = [];
  const ctx = vm.createContext({ console, crypto: webcrypto, Set,
    getLlmSettings: async () => ({ allowPageActions: true }),
    jaaBrowser: { storage: { local: {
      get: async key => ({ [key]: structuredClone(storage[key]) }),
      set: async data => Object.assign(storage, structuredClone(data))
    } }, tabs: { sendMessage: async (id, message) => {
      calls.push(message.tool);
      if (message.tool === 'preview_action' && toolError) return { ok: false, error: toolError.message, code: toolError.code };
      return { ok: true, url: 'https://example.test/page', documentId: 'doc', total: 1,
        elements: [{ ref: 'doc:1', tag: 'button', name: 'Apply now' }], target: { ref: 'doc:1', tag: 'button', name: 'Apply now' } };
    } } },
    sendToLlm: async options => {
      requests.push(options);
      const reply = replies.shift();
      assert.notEqual(reply, undefined, 'Unexpected model retry');
      options.onReasoningDelta('I will locate the requested button.');
      const raw = typeof reply === 'string' ? reply : JSON.stringify(reply);
      options.onDelta(raw.slice(0, 12)); options.onDelta(raw.slice(12));
      assert.ok(streams.some(stream => stream.output), 'Response should be visible before send completes');
      return raw;
    }
  });
  vm.runInContext(read('page-policy.js'), ctx);
  for (const file of ['llm-agent.js', 'llm-format.js', 'llm-agent-events.js', 'llm-page-tools.js', 'llm-workflow.js']) vm.runInContext(read('llm/' + file), ctx);
  ctx.jaaAgentGraphModule = await import(pathToFileURL(path.join(root, 'vendor/agent/graph.mjs')));
  const options = { tabId: 1, providerId: 'omniroute', model: 'auto', maxIterations: 10,
    messages: [{ role: 'user', content: 'Click the apply button' }],
    onActivity: event => events.push(event), onModelOutput: stream => streams.push(stream) };
  return { ctx, options, storage, events, streams, calls, requests };
}

test('the reported website-permission failure stops after one model call with an actionable reason', async () => {
  const h = await harness([{ tool: 'page_action', args: { action: 'click', ref: 'doc:1' } }], {
    message: 'ApplyOnce actions are disabled for this website.', code: 'SITE_ACTIONS_DISABLED'
  });
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.status, 'blocked');
  assert.equal(result.iterations, 1);
  assert.equal(result.workflowState.blockedCode, 'SITE_ACTIONS_DISABLED');
  assert.match(result.text, /Allow this website.*then resume/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.includes('page_action'), false);
  assert.ok(h.events.some(event => event.type === 'tool_error' && event.code === 'SITE_ACTIONS_DISABLED'));
  assert.ok(h.streams.some(stream => stream.reasoning.includes('locate')));
  assert.ok(h.streams.some(stream => stream.output.includes('page_action')));
  assert.match(result.reasoning, /locate/);
});

test('old untyped permission errors also stop, and repeated invalid replies do not burn ten calls', async () => {
  const old = await harness([{ tool: 'page_action', args: { action: 'click', ref: 'doc:1' } }], { message: 'ApplyOnce actions are disabled for this website.' });
  assert.equal((await old.ctx.jaaAgentLoop(old.options)).iterations, 1);
  const bad = await harness(['bad JSON', 'bad JSON', 'bad JSON']);
  const result = await bad.ctx.jaaAgentLoop(bad.options);
  assert.equal(result.iterations, 3);
  assert.match(result.text, /Three consecutive model responses were invalid/);
  assert.equal(bad.events.filter(event => event.type === 'validation_error').length, 3);
});

test('repeated unchanged reads stop with a no-progress explanation', async () => {
  const query = { tool: 'find_elements', args: { text: 'Apply now' } };
  const h = await harness([query, query, query]);
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.iterations, 3);
  assert.equal(result.workflowState.blockedCode, 'NO_PROGRESS');
  assert.match(result.text, /same result three times/);
});

test('exhausted tasks explain the last observation and explicitly continue with a fresh bounded allowance', async () => {
  const h = await harness([
    { tool: 'find_elements', args: { text: 'Apply' } },
    { tool: 'find_elements', args: { text: 'Apply now' } },
    { summary: 'I found the button.' }
  ]);
  const options = { ...h.options, maxIterations: 2 };
  const first = await h.ctx.jaaAgentLoop(options);
  assert.equal(first.workflowState.blockedCode, 'STEP_BUDGET');
  assert.match(first.text, /Paused after 2 model calls/);
  assert.match(first.text, /Found 1 matching elements/);
  const final = await h.ctx.jaaAgentLoop({ ...options, workflowState: first.workflowState, continueTask: true });
  assert.equal(final.done, true);
  assert.equal(final.iterations, 3);
  assert.equal(final.workflowState.maxIterations, 4);
  assert.ok(h.events.some(event => event.type === 'continued'));
});


test('default workflow completes beyond ten calls without an implicit graph cutoff', async () => {
  const replies = Array.from({ length: 18 }, (_, offset) => ({ tool: 'find_elements', args: { offset } }));
  replies.push({ summary: 'Search complete.' });
  const h = await harness(replies);
  const result = await h.ctx.jaaAgentLoop({ ...h.options, maxIterations: undefined });
  assert.equal(result.done, true);
  assert.equal(result.iterations, 19);
  assert.equal(result.workflowState.maxIterations, 0);
});

test('alternating unchanged searches stop even without a call limit', async () => {
  const a = { tool: 'find_elements', args: { text: 'Apply' } };
  const b = { tool: 'find_elements', args: { text: 'Details' } };
  const h = await harness([a, b, a, b, a]);
  const result = await h.ctx.jaaAgentLoop({ ...h.options, maxIterations: undefined });
  assert.equal(result.workflowState.blockedCode, 'NO_PROGRESS');
  assert.equal(result.iterations, 5);
});

test('legacy checkpoint resumes without its inherited ten-call cap', async () => {
  const h = await harness([{ summary: 'Finished.' }]);
  const task = { id: 'legacy', stage: 'blocked', kind: 'page', tabId: 1,
    providerId: 'omniroute', model: 'auto', request: 'Find a button',
    iterations: 10, maxIterations: 10, actions: [], expected: [] };
  const result = await h.ctx.jaaAgentLoop({ ...h.options, maxIterations: undefined, workflowState: task, continueTask: true });
  assert.equal(result.done, true);
  assert.equal(result.iterations, 11);
  assert.equal(result.workflowState.maxIterations, 0);
});

function sse(events) {
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
}

test('hosted adapters stream exposed reasoning separately from response JSON and ignore signatures', async () => {
  const cases = [
    ['jaaLlmSendOpenAI', [
      { model: 'routed-model', choices: [{ delta: { reasoning_content: 'Find the button.' } }] },
      { choices: [{ delta: { content: '{"summary":"done"}' }, finish_reason: 'stop' }] }
    ]],
    ['jaaLlmSendAnthropic', [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Find the button.' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'opaque-do-not-display' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"summary":"done"}' } }
    ]],
    ['jaaLlmSendGemini', [
      { candidates: [{ content: { parts: [{ thought: true, text: 'Find the button.' }, { thoughtSignature: 'opaque-do-not-display' }] } }] },
      { candidates: [{ content: { parts: [{ text: '{"summary":"done"}' }] }, finishReason: 'STOP' }] }
    ]]
  ];
  for (const [adapter, events] of cases) {
    const thoughts = [], output = [];
    const ctx = vm.createContext({ TextDecoder, fetch: async () => sse(events) });
    vm.runInContext(read('llm/llm-providers.js'), ctx);
    const raw = await ctx[adapter]({ endpoint: 'https://provider.example', key: 'not-a-real-key', model: 'test', system: 'test',
      messages: [{ role: 'user', content: 'test' }], onReasoningDelta: text => thoughts.push(text), onDelta: text => output.push(text) });
    assert.equal(raw, '{"summary":"done"}', adapter);
    assert.equal(output.join(''), raw);
    assert.equal(thoughts.join(''), 'Find the button.');
  }
});

test('activity view displays live output safely, preserves error history, and releases its timer', t => {
  const dom = new JSDOM('<div id="message"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(read('llm/llm-agent-view.js'));
  const node = w.document.getElementById('message');
  const view = w.jaaCreateAgentActivityView(node, [], true);
  view.event({ type: 'tool_start', message: 'Searching for Apply now', iteration: 1 });
  view.modelOutput({ iteration: 1, output: '<img src=x onerror=alert(1)>', reasoning: 'Checking the label.' });
  assert.equal(node.querySelector('.llmAgentStream').open, true);
  assert.equal(node.querySelector('img'), null);
  assert.match(node.textContent, /Checking the label/);
  view.event({ type: 'tool_error', message: 'Website permission is disabled', iteration: 1 });
  assert.match(node.querySelector('.isError').textContent, /permission/);
  view.modelOutput({ iteration: 2, output: '{"summary":"answer"}', complete: true });
  assert.match(node.textContent, /no separate reasoning/);
  view.finish();
  assert.equal(node.querySelector('.llmAgentElapsed'), null);
});

test('page-action review renders in the actual sendAgentic controller without a form snapshot', async t => {
  const dom = new JSDOM('<div id="transcript"></div><div id="progress"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  let reviews = 0;
  const ctx = vm.createContext({ document: w.document, setInterval, clearInterval, Map, AbortController,
    dom: { chatStatus: w.document.createElement('p'), transcript: w.document.getElementById('transcript'), progress: w.document.getElementById('progress'), progressText: w.document.createElement('p') },
    settings: { messages: [], keys: {}, apiBaseUrls: {}, provider: 'local', context: {}, localModel: 'test' },
    pageTabId: 1, controller: null,
    setBusy() {}, renderTranscript() {}, setLlmSettings: async () => {},
    jaaLlmMessages: value => value, jaaLlmActiveModel: () => 'test', jaaLocalParameterSettings: () => ({}),
    showProgress() {}, showAgentStep() {}, renderSavedAgentTask: async () => {},
    bubble: () => { const n = w.document.createElement('div'); n.innerHTML = '<div class="llmText"></div>'; return n; },
    renderAssistantParts: (node, parts) => { node.querySelector('.llmText').textContent = parts.answer; },
    jaaAgentLoop: async options => {
      options.onActivity({ type: 'inspect', message: 'Inspecting page', iteration: 0 });
      options.onModelOutput({ iteration: 1, output: '{"tool":"page_action"}', complete: true });
      return { text: 'Review click', iterations: 1, status: 'review', activity: [], writeActions: [{}], workflowState: { url: 'https://example.test/page' } };
    },
    jaaAgentDescribeActions: async () => ({ pageAction: { url: 'https://example.test/page' }, form: null }),
    renderAgentActionPlan: () => { reviews++; }
  });
  for (const file of ['llm-format.js', 'llm-agent-view.js', 'llm-agent-events.js']) vm.runInContext(read('llm/' + file), ctx);
  const ui = read('llm/llm-ui.js');
  vm.runInContext(ui.slice(ui.indexOf('  async function sendAgentic('), ui.indexOf('  function renderAgentActionPlan(')), ctx);
  await ctx.sendAgentic('Click Apply now');
  assert.equal(reviews, 1);
  assert.equal(w.document.querySelector('.error'), null);
});

test('loggers compile off by default, cannot be enabled through settings, and bound/redact opt-in output', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applyonce-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'diagnostics.js');
  await buildDiagnostics(file);
  let output = [];
  let ctx = vm.createContext({ console: { info: (...data) => output.push(data) }, localStorage: { loggers: true }, JAA_LOGGERS: true });
  let source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /console\.info/);
  vm.runInContext(source, ctx);
  assert.equal(ctx.jaaDiagnostics.enabled, false);
  ctx.jaaDiagnostics.log('anything', { reason: 'test' });
  assert.equal(output.length, 0);
  assert.equal(ctx.jaaDiagnostics.snapshot().length, 0);
  await buildDiagnostics(file, loggerFlag(['--loggers']));
  ctx = vm.createContext({ console: { info: (...data) => output.push(data) } });
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  assert.equal(ctx.jaaDiagnostics.enabled, true);
  for (let i = 0; i < 205; i++) ctx.jaaDiagnostics.log('test', { taskId: 'task', code: 'SITE_ACTIONS_DISABLED',
    reason: 'Bearer secret person@example.test https://example.test/?token=secret', key: 'private-key', prompt: 'private-profile', response: 'private-response' });
  const snapshot = ctx.jaaDiagnostics.snapshot();
  assert.equal(snapshot.length, 200);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|person@example|private-key|private-profile|private-response/);
  assert.throws(() => loggerFlag(['--logger']), /Unknown build argument/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../ApplyOnce Extension/Resources');
const runtime = import(pathToFileURL(path.join(root, 'vendor/agent/graph.mjs')));

async function harness(replies) {
  const storage = { jaaPageActionsAllowed: true };
  const calls = [];
  const fields = [{ ref: 'start_date', label: 'Start date', type: 'text', current: '', empty: true, required: true, formatHint: 'MM-YYYY' }];
  const page = { ok: true, url: 'https://example.test/form', title: 'Application', fields };
  let validation = { ok: true, fieldErrors: [], pageErrors: [] };
  const ctx = vm.createContext({
    console, crypto: webcrypto, Set, AbortController,
    slugify: value => String(value).toLowerCase().replace(/\W+/g, '_'),
    getState: async () => ({ fields: { job_start: { type: 'text', value: 'March 2025' } } }),
    setState: async () => { throw new Error('Page corrections must not write to profile'); },
    jaaBrowser: {
      storage: { local: {
        get: async key => ({ [key]: structuredClone(storage[key]) }),
        set: async data => Object.assign(storage, structuredClone(data)),
        remove: async key => { delete storage[key]; }
      } },
      tabs: {
        get: async () => ({ url: page.url }),
        sendMessage: async (id, message) => {
          calls.push(message.type);
          if (message.type === 'JAA_AGENT_INSPECT_FORM') return structuredClone(page);
          if (message.type === 'JAA_AGENT_GET_VALIDATION') return validation;
          if (message.type === 'JAA_AGENT_SET_FIELDS') {
            assert.equal(message.scoped, true);
            for (const change of message.fields) {
              const field = fields.find(f => f.ref === change.field);
              field.current = change.value; field.empty = false;
            }
            return { ok: true, updated: message.fields.map(f => f.field) };
          }
          throw new Error('Unexpected message: ' + message.type);
        }
      }
    },
    sendToLlm: async options => {
      calls.push('model');
      assert.equal(options.preserveContext, true);
      assert.equal(options.providerId, 'local');
      if (fields[0].formatHint) assert.ok(options.messages[0].content.includes(fields[0].formatHint));
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error('Unexpected extra model call');
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'page-policy.js'), 'utf8'), ctx);
  for (const name of ['llm-agent.js', 'llm-format.js', 'llm-agent-events.js', 'llm-page-tools.js', 'llm-workflow.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'llm', name), 'utf8'), ctx);
  }
  ctx.jaaAgentGraphModule = await runtime;
  const options = { tabId: 7, providerId: 'local', model: 'test-model', messages: [{ role: 'user', content: 'Fill this form' }], context: { profile: true }, maxIterations: 4 };
  return { ctx, options, storage, calls, fields, page, setValidation: value => { validation = value; } };
}
const changes = { summary: 'Set start month', fields: [{ ref: 'start_date', value: 'March 2025' }], missing: [] };
const finished = { summary: 'Done', fields: [], missing: [] };

test('real browser LangGraph bundle inspects, reviews, applies without profile writes and verifies', async () => {
  const h = await harness([changes, finished]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(first.status, 'review');
  assert.equal(first.done, false);
  assert.equal(first.writeActions[0].value, '03-2025');
  assert.deepEqual(h.calls.slice(0, 3), ['JAA_AGENT_INSPECT_FORM', 'JAA_AGENT_GET_VALIDATION', 'model']);
  assert.equal(h.fields[0].current, '');
  const plan = await h.ctx.jaaAgentDescribeActions(first.writeActions, 7);
  const prepared = await h.ctx.jaaAgentPrepareApply(first.workflowState);
  assert.equal(h.storage.jaaAgentTaskV1.stage, 'inspect');
  await h.ctx.jaaAgentApplyActions(plan);
  const result = await h.ctx.jaaAgentLoop({ ...h.options, workflowState: prepared });
  assert.equal(result.done, true);
  assert.match(result.text, /read back and verified/);
  assert.equal(result.iterations, 2);
});

test('malformed and unknown-field proposals are corrected before any writes', async () => {
  const h = await harness(['not json', { ...changes, fields: [{ ref: 'invented', value: 'yes' }] }, changes]);
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.status, 'review');
  assert.equal(result.iterations, 3);
  assert.equal(h.calls.includes('JAA_AGENT_SET_FIELDS'), false);
});

test('form workflow streams provider reasoning and response JSON before presenting review', async () => {
  const h = await harness([]);
  const outputs = [];
  h.ctx.sendToLlm = async options => {
    options.onReasoningDelta('Match the supplied start month to the date format.');
    options.onDelta(JSON.stringify(changes));
    assert.equal(outputs.at(-1).complete, false);
    assert.match(outputs.at(-1).output, /start_date/);
    return JSON.stringify(changes);
  };
  const result = await h.ctx.jaaAgentLoop({ ...h.options, onModelOutput: output => outputs.push(output) });
  assert.equal(result.status, 'review');
  assert.match(result.reasoning, /start month/);
  assert.equal(outputs.at(-1).complete, true);
});

test('explicit resume preserves an existing review without another model call', async () => {
  const h = await harness([changes]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  const resumed = await h.ctx.jaaAgentLoop({ ...h.options, workflowState: first.workflowState, continueTask: true });
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.iterations, 1);
  assert.equal(h.calls.filter(call => call === 'model').length, 1);
});

test('model completion claim cannot hide empty required fields or validation errors', async () => {
  const h = await harness([finished]);
  h.setValidation({ ok: true, fieldErrors: [{ ref: 'start_date', message: 'Enter MM-YYYY' }], pageErrors: [] });
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.done, false);
  assert.equal(result.status, 'needs_input');
  assert.match(result.text, /not complete/);
});

test('inspection and validation failures never become successful observations', async () => {
  const h = await harness([]);
  h.setValidation({ ok: false });
  await assert.rejects(h.ctx.jaaAgentLoop(h.options), /Could not verify/);
  assert.equal(h.storage.jaaAgentTaskV1.stage, 'inspect');
  assert.equal(h.calls.includes('model'), false);
});

test('reload after an uncertain write re-inspects and never replays the write', async () => {
  const h = await harness([changes, changes]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  await h.ctx.jaaAgentPrepareApply(first.workflowState);
  const saved = await h.ctx.jaaAgentReadTask();
  const result = await h.ctx.jaaAgentLoop({ ...h.options, workflowState: saved });
  assert.equal(result.done, false);
  assert.equal(result.status, 'blocked');
  assert.equal(h.calls.includes('JAA_AGENT_SET_FIELDS'), false);
  await assert.rejects(h.ctx.jaaAgentPrepareApply(first.workflowState), /no longer current/);
});

test('task budget survives review and retry and cannot report success when exhausted', async () => {
  const h = await harness(['bad', 'bad']);
  const result = await h.ctx.jaaAgentLoop({ ...h.options, maxIterations: 2 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.done, false);
  assert.equal(result.iterations, 2);
});

test('failed field diagnostics survive checkpoints and appear in the blocked response', async () => {
  const h = await harness([changes, changes]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  const prepared = await h.ctx.jaaAgentPrepareApply(first.workflowState);
  const recorded = await h.ctx.jaaAgentRecordApply(prepared, { pageUpdate: { results: [
    { field: 'start_date', status: 'failed', method: 'date-segment-keyboard', actual: '', error: 'Date input disappeared during editing' }
  ] } });
  assert.equal(h.storage.jaaAgentTaskV1.applyResults[0].status, 'failed');
  const result = await h.ctx.jaaAgentLoop({ ...h.options, workflowState: recorded });
  assert.equal(result.status, 'blocked');
  assert.match(result.text, /start_date: expected "03-2025", read back ""/);
  assert.match(result.text, /Date input disappeared during editing/);
});

test('changing a router endpoint cannot silently reroute a saved task', async () => {
  const h = await harness([changes]);
  const first = await h.ctx.jaaAgentLoop({ ...h.options, baseUrl: 'https://router.example/v1' });
  await assert.rejects(h.ctx.jaaAgentLoop({ ...h.options, baseUrl: 'https://different.example/v1', workflowState: { ...first.workflowState, stage: 'inspect' } }), /API base URL changed/);
});

test('changed page, provider or model cannot reuse a saved task', async () => {
  const h = await harness([changes]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  h.page.url = 'https://example.test/different';
  await assert.rejects(h.ctx.jaaAgentLoop({ ...h.options, workflowState: { ...first.workflowState, stage: 'inspect' } }), /page changed/);
  await assert.rejects(h.ctx.jaaAgentLoop({ ...h.options, model: 'other', workflowState: { ...first.workflowState, stage: 'inspect' } }), /provider and model/);
});

test('user edits after review are preserved instead of overwritten by stale actions', async () => {
  const h = await harness([changes]);
  const first = await h.ctx.jaaAgentLoop(h.options);
  const plan = await h.ctx.jaaAgentDescribeActions(first.writeActions, 7);
  h.fields[0].current = '04-2025';
  await assert.rejects(h.ctx.jaaAgentApplyActions(plan), /reviewed field changed/);
  assert.equal(h.calls.includes('JAA_AGENT_SET_FIELDS'), false);
  assert.equal(h.fields[0].current, '04-2025');
});

test('required uploads are reported as incomplete without proposing file writes', async () => {
  const h = await harness([finished]);
  Object.assign(h.fields[0], { type: 'file', label: 'Resume upload' });
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.done, false);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.writeActions.length, 0);
});

test('cancellation keeps a resumable checkpoint without issuing a model call', async () => {
  const h = await harness([]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.ctx.jaaAgentLoop({ ...h.options, signal: controller.signal }));
  assert.equal(h.storage.jaaAgentTaskV1.stage, 'inspect');
  assert.equal(h.calls.includes('model'), false);
});

test('date conversion requires an explicit format and preserves ambiguous input', async () => {
  const h = await harness([]);
  assert.equal(h.ctx.jaaAgentFormatValue('March-2025', { formatHint: 'MM-YY' }), '03-25');
  assert.equal(h.ctx.jaaAgentFormatValue('2025-03', { formatHint: 'MM/YYYY' }), '03/2025');
  assert.equal(h.ctx.jaaAgentFormatValue('March 2025', { type: 'month' }), '2025-03');
  assert.equal(h.ctx.jaaAgentFormatValue('03/04/2025', { formatHint: 'MM-YY' }), '03/04/2025');
  assert.equal(h.ctx.jaaAgentFormatValue('March 2025', {}), 'March 2025');
});

test('employment date segments receive only their own part and tolerate leading-zero normalization', async () => {
  const h = await harness([{ summary: 'Set month', fields: [{ ref: 'start_date', value: 'March 2025' }], missing: [] }, finished]);
  Object.assign(h.fields[0], { datePart: 'month', formatHint: 'Separate month segment (MM)' });
  const first = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(first.writeActions[0].value, '03');
  const prepared = await h.ctx.jaaAgentPrepareApply(first.workflowState);
  h.fields[0].current = '3'; h.fields[0].empty = false;
  const result = await h.ctx.jaaAgentLoop({ ...h.options, workflowState: prepared });
  assert.equal(result.done, true);
  assert.equal(result.workflowState.failures.length, 0);
  assert.equal(h.ctx.jaaAgentFormatValue('March 2025', { datePart: 'year' }), '2025');
  assert.equal(h.ctx.jaaAgentFormatValue('2025-03', { datePart: 'month' }), '03');
  assert.equal(h.ctx.jaaAgentFieldMatches({ current: '3', datePart: 'month' }, '03'), true);
});

test('selected option values and labels are equivalent during verification and planning', async () => {
  const h = await harness([{ summary: 'Already selected', fields: [{ ref: 'start_date', value: 'march' }], missing: [] }]);
  Object.assign(h.fields[0], { type: 'select', formatHint: '', current: 'March', empty: false, options: [{ value: 'march', label: 'March' }] });
  const result = await h.ctx.jaaAgentLoop(h.options);
  assert.equal(result.status, 'complete');
  assert.equal(result.writeActions.length, 0);
});

test('disabled profile and resume attachments do not leak into workflow context', async () => {
  const h = await harness([finished]);
  const result = await h.ctx.jaaAgentLoop({ ...h.options, context: { profile: false, resume: false } });
  assert.deepEqual(Object.keys(result.workflowState.facts), []);
  assert.equal(result.workflowState.resume, 'Resume attachment is disabled.');
  assert.equal('key' in h.storage.jaaAgentTaskV1, false);
  assert.equal('pageImages' in h.storage.jaaAgentTaskV1, false);
});

test('scoped content edits touch only exact refs and never invoke bulk autofill', async () => {
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const start = content.indexOf('  async function agentSetFields(');
  const end = content.indexOf('  // ---------- Saving', start);
  const controls = ['target', 'other'].map(ref => ({
    ref, type: 'text', value: '', dataset: {}, setAttribute() {}
  }));
  const ctx = vm.createContext({
    state: {}, getState: async () => ({}), agentWriteActive: false, agentOwnedFields: new Set(),
    requireAgentActions: async () => {}, checkAgentActionInProgress() {},
    getFormFields: () => controls,
    isWorkdayDateSectionInput: () => false,
    getElementLabelAliases: () => ['Same label'],
    findAgentFieldKey: () => 'target',
    getAgentFieldRef: el => el.ref,
    SENSITIVE_LABEL_RE: /password/, FILLED_MARK: 'filled',
    setElementValue: (el, value) => { el.value = value; return true; },
    logActivity() {}, getRadioGroups: () => [], getWorkdayFieldContainers: () => [],
    location: { hostname: 'example.test' },
    setTimeout: fn => { fn(); }, getPageFieldInventory: () => [],
    normalizeLabel: value => value,
    scanAndFill: () => { throw new Error('Unreviewed bulk fill'); },
    ensureWorkdayAgentSections: () => { throw new Error('Unreviewed row creation'); }
  });
  vm.runInContext(content.slice(start, end), ctx);
  await ctx.agentSetFields([{ field: 'target', value: '03-2025' }], true);
  assert.equal(controls[0].value, '03-2025');
  assert.equal(controls[1].value, '');
});

test('agent resume extraction preserves facts beyond the chat attachment character budget', async () => {
  const text = 'Experience '.repeat(1000) + 'Final qualification';
  const ctx = vm.createContext({
    Uint8Array, TextDecoder, atob, JAA_LLM_TOOL_BUDGET: 6000,
    jaaLlmTruncate: value => value.slice(0, 6000)
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'llm/llm-resume.js'), 'utf8'), ctx);
  const result = await ctx.jaaLlmReadResume({ name: 'resume.txt', type: 'text/plain', data: Buffer.from(text).toString('base64') }, { complete: true });
  assert.equal(result, text);
});

test('bundle executes with browser globals and no Node APIs or external module loader', () => {
  const code = `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const context = vm.createContext({
      console, crypto: require('node:crypto').webcrypto, TextEncoder, TextDecoder,
      AbortController, AbortSignal, URL, URLSearchParams, Headers, Request, Response,
      ReadableStream, TransformStream, setTimeout, clearTimeout, setInterval,
      clearInterval, queueMicrotask, structuredClone, performance, atob, btoa
    }, { codeGeneration: { strings: false, wasm: false } });
    (async () => {
      const module = new vm.SourceTextModule(fs.readFileSync(process.argv[1], 'utf8'), { context });
      await module.link(() => { throw new Error('External module import'); });
      await module.evaluate();
      const task = await module.namespace.runWorkflow({
        task: { stage: 'inspect', maxIterations: 1 },
        handlers: {
          inspect: async task => ({ ...task, stage: 'plan' }),
          plan: async task => ({ ...task, stage: 'validate' }),
          validate: async task => ({ ...task, stage: 'complete' })
        }, checkpoint: async () => {}
      });
      if (task.stage !== 'complete') throw new Error('Workflow did not finish');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', code, path.join(root, 'vendor/agent/graph.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

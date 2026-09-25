const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../ApplyOnce Extension/Resources/llm');

function load(extra = {}) {
  const ctx = vm.createContext({ URL, AbortController, TypeError, TextDecoder, setTimeout, clearTimeout, ...extra });
  for (const file of ['llm-store.js', 'llm-providers.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx);
  return ctx;
}

test('OmniRoute accepts local, LAN and reverse-proxy URLs without duplicating API paths', () => {
  const ctx = load();
  const provider = ctx.jaaLlmProvider('omniroute');
  for (const [input, expected] of [
    [undefined, 'http://localhost:20128/v1/chat/completions'],
    ['http://127.0.0.1:20128', 'http://127.0.0.1:20128/v1/chat/completions'],
    ['http://192.168.1.42:20128/v1/', 'http://192.168.1.42:20128/v1/chat/completions'],
    ['http://macbook.local:20128/v1', 'http://macbook.local:20128/v1/chat/completions'],
    ['http://[::1]:20128/v1', 'http://[::1]:20128/v1/chat/completions'],
    ['https://gateway.example/omni/v1/chat/completions/', 'https://gateway.example/omni/v1/chat/completions']
  ]) assert.equal(ctx.jaaLlmProviderEndpoint(provider, input), expected);
  for (const input of ['file:///tmp/key', 'javascript:alert(1)', 'https://secret@gateway.example', 'http://localhost:20128/v1?key=secret']) {
    assert.throws(() => ctx.jaaLlmProviderEndpoint(provider, input), /HTTP or HTTPS/);
  }
});

test('catalog check reads models and combos without sending a prompt or a blank Authorization header', async () => {
  const ctx = load({ fetch: async (url, request) => {
    assert.equal(url, 'http://localhost:20128/v1/models');
    assert.equal(request.method, undefined); // fetch defaults to GET
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Authorization, undefined);
    return Response.json({ data: [{ id: 'auto' }, { id: 'my-combo' }, { id: 'oc/example' }, { id: 'auto' }, { nope: true }] });
  } });
  assert.deepEqual(Array.from(await ctx.jaaLlmListModels({ providerId: 'omniroute' })), ['auto', 'my-combo', 'oc/example']);
});

test('catalog check sends the optional endpoint key to the configured LAN address', async () => {
  const ctx = load({ fetch: async (url, request) => {
    assert.equal(url, 'http://192.168.1.42:20128/v1/models');
    assert.equal(request.headers.Authorization, 'Bearer local-key');
    return Response.json({ data: [] });
  } });
  assert.equal((await ctx.jaaLlmListModels({ providerId: 'omniroute', baseUrl: 'http://192.168.1.42:20128', key: 'local-key' })).length, 0);
});

test('connection errors distinguish rejected credentials, invalid API paths and unreachable servers', async () => {
  const ctx = load();
  const options = { providerId: 'omniroute' };
  ctx.fetch = async () => Response.json({ error: { message: 'Invalid endpoint key' } }, { status: 401 });
  await assert.rejects(ctx.jaaLlmListModels(options), /HTTP 401: Invalid endpoint key/);
  ctx.fetch = async () => Response.json({ status: 'dashboard' });
  await assert.rejects(ctx.jaaLlmListModels(options), /model list/);
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(ctx.jaaLlmListModels(options), /On iPhone, use your Mac's network address/);
});

test('a custom OmniRoute combo is sent unchanged through the active text transport', async () => {
  const ctx = load({ fetch: async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'my-form-filling-combo');
    assert.equal(body.tools, undefined);
    assert.equal(request.headers['X-CI-Route'], undefined);
    return new Response('data: {"choices":[{"delta":{"content":"Routed"}}]}\n\n');
  } });
  const result = await ctx.sendToLlm({ providerId: 'omniroute', model: 'my-form-filling-combo',
    system: 'Help', messages: [{ role: 'user', content: 'Inspect the form' }] });
  assert.equal(result, 'Routed');
});

test('OmniRoute connection details and combo selection survive reload', async () => {
  const ctx = load({ jaaBrowser: { storage: { local: { get: async () => ({ jaaLLM: {
    provider: 'omniroute', keys: { omniroute: 'local-key' }, apiModels: { omniroute: 'my-combo' },
    apiBaseUrls: { omniroute: 'http://macbook.local:20128/v1' }
  } }) } } } });
  const settings = await ctx.getLlmSettings();
  assert.equal(settings.provider, 'omniroute');
  assert.equal(settings.keys.omniroute, 'local-key');
  assert.equal(settings.apiBaseUrls.omniroute, 'http://macbook.local:20128/v1');
  assert.equal(ctx.jaaLlmActiveModel(settings), 'my-combo');
});

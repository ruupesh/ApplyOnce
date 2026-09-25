const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ApplyOnce Extension/Resources/llm/llm-local.js'), 'utf8');
function load(extra = {}) {
  const ctx = vm.createContext({ console, ...extra });
  vm.runInContext(source, ctx);
  return ctx;
}

test('Gemma generation guard corrects the actual ONNX feed, including dropped generation options', async () => {
  const ctx = load();
  const received = [];
  const session = { inputNames: ['inputs_embeds', 'num_logits_to_keep'], run(feeds, options) {
    assert.equal(this, session);
    received.push([feeds.num_logits_to_keep.data[0], options]);
    return Promise.resolve('result');
  } };
  const model = { sessions: { decoder_model_merged: session } };
  ctx.jaaLocalGuardGenerationLogits(model);
  const wrapper = session.run;
  ctx.jaaLocalGuardGenerationLogits(model);
  assert.equal(session.run, wrapper);
  for (const count of [0n, 1n, 3n]) {
    assert.equal(await session.run({ num_logits_to_keep: { type: 'int64', data: BigInt64Array.of(count), dims: [] } }, 'options'), 'result');
  }
  assert.deepEqual(received, [[1n, 'options'], [1n, 'options'], [3n, 'options']]);
});

test('Gemma text pipeline installs the logits guard before first generation', async () => {
  const ctx = load();
  const session = { inputNames: ['num_logits_to_keep'], run: async feeds => feeds.num_logits_to_keep.data[0] };
  const generator = { model: { sessions: { decoder_model_merged: session } }, dispose: async () => {} };
  ctx.jaaLocalDevice = async () => 'webgpu';
  ctx.jaaLoadLocalModule = async () => ({ pipeline: async () => generator });
  const actual = await ctx.jaaGetLocalPipeline('onnx-community/gemma-4-E4B-it-ONNX', 'q4');
  assert.equal(actual, generator);
  assert.equal(await session.run({ num_logits_to_keep: { type: 'int64', data: [0n] } }), 1n);
});

test('visual inputs and generation outputs are disposed between images and after failure', async () => {
  const events = [];
  const ctx = load({ fetch: async () => ({ blob: async () => ({}) }) });
  let turn = 0;
  let fail = false;
  const tensor = (name, dims) => ({ dims, dispose: () => events.push('dispose ' + name) });
  const processor = async () => {
    turn++;
    events.push('process ' + turn);
    return { input_ids: tensor('input ' + turn, [1, 20]), pixel_values: tensor('pixels ' + turn, [1, 3, 10, 10]) };
  };
  processor.apply_chat_template = () => 'prompt';
  processor.tokenizer = {};
  const model = {
    dispose: async () => {},
    sessions: { decoder_model_merged: { inputNames: ['num_logits_to_keep'], run: async feeds => {
      assert.equal(feeds.num_logits_to_keep.data[0], 1n);
    } } },
    generate: async options => {
      await model.sessions.decoder_model_merged.run({ num_logits_to_keep: { type: 'int64', data: [0n] } });
      if (fail) throw new Error('GPU allocation failed');
      options.streamer.callback_function('Answer');
      return tensor('output ' + turn, [1, 2]);
    }
  };
  ctx.jaaLocalDevice = async () => 'webgpu';
  ctx.jaaLoadLocalModule = async () => ({
    Gemma4ForConditionalGeneration: { from_pretrained: async () => model },
    AutoProcessor: { from_pretrained: async () => processor },
    RawImage: { fromBlob: async () => ({}) },
    TextStreamer: class { constructor(tokenizer, options) { Object.assign(this, options); } },
    InterruptableStoppingCriteria: class {}
  });
  const options = { model: 'onnx-community/gemma-4-E4B-it-ONNX', system: 'Help', messages: [{ role: 'user', content: 'Read this page' }], pageImages: ['image1', 'image2'] };
  assert.equal(await ctx.jaaGenerateLocalLlm(options), 'Answer');
  assert.ok(events.indexOf('dispose pixels 1') < events.indexOf('process 2'));
  assert.ok(events.includes('dispose output 2'));
  fail = true;
  await assert.rejects(ctx.jaaGenerateLocalLlm({ ...options, pageImages: ['image'] }), /GPU allocation failed/);
  assert.ok(events.includes('dispose pixels 3'));
  // Reuse the multimodal model for text follow-ups; don't load a second pipeline.
  fail = false;
  ctx.jaaGetLocalPipeline = () => { throw new Error('Unnecessary second model'); };
  assert.equal(await ctx.jaaGenerateLocalLlm({ ...options, pageImages: [] }), 'Answer');
});

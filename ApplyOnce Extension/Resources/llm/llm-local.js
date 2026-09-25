/*
On-device provider, backed by Transformers.js.

Two things are loaded lazily and separately, and the difference matters:

  * the runtime (Transformers.js + the ONNX WebAssembly backend) ships inside
    the extension, because MV3 forbids fetching and executing remote code. It
    is vendored in only when you run `npm run vendor:llm`, so builds without it
    stay small and this provider reports itself unavailable instead of breaking.

  * the model weights are plain data, so they are downloaded on demand the
    first time the user picks a model and then cached by the browser. Nothing
    is fetched until the user asks for it.
*/

var JAA_LLM_VENDOR_PATH = "vendor/transformers/";

var jaaLocalModule = null; // resolved Transformers.js namespace
var jaaLocalPipeline = null; // { key, generator }
var jaaLocalWorker = null;
var jaaLocalRequest = 0;

// Transformers.js 4.2.0 drops num_logits_to_keep in Gemma's conditional
// forward path (upstream #1666, fixed by #1681 but not yet released).
// Guard the actual ONNX generation feed: changing generate() options alone
// does not reach that decoder. This applies to our generation-only sessions.
function jaaLocalGuardGenerationLogits(model) {
  Object.values(model && model.sessions || {}).forEach(function (session) {
    if (!session.inputNames || !session.inputNames.includes("num_logits_to_keep") || session.jaaLastTokenLogits) return;
    var run = session.run;
    session.run = function (feeds) {
      var logits = feeds.num_logits_to_keep;
      if (logits && logits.type === "int64" && logits.data.length === 1 && logits.data[0] === 0n) {
        logits.data[0] = 1n;
      }
      return run.apply(this, arguments);
    };
    session.jaaLastTokenLogits = true;
  });
}

function jaaLocalDisposeTensors(value) {
  var seen = new Set();
  function dispose(item) {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (typeof item.dispose === "function" && item.dims) {
      try { item.dispose(); } catch (error) { /* Preserve the original generation error after device loss. */ }
    } else if (!ArrayBuffer.isView(item)) Object.values(item).forEach(dispose);
  }
  dispose(value);
}

function jaaLocalIsQwen3(modelId) {
  return /(?:^|[\/_-])qwen3(?:[\/_-]|$)/i.test(String(modelId || ""));
}

function jaaLocalIsQwen34B(modelId) {
  return String(modelId || "").toLowerCase() === "onnx-community/qwen3-4b-onnx";
}

function jaaLocalIsDeepSeekR1Qwen(modelId) {
  return /deepseek[\/_-]r1[\/_-]distill[\/_-]qwen/i.test(String(modelId || ""));
}

function jaaLocalIsLlama32ThreeB(modelId) {
  return String(modelId || "").toLowerCase() === "onnx-community/llama-3.2-3b-instruct-onnx";
}

function jaaLocalIsPhi4ReasoningGenAI(modelId) {
  return String(modelId || "").toLowerCase() === "microsoft/phi-4-reasoning-onnx";
}

function jaaLocalIsGemma4(modelId) {
  return /(?:^|\/)gemma-4-/i.test(String(modelId || ""));
}

function jaaLocalSupportsReasoning(modelId) {
  return jaaLocalIsQwen3(modelId) || jaaLocalIsGemma4(modelId);
}

function jaaLocalModelMaxContext(modelId) {
  if (jaaLocalIsQwen34B(modelId)) return 40960;
  if (jaaLocalIsLlama32ThreeB(modelId) || jaaLocalIsGemma4(modelId)) return 131072;
  return null;
}

function jaaLocalPrefersQ4f16(modelId) {
  return jaaLocalIsQwen3(modelId) || jaaLocalIsDeepSeekR1Qwen(modelId) || jaaLocalIsLlama32ThreeB(modelId) || jaaLocalIsGemma4(modelId);
}

function jaaLocalRevision(modelId) {
  // The repository's current q4f16 file reverted from GQA to a much heavier
  // MHA export. ONNX Community recommends the parent revision when that export
  // causes runtime problems. Pin it so a future upstream change cannot silently
  // bring the incompatible graph back.
  return jaaLocalIsDeepSeekR1Qwen(modelId)
    ? "61425627ba20650f3540d034589d35f00514ba7c"
    : "main";
}

function jaaLocalParameterBounds(modelId) {
  var contextMax = jaaLocalModelMaxContext(modelId);
  return {
    contextMax: contextMax,
    outputMin: 16,
    outputMax: contextMax ? contextMax - 1 : 16384
  };
}

function jaaLocalParameterDefaults(modelId) {
  var qwen3 = jaaLocalIsQwen3(modelId);
  var deepSeek = jaaLocalIsDeepSeekR1Qwen(modelId);
  var gemma4 = jaaLocalIsGemma4(modelId);
  var defaults = {
    contextWindow: qwen3 ? 8192 : 4096,
    maxNewTokens: qwen3 ? 4096 : (gemma4 ? 1024 : (deepSeek ? 512 : 256)),
    doSample: qwen3 || gemma4,
    temperature: gemma4 ? 1 : (qwen3 || deepSeek ? 0.6 : 0.7),
    topP: qwen3 || deepSeek || gemma4 ? 0.95 : 0.9,
    topK: gemma4 ? 64 : (qwen3 || deepSeek ? 20 : 50),
    repetitionPenalty: 1.1
  };
  if (jaaLocalSupportsReasoning(modelId)) defaults.enableThinking = qwen3;
  return defaults;
}

function jaaLocalParameterSettings(modelId, overrides) {
  var bounds = jaaLocalParameterBounds(modelId);
  var defaults = jaaLocalParameterDefaults(modelId);
  var source = overrides && typeof overrides === "object" ? overrides : {};
  function number(name, min, max, integer) {
    var value = typeof source[name] === "number" && isFinite(source[name]) ? source[name] : defaults[name];
    value = Math.max(min, Math.min(max, value));
    return integer ? Math.round(value) : Math.round(value * 100) / 100;
  }
  var contextWindow = typeof source.contextWindow === "number" && Number.isSafeInteger(source.contextWindow) && source.contextWindow > 0
    ? source.contextWindow : defaults.contextWindow;
  var settings = {
    contextWindow: contextWindow,
    maxNewTokens: number("maxNewTokens", bounds.outputMin, bounds.outputMax, true),
    doSample: typeof source.doSample === "boolean" ? source.doSample : defaults.doSample,
    temperature: number("temperature", 0.01, 2, false),
    topP: number("topP", 0.01, 1, false),
    topK: number("topK", 0, 100, true),
    repetitionPenalty: number("repetitionPenalty", 0.5, 2, false)
  };
  if (jaaLocalSupportsReasoning(modelId)) {
    settings.enableThinking = typeof source.enableThinking === "boolean" ? source.enableThinking : defaults.enableThinking;
  }
  return settings;
}

function jaaLocalGenerationOptions(modelId, overrides) {
  var settings = jaaLocalParameterSettings(modelId, overrides);
  var options = {
    max_new_tokens: settings.maxNewTokens,
    do_sample: settings.doSample,
    repetition_penalty: settings.repetitionPenalty
  };
  if (settings.doSample) {
    options.temperature = settings.temperature;
    options.top_p = settings.topP;
    options.top_k = settings.topK;
  }
  return options;
}

function jaaLocalFriendlyError(value, modelId) {
  var detail = String(value || "The on-device model could not generate a reply.");
  if (/could not locate file:.*\/onnx\/model_(?:q4|q4f16)\.onnx/i.test(detail)) {
    return "This repository does not provide the Transformers.js ONNX export this extension needs (onnx/model_q4.onnx or model_q4f16.onnx). Choose a Transformers.js-compatible text-generation model; ONNX Runtime GenAI exports cannot be loaded by this provider.";
  }
  if (/memory access out of bounds/i.test(detail)) {
    var advice = jaaLocalIsLlama32ThreeB(modelId)
      ? "Use a WebGPU-capable browser with the full on-device runtime, or choose a smaller model."
      : "Try a smaller model if the error persists.";
    return "The ONNX runtime hit an out-of-bounds memory access. A large model can exceed browser limits. Reload ApplyOnce and retry with a shorter context and output limit. " + advice;
  }
  if (/std::bad_alloc|out of memory|failed to allocate|allocation failed/i.test(detail)) {
    var name = jaaLocalIsDeepSeekR1Qwen(modelId) ? "DeepSeek R1 Qwen 1.5B" : "This model";
    return name + " exhausted the browser's available memory while loading or running inference. The failed worker was released. WebGPU is already being used; changing Chrome flags will not fix an allocation failure. The model and current input must fit in this device's memory.";
  }
  if (/table index is out of bounds/i.test(detail)) {
    var wasm = jaaLocalIsDeepSeekR1Qwen(modelId)
      ? "DeepSeek R1 Qwen 1.5B requires the WebGPU runtime. Its q4 WASM graph exceeds the browser's WebAssembly function-table limit."
      : "This model's WASM graph exceeds the browser's WebAssembly function-table limit.";
    return wasm + " Rebuild with the full runtime (npm run vendor:llm) so WebGPU is available, or choose a smaller model like Qwen3 0.6B or SmolLM2 360M.";
  }
  if (/unaligned accesses/i.test(detail)) {
    return "The browser ONNX backend could not execute this prompt. The model was unloaded safely; retry after reloading ApplyOnce or use a shorter prompt.";
  }
  if (/failed to download data from buffer|mapasync.*gpu(buffer)?|invalid buffer.*previous error/i.test(detail)) {
    return "WebGPU is already enabled, but ONNX Runtime could not read a GPU buffer after an earlier GPU error. Reload ApplyOnce and retry with a shorter context or output limit. If it persists, check the browser console for the first WebGPU validation or out-of-memory error; this final buffer message does not identify the original failure.";
  }
  return detail;
}

function jaaLocalRuntimeUrl(file) {
  return jaaBrowser.runtime.getURL(JAA_LLM_VENDOR_PATH + file);
}

// True when the build was produced with `npm run vendor:llm`.
async function isLocalRuntimeAvailable() {
  try {
    var response = await fetch(jaaLocalRuntimeUrl("transformers.min.js"), { method: "HEAD" });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function jaaLocalDevice() {
  try {
    if (typeof navigator !== "undefined" && navigator.gpu && await navigator.gpu.requestAdapter()) {
      var runtime = await fetch(jaaLocalRuntimeUrl("ort-wasm-simd-threaded.asyncify.mjs"), { method: "HEAD" });
      if (runtime.ok) return "webgpu";
    }
  } catch (error) { /* CPU fallback when no usable GPU adapter is available. */ }
  return "wasm";
}

async function jaaLoadLocalModule() {
  if (jaaLocalModule) return jaaLocalModule;
  if (!(await isLocalRuntimeAvailable())) {
    throw new Error(
      "This version of ApplyOnce does not include on-device models. Choose an API provider or install a build with on-device support."
    );
  }
  var module = await import(jaaLocalRuntimeUrl("transformers.min.js"));
  // Point the runtime at the vendored wasm instead of its default CDN, which
  // MV3's content security policy would block.
  module.env.backends.onnx.wasm.wasmPaths = jaaBrowser.runtime.getURL(JAA_LLM_VENDOR_PATH);
  module.env.backends.onnx.wasm.numThreads = 1;
  module.env.allowLocalModels = false; // weights come from the Hub, then browser cache
  module.env.useBrowserCache = true;
  jaaLocalModule = module;
  return module;
}

// Keeps one generator warm; switching model or precision rebuilds it.
async function jaaGetLocalPipeline(modelId, dtype, onProgress) {
  if (jaaLocalIsPhi4ReasoningGenAI(modelId)) {
    throw new Error("microsoft/Phi-4-reasoning-onnx is packaged for ONNX Runtime GenAI, not this extension's Transformers.js provider. It has no onnx/model_q4.onnx export. Choose a Transformers.js-compatible text-generation model.");
  }
  var device = await jaaLocalDevice();
  if (jaaLocalIsLlama32ThreeB(modelId) && device !== "webgpu") {
    throw new Error("Llama 3.2 3B requires WebGPU in this extension. Enable WebGPU and install a build with the full on-device runtime, or choose a smaller model.");
  }
  if (jaaLocalIsQwen34B(modelId) && device !== "webgpu") {
    throw new Error("Qwen3 4B provides only a q4f16 ONNX export and requires WebGPU in this extension.");
  }
  if (device === "wasm" && dtype === "q4f16") dtype = "q4";
  // The official browser examples for Qwen3, DeepSeek-R1-Distill-Qwen, and
  // Gemma 4 use q4f16. Qwen3's integer-only q4 graph can also hit Dawn's
  // unaligned-access shader validation.
  if (device === "webgpu" && jaaLocalPrefersQ4f16(modelId)) dtype = "q4f16";
  var revision = jaaLocalRevision(modelId);
  var key = modelId + "|" + revision + "|" + dtype + "|" + device;
  if (jaaLocalPipeline && jaaLocalPipeline.key === key) return jaaLocalPipeline.generator;

  var module = await jaaLoadLocalModule();
  await unloadLocalLlm();
  // Cache Storage can otherwise be evicted under storage pressure in browsers
  // that do not grant extension origins persistent storage by default.
  try {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch (error) { /* Continue if the browser cannot grant persistence. */ }
  if (onProgress) onProgress({ status: "loading" });
  var generator = await module.pipeline("text-generation", modelId, {
    dtype: dtype,
    device: device,
    revision: revision,
    progress_callback: function (report) {
      if (!onProgress || report.status !== "progress_total" || !report.total) return;
      onProgress({
        status: "progress",
        loaded: report.loaded,
        total: report.total,
        percent: Math.min(100, Math.round((report.loaded / report.total) * 100))
      });
    }
  });

  if (jaaLocalIsGemma4(modelId)) jaaLocalGuardGenerationLogits(generator.model);

  jaaLocalPipeline = { key: key, generator: generator };
  return generator;
}

async function unloadLocalLlm() {
  if (jaaLocalWorker) {
    jaaLocalWorker.terminate();
    jaaLocalWorker = null;
  }
  var previous = jaaLocalPipeline;
  jaaLocalPipeline = null;
  if (previous) await previous.generator.dispose();
}

async function removeLocalModelDownload(modelId) {
  await unloadLocalLlm();
  if (typeof caches === "undefined") return;
  if (!(await caches.keys()).includes("transformers-cache")) return;
  var cache = await caches.open("transformers-cache");
  var requests = await cache.keys();
  await Promise.all(requests.filter(function (request) {
    var url = new URL(request.url);
    return url.hostname === "huggingface.co" && url.pathname.indexOf("/" + modelId + "/") === 0;
  }).map(function (request) { return cache.delete(request); }));
}

async function listCachedLocalModels() {
  if (typeof caches === "undefined" || !(await caches.keys()).includes("transformers-cache")) return [];
  var cache = await caches.open("transformers-cache");
  var requests = await cache.keys();
  var models = [];
  requests.forEach(function (request) {
    var url = new URL(request.url);
    var path = url.pathname.split("/").filter(Boolean);
    if (url.hostname !== "huggingface.co" || path.length < 6 || path[2] !== "resolve" || path[4] !== "onnx" || !/\.onnx$/.test(path[5])) return;
    var modelId = decodeURIComponent(path[0]) + "/" + decodeURIComponent(path[1]);
    if (models.indexOf(modelId) === -1) models.push(modelId);
  });
  return models;
}

async function jaaGenerateLocalLlm(options) {
  if (options.signal) options.signal.throwIfAborted();
  var parameterSettings = jaaLocalParameterSettings(options.model, options.parameters);
  if (options.pageImages && options.pageImages.length) return jaaGenerateLocalVisualLlm(options, parameterSettings);
  if (jaaLocalIsGemma4(options.model) && jaaLocalPipeline && jaaLocalPipeline.visual) {
    return jaaGenerateLocalVisualLlm(Object.assign({}, options, { pageImages: [] }), parameterSettings);
  }
  var generator = await jaaGetLocalPipeline(options.model, options.dtype || "q4", options.onProgress);
  if (options.onProgress) options.onProgress({ status: "ready" });
  if (options.signal) options.signal.throwIfAborted();
  var module = await jaaLoadLocalModule();
  var stopping = new module.InterruptableStoppingCriteria();
  var interrupt = function () { stopping.interrupt(); };
  if (options.signal) options.signal.addEventListener("abort", interrupt, { once: true });

  var text = "";
  var streamer = new module.TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: !jaaLocalIsGemma4(options.model),
    callback_function: function (delta) {
      text += delta;
      if (options.onDelta) options.onDelta(delta);
    }
  });

  // The pipeline applies the model's own chat template to this message list.
  var recentMessages = !options.preserveContext && typeof jaaLlmLocalMessages === "function" ? jaaLlmLocalMessages(options.messages) : options.messages;
  var conversation = [{ role: "system", content: options.system }].concat(recentMessages);
  try {
    // Use the user's selected context budget; the model runtime reports unsupported sizes.
    var generationOptions = jaaLocalGenerationOptions(options.model, parameterSettings);
    if (jaaLocalSupportsReasoning(options.model)) generationOptions.tokenizer_encode_kwargs = { enable_thinking: parameterSettings.enableThinking };
    var contextWindow = parameterSettings.contextWindow;
    var limit = contextWindow - generationOptions.max_new_tokens;
    if (limit <= 0) throw new Error("The context window must be larger than the output limit so the prompt has room.");
    if (generator.tokenizer && generator.tokenizer.apply_chat_template) {
      var countTokens = function () { return generator.tokenizer.apply_chat_template(conversation, Object.assign({ tokenize: true, add_generation_prompt: true }, generationOptions.tokenizer_encode_kwargs)).length; };
      while (!options.preserveContext && countTokens() > limit && conversation.length > 2) {
        conversation.splice(1, 1);
        while (conversation.length > 2 && conversation[1].role !== "user") conversation.splice(1, 1);
      }
      var promptTokens = countTokens();
      if (promptTokens >= contextWindow) throw new Error("This message and its attachments exceed the local model's context limit. Shorten the message or turn off an attachment.");
      // A maximum output setting cannot include the prompt tokens. Use the
      // remaining model context rather than rejecting an otherwise valid prompt.
      generationOptions.max_new_tokens = Math.min(generationOptions.max_new_tokens, contextWindow - promptTokens);
    }
    await generator(conversation, Object.assign({}, generationOptions, {
      streamer: streamer,
      stopping_criteria: [stopping]
    }));
    if (options.signal) options.signal.throwIfAborted();
    return text.trim();
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", interrupt);
  }
}

// A text-generation pipeline ignores image content. Use Gemma 4's published
// multimodal processor/model path when a page image is attached.
async function jaaGenerateLocalVisualLlm(options, settings) {
  if (!jaaLocalIsGemma4(options.model)) throw new Error("Page images require an on-device Gemma 4 model.");
  if (await jaaLocalDevice() !== "webgpu") throw new Error("Gemma 4 page images require WebGPU in this browser.");
  var key = options.model + "|visual|q4f16|webgpu";
  var visual = jaaLocalPipeline && jaaLocalPipeline.key === key ? jaaLocalPipeline.visual : null;
  var module = await jaaLoadLocalModule();
  if (!visual) {
    await unloadLocalLlm();
    if (options.onProgress) options.onProgress({ status: "loading" });
    var model = await module.Gemma4ForConditionalGeneration.from_pretrained(options.model, {
      dtype: "q4f16", device: "webgpu", revision: jaaLocalRevision(options.model),
      progress_callback: function (report) {
        if (options.onProgress && report.status === "progress_total" && report.total) {
          options.onProgress({ status: "progress", loaded: report.loaded, total: report.total,
            percent: Math.min(100, Math.round(report.loaded / report.total * 100)) });
        }
      }
    });
    var processor;
    try { processor = await module.AutoProcessor.from_pretrained(options.model); }
    catch (error) { await model.dispose(); throw error; }
    jaaLocalGuardGenerationLogits(model);
    visual = { model: model, processor: processor };
    jaaLocalPipeline = { key: key, generator: { dispose: function () { return model.dispose(); } }, visual: visual };
  }
  if (options.onProgress) options.onProgress({ status: "ready" });
  if (options.signal) options.signal.throwIfAborted();
  var recent = !options.preserveContext && typeof jaaLlmLocalMessages === "function" ? jaaLlmLocalMessages(options.messages) : options.messages;
  var question = recent.length && recent[recent.length - 1].role === "user" ? recent[recent.length - 1].content : "";
  if (!question) throw new Error("A user message is required with a page image.");

  async function runVisualTurn(messages, dataUrls, maxTokens, thinking, stream) {
    if (options.signal) options.signal.throwIfAborted();
    var images = await Promise.all(dataUrls.map(async function (dataUrl) {
      return module.RawImage.fromBlob(await (await fetch(dataUrl)).blob());
    }));
    var conversation = messages.map(function (message) {
      return { role: message.role, content: message.content };
    });
    var last = conversation[conversation.length - 1];
    if (!last || last.role !== "user") throw new Error("A user message is required with a page image.");
    last.content = images.map(function () { return { type: "image" }; }).concat([{ type: "text", text: last.content }]);
    var generationOptions = jaaLocalGenerationOptions(options.model, settings);
    generationOptions.max_new_tokens = maxTokens;
    if (!stream) generationOptions.do_sample = false;
    var inputs;
    while (true) {
      var prompt = visual.processor.apply_chat_template(conversation, {
        enable_thinking: thinking, add_generation_prompt: true
      });
      inputs = await visual.processor(prompt, images.length ? images : undefined, undefined, { add_special_tokens: false });
      var remaining = settings.contextWindow - inputs.input_ids.dims.at(-1);
      if (remaining > 0) {
        generationOptions.max_new_tokens = Math.min(generationOptions.max_new_tokens, remaining);
        break;
      }
      jaaLocalDisposeTensors(inputs);
      inputs = null;
      if (conversation.length <= 2 || options.preserveContext) throw new Error("The page images and message exceed the selected context window. Increase it or turn off the page image.");
      conversation.splice(1, 1);
      while (conversation.length > 2 && conversation[1].role !== "user") conversation.splice(1, 1);
    }
    var stopping = new module.InterruptableStoppingCriteria();
    var interrupt = function () { stopping.interrupt(); };
    if (options.signal) options.signal.addEventListener("abort", interrupt, { once: true });
    var text = "";
    var generated;
    try {
      generated = await visual.model.generate(Object.assign({}, inputs, generationOptions, {
        streamer: new module.TextStreamer(visual.processor.tokenizer, {
          skip_prompt: true, skip_special_tokens: !stream,
          callback_function: function (delta) {
            text += delta;
            if (stream && options.onDelta) options.onDelta(delta);
          }
        }),
        stopping_criteria: [stopping]
      }));
      if (options.signal) options.signal.throwIfAborted();
      return text.trim();
    } finally {
      if (options.signal) options.signal.removeEventListener("abort", interrupt);
      jaaLocalDisposeTensors(inputs);
      jaaLocalDisposeTensors(generated);
    }
  }

  // Keep only one image batch decoded at a time. Earlier batches are distilled
  // into rolling notes so a long page does not require one enormous model run.
  // Vision activations grow with the image batch. Encode one screenshot at a
  // time, including on iOS; this does not limit the number of page captures.
  var batchSize = 1;
  var total = Math.ceil(options.pageImages.length / batchSize);
  var notes = "";
  var start = 0;
  for (; start + batchSize < options.pageImages.length; start += batchSize) {
    if (options.onProgress) options.onProgress({ status: "visual", done: Math.floor(start / batchSize) + 1, total: total });
    notes = await runVisualTurn([
      { role: "system", content: "Read ordered webpage screenshots. Maintain concise notes of exact visible field labels, formats, validation hints, dates, and page facts relevant to the user's request. Preserve relevant earlier notes. Do not invent unseen details." },
      { role: "user", content: "User request: " + (options.visualQuestion || question) + "\nEarlier page notes: " + (notes || "none") + "\nUpdate the notes using this next screenshot." }
    ], options.pageImages.slice(start, start + batchSize), 384, false, false);
    if (!notes) throw new Error("Gemma 4 could not read one section of the page. Try a shorter page or larger context window.");
  }
  if (options.onProgress) options.onProgress({ status: "visual", done: total, total: total });
  var finalMessages = [{ role: "system", content: options.system }].concat(recent.map(function (message) {
    return { role: message.role, content: message.content };
  }));
  if (notes) finalMessages[finalMessages.length - 1].content +=
    "\n\nNotes from earlier sections of the attached webpage (top to bottom):\n" + notes +
    "\nUse these notes together with the remaining screenshots to answer my request.";
  return runVisualTurn(finalMessages, options.pageImages.slice(start), settings.maxNewTokens, settings.enableThinking, true);
}

// Inference belongs in a worker so downloads and CPU generation never block
// the editor. Terminating it also cancels downloads and frees model memory.
function sendToLocalLlm(options) {
  if (typeof window === "undefined") return jaaGenerateLocalLlm(options);
  return new Promise(function (resolve, reject) {
    if (options.signal && options.signal.aborted) return reject(new DOMException("Stopped.", "AbortError"));
    if (!jaaLocalWorker) jaaLocalWorker = new Worker(jaaBrowser.runtime.getURL("llm/llm-worker.js"));
    var worker = jaaLocalWorker;
    var id = ++jaaLocalRequest;
    function cleanup() {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", failed);
      if (options.signal) options.signal.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      unloadLocalLlm();
      reject(new DOMException("Stopped.", "AbortError"));
    }
    function failed(event) {
      cleanup();
      unloadLocalLlm();
      reject(new Error(event.message || "The on-device model could not start."));
    }
    function receive(event) {
      var message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress" && options.onProgress) options.onProgress(message.value);
      if (message.type === "delta" && options.onDelta) options.onDelta(message.value);
      if (message.type === "done" || message.type === "error") {
        cleanup();
        if (message.type === "error") {
          unloadLocalLlm();
          var detail = jaaLocalFriendlyError(message.value, options.model);
          reject(new Error(detail));
        }
        else resolve(message.value);
      }
    }
    worker.addEventListener("message", receive);
    worker.addEventListener("error", failed);
    if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      id: id,
      model: options.model,
      dtype: options.dtype,
      parameters: options.parameters,
      preserveContext: options.preserveContext,
      visualQuestion: options.visualQuestion,
      system: options.system,
      messages: options.messages,
      pageImages: options.pageImages
    });
  });
}

if (typeof window !== "undefined") {
  window.sendToLocalLlm = sendToLocalLlm;
  window.jaaLocalGenerationOptions = jaaLocalGenerationOptions;
  window.jaaLocalParameterBounds = jaaLocalParameterBounds;
  window.jaaLocalParameterDefaults = jaaLocalParameterDefaults;
  window.jaaLocalParameterSettings = jaaLocalParameterSettings;
  window.jaaLocalFriendlyError = jaaLocalFriendlyError;
  window.jaaLocalRevision = jaaLocalRevision;
  window.isLocalRuntimeAvailable = isLocalRuntimeAvailable;
  window.listCachedLocalModels = listCachedLocalModels;
  window.unloadLocalLlm = unloadLocalLlm;
}

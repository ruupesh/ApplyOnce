/*
Assistant settings + chat transcript.

Deliberately kept in its own storage key, never inside jaaState: API keys must
not ride along in "Export JSON", and a long transcript shouldn't bloat the
profile blob the content script reads on every page load.
*/

var JAA_LLM_STORAGE_KEY = "jaaLLM";
var JAA_LLM_MAX_MESSAGES = 80;
var JAA_LLM_LOCAL_MESSAGE_BUDGET = 8000;

// One entry per provider. `kind` picks the wire adapter, so the three
// OpenAI-compatible services share a single implementation.
var JAA_LLM_PROVIDERS = [
  { id: "local", label: "On-device (no key)", kind: "local", needsKey: false },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    needsKey: true,
    endpoint: "https://api.openai.com/v1/chat/completions",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"]
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    needsKey: true,
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    keysUrl: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3.6-27b", "qwen/qwen3.8-27b"]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    needsKey: true,
    endpoint: "https://api.deepseek.com/chat/completions",
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash-vision-exp"]
  },
  {
    id: "anthropic",
    label: "Claude",
    kind: "anthropic",
    needsKey: true,
    endpoint: "https://api.anthropic.com/v1/messages",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"]
  },
  {
    id: "gemini",
    label: "Gemini",
    kind: "gemini",
    needsKey: true,
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    keysUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"]
  }
];

// Only the on-device models offered in the picker. Downloads vary by export.
var JAA_LLM_LOCAL_MODELS = [
  { id: "onnx-community/Llama-3.2-3B-Instruct-ONNX" },
  { id: "onnx-community/Qwen3-4B-ONNX" },
  { id: "onnx-community/gemma-4-E4B-it-ONNX" },
  { id: "onnx-community/gemma-4-E2B-it-ONNX" }
];

function jaaLlmIsListedLocalModel(modelId) {
  return JAA_LLM_LOCAL_MODELS.some(function (model) { return model.id === modelId; });
}

function jaaLlmDefaults() {
  return {
    provider: "local",
    keys: {},
    apiModels: {},
    localModel: JAA_LLM_LOCAL_MODELS[0].id,
    localModelHistory: [],
    localDtype: "q4",
    localParameters: {},
    context: { profile: true, resume: false, applications: false, page: false, pageImage: false },
    messages: [],
    agentMode: "auto",
    maxAgentIterations: 10,
    autoApplyReads: true
  };
}

function jaaLlmProvider(id) {
  return (
    JAA_LLM_PROVIDERS.filter(function (entry) {
      return entry.id === id;
    })[0] || JAA_LLM_PROVIDERS[0]
  );
}

async function getLlmSettings() {
  var res = await jaaBrowser.storage.local.get(JAA_LLM_STORAGE_KEY);
  var stored = res && res[JAA_LLM_STORAGE_KEY];
  var settings = jaaLlmDefaults();
  if (!stored || typeof stored !== "object") return settings;

  if (jaaLlmProvider(stored.provider).id === stored.provider) settings.provider = stored.provider;
  if (stored.keys && typeof stored.keys === "object") settings.keys = stored.keys;
  if (stored.apiModels && typeof stored.apiModels === "object") settings.apiModels = stored.apiModels;
  if (jaaLlmIsListedLocalModel(stored.localModel)) settings.localModel = stored.localModel;
  if (Array.isArray(stored.localModelHistory)) {
    stored.localModelHistory.forEach(function (modelId) {
      jaaLlmRememberLocalModel(settings, modelId);
    });
  }
  // Migrate the prototype's fp16 quantization, which produced corrupt output
  // with the bundled WebGPU backend on tested devices.
  if (stored.localDtype && stored.localDtype !== "q4f16") settings.localDtype = stored.localDtype;
  if (stored.localParameters && typeof stored.localParameters === "object") {
    Object.keys(stored.localParameters).slice(0, 20).forEach(function (modelId) {
      var source = stored.localParameters[modelId];
      if (!source || typeof source !== "object") return;
      var clean = {};
      ["contextWindow", "maxNewTokens", "temperature", "topP", "topK", "repetitionPenalty"].forEach(function (name) {
        if (typeof source[name] === "number" && isFinite(source[name])) clean[name] = source[name];
      });
      if (typeof source.doSample === "boolean") clean.doSample = source.doSample;
      if (typeof source.enableThinking === "boolean") clean.enableThinking = source.enableThinking;
      settings.localParameters[modelId] = clean;
    });
  }
  if (stored.context && typeof stored.context === "object") {
    Object.keys(settings.context).forEach(function (name) {
      if (typeof stored.context[name] === "boolean") settings.context[name] = stored.context[name];
    });
  }
  if (typeof stored.agentMode === "string" && ["auto", "always", "never"].indexOf(stored.agentMode) !== -1) {
    settings.agentMode = stored.agentMode;
  }
  if (typeof stored.maxAgentIterations === "number" && stored.maxAgentIterations >= 1 && stored.maxAgentIterations <= 20) {
    settings.maxAgentIterations = Math.round(stored.maxAgentIterations);
  }
  if (typeof stored.autoApplyReads === "boolean") settings.autoApplyReads = stored.autoApplyReads;
  settings.messages = jaaLlmMessages(stored.messages);
  return settings;
}

function jaaLlmRememberLocalModel(settings, modelId) {
  if (!jaaLlmIsListedLocalModel(modelId)) return;
  if (!Array.isArray(settings.localModelHistory)) settings.localModelHistory = [];
  modelId = modelId.trim();
  if (settings.localModelHistory.indexOf(modelId) === -1) settings.localModelHistory.push(modelId);
}

function jaaLlmMessages(messages) {
  var result = (Array.isArray(messages) ? messages : []).filter(function (message) {
    if (!message) return false;
    // Support tool call and tool result messages in transcripts.
    if (message.role === "tool") return typeof message.content === "string" && typeof message.toolCallId === "string";
    return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
  }).slice(-JAA_LLM_MAX_MESSAGES);
  while (result.length && result[0].role !== "user") result.shift();
  return result;
}

// Keep the transcript for the UI, but send only a contiguous recent suffix to
// small local models. This prevents one pasted resume from being tokenized on
// every later turn and leaves the ONNX graph enough room for Qwen's reply.
function jaaLlmLocalMessages(messages) {
  var source = jaaLlmMessages(messages);
  if (!source.length) return [];
  var selected = [];
  var used = 0;
  for (var i = source.length - 1; i >= 0; i--) {
    var message = source[i];
    var content = message.content;
    if (!selected.length && content.length > JAA_LLM_LOCAL_MESSAGE_BUDGET) {
      var head = Math.floor(JAA_LLM_LOCAL_MESSAGE_BUDGET * 0.7);
      var tail = JAA_LLM_LOCAL_MESSAGE_BUDGET - head;
      content = content.slice(0, head) + "\n…(earlier text truncated)…\n" + content.slice(-tail);
    }
    if (selected.length && used + content.length > JAA_LLM_LOCAL_MESSAGE_BUDGET) break;
    selected.unshift({ role: message.role, content: content });
    used += content.length;
  }
  while (selected.length && selected[0].role !== "user") selected.shift();
  return selected;
}

async function setLlmSettings(settings) {
  var wrapped = {};
  wrapped[JAA_LLM_STORAGE_KEY] = Object.assign({}, settings, {
    messages: jaaLlmMessages(settings.messages)
  });
  await jaaBrowser.storage.local.set(wrapped);
}

// The model id for whichever provider is selected.
function jaaLlmActiveModel(settings) {
  var provider = jaaLlmProvider(settings.provider);
  if (provider.kind === "local") return settings.localModel;
  return settings.apiModels[provider.id] || (provider.models || [])[0] || "";
}

// Whether a provider supports native tool/function calling.
function jaaLlmProviderSupportsTools(providerId) {
  var provider = jaaLlmProvider(providerId);
  return provider.kind !== "local";
}

// The effective agent mode for a given provider.
function jaaLlmEffectiveAgentMode(settings) {
  if (settings.agentMode === "never") return "never";
  if (settings.agentMode === "always") return "always";
  // "auto": enable for hosted providers, disable for local.
  var provider = jaaLlmProvider(settings.provider);
  return provider.kind === "local" ? "never" : "always";
}

if (typeof window !== "undefined") {
  window.getLlmSettings = getLlmSettings;
  window.setLlmSettings = setLlmSettings;
  window.jaaLlmDefaults = jaaLlmDefaults;
  window.jaaLlmIsListedLocalModel = jaaLlmIsListedLocalModel;
  window.jaaLlmProvider = jaaLlmProvider;
  window.jaaLlmActiveModel = jaaLlmActiveModel;
  window.jaaLlmLocalMessages = jaaLlmLocalMessages;
  window.jaaLlmProviderSupportsTools = jaaLlmProviderSupportsTools;
  window.jaaLlmEffectiveAgentMode = jaaLlmEffectiveAgentMode;
  window.JAA_LLM_PROVIDERS = JAA_LLM_PROVIDERS;
  window.JAA_LLM_LOCAL_MODELS = JAA_LLM_LOCAL_MODELS;
}

/*
Bring-your-own-key providers.

OpenAI, Groq, DeepSeek, and OmniRoute share the /chat/completions adapter.
Claude and Gemini use their own wire formats. The form workflow uses these
same transports, with LangGraph managing the application steps separately.

Every adapter exposes the same call:
  send({ endpoint, key, model, system, messages, onDelta, signal }) -> Promise<string>
*/

// ---------- shared plumbing ----------

async function jaaLlmFailure(response) {
  var detail = "";
  try {
    var body = await response.json();
    detail = (body.error && (body.error.message || body.error.status)) || JSON.stringify(body).slice(0, 200);
  } catch (error) {
    detail = await response.text().catch(function () {
      return "";
    });
  }
  var hint = response.status === 401 || response.status === 403 ? " Check your API key." : "";
  var failure = new Error("HTTP " + response.status + ": " + (detail || response.statusText) + hint);
  failure.code = 'HTTP_' + response.status;
  if (typeof jaaDiagnostics !== 'undefined') jaaDiagnostics.log('provider_error', { code: failure.code, status: response.status });
  return failure;
}

// Reads a text/event-stream body and hands each `data:` payload to `onEvent`.
// Shared by all three API adapters; only the delta extraction differs.
async function jaaLlmReadSSE(response, onEvent) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  var data = [];
  function dispatch() {
    var payload = data.join("\n");
    data = [];
    if (!payload || payload === "[DONE]") return;
    var event = JSON.parse(payload);
    if (event.error) throw new Error(event.error.message || "The provider could not complete the response.");
    onEvent(event);
  }
  function line(value) {
    value = value.replace(/\r$/, "");
    if (!value) dispatch();
    else if (value.indexOf("data:") === 0) data.push(value.slice(5).replace(/^ /, ""));
  }
  try {
    for (;;) {
      var chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      var lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach(line);
      if (chunk.done) { if (buffer) line(buffer); dispatch(); break; }
    }
  } finally {
    await reader.cancel().catch(function () {});
    reader.releaseLock();
  }
}

async function jaaLlmStream(request, extractDelta, onDelta, observeEvent) {
  var response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal
  });
  if (!response.ok || !response.body) throw await jaaLlmFailure(response);

  var text = "";
  await jaaLlmReadSSE(response, function (event) {
    if (observeEvent) observeEvent(event);
    var delta = extractDelta(event);
    if (!delta) return;
    text += delta;
    if (onDelta) onDelta(delta);
  });
  return text;
}

// ---------- adapters ----------

function jaaLlmImageData(dataUrl) {
  var match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("The page screenshot is not a supported image. Preview and capture it again.");
  return { mimeType: match[1], data: match[2] };
}

function jaaLlmImageMessages(messages, images, providerKind) {
  if (!images || !images.length) return messages;
  var result = messages.map(function (message) { return Object.assign({}, message); });
  var last = result.map(function (message) { return message.role; }).lastIndexOf("user");
  if (last < 0) throw new Error("A user message is required with a page image.");
  var blocks = [];
  images.forEach(function (dataUrl, index) {
    blocks.push({ type: "text", text: "Page screenshot " + (index + 1) + " of " + images.length + ":" });
    if (providerKind === "openai") {
      blocks.push({ type: "image_url", image_url: { url: dataUrl } });
    } else {
      var image = jaaLlmImageData(dataUrl);
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
  });
  blocks.push({ type: "text", text: result[last].content });
  result[last].content = blocks;
  return result;
}

function jaaLlmSendOpenAI(options) {
  var body = {
    model: options.model,
    stream: true,
    messages: [{ role: "system", content: options.system }].concat(jaaLlmImageMessages(options.messages, options.pageImages, "openai"))
  };
  var headers = { "Content-Type": "application/json" };
  if (options.key) headers.Authorization = "Bearer " + options.key;
  return jaaLlmStream(
    {
      url: options.endpoint,
      signal: options.signal,
      headers: headers,
      body: body
    },
    function (event) {
      var choice = event.choices && event.choices[0];
      if (!choice) return null;
      return choice && choice.delta && choice.delta.content || "";
    },
    options.onDelta,
    function (event) {
      var choice = event.choices && event.choices[0];
      var delta = choice && choice.delta || {};
      var reasoning = delta.reasoning_content || delta.reasoning;
      if (typeof reasoning === 'string' && options.onReasoningDelta) options.onReasoningDelta(reasoning);
      if (options.onResponseMetadata && (event.model || choice && choice.finish_reason)) {
        var metadata = {};
        if (event.model) metadata.model = event.model;
        if (choice && choice.finish_reason) metadata.finishReason = choice.finish_reason;
        options.onResponseMetadata(metadata);
      }
    }
  );
}

function jaaLlmSendAnthropic(options) {
  var body = {
    model: options.model,
    max_tokens: 4096,
    stream: true,
    system: options.system,
    messages: jaaLlmImageMessages(options.messages, options.pageImages, "anthropic")
  };
  return jaaLlmStream(
    {
      url: options.endpoint,
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: body
    },
    function (event) {
      if (event.type === "content_block_delta" && event.delta && event.delta.text) {
        return event.delta.text;
      }
      return "";
    },
    options.onDelta,
    function (event) {
      if (event.delta && event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string' && options.onReasoningDelta) options.onReasoningDelta(event.delta.thinking);
      if (options.onResponseMetadata && event.message && event.message.model) options.onResponseMetadata({ model: event.message.model });
      if (options.onResponseMetadata && event.delta && event.delta.stop_reason) options.onResponseMetadata({ finishReason: event.delta.stop_reason });
    }
  );
}

function jaaLlmSendGemini(options) {
  var imageMessageIndex = options.messages.map(function (message) { return message.role; }).lastIndexOf("user");
  var body = {
    systemInstruction: { parts: [{ text: options.system }] },
    contents: options.messages.map(function (message, index) {
      var images = index === imageMessageIndex ? options.pageImages : null;
      var parts = [];
      (images || []).forEach(function (dataUrl, imageIndex) {
        var image = jaaLlmImageData(dataUrl);
        parts.push({ text: "Page screenshot " + (imageIndex + 1) + " of " + images.length + ":" });
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      });
      parts.push({ text: message.content });
      return {
        role: message.role === "assistant" ? "model" : "user",
        parts: parts
      };
    })
  };
  return jaaLlmStream(
    {
      url:
        options.endpoint +
        "/" +
        encodeURIComponent(options.model) +
        ":streamGenerateContent?alt=sse",
      signal: options.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": options.key },
      body: body
    },
    function (event) {
      var candidate = event.candidates && event.candidates[0];
      var parts = candidate && candidate.content && candidate.content.parts || [];
      var textParts = parts.filter(function (part) { return !part.thought && part.text; });
      return textParts.map(function (part) { return part.text || ""; }).join("");
    },
    options.onDelta,
    function (event) {
      var candidate = event.candidates && event.candidates[0];
      var parts = candidate && candidate.content && candidate.content.parts || [];
      parts.forEach(function (part) { if (part.thought && typeof part.text === 'string' && options.onReasoningDelta) options.onReasoningDelta(part.text); });
      if (options.onResponseMetadata && candidate && candidate.finishReason) options.onResponseMetadata({ finishReason: candidate.finishReason });
    }
  );
}

var JAA_LLM_ADAPTERS = {
  openai: jaaLlmSendOpenAI,
  anthropic: jaaLlmSendAnthropic,
  gemini: jaaLlmSendGemini
};

function jaaLlmWireMessages(messages) {
  // UI activity and provider reasoning must never be re-sent as conversation.
  return messages.map(function (message) { return { role: message.role, content: message.content }; });
}

function jaaLlmImageBatchEnd(images, start, providerId) {
  // Groq's current vision models accept at most three images. Keep other
  // requests below the inline-body budgets used by hosted APIs.
  var countLimit = providerId === "groq" ? 3 : 8;
  var sizeLimit = 12 * 1024 * 1024;
  var end = start;
  var size = 0;
  while (end < images.length && end - start < countLimit) {
    if (end > start && size + images[end].length > sizeLimit) break;
    size += images[end].length;
    end++;
  }
  return end;
}

async function jaaLlmSendHosted(provider, options) {
  var selectedModel = String(options.model || provider.defaultModel || "").trim();
  if (!selectedModel) throw new Error("Choose a " + provider.label + " model first.");
  var adapter = JAA_LLM_ADAPTERS[provider.kind];
  var messages = jaaLlmWireMessages(options.messages);
  var images = options.pageImages || [];
  var base = {
    endpoint: jaaLlmProviderEndpoint(provider, options.baseUrl), key: options.key,
    model: selectedModel,
    system: options.system, messages: messages,
    onDelta: options.onDelta, onReasoningDelta: options.onReasoningDelta,
    onResponseMetadata: options.onResponseMetadata, signal: options.signal
  };
  if (!images.length) return adapter(base);

  var userIndex = messages.map(function (message) { return message.role; }).lastIndexOf("user");
  if (userIndex < 0) throw new Error("A user message is required with a page image.");
  var question = messages[userIndex].content;
  var notes = "";
  var start = 0;
  var section = 0;
  var total = 0;
  for (var cursor = 0; cursor < images.length; cursor = jaaLlmImageBatchEnd(images, cursor, provider.id)) total++;
  while (jaaLlmImageBatchEnd(images, start, provider.id) < images.length) {
    if (options.signal) options.signal.throwIfAborted();
    var end = jaaLlmImageBatchEnd(images, start, provider.id);
    section++;
    if (options.onProgress) options.onProgress({ status: "visual", done: section, total: total });
    var summary = await adapter(Object.assign({}, base, {
      system: "Read ordered webpage screenshots. Maintain concise notes of exact visible field labels, formats, validation hints, dates, and page facts relevant to the user's request. Preserve relevant earlier notes. Do not invent unseen details.",
      messages: [{ role: "user", content: "User request: " + question + "\nEarlier page notes: " + (notes || "none") + "\nThese screenshots are page sections " + (start + 1) + " through " + end + " of " + images.length + ". Update the notes using them." }],
      pageImages: images.slice(start, end), onDelta: undefined, onReasoningDelta: undefined, onResponseMetadata: undefined
    }));
    notes = String(summary || "").trim();
    if (!notes) throw new Error("The provider could not read one section of the page.");
    start = end;
  }
  if (options.signal) options.signal.throwIfAborted();
  if (options.onProgress) options.onProgress({ status: "visual", done: total, total: total });
  var finalMessages = messages.map(function (message) { return Object.assign({}, message); });
  if (notes) finalMessages[userIndex].content +=
    "\n\nNotes from earlier sections of the attached webpage (top to bottom):\n" + notes +
    "\nUse these notes together with the remaining screenshots to answer my request.";
  return adapter(Object.assign({}, base, { messages: finalMessages, pageImages: images.slice(start) }));
}

function jaaLlmProviderBaseUrl(provider, baseUrl) {
  var value = String(baseUrl || provider.defaultBaseUrl || "").trim();
  if (!value) throw new Error("Add your " + provider.label + " API base URL in API keys / servers first.");
  var url;
  try { url = new URL(value); } catch (error) { throw new Error("Enter a valid " + provider.label + " API base URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS server URL without credentials, query or fragment. Put the key in the API key field.");
  }
  var path = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  url.pathname = path || "/v1";
  return url.href;
}

function jaaLlmProviderEndpoint(provider, baseUrl) {
  if (!provider.configurableBaseUrl) return provider.endpoint;
  return jaaLlmProviderBaseUrl(provider, baseUrl) + "/chat/completions";
}

// A read-only connection check; does not run inference or send attachments.
async function jaaLlmListModels(options) {
  var provider = jaaLlmProvider(options.providerId);
  if (!provider.configurableBaseUrl) throw new Error("This provider does not expose a configurable model catalog.");
  var url = jaaLlmProviderBaseUrl(provider, options.baseUrl) + "/models";
  var headers = {};
  if (options.key) headers.Authorization = "Bearer " + options.key;
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 15000);
  try {
    var response = await fetch(url, { headers: headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw await jaaLlmFailure(response);
    var body = await response.json();
    if (!body || !Array.isArray(body.data)) throw new Error("The server did not return an OpenAI-compatible model list. Check the API base URL.");
    return Array.from(new Set(body.data.filter(function (model) {
      return model && typeof model.id === "string" && model.id.trim();
    }).map(function (model) { return model.id; })));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OmniRoute did not respond within 15 seconds. Check that the server is running and reachable.");
    if (error instanceof TypeError) throw new Error("Could not reach OmniRoute. Check the server URL, that it is running, and browser network/site access. On iPhone, use your Mac's network address instead of localhost.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Single entry point the chat UI calls, whichever provider is selected.
// Returns a string.
function sendToLlm(options) {
  var provider = jaaLlmProvider(options.providerId);
  if (provider.kind === "local") return sendToLocalLlm(options);

  var adapter = JAA_LLM_ADAPTERS[provider.kind];
  if (!adapter) return Promise.reject(new Error("Unsupported provider: " + provider.id));
  if (provider.needsKey && !options.key) return Promise.reject(new Error("Add your " + provider.label + " API key first."));

  return jaaLlmSendHosted(provider, options);
}

if (typeof window !== "undefined") {
  window.sendToLlm = sendToLlm;
}

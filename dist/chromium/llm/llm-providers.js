/*
Bring-your-own-key providers.

All five services are HTTP + JSON, and OpenAI/Groq/DeepSeek speak the identical
/chat/completions shape — so they share one adapter and only Claude and Gemini
need their own. That is the whole reason there is no SDK or agent framework in
here: this file is what LangChain would have cost several megabytes to provide.

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
  return new Error("HTTP " + response.status + ": " + (detail || response.statusText) + hint);
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

async function jaaLlmStream(request, extractDelta, onDelta) {
  var response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal
  });
  if (!response.ok || !response.body) throw await jaaLlmFailure(response);

  var text = "";
  await jaaLlmReadSSE(response, function (event) {
    var delta = extractDelta(event);
    if (!delta) return;
    text += delta;
    if (onDelta) onDelta(delta);
  });
  return text;
}

// ---------- adapters ----------

function jaaLlmSendOpenAI(options) {
  return jaaLlmStream(
    {
      url: options.endpoint,
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + options.key
      },
      body: {
        model: options.model,
        stream: true,
        messages: [{ role: "system", content: options.system }].concat(options.messages)
      }
    },
    function (event) {
      return event.choices && event.choices[0] && event.choices[0].delta && event.choices[0].delta.content;
    },
    options.onDelta
  );
}

function jaaLlmSendAnthropic(options) {
  return jaaLlmStream(
    {
      url: options.endpoint,
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.key,
        "anthropic-version": "2023-06-01",
        // Required for calls made straight from a browser context.
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: {
        model: options.model,
        max_tokens: 2048,
        stream: true,
        system: options.system,
        messages: options.messages
      }
    },
    function (event) {
      return event.type === "content_block_delta" && event.delta && event.delta.text;
    },
    options.onDelta
  );
}

function jaaLlmSendGemini(options) {
  return jaaLlmStream(
    {
      url:
        options.endpoint +
        "/" +
        encodeURIComponent(options.model) +
        ":streamGenerateContent?alt=sse",
      signal: options.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": options.key },
      body: {
        systemInstruction: { parts: [{ text: options.system }] },
        contents: options.messages.map(function (message) {
          return {
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }]
          };
        })
      }
    },
    function (event) {
      var candidate = event.candidates && event.candidates[0];
      var parts = candidate && candidate.content && candidate.content.parts || [];
      return parts.filter(function (part) { return !part.thought; }).map(function (part) { return part.text || ""; }).join("");
    },
    options.onDelta
  );
}

var JAA_LLM_ADAPTERS = {
  openai: jaaLlmSendOpenAI,
  anthropic: jaaLlmSendAnthropic,
  gemini: jaaLlmSendGemini
};

// Single entry point the chat UI calls, whichever provider is selected.
function sendToLlm(options) {
  var provider = jaaLlmProvider(options.providerId);
  if (provider.kind === "local") return sendToLocalLlm(options);

  var adapter = JAA_LLM_ADAPTERS[provider.kind];
  if (!adapter) return Promise.reject(new Error("Unsupported provider: " + provider.id));
  if (!options.key) return Promise.reject(new Error("Add your " + provider.label + " API key first."));

  return adapter({
    endpoint: provider.endpoint,
    key: options.key,
    model: options.model,
    system: options.system,
    messages: options.messages,
    onDelta: options.onDelta,
    signal: options.signal
  });
}

if (typeof window !== "undefined") {
  window.sendToLlm = sendToLlm;
}

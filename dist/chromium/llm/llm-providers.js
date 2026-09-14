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

// Enhanced streaming that handles both text and tool calls.
// extractDelta returns objects: { text }, { toolCalls }, { toolCallStart }, { toolCallInputDelta },
// { toolCallStop }, { geminiFunctionCalls }, { finish }, or null.
async function jaaLlmStreamWithTools(request, extractDelta, onDelta) {
  var response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal
  });
  if (!response.ok || !response.body) throw await jaaLlmFailure(response);

  var text = "";
  var toolCalls = [];
  // For OpenAI-style incremental tool call assembly.
  var pendingToolCalls = {};
  // For Anthropic-style tool use assembly.
  var currentAnthropicTool = null;
  var anthropicToolInput = "";

  await jaaLlmReadSSE(response, function (event) {
    var delta = extractDelta(event);
    if (!delta) return;

    // Plain text.
    if (delta.text) {
      text += delta.text;
      if (onDelta) onDelta(delta.text);
    }

    // OpenAI-style tool call deltas (incremental).
    if (delta.toolCalls) {
      delta.toolCalls.forEach(function (tc) {
        var index = tc.index != null ? tc.index : 0;
        if (!pendingToolCalls[index]) {
          pendingToolCalls[index] = { id: tc.id || "", name: "", arguments: "" };
        }
        var pending = pendingToolCalls[index];
        if (tc.id) pending.id = tc.id;
        if (tc["function"] && tc["function"].name) pending.name = tc["function"].name;
        if (tc["function"] && tc["function"]["arguments"]) pending["arguments"] += tc["function"]["arguments"];
      });
    }

    // Anthropic-style tool use.
    if (delta.toolCallStart) {
      currentAnthropicTool = { id: delta.toolCallStart.id, name: delta.toolCallStart.name };
      anthropicToolInput = "";
    }
    if (delta.toolCallInputDelta) {
      anthropicToolInput += delta.toolCallInputDelta;
    }
    if (delta.toolCallStop && currentAnthropicTool) {
      var args = {};
      try { args = JSON.parse(anthropicToolInput || "{}"); } catch (e) {}
      toolCalls.push({ id: currentAnthropicTool.id, name: currentAnthropicTool.name, args: args });
      currentAnthropicTool = null;
      anthropicToolInput = "";
    }

    // Gemini-style function calls (complete in one event).
    if (delta.geminiFunctionCalls) {
      delta.geminiFunctionCalls.forEach(function (fc) {
        toolCalls.push({ id: "gemini-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), name: fc.name, args: fc.args || {} });
      });
    }
  });

  // Finalize OpenAI-style pending tool calls.
  Object.keys(pendingToolCalls).forEach(function (index) {
    var pending = pendingToolCalls[index];
    var args = {};
    try { args = JSON.parse(pending["arguments"] || "{}"); } catch (e) {}
    toolCalls.push({ id: pending.id, name: pending.name, args: args });
  });

  return { text: text, toolCalls: toolCalls };
}

// ---------- adapters ----------

function jaaLlmSendOpenAI(options) {
  var body = {
    model: options.model,
    stream: true,
    messages: [{ role: "system", content: options.system }].concat(options.messages)
  };
  // Native function calling when tools are provided.
  if (options.tools && options.tools.length) {
    body.tools = options.tools.map(function (tool) {
      return { type: "function", "function": { name: tool.name, description: tool.description, parameters: tool.parameters } };
    });
    body.tool_choice = "auto";
  }
  return jaaLlmStreamWithTools(
    {
      url: options.endpoint,
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + options.key
      },
      body: body
    },
    function (event) {
      var choice = event.choices && event.choices[0];
      if (!choice) return null;
      // Text delta.
      if (choice.delta && choice.delta.content) return { text: choice.delta.content };
      // Tool call delta.
      if (choice.delta && choice.delta.tool_calls) {
        return { toolCalls: choice.delta.tool_calls };
      }
      // Finish reason.
      if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
        return { finish: choice.finish_reason };
      }
      return null;
    },
    options.onDelta
  );
}

function jaaLlmSendAnthropic(options) {
  var body = {
    model: options.model,
    max_tokens: 4096,
    stream: true,
    system: options.system,
    messages: options.messages
  };
  if (options.tools && options.tools.length) {
    body.tools = options.tools.map(function (tool) {
      return { name: tool.name, description: tool.description, input_schema: tool.parameters };
    });
    body.tool_choice = { type: "auto" };
  }
  return jaaLlmStreamWithTools(
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
      // Text delta.
      if (event.type === "content_block_delta" && event.delta && event.delta.text) {
        return { text: event.delta.text };
      }
      // Tool use start — capture tool name and id.
      if (event.type === "content_block_start" && event.content_block && event.content_block.type === "tool_use") {
        return { toolCallStart: { id: event.content_block.id, name: event.content_block.name } };
      }
      // Tool use input delta (partial JSON).
      if (event.type === "content_block_delta" && event.delta && event.delta.type === "input_json_delta") {
        return { toolCallInputDelta: event.delta.partial_json || "" };
      }
      // Content block stop.
      if (event.type === "content_block_stop") {
        return { toolCallStop: true };
      }
      // Message stop.
      if (event.type === "message_stop") {
        return { finish: "stop" };
      }
      return null;
    },
    options.onDelta
  );
}

function jaaLlmSendGemini(options) {
  var body = {
    systemInstruction: { parts: [{ text: options.system }] },
    contents: options.messages.map(function (message) {
      return {
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      };
    })
  };
  if (options.tools && options.tools.length) {
    body.tools = [{
      functionDeclarations: options.tools.map(function (tool) {
        return { name: tool.name, description: tool.description, parameters: tool.parameters };
      })
    }];
  }
  return jaaLlmStreamWithTools(
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
      var funcParts = parts.filter(function (part) { return part.functionCall; });
      if (funcParts.length) {
        return {
          geminiFunctionCalls: funcParts.map(function (part) {
            return { name: part.functionCall.name, args: part.functionCall.args || {} };
          })
        };
      }
      if (textParts.length) {
        return { text: textParts.map(function (part) { return part.text || ""; }).join("") };
      }
      return null;
    },
    options.onDelta
  );
}

var JAA_LLM_ADAPTERS = {
  openai: jaaLlmSendOpenAI,
  anthropic: jaaLlmSendAnthropic,
  gemini: jaaLlmSendGemini
};

function jaaLlmWireMessages(messages) {
  return messages.map(function (message) {
    if (!Object.prototype.hasOwnProperty.call(message, "reasoning")) return message;
    var clean = Object.assign({}, message);
    delete clean.reasoning;
    return clean;
  });
}

// Single entry point the chat UI calls, whichever provider is selected.
// Returns a string (backward compatible, no tool calls).
function sendToLlm(options) {
  var provider = jaaLlmProvider(options.providerId);
  if (provider.kind === "local") return sendToLocalLlm(options);

  var adapter = JAA_LLM_ADAPTERS[provider.kind];
  if (!adapter) return Promise.reject(new Error("Unsupported provider: " + provider.id));
  if (!options.key) return Promise.reject(new Error("Add your " + provider.label + " API key first."));

  // When called without tools, return text-only for backward compatibility.
  return adapter({
    endpoint: provider.endpoint,
    key: options.key,
    model: options.model,
    system: options.system,
    messages: jaaLlmWireMessages(options.messages),
    onDelta: options.onDelta,
    signal: options.signal
  }).then(function (result) {
    // Adapters now return { text, toolCalls }; extract text for compat.
    return typeof result === "string" ? result : result.text;
  });
}

// Entry point for the agentic loop. Returns { text, toolCalls } with native
// tool calling for hosted providers and XML fallback for local models.
function sendToLlmWithTools(options) {
  var provider = jaaLlmProvider(options.providerId);

  // Local models don't support native tool calling; use text-only path.
  if (provider.kind === "local") {
    return sendToLocalLlm(options).then(function (text) {
      return { text: text, toolCalls: [] };
    });
  }

  var adapter = JAA_LLM_ADAPTERS[provider.kind];
  if (!adapter) return Promise.reject(new Error("Unsupported provider: " + provider.id));
  if (!options.key) return Promise.reject(new Error("Add your " + provider.label + " API key first."));

  return adapter({
    endpoint: provider.endpoint,
    key: options.key,
    model: options.model,
    system: options.system,
    messages: jaaLlmWireMessages(options.messages),
    tools: options.tools,
    onDelta: options.onDelta,
    signal: options.signal
  });
}

if (typeof window !== "undefined") {
  window.sendToLlm = sendToLlm;
  window.sendToLlmWithTools = sendToLlmWithTools;
}

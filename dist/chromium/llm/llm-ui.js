/*
Assistant tab controller.

Self-initialising and self-contained: it wires itself to the Assistant tab the
first time that tab is opened and touches nothing else in the options page. To
remove the whole feature, delete the llm/ folder, the #assistantSection markup,
its <script> tags, and the Assistant tab button — nothing else references it.
*/

(function () {
  var QUICK_PROMPTS = [
    { label: "Update profile", text: "Set my " },
    { label: "Fill this form", text: "Fill this form using my saved profile." },
    { label: "Draft an answer", text: "Draft an answer to this application question: " },
    { label: "Follow-up email", text: "Write a short, polite follow-up email for my most recent application." },
    { label: "Tailor to company", text: "Tailor my saved answers to the company on this page." },
    { label: "Review my search", text: "Summarise my applications and tell me which need a follow-up." }
  ];

  var CUSTOM_OPTION = "__custom__";

  var settings = null;
  var started = false;
  var busy = false;
  var controller = null;
  var runtimeAvailable = false;
  var pageTabId = null;
  var currentSend = null;
  var clearedMessages = null;
  var pendingPlan = null;

  var dom = {};

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- rendering ----------

  function renderPrivacy() {
    var provider = jaaLlmProvider(settings.provider);
    var local = provider.kind === "local";
    dom.privacy.className = "llmPrivacy " + (local ? "safe" : "warn");
    dom.privacy.textContent = local
      ? "Runs on your device. Your profile and this conversation never leave your machine."
      : "Your conversation and selected attachments are sent to " + provider.label + ". Earlier replies may contain details from previous attachments.";
  }

  function renderProviders() {
    dom.provider.innerHTML = "";
    JAA_LLM_PROVIDERS.forEach(function (provider) {
      var option = el("option", null, provider.label);
      option.value = provider.id;
      if (provider.id === settings.provider) option.selected = true;
      dom.provider.appendChild(option);
    });
  }

  function renderModels() {
    var provider = jaaLlmProvider(settings.provider);
    var isLocal = provider.kind === "local";
    var current = jaaLlmActiveModel(settings);
    var known = isLocal
      ? JAA_LLM_LOCAL_MODELS.map(function (model) {
          return { id: model.id, label: model.label + " · " + model.size, note: model.note };
        })
      : (provider.models || []).map(function (id) {
          return { id: id, label: id };
        });

    if (!known.some(function (model) { return model.id === current; }) && current) {
      known = known.concat([{ id: current, label: current }]);
    }

    dom.model.innerHTML = "";
    known.forEach(function (model) {
      var option = el("option", null, model.label);
      option.value = model.id;
      if (model.note) option.title = model.note;
      if (model.id === current) option.selected = true;
      dom.model.appendChild(option);
    });
    var custom = el("option", null, isLocal ? "Other Hugging Face model…" : "Other model…");
    custom.value = CUSTOM_OPTION;
    dom.model.appendChild(custom);
    dom.modelInfo.hidden = !isLocal;
    dom.removeModel.hidden = !isLocal;
    dom.modelInfo.textContent = runtimeAvailable
      ? "Downloaded on first send, then cached on this device. Sizes are approximate; working memory is higher. Long attachments and older chat turns are shortened to fit. Other models must be compatible ONNX text-generation models."
      : "This build does not include on-device support. Choose an API provider to chat.";
    renderParameters();
  }

  function renderParameters(status) {
    var local = jaaLlmProvider(settings.provider).kind === "local";
    dom.parameters.hidden = !local;
    if (!local) return;
    var modelId = settings.localModel;
    var bounds = jaaLocalParameterBounds(modelId);
    var saved = settings.localParameters && settings.localParameters[modelId];
    var values = jaaLocalParameterSettings(modelId, saved);
    dom.contextWindow.min = bounds.contextMin;
    dom.contextWindow.max = bounds.contextMax;
    dom.contextWindow.value = values.contextWindow;
    dom.maxNewTokens.min = bounds.outputMin;
    dom.maxNewTokens.max = Math.min(bounds.outputMax, values.contextWindow - 128);
    dom.maxNewTokens.value = values.maxNewTokens;
    dom.doSample.checked = values.doSample;
    dom.temperature.value = values.temperature;
    dom.topP.value = values.topP;
    dom.topK.value = values.topK;
    dom.repetitionPenalty.value = values.repetitionPenalty;
    dom.parameterInputs.forEach(function (input) { input.disabled = busy; });
    dom.temperature.disabled = busy || !values.doSample;
    dom.topP.disabled = busy || !values.doSample;
    dom.topK.disabled = busy || !values.doSample;
    dom.resetParameters.disabled = busy;
    dom.parameterStatus.textContent = status ||
      "Selectable limits: " + bounds.contextMax.toLocaleString() + " context, " + bounds.outputMax.toLocaleString() + " output tokens. The model's own architecture may support less.";
  }

  async function saveParameters() {
    var modelId = settings.localModel;
    var values = jaaLocalParameterSettings(modelId, {
      contextWindow: Number(dom.contextWindow.value),
      maxNewTokens: Number(dom.maxNewTokens.value),
      doSample: dom.doSample.checked,
      temperature: Number(dom.temperature.value),
      topP: Number(dom.topP.value),
      topK: Number(dom.topK.value),
      repetitionPenalty: Number(dom.repetitionPenalty.value)
    });
    if (!settings.localParameters) settings.localParameters = {};
    settings.localParameters[modelId] = values;
    await setLlmSettings(settings);
    renderParameters("Saved for " + modelId + ".");
  }

  function renderChips() {
    dom.chips.innerHTML = "";
    JAA_LLM_TOOLS.forEach(function (tool) {
      var chip = el("button", "llmChip", tool.label);
      chip.type = "button";
      chip.disabled = busy;
      chip.title = tool.hint;
      var on = !!settings.context[tool.id];
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", function () {
        settings.context[tool.id] = !settings.context[tool.id];
        setLlmSettings(settings);
        renderChips();
        if (tool.id === "page") renderPagePicker();
      });
      dom.chips.appendChild(chip);
    });
  }

  async function renderPagePicker() {
    dom.pageRow.hidden = !settings.context.page;
    if (!settings.context.page) return;
    dom.pageSelect.innerHTML = "";
    try {
      var tabs = await jaaBrowser.tabs.query({ lastFocusedWindow: true });
      tabs = tabs.filter(function (tab) { return /^https?:/i.test(tab.url || ""); }).sort(function (a, b) {
        return Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0);
      });
      if (!tabs.some(function (tab) { return tab.id === pageTabId; })) pageTabId = tabs.length ? tabs[0].id : null;
      tabs.forEach(function (tab) {
        var option = el("option", null, (tab.title || new URL(tab.url).hostname) + " · " + new URL(tab.url).hostname);
        option.value = tab.id;
        option.selected = tab.id === pageTabId;
        dom.pageSelect.appendChild(option);
      });
      if (!tabs.length) dom.pageSelect.appendChild(el("option", null, "No readable web tabs open"));
    } catch (error) {
      dom.pageSelect.appendChild(el("option", null, "Could not list web tabs"));
    }
  }

  function renderPrompts() {
    dom.prompts.innerHTML = "";
    QUICK_PROMPTS.forEach(function (prompt) {
      var button = el("button", "llmPrompt", prompt.label);
      button.type = "button";
      button.addEventListener("click", function () {
        dom.input.value = prompt.text;
        dom.input.focus();
      });
      dom.prompts.appendChild(button);
    });
  }

  function renderKeysPanel() {
    dom.keysPanel.innerHTML = "";
    JAA_LLM_PROVIDERS.filter(function (provider) {
      return provider.needsKey;
    }).forEach(function (provider) {
      var row = el("div", "llmKeyRow");
      var label = el("label", null, provider.label);
      label.htmlFor = "llmKey_" + provider.id;
      var input = el("input");
      input.type = "password";
      input.id = "llmKey_" + provider.id;
      input.placeholder = "Paste your API key";
      input.autocomplete = "off";
      input.value = settings.keys[provider.id] || "";
      input.addEventListener("change", function () {
        settings.keys[provider.id] = input.value.trim();
        setLlmSettings(settings);
      });
      var link = el("a", "llmKeyLink", "Get a key");
      link.href = provider.keysUrl;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(link);
      dom.keysPanel.appendChild(row);
    });
    var note = el(
      "p",
      "llmKeyNote",
      "Keys are stored on this device only and are never included in Export JSON."
    );
    dom.keysPanel.appendChild(note);
  }

  function bubble(role, text) {
    var node = el("div", "llmMsg " + role);
    node.appendChild(el("div", "llmRole", role === "user" ? "You" : "Assistant"));
    var content = el("div", "llmText");
    if (role === "assistant") {
      var separated = jaaLlmSplitReasoning(text);
      jaaRenderMarkdown(content, separated.incomplete
        ? "The model stopped while reasoning and did not produce a final answer. Try again with a shorter request or add `/no_think`."
        : separated.answer);
    } else content.textContent = text;
    node.appendChild(content);
    return node;
  }

  function renderTranscript() {
    Array.prototype.slice.call(dom.transcript.querySelectorAll(".llmMsg, .llmActionCard")).forEach(function (node) {
      node.remove();
    });
    dom.empty.hidden = settings.messages.length > 0;
    settings.messages.forEach(function (message) {
      dom.transcript.appendChild(bubble(message.role, message.content));
    });
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }

  function renderActionPlan(afterNode, plan) {
    var card = el("div", "llmActionCard");
    pendingPlan = plan;
    card.appendChild(el("strong", null, "Review actions"));
    var list = el("ul");
    plan.fields.forEach(function (change) {
      var from = change.from ? '“' + change.from + '”' : "not saved";
      list.appendChild(el("li", null, "Update " + change.label + ": " + from + " → “" + change.to + "”"));
    });
    if (plan.form && plan.actions.some(function (action) { return action.type === "fill_form"; })) {
      var fillable = plan.form.fields.filter(function (field) { return field.fillable; });
      var labels = fillable.slice(0, 6).map(function (field) { return field.label; }).join(", ");
      list.appendChild(el("li", null, "Fill matching empty fields on “" + plan.form.title + "”" + (labels ? ": " + labels : ". No saved matches found yet; profile updates above may create matches.")));
    }
    card.appendChild(list);
    card.appendChild(el("p", "llmActionNote", "ApplyOnce will not overwrite typed values or submit the form."));
    var controls = el("div", "llmActionControls");
    var apply = el("button", null, "Apply actions");
    apply.type = "button";
    var dismiss = el("button", "secondary", "Dismiss");
    dismiss.type = "button";
    var status = el("span", "llmActionStatus");
    controls.appendChild(apply);
    controls.appendChild(dismiss);
    controls.appendChild(status);
    card.appendChild(controls);
    afterNode.insertAdjacentElement("afterend", card);

    dismiss.addEventListener("click", function () {
      if (pendingPlan === plan) pendingPlan = null;
      card.remove();
      if (!dom.transcript.querySelector(".llmActionCard")) dom.input.focus();
    });
    apply.addEventListener("click", async function () {
      apply.disabled = true;
      dismiss.disabled = true;
      status.textContent = "Applying…";
      try {
        var result = await jaaAgentApplyActions(plan);
        status.textContent = actionResultText(result);
        if (pendingPlan === plan) pendingPlan = null;
        apply.remove();
        dismiss.textContent = "Close";
        dismiss.disabled = false;
      } catch (error) {
        status.textContent = String((error && error.message) || error);
        apply.disabled = false;
        dismiss.disabled = false;
      }
    });
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }

  function actionResultText(result) {
    var summary = [];
    if (result.updatedCount) summary.push("updated " + result.updatedCount + " profile field" + (result.updatedCount === 1 ? "" : "s"));
    if (result.form) summary.push("filled " + result.form.filledCount + " form field" + (result.form.filledCount === 1 ? "" : "s"));
    if (result.pageUpdate) summary.push("updated " + result.pageUpdate.updatedCount + " field" + (result.pageUpdate.updatedCount === 1 ? "" : "s") + " on the page");
    return "Done — " + (summary.join(" and ") || "no changes needed") + ". Review the page before submitting.";
  }

  function setBusy(value) {
    busy = value;
    dom.send.textContent = value ? "Stop" : "Send";
    dom.input.disabled = value;
    dom.provider.disabled = value;
    dom.model.disabled = value;
    dom.undoClearBtn.disabled = value;
    dom.removeModel.disabled = value;
    dom.pageSelect.disabled = value;
    renderParameters();
    Array.prototype.forEach.call(dom.transcript.querySelectorAll(".llmActionCard button"), function (button) { button.disabled = value; });
    renderChips();
  }

  function showProgress(report) {
    dom.progress.hidden = false;
    if (report.status === "ready") {
      dom.progressFill.style.width = "100%";
      dom.progressText.textContent = "Model ready · preparing answer…";
      return;
    }
    dom.progressFill.style.width = report.percent + "%";
    dom.progressText.textContent =
      "Downloading model · " + report.percent + "% (" + Math.round(report.total / 1048576) + " MB)";
  }

  function missingPageRequestFrom(text) {
    if (jaaAgentAsksForMissingPageFields(text)) return text;
    if (!/^(?:please\s+)?(?:check|check again|retry|try again)[.!]?$/i.test(String(text || "").trim())) return "";
    var previous = settings.messages.slice(0, -1).reverse().find(function (message) {
      return message.role === "user" && jaaAgentAsksForMissingPageFields(message.content);
    });
    return previous ? previous.content : "";
  }

  function missingPageFieldsReply(form) {
    var empty = (form.fields || []).filter(function (field) { return field.empty && field.type !== "file"; });
    if (!empty.length) return "**No empty form fields were found on this page.**";
    var required = empty.filter(function (field) { return field.required; });
    var optional = empty.filter(function (field) { return !field.required; });
    function line(field) {
      var scope = field.ref && field.ref !== slugify(field.label)
        ? field.ref.replace(/_/g, " ").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); })
        : field.label;
      return "- **" + scope.replace(/\*+\s*$/, "") + "**";
    }
    var parts = ["**" + empty.length + " empty fields found.**"];
    if (required.length) parts.push("### Required\n" + required.map(line).join("\n"));
    if (optional.length) parts.push("### Optional\n" + optional.map(line).join("\n"));
    return parts.join("\n\n");
  }

  // ---------- sending ----------

  async function send(text) {
    dom.chatStatus.hidden = true;
    setBusy(true);
    controller = new AbortController();
    settings.messages.push({ role: "user", content: text });
    settings.messages = jaaLlmMessages(settings.messages);
    renderTranscript();

    var node = bubble("assistant", "");
    var target = node.querySelector(".llmText");
    target.textContent = "…";
    dom.transcript.appendChild(node);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    var first = true;
    var streamedReply = "";

    try {
      await setLlmSettings(settings);
      var directAgentReply = jaaAgentExtractActions("", text);
      var recoveredPlan = null;
      var onlyGenericFill = directAgentReply.actions.length && directAgentReply.actions.every(function (action) {
        return action.type === "fill_form";
      });
      if ((!directAgentReply.actions.length || onlyGenericFill) && /\bresume\b/i.test(text) && /\b(?:update|fill|apply|import|use)\b/i.test(text)) {
        var earlierResume = settings.messages.slice(0, -1).reverse().find(function (message) {
          return message.role === "user" && jaaAgentExtractResumeActions(message.content).length;
        });
        if (earlierResume) directAgentReply = { text: "", actions: jaaAgentExtractResumeActions(earlierResume.content) };
      }
      if (!directAgentReply.actions.length && /^(?:please\s+)?(?:update|apply|save|make)\s+(?:(?:the|that|those)\s+)?(?:field|change|changes|update|it)(?:\s+now)?[.!]?$/i.test(text)) {
        recoveredPlan = pendingPlan;
        if (!recoveredPlan) {
          var earlier = settings.messages.slice(0, -1).reverse().find(function (message) {
            return message.role === "user" && jaaAgentExtractActions("", message.content).actions.length;
          });
          if (earlier) recoveredPlan = await jaaAgentDescribeActions(jaaAgentExtractActions("", earlier.content).actions, pageTabId);
        }
      }
      if (directAgentReply.actions.length) {
        var directPlan = await jaaAgentDescribeActions(directAgentReply.actions, pageTabId);
        var directReply = "I prepared the requested changes for your review.";
        target.textContent = directReply;
        settings.messages.push({ role: "assistant", content: directReply });
        await setLlmSettings(settings);
        renderActionPlan(node, directPlan);
        return;
      }
      if (recoveredPlan) {
        target.textContent = "Applying the confirmed change…";
        var recoveredResult = await jaaAgentApplyActions(recoveredPlan);
        var recoveredReply = actionResultText(recoveredResult);
        pendingPlan = null;
        jaaRenderMarkdown(target, recoveredReply);
        settings.messages.push({ role: "assistant", content: recoveredReply });
        await setLlmSettings(settings);
        return;
      }
      if (missingPageRequestFrom(text)) {
        var inspected = await jaaAgentInspectForm(pageTabId);
        var inventoryReply = missingPageFieldsReply(inspected.result);
        jaaRenderMarkdown(target, inventoryReply);
        settings.messages.push({ role: "assistant", content: inventoryReply });
        await setLlmSettings(settings);
        return;
      }
      if (settings.context.page && pageTabId === null) throw new Error("Choose a readable web tab to attach.");
      var context = await buildLlmContext(settings.context, { pageTabId: pageTabId });
      controller.signal.throwIfAborted();
      var reply = await sendToLlm({
        providerId: settings.provider,
        key: settings.keys[settings.provider],
        model: jaaLlmActiveModel(settings),
        dtype: settings.localDtype,
        parameters: jaaLocalParameterSettings(
          settings.localModel,
          settings.localParameters && settings.localParameters[settings.localModel]
        ),
        system: jaaLlmSystemPrompt(context),
        messages: settings.messages,
        signal: controller.signal,
        onProgress: showProgress,
        onDelta: function (delta) {
          dom.progress.hidden = true;
          streamedReply += delta;
          if (first) {
            target.textContent = "";
            first = false;
          }
          var visible = jaaLlmSplitReasoning(streamedReply);
          if (visible.thinking && !visible.answer) target.textContent = "Reasoning…";
          else jaaRenderMarkdown(target, visible.answer);
          dom.transcript.scrollTop = dom.transcript.scrollHeight;
        }
      });

      dom.progress.hidden = true;
      var separated = jaaLlmSplitReasoning(reply);
      if (separated.incomplete) {
        throw new Error("The model used its entire reply budget for reasoning before producing an answer. Try a shorter request or add /no_think.");
      }
      reply = separated.answer;
      var agentReply = jaaAgentExtractActions(reply, text);
      reply = agentReply.text || (agentReply.actions.length ? "I prepared the requested changes for your review." : "");
      if (!reply.trim()) throw new Error("The model returned an empty answer. Try another model or a shorter message.");
      if (reply) {
        jaaRenderMarkdown(target, reply);
        settings.messages.push({ role: "assistant", content: reply });
        await setLlmSettings(settings);
        if (agentReply.actions.length) {
          var plan = await jaaAgentDescribeActions(agentReply.actions, pageTabId);
          renderActionPlan(node, plan);
        }
      }
    } catch (error) {
      dom.progress.hidden = true;
      var aborted = error && error.name === "AbortError";
      node.classList.add("error");
      target.textContent = aborted ? "Stopped." : String((error && error.message) || error);
    } finally {
      controller = null;
      setBusy(false);
    }
  }

  // ---------- wiring ----------

  function pickCustomModel() {
    var provider = jaaLlmProvider(settings.provider);
    var isLocal = provider.kind === "local";
    var answer = prompt(
      isLocal
        ? "Hugging Face model id (must be an ONNX build, e.g. onnx-community/SmolLM2-135M-Instruct-ONNX)"
        : "Model id for " + provider.label,
      jaaLlmActiveModel(settings)
    );
    if (!answer || !answer.trim()) {
      renderModels();
      return;
    }
    applyModel(answer.trim());
  }

  function applyModel(id) {
    var provider = jaaLlmProvider(settings.provider);
    if (provider.kind === "local") {
      settings.localModel = id;
    } else {
      settings.apiModels[provider.id] = id;
    }
    setLlmSettings(settings);
    renderModels();
  }

  async function init() {
    if (started) return;
    started = true;

    [
      ["provider", "llmProvider"], ["model", "llmModel"], ["chips", "llmChips"],
      ["privacy", "llmPrivacy"], ["transcript", "llmTranscript"], ["empty", "llmEmpty"],
      ["prompts", "llmPrompts"], ["composer", "llmComposer"], ["input", "llmInput"],
      ["send", "llmSendBtn"], ["keysPanel", "llmKeysPanel"], ["keysBtn", "llmKeysBtn"],
      ["clearBtn", "llmClearBtn"], ["progress", "llmProgress"],
      ["progressFill", "llmProgressFill"], ["progressText", "llmProgressText"],
      ["modelInfo", "llmModelInfo"], ["removeModel", "llmRemoveModel"],
      ["pageRow", "llmPageRow"], ["pageSelect", "llmPageSelect"],
      ["undoClearBtn", "llmUndoClearBtn"], ["chatStatus", "llmChatStatus"],
      ["parameters", "llmParameters"], ["contextWindow", "llmContextWindow"],
      ["maxNewTokens", "llmMaxNewTokens"], ["doSample", "llmDoSample"],
      ["temperature", "llmTemperature"], ["topP", "llmTopP"], ["topK", "llmTopK"],
      ["repetitionPenalty", "llmRepetitionPenalty"], ["resetParameters", "llmResetParameters"],
      ["parameterStatus", "llmParameterStatus"]
    ].forEach(function (pair) {
      dom[pair[0]] = document.getElementById(pair[1]);
    });

    settings = await getLlmSettings();
    dom.parameterInputs = [
      dom.contextWindow, dom.maxNewTokens, dom.doSample, dom.temperature,
      dom.topP, dom.topK, dom.repetitionPenalty
    ];
    var cleanedReasoning = false;
    settings.messages.forEach(function (message) {
      if (message.role !== "assistant") return;
      var separated = jaaLlmSplitReasoning(message.content);
      if (!separated.reasoning && !separated.incomplete) return;
      message.content = separated.incomplete
        ? "The model stopped while reasoning and did not produce a final answer. Try again with a shorter request or add `/no_think`."
        : separated.answer;
      cleanedReasoning = true;
    });
    if (cleanedReasoning) await setLlmSettings(settings);

    // A build without `npm run vendor:llm` has no on-device runtime; say so
    // once rather than failing on the first message.
    runtimeAvailable = await isLocalRuntimeAvailable();

    renderProviders();
    renderModels();
    renderChips();
    renderPrompts();
    renderPrivacy();
    renderKeysPanel();
    renderTranscript();
    renderPagePicker();
    dom.pageSelect.addEventListener("change", function () { pageTabId = Number(dom.pageSelect.value); });
    dom.removeModel.addEventListener("click", async function () {
      if (!confirm("Remove the selected model's downloaded files? You can download it again on your next message.")) return;
      setBusy(true);
      dom.send.disabled = true;
      try {
        await removeLocalModelDownload(settings.localModel);
        dom.modelInfo.textContent = "Downloaded files removed. This model will download again on the next send.";
      } catch (error) { dom.modelInfo.textContent = "Could not remove model files: " + error.message; }
      finally { setBusy(false); dom.send.disabled = false; }
    });

    dom.provider.addEventListener("change", function () {
      settings.provider = dom.provider.value;
      setLlmSettings(settings);
      renderModels();
      renderPrivacy();
      var provider = jaaLlmProvider(settings.provider);
      if (provider.needsKey && !settings.keys[provider.id]) dom.keysPanel.hidden = false;
    });

    dom.model.addEventListener("change", function () {
      if (dom.model.value === CUSTOM_OPTION) pickCustomModel();
      else applyModel(dom.model.value);
    });

    dom.keysBtn.addEventListener("click", function () {
      dom.keysPanel.hidden = !dom.keysPanel.hidden;
    });

    dom.parameterInputs.forEach(function (input) {
      input.addEventListener("change", function () {
        saveParameters().catch(function (error) {
          dom.parameterStatus.textContent = "Could not save parameters: " + error.message;
        });
      });
    });

    dom.resetParameters.addEventListener("click", async function () {
      if (settings.localParameters) delete settings.localParameters[settings.localModel];
      await setLlmSettings(settings);
      renderParameters("Restored defaults for " + settings.localModel + ".");
    });

    dom.clearBtn.addEventListener("click", async function () {
      dom.clearBtn.disabled = true;
      try {
        if (controller) controller.abort();
        if (currentSend) await currentSend;
        currentSend = null;
        await unloadLocalLlm();
        if (settings.messages.length) clearedMessages = settings.messages.slice();
        settings.messages = [];
        await setLlmSettings(settings);
        renderTranscript();
        dom.progress.hidden = true;
        dom.input.value = "";
        dom.undoClearBtn.hidden = !clearedMessages;
        dom.chatStatus.textContent = "Chat cleared. Your profile, API keys, and downloaded models are unchanged. Undo is available until you close or reload this editor.";
        dom.chatStatus.hidden = false;
        dom.input.focus();
      } catch (error) {
        if (clearedMessages) settings.messages = clearedMessages.slice();
        dom.chatStatus.textContent = "Could not clear chat: " + error.message;
        dom.chatStatus.hidden = false;
      } finally { dom.clearBtn.disabled = false; }
    });

    dom.undoClearBtn.addEventListener("click", async function () {
      if (busy || !clearedMessages) return;
      var current = settings.messages;
      settings.messages = clearedMessages.concat(current);
      try {
        await setLlmSettings(settings);
        clearedMessages = null;
        dom.undoClearBtn.hidden = true;
        dom.chatStatus.textContent = "Previous conversation restored.";
        dom.chatStatus.hidden = false;
        renderTranscript();
      } catch (error) {
        settings.messages = current;
        dom.chatStatus.textContent = "Could not restore chat: " + error.message;
        dom.chatStatus.hidden = false;
      }
    });

    dom.composer.addEventListener("submit", function (event) {
      event.preventDefault();
      if (busy) {
        if (controller) controller.abort();
        return;
      }
      var text = dom.input.value.trim();
      if (!text) return;
      dom.input.value = "";
      currentSend = send(text);
    });

    // Enter sends, Shift+Enter makes a new line.
    dom.input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        dom.composer.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });
  }

  // Boot only when the Assistant tab is actually opened, so the options page
  // stays as fast as it was for everyone who never uses this.
  function watchForTab() {
    var button = document.querySelector('.tabBtn[data-tab="assistant"]');
    if (!button) return;
    button.addEventListener("click", init);
    window.addEventListener("hashchange", function () {
      if (location.hash === "#assistant") init();
    });
    if (String(location.hash).replace(/^#/, "") === "assistant") init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForTab);
  } else {
    watchForTab();
  }
})();

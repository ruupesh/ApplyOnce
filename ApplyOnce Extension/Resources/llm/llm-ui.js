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
    { label: "Review my search", text: "Summarise my applications and tell me which need a follow-up." },
    { label: "Agent: fill form", text: "[agent] Inspect this form, fill all fields using my profile and resume, and report what was filled and what needs attention." },
    { label: "Inspect page code", text: "[agent] Find the buttons on this page and inspect the HTML of the relevant one: " }
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
  var gatewayModels = {};
  var pendingPlan = null;
  var progressLoaded = 0;
  var progressTotal = 0;
  var progressPercent = 0;
  var previewCapture = null;

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
      : provider.configurableBaseUrl
        ? "Your conversation and selected attachments go to your configured OmniRoute server. It may forward them to its connected online providers."
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
          return { id: model.id, label: model.id };
        })
      : (provider.models || []).map(function (id) {
          return { id: id, label: provider.modelLabels && provider.modelLabels[id] || id };
        });
    (gatewayModels[provider.id] || []).forEach(function (id) {
      if (!known.some(function (model) { return model.id === id; })) known.push({ id: id, label: id });
    });

    if (!isLocal && !known.some(function (model) { return model.id === current; }) && current) {
      known = known.concat([{ id: current, label: current }]);
    }

    dom.model.innerHTML = "";
    if (!isLocal && !current) {
      var placeholder = el("option", null, "Choose a model…");
      placeholder.value = "";
      placeholder.disabled = true;
      placeholder.selected = true;
      dom.model.appendChild(placeholder);
    }
    known.forEach(function (model) {
      var option = el("option", null, model.label);
      option.value = model.id;
      if (model.note) option.title = model.note;
      if (model.id === current) option.selected = true;
      dom.model.appendChild(option);
    });
    if (!isLocal) {
      var custom = el("option", null, "Other model…");
      custom.value = CUSTOM_OPTION;
      dom.model.appendChild(custom);
    }
    dom.modelInfo.hidden = !isLocal && !provider.configurableBaseUrl;
    dom.removeModel.hidden = !isLocal;
    dom.modelInfo.textContent = runtimeAvailable
      ? "Downloaded on first send, then kept in this browser's Cache Storage (transformers-cache), within the browser profile on this Mac. Switching models releases RAM but keeps cached files; Remove selected model download deletes them."
      : "This build does not include on-device support. Choose an API provider to chat.";
    if (provider.configurableBaseUrl) dom.modelInfo.textContent = "Auto lets OmniRoute choose from its available providers. Use API keys / servers to set the address and load your models or combos; Other model… accepts any model or combo name.";
    renderParameters();
  }

  function renderParameters(status) {
    var local = jaaLlmProvider(settings.provider).kind === "local";
    dom.parameters.hidden = !local;
    if (!local) return;
    var modelId = settings.localModel;
    var saved = settings.localParameters && settings.localParameters[modelId];
    var values = jaaLocalParameterSettings(modelId, saved);
    dom.contextWindow.value = values.contextWindow;
    var bounds = jaaLocalParameterBounds(modelId);
    dom.maxContext.disabled = busy || !bounds.contextMax;
    dom.maxOutput.disabled = busy || !bounds.contextMax;
    dom.maxNewTokens.min = bounds.outputMin;
    dom.maxNewTokens.max = bounds.outputMax;
    dom.maxNewTokens.value = values.maxNewTokens;
    dom.doSample.checked = values.doSample;
    var supportsReasoning = jaaLocalSupportsReasoning(modelId);
    dom.thinkingToggle.classList.toggle("isDisabled", !supportsReasoning);
    dom.thinkingToggle.title = supportsReasoning ? "" : "This model does not offer a thinking-mode switch.";
    dom.enableThinking.checked = !!values.enableThinking;
    dom.temperature.value = values.temperature;
    dom.topP.value = values.topP;
    dom.topK.value = values.topK;
    dom.repetitionPenalty.value = values.repetitionPenalty;
    dom.parameterInputs.forEach(function (input) { input.disabled = busy; });
    dom.enableThinking.disabled = busy || !supportsReasoning;
    dom.temperature.disabled = busy || !values.doSample;
    dom.topP.disabled = busy || !values.doSample;
    dom.topK.disabled = busy || !values.doSample;
    dom.resetParameters.disabled = busy;
    dom.parameterStatus.textContent = status ||
      "Published context: " + (bounds.contextMax ? bounds.contextMax.toLocaleString() : "unknown") + " tokens. Max output depends on prompt length; very large settings may exhaust browser memory.";
  }

  async function saveParameters() {
    var modelId = settings.localModel;
    var contextWindow = Number(dom.contextWindow.value);
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      dom.parameterStatus.textContent = "Enter a positive whole number for the context window.";
      return;
    }
    var values = jaaLocalParameterSettings(modelId, {
      contextWindow: contextWindow,
      maxNewTokens: Number(dom.maxNewTokens.value),
      doSample: dom.doSample.checked,
      enableThinking: dom.enableThinking.checked,
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

  function pageImageAvailable() {
    return settings.provider !== "local" || jaaLocalIsGemma4(settings.localModel);
  }

  function selectVisionModelForPageImage() {
    if (!settings.context.pageImage) return;
    var current = jaaLlmActiveModel(settings);
    if (settings.provider === "groq" && ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"].indexOf(current) !== -1) {
      settings.apiModels.groq = "qwen/qwen3.6-27b";
    }
    if (settings.provider === "deepseek" && ["deepseek-chat", "deepseek-reasoner"].indexOf(current) !== -1) {
      settings.apiModels.deepseek = "deepseek-v4-flash-vision-exp";
    }
  }

  function pageImagesForSend(signal) {
    if (previewCapture && previewCapture.tabId === pageTabId) {
      var images = previewCapture.images;
      previewCapture = null;
      dom.pagePreview.textContent = "Preview page image";
      return Promise.resolve(images);
    }
    return jaaCapturePageImages(pageTabId, signal, function (done, total) {
      dom.progress.hidden = false;
      dom.progressText.textContent = "Capturing page image " + done + " of " + total + "…";
    });
  }

  function renderChips() {
    dom.chips.innerHTML = "";
    JAA_LLM_TOOLS.concat([{
      id: "pageImage",
      label: "Page image",
      hint: "Attach ordered screenshots of the full webpage. Hosted providers receive the images; the page may contain private information."
    }]).forEach(function (tool) {
      var chip = el("button", "llmChip", tool.label);
      chip.type = "button";
      var available = tool.id !== "pageImage" || pageImageAvailable();
      chip.disabled = busy || !available;
      chip.title = tool.hint;
      var on = available && !!settings.context[tool.id];
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", function () {
        settings.context[tool.id] = !settings.context[tool.id];
        if (tool.id === "pageImage") {
          previewCapture = null;
          selectVisionModelForPageImage();
          renderModels();
        }
        setLlmSettings(settings);
        renderChips();
        if (tool.id === "page" || tool.id === "pageImage") renderPagePicker();
      });
      dom.chips.appendChild(chip);
    });
  }

  async function renderPagePicker() {
    var needsPage = settings.context.page || settings.allowPageActions || (settings.context.pageImage && pageImageAvailable());
    dom.pageRow.hidden = !needsPage;
    dom.pagePreview.hidden = !settings.context.pageImage || !pageImageAvailable();
    dom.pagePreview.disabled = busy || pageTabId === null;
    dom.pagePreview.textContent = previewCapture ? "Refresh preview" : "Preview page image";
    if (!needsPage) return;
    dom.pageSelect.innerHTML = "";
    try {
      var tabs = await jaaBrowser.tabs.query({ lastFocusedWindow: true });
      tabs = tabs.filter(function (tab) { return /^https?:/i.test(tab.url || ""); }).sort(function (a, b) {
        return Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0);
      });
      if (!tabs.some(function (tab) { return tab.id === pageTabId; })) pageTabId = tabs.length ? tabs[0].id : null;
      dom.pagePreview.disabled = busy || pageTabId === null;
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

  async function previewPageImage() {
    if (pageTabId === null) return;
    setBusy(true);
    controller = new AbortController();
    dom.chatStatus.hidden = true;
    try {
      var tab = await jaaBrowser.tabs.get(pageTabId);
      var images = await jaaCapturePageImages(pageTabId, controller.signal, function (done, total) {
        dom.progress.hidden = false;
        dom.progressText.textContent = "Capturing page image " + done + " of " + total + "…";
      });
      previewCapture = { tabId: pageTabId, images: images };
      dom.previewInfo.textContent = images.length + " screenshot" + (images.length === 1 ? "" : "s") + " from " + tab.url + ". These exact images will be sent with your next message. Click an image to view it at capture size.";
      dom.previewTiles.innerHTML = "";
      images.forEach(function (dataUrl, index) {
        var figure = el("figure");
        var caption = el("figcaption", null, "Page section " + (index + 1) + " of " + images.length);
        var image = el("img");
        image.src = dataUrl;
        image.alt = "Captured page section " + (index + 1) + " of " + images.length;
        image.addEventListener("click", function () { image.classList.toggle("actual"); });
        figure.appendChild(caption);
        figure.appendChild(image);
        dom.previewTiles.appendChild(figure);
      });
      dom.pagePreview.textContent = "Refresh preview";
      dom.previewDialog.showModal();
    } catch (error) {
      dom.chatStatus.textContent = error && error.name === "AbortError"
        ? "Page image preview stopped."
        : "Could not preview page image: " + String((error && error.message) || error);
      dom.chatStatus.hidden = false;
    } finally {
      controller = null;
      dom.progress.hidden = true;
      setBusy(false);
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
      return provider.needsKey || provider.optionalKey || provider.configurableBaseUrl;
    }).forEach(function (provider) {
      var row = el("div", "llmKeyRow");
      var label = el("label", null, provider.label);
      label.htmlFor = "llmKey_" + provider.id;
      var input = el("input");
      input.type = "password";
      input.id = "llmKey_" + provider.id;
      input.placeholder = provider.optionalKey ? "Optional — OmniRoute endpoint key if authentication is enabled" : "Paste your API key";
      input.autocomplete = "off";
      input.value = settings.keys[provider.id] || "";
      input.addEventListener("change", function () {
        settings.keys[provider.id] = input.value.trim();
        delete gatewayModels[provider.id];
        setLlmSettings(settings);
        renderModels();
      });
      row.appendChild(label);
      row.appendChild(input);
      if (provider.keysUrl) {
        var link = el("a", "llmKeyLink", "Get a key");
        link.href = provider.keysUrl;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        row.appendChild(link);
      }
      dom.keysPanel.appendChild(row);
      if (provider.configurableBaseUrl) {
        var endpointRow = el("div", "llmKeyRow");
        var endpointLabel = el("label", null, provider.label + " API base URL");
        var endpoint = el("input");
        endpoint.id = "llmBaseUrl_" + provider.id;
        endpointLabel.htmlFor = endpoint.id;
        endpoint.type = "url";
        endpoint.placeholder = provider.defaultBaseUrl || "OpenAI-compatible API base URL";
        endpoint.value = settings.apiBaseUrls[provider.id] || provider.defaultBaseUrl || "";
        endpoint.addEventListener("change", async function () {
          settings.apiBaseUrls[provider.id] = endpoint.value.trim();
          delete gatewayModels[provider.id];
          try {
            settings.apiBaseUrls[provider.id] = jaaLlmProviderBaseUrl(provider, endpoint.value);
            endpoint.value = settings.apiBaseUrls[provider.id];
            endpoint.setCustomValidity("");
          } catch (error) {
            endpoint.setCustomValidity(error.message);
            endpoint.reportValidity();
          }
          await setLlmSettings(settings);
          renderModels();
        });
        endpointRow.appendChild(endpointLabel);
        endpointRow.appendChild(endpoint);
        dom.keysPanel.appendChild(endpointRow);
        var check = el("button", "secondary", "Test connection / Load models");
        check.type = "button";
        check.id = "llmCheckServer_" + provider.id;
        var checkStatus = el("p", "llmKeyNote");
        checkStatus.setAttribute("role", "status");
        checkStatus.textContent = "On this Mac: " + provider.defaultBaseUrl + ". On iPhone: use your Mac's reachable network address and port. The key, if needed, comes from OmniRoute Dashboard → Endpoints.";
        check.addEventListener("click", async function () {
          check.disabled = true;
          checkStatus.textContent = "Checking the server…";
          var address = endpoint.value.trim();
          var serverKey = input.value.trim();
          try {
            var models = await jaaLlmListModels({ providerId: provider.id, baseUrl: address, key: serverKey });
            if (address !== endpoint.value.trim() || serverKey !== input.value.trim()) throw new Error("Connection settings changed. Test the server again.");
            settings.apiBaseUrls[provider.id] = jaaLlmProviderBaseUrl(provider, address);
            settings.keys[provider.id] = serverKey;
            await setLlmSettings(settings);
            gatewayModels[provider.id] = models;
            renderModels();
            checkStatus.textContent = models.length ? "Connected. Loaded " + models.length + " models and combos. No prompt was sent." : "Connected, but the server returned no models. Check OmniRoute's provider connections.";
          } catch (error) {
            checkStatus.textContent = error.message || String(error);
          } finally {
            check.disabled = false;
          }
        });
        dom.keysPanel.appendChild(check);
        dom.keysPanel.appendChild(checkStatus);
      }
    });
    var note = el(
      "p",
      "llmKeyNote",
      "Keys are stored on this device only and are never included in Export JSON."
    );
    dom.keysPanel.appendChild(note);
  }

  function renderReasoning(node, separated, complete) {
    var panel = node.querySelector(".llmReasoning");
    if (!panel) return;
    if (!separated.reasoning && !separated.thinking) {
      panel.hidden = true;
      return;
    }
    if (panel.hidden) {
      panel.hidden = false;
      panel.open = !complete;
    }
    panel.querySelector("summary").textContent = complete ? "Reasoning" : "Reasoning…";
    panel.querySelector(".llmReasoningText").textContent = separated.reasoning || "Reasoning…";
    if (complete) panel.open = false;
  }

  function renderAssistantParts(node, separated, complete) {
    renderReasoning(node, separated, complete);
    var target = node.querySelector(".llmText");
    if (separated.answer) jaaRenderMarkdown(target, separated.answer);
    else target.textContent = separated.thinking ? "Preparing answer…" : "";
  }

  function bubble(role, text, reasoning) {
    var node = el("div", "llmMsg " + role);
    node.appendChild(el("div", "llmRole", role === "user" ? "You" : "Assistant"));
    if (role === "assistant") {
      var panel = el("details", "llmReasoning");
      panel.hidden = true;
      panel.appendChild(el("summary", null, "Reasoning"));
      panel.appendChild(el("div", "llmReasoningText"));
      node.appendChild(panel);
    }
    var content = el("div", "llmText");
    if (role !== "assistant") content.textContent = text;
    node.appendChild(content);
    if (role === "assistant") {
      var separated = jaaLlmSplitReasoning(text);
      if (reasoning) separated.reasoning = reasoning;
      renderAssistantParts(node, separated, true);
    }
    return node;
  }

  function renderTranscript() {
    Array.prototype.slice.call(dom.transcript.querySelectorAll(".llmMsg, .llmActionCard")).forEach(function (node) {
      node.remove();
    });
    dom.empty.hidden = settings.messages.length > 0;
    settings.messages.forEach(function (message) {
      var node = bubble(message.role, message.content, message.reasoning);
      if (message.activity && message.activity.length) jaaCreateAgentActivityView(node, message.activity, false);
      dom.transcript.appendChild(node);
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
    if (result.pageAction) return result.pageAction.note || "Action dispatched. Inspecting the result…";
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
    if (dom.resumeTask) dom.resumeTask.disabled = value;
    dom.provider.disabled = value;
    dom.model.disabled = value;
    dom.undoClearBtn.disabled = value;
    dom.removeModel.disabled = value;
    dom.pageSelect.disabled = value;
    dom.pagePreview.disabled = value || pageTabId === null || !settings.context.pageImage || !pageImageAvailable();
    renderParameters();
    Array.prototype.forEach.call(dom.transcript.querySelectorAll(".llmActionCard button"), function (button) { button.disabled = value; });
    renderChips();
  }

  function showProgress(report) {
    dom.progress.hidden = false;
    if (report.status === "visual") {
      dom.progressText.textContent = "Analyzing page section " + report.done + " of " + report.total + "…";
      return;
    }
    if (report.status === "loading") {
      progressLoaded = 0;
      progressTotal = 0;
      progressPercent = 0;
      dom.progress.classList.add("loading");
      dom.progressFill.style.width = "0%";
      dom.progressText.textContent = "Checking model files…";
      return;
    }
    if (report.status === "ready") {
      dom.progress.classList.remove("loading");
      dom.progressFill.style.width = "100%";
      dom.progressText.textContent = "Model ready · preparing answer…";
      return;
    }
    if (report.status !== "progress" || !report.total) return;
    progressLoaded = Math.max(progressLoaded, report.loaded);
    progressTotal = Math.max(progressTotal, report.total, progressLoaded);
    progressPercent = Math.max(progressPercent, Math.min(100, Math.round((progressLoaded / progressTotal) * 100)));
    dom.progress.classList.remove("loading");
    dom.progressFill.style.width = progressPercent + "%";
    function size(bytes) {
      return bytes >= 1073741824
        ? (bytes / 1073741824).toFixed(2) + " GB"
        : (bytes / 1048576).toFixed(1) + " MB";
    }
    dom.progressText.textContent = "Loading model files · " + size(progressLoaded) + " of " + size(progressTotal) + " (" + progressPercent + "%)";
  }

  function showAgentStep(step) {
    dom.progress.hidden = false;
    dom.progress.classList.add('loading');
    dom.progressFill.style.width = '100%';
    dom.progressText.title = 'This counts model calls, including retries. It is not a completion percentage.';
    if (step.status === "thinking") {
      dom.progressText.textContent = "Model call " + step.iteration + (step.maxIterations > 0 ? " of " + step.maxIterations : "") + " · waiting for output";
    } else if (step.status === "tool") {
      dom.progressText.textContent = "Running " + step.tool + " · " + step.iteration + " model calls used";
    }
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
    var streamedReasoning = "";

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
      var attachImage = settings.context.pageImage && pageImageAvailable();
      if ((settings.context.page || attachImage) && pageTabId === null) throw new Error("Choose a readable web tab to attach.");
      var context = await buildLlmContext(settings.context, { pageTabId: pageTabId });
      var pageImages = attachImage ? await pageImagesForSend(controller.signal) : [];
      controller.signal.throwIfAborted();
      var reply = await sendToLlm({
        baseUrl: settings.apiBaseUrls[settings.provider],
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
        pageImages: pageImages,
        signal: controller.signal,
        onProgress: showProgress,
        onReasoningDelta: function (delta) {
          streamedReasoning += delta;
          var visible = jaaLlmSplitReasoning(streamedReply);
          visible.reasoning = (streamedReasoning + '\n' + visible.reasoning).trim();
          visible.thinking = !visible.answer;
          renderAssistantParts(node, visible, false);
        },
        onDelta: function (delta) {
          dom.progress.hidden = true;
          streamedReply += delta;
          if (first) {
            target.textContent = "";
            first = false;
          }
          var visible = jaaLlmSplitReasoning(streamedReply);
          visible.reasoning = (streamedReasoning + '\n' + visible.reasoning).trim();
          renderAssistantParts(node, visible, false);
          dom.transcript.scrollTop = dom.transcript.scrollHeight;
        }
      });

      dom.progress.hidden = true;
      var separated = jaaLlmSplitReasoning(reply);
      separated.reasoning = (streamedReasoning + '\n' + separated.reasoning).trim();
      renderAssistantParts(node, separated, true);
      if (separated.incomplete) {
        throw new Error("The model used its entire reply budget for reasoning before producing an answer. Increase the output limit or try a shorter request.");
      }
      reply = separated.answer;
      var agentReply = jaaAgentExtractActions(reply, text);
      reply = agentReply.text || (agentReply.actions.length ? "I prepared the requested changes for your review." : "");
      if (!reply.trim()) throw new Error("The model returned an empty answer. Try another model or a shorter message.");
      if (reply) {
        jaaRenderMarkdown(target, reply);
        settings.messages.push({ role: "assistant", content: reply, reasoning: separated.reasoning });
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

  async function sendAgentic(text, resumeTask, continueTask) {
    dom.chatStatus.hidden = true;
    setBusy(true);
    controller = new AbortController();
    if (!resumeTask) settings.messages.push({ role: "user", content: text });
    settings.messages = jaaLlmMessages(settings.messages);
    renderTranscript();

    var node = bubble("assistant", "");
    var target = node.querySelector(".llmText");
    target.textContent = "Connecting to the selected page…";
    var activityView = jaaCreateAgentActivityView(node, resumeTask && resumeTask.activity, true);
    dom.transcript.appendChild(node);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;

    try {
      await setLlmSettings(settings);

      if (resumeTask) {
        pageTabId = resumeTask.tabId;
        var savedTab = await jaaBrowser.tabs.get(pageTabId);
        if (resumeTask.url && savedTab.url !== resumeTask.url) throw new Error("The saved task belongs to a different page. Start a new task.");
        if (resumeTask.stage !== "review") resumeTask = Object.assign({}, resumeTask, { stage: "inspect" });
      }
      // Get the web tab.
      if (pageTabId === null) {
        var tabs = await jaaBrowser.tabs.query({ lastFocusedWindow: true });
        var webTab = (tabs || []).filter(function (tab) { return /^https?:/i.test(tab.url || ""); }).sort(function (a, b) {
          return Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0);
        })[0];
        if (webTab) pageTabId = webTab.id;
      }
      if (pageTabId === null) throw new Error("Open a webpage containing a form, then try again.");

      var attachImage = !resumeTask && settings.context.pageImage && pageImageAvailable();
      var pageImages = attachImage ? await pageImagesForSend(controller.signal) : [];
      controller.signal.throwIfAborted();


      var loopResult = await jaaAgentLoop({
        baseUrl: settings.apiBaseUrls[settings.provider],
        tabId: pageTabId,
        providerId: settings.provider,
        key: settings.keys[settings.provider],
        model: jaaLlmActiveModel(settings),
        parameters: jaaLocalParameterSettings(settings.localModel, settings.localParameters && settings.localParameters[settings.localModel]),
        pageImages: pageImages,
        workflowState: resumeTask,
        continueTask: continueTask === true,
        context: settings.context,
        onProgress: showProgress,
        messages: settings.messages,
        signal: controller.signal,
        onStep: showAgentStep,
        onActivity: function (event) {
          var follow = dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < 100;
          activityView.event(event);
          target.textContent = event.message;
          if (event.type === 'model_stream') dom.progressText.textContent = 'Model call ' + event.iteration + (event.maxIterations > 0 ? ' of ' + event.maxIterations : '') + ' · receiving output';
          if (follow) dom.transcript.scrollTop = dom.transcript.scrollHeight;
        },
        onModelOutput: function (output) {
          var follow = dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < 100;
          activityView.modelOutput(output);
          if (follow) dom.transcript.scrollTop = dom.transcript.scrollHeight;
        }
      });

      dom.progress.hidden = true;

      // Display the agent's text response.
      var replyText = loopResult.text || "";
      var separated = jaaLlmSplitReasoning(replyText);
      separated.reasoning = loopResult.reasoning || "";
      renderAssistantParts(node, separated, true);
      if (separated.incomplete) throw new Error("The model stopped while reasoning before producing an answer. Increase the output limit or try a shorter request.");
      replyText = separated.answer;

      if (replyText) {
        jaaRenderMarkdown(target, replyText);
      }

      // Add iteration info.
      if (loopResult.iterations > 1) {
        var iterNote = el("div", "llmAgentMeta", "Model calls used: " + loopResult.iterations + " · " + loopResult.status.replace(/_/g, " "));
        node.appendChild(iterNote);
      }

      settings.messages.push({ role: "assistant", content: replyText || "Agent paused.", reasoning: separated.reasoning, activity: loopResult.activity });
      await setLlmSettings(settings);

      // If there are write actions, show the review card.
      if (loopResult.writeActions && loopResult.writeActions.length) {
        var plan = await jaaAgentDescribeActions(loopResult.writeActions, pageTabId);
        if ((plan.pageAction && plan.pageAction.url || plan.form && plan.form.url) !== loopResult.workflowState.url) throw new Error("The page changed before review. Start a new task.");
        renderAgentActionPlan(node, plan, loopResult);
      }

    } catch (error) {
      dom.progress.hidden = true;
      var aborted = error && error.name === "AbortError";
      activityView.event({ type: 'error', message: aborted ? 'Stopped by you.' : String(error.message || error) });
      if (typeof jaaDiagnostics !== 'undefined') jaaDiagnostics.log('task_error', { code: aborted ? 'ABORTED' : jaaAgentErrorCode(error) });
      node.classList.add("error");
      target.textContent = aborted ? "Agent stopped." : String((error && error.message) || error);
    } finally {
      activityView.finish();
      dom.progress.classList.remove('loading');
      controller = null;
      setBusy(false);
      await renderSavedAgentTask();
    }
  }

  function renderAgentActionPlan(afterNode, plan, loopResult) {
    var card = el("div", "llmActionCard llmAgentCard");
    pendingPlan = plan;
    card.appendChild(el("strong", null, "Agent actions — review before applying"));
    var list = el("ul");
    plan.fields.forEach(function (change) {
      var from = change.from ? '"' + change.from + '"' : "not saved";
      list.appendChild(el("li", null, "Update " + change.label + ": " + from + " → \"" + change.to + "\""));
    });
    card.appendChild(list);
    card.appendChild(el("p", "llmActionNote", "The agent will observe results after applying and may propose follow-up corrections."));
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

    dismiss.addEventListener("click", async function () {
      if (pendingPlan === plan) pendingPlan = null;
      if (dismiss.textContent !== "Close") await jaaAgentClearTask(loopResult.workflowState.id);
      await renderSavedAgentTask();
      card.remove();
      if (!dom.transcript.querySelector(".llmActionCard")) dom.input.focus();
    });

    apply.addEventListener("click", async function () {
      if (busy) return;
      setBusy(true);
      controller = new AbortController();
      status.textContent = "Applying…";
      try {
        var nextTask = await jaaAgentPrepareApply(loopResult.workflowState);
        // Once a write might have happened, recovery must inspect, never replay it.
        apply.remove();
        var result = await jaaAgentApplyActions(plan);
        nextTask = await jaaAgentRecordApply(nextTask, result);
        controller.signal.throwIfAborted();
        status.textContent = actionResultText(result);
        if (pendingPlan === plan) pendingPlan = null;
        dismiss.textContent = "Close";
        currentSend = sendAgentic("", nextTask);
        await currentSend;
      } catch (error) {
        status.textContent = String(error.message || error) + " Use Resume task to inspect the current page.";
      } finally {
        controller = null;
        setBusy(false);
        await renderSavedAgentTask();
      }
    });
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }

  async function renderSavedAgentTask() {
    if (!dom.resumeTask) {
      dom.resumeTask = el("button", "secondary", "Resume task");
      dom.resumeTask.type = "button";
      dom.composer.insertAdjacentElement("beforebegin", dom.resumeTask);
      dom.resumeTask.addEventListener("click", async function () {
        if (busy) return;
        var saved = await jaaAgentReadTask();
        if (!saved) return;
        currentSend = sendAgentic("", saved, true);
        await currentSend;
      });
    }
    var saved = await jaaAgentReadTask();
    dom.resumeTask.hidden = !saved || saved.stage === "complete";
    dom.resumeTask.disabled = busy;
    dom.resumeTask.textContent = 'Resume task';
    dom.resumeTask.title = saved ? saved.request : "";
  }

  // ---------- wiring ----------

  function pickCustomModel() {
    var provider = jaaLlmProvider(settings.provider);
    var answer = prompt("Model id for " + provider.label, jaaLlmActiveModel(settings));
    if (!answer || !answer.trim()) {
      renderModels();
      return;
    }
    applyModel(answer.trim());
  }

  function applyModel(id) {
    var provider = jaaLlmProvider(settings.provider);
    if (provider.kind === "local") {
      if (!jaaLlmIsListedLocalModel(id)) {
        renderModels();
        return;
      }
      jaaLlmRememberLocalModel(settings, settings.localModel);
      jaaLlmRememberLocalModel(settings, id);
      settings.localModel = id;
    } else {
      settings.apiModels[provider.id] = id;
    }
    setLlmSettings(settings);
    renderModels();
    renderChips();
    renderPagePicker();
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
      ["pagePreview", "llmPreviewPage"], ["previewDialog", "llmImagePreview"],
      ["previewClose", "llmImagePreviewClose"], ["previewInfo", "llmImagePreviewInfo"],
      ["previewTiles", "llmImagePreviewTiles"],
      ["undoClearBtn", "llmUndoClearBtn"], ["chatStatus", "llmChatStatus"],
      ["parameters", "llmParameters"], ["contextWindow", "llmContextWindow"],
      ["maxNewTokens", "llmMaxNewTokens"], ["doSample", "llmDoSample"],
      ["maxContext", "llmMaxContext"], ["maxOutput", "llmMaxOutput"],
      ["thinkingToggle", "llmThinkingToggle"], ["enableThinking", "llmEnableThinking"],
      ["temperature", "llmTemperature"], ["topP", "llmTopP"], ["topK", "llmTopK"],
      ["repetitionPenalty", "llmRepetitionPenalty"], ["resetParameters", "llmResetParameters"],
      ["parameterStatus", "llmParameterStatus"], ["allowPageActions", "llmAllowPageActions"]
    ].forEach(function (pair) {
      dom[pair[0]] = document.getElementById(pair[1]);
    });

    settings = await getLlmSettings();
    dom.allowPageActions.checked = settings.allowPageActions;
    dom.allowPageActions.addEventListener("change", async function () {
      var allowed = dom.allowPageActions.checked;
      try {
        await jaaSetPageActionsAllowed(allowed);
        settings.allowPageActions = allowed;
        renderPagePicker();
      } catch (error) {
        dom.allowPageActions.checked = settings.allowPageActions;
        dom.chatStatus.hidden = false;
        dom.chatStatus.textContent = "Could not save page action permission: " + error.message;
      }
    });
    jaaBrowser.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.jaaPageActionsAllowed) return;
      settings.allowPageActions = changes.jaaPageActionsAllowed.newValue === true;
      dom.allowPageActions.checked = settings.allowPageActions;
    });
    dom.parameterInputs = [
      dom.contextWindow, dom.maxNewTokens, dom.doSample, dom.enableThinking, dom.temperature,
      dom.topP, dom.topK, dom.repetitionPenalty
    ];
    var cleanedReasoning = false;
    settings.messages.forEach(function (message) {
      if (message.role !== "assistant") return;
      var separated = jaaLlmSplitReasoning(message.content);
      if (!separated.reasoning && !separated.incomplete) return;
      if (separated.reasoning) message.reasoning = separated.reasoning;
      message.content = separated.incomplete
        ? "The model stopped while reasoning and did not produce a final answer. Increase the output limit or try a shorter request."
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
    await renderSavedAgentTask();
    dom.pageSelect.addEventListener("change", function () {
      pageTabId = Number(dom.pageSelect.value);
      previewCapture = null;
      dom.pagePreview.textContent = "Preview page image";
    });
    dom.pagePreview.addEventListener("click", previewPageImage);
    dom.previewClose.addEventListener("click", function () { dom.previewDialog.close(); });
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
      previewCapture = null;
      selectVisionModelForPageImage();
      setLlmSettings(settings);
      renderModels();
      renderChips();
      renderPagePicker();
      renderPrivacy();
      var provider = jaaLlmProvider(settings.provider);
      if (provider.configurableBaseUrl || provider.needsKey && !settings.keys[provider.id]) dom.keysPanel.hidden = false;
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

    dom.maxContext.addEventListener("click", function () {
      var bounds = jaaLocalParameterBounds(settings.localModel);
      if (!bounds.contextMax) return;
      dom.contextWindow.value = bounds.contextMax;
      saveParameters().catch(function (error) { dom.parameterStatus.textContent = "Could not save context: " + error.message; });
    });

    dom.maxOutput.addEventListener("click", function () {
      var bounds = jaaLocalParameterBounds(settings.localModel);
      var contextWindow = Number(dom.contextWindow.value);
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= bounds.outputMin) {
        dom.parameterStatus.textContent = "Set a context window larger than " + bounds.outputMin + " tokens first.";
        return;
      }
      dom.maxNewTokens.value = Math.min(contextWindow - 1, bounds.outputMax);
      saveParameters().catch(function (error) { dom.parameterStatus.textContent = "Could not save output limit: " + error.message; });
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
        await jaaAgentClearTask();
        await renderSavedAgentTask();
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
      // Route to agentic mode if the message starts with [agent] or the
      // effective agent mode is 'always' and the message mentions forms/filling.
      var isAgentRequest = /^\[agent\]/i.test(text);
      var effectiveMode = typeof jaaLlmEffectiveAgentMode === "function" ? jaaLlmEffectiveAgentMode(settings) : "never";
      if (!isAgentRequest && effectiveMode === "always") {
        isAgentRequest = /\b(?:fill|autofill|apply|complete)\b[\s\S]*\b(?:form|fields?|page|application)\b/i.test(text) ||
          jaaAgentIsPageToolRequest(text) && (settings.context.page || settings.allowPageActions);
      }
      if (isAgentRequest) {
        var cleanText = text.replace(/^\[agent\]\s*/i, "");
        currentSend = sendAgentic(cleanText);
      } else {
        currentSend = send(text);
      }
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

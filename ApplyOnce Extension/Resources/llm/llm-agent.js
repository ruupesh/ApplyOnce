/* Reviewable write tools for the Assistant. No tool submits a form. */
var JAA_AGENT_MAX_ACTIONS = 30;
var JAA_AGENT_SENSITIVE_RE = /(password|passwd|\bssn\b|social security|passport number|driver'?s?\s*licen[cs]e|credit card|card number|\bcvv\b|\bcvc\b|security code|routing number|bank account|account number|pin number)/i;

function jaaAgentSystemInstructions() {
  return (
    "\n\n# Available ApplyOnce actions\n" +
    "When the user explicitly asks to save or change profile fields or fill a web form, explain what you propose, then end with exactly one machine-readable block:\n" +
    "<applyonce_actions>[{\"type\":\"set_field\",\"field\":\"email\",\"value\":\"person@example.com\"},{\"type\":\"fill_form\"}]</applyonce_actions>\n" +
    "Use set_field only for facts the user explicitly supplied. Use append_field when the user explicitly asks to add text to that same field's current value. Use snake_case field names. Use fill_form only when explicitly asked. Never propose passwords, government IDs, banking/payment data, file fields, clicks, or form submission. The user reviews every action before it runs."
  );
}

function jaaAgentValidateActions(actions) {
  if (!Array.isArray(actions)) return [];
  var out = [];
  actions.slice(0, JAA_AGENT_MAX_ACTIONS).forEach(function (action) {
    if (!action || typeof action !== "object") return;
    if (action.type === "fill_form" && !out.some(function (item) { return item.type === "fill_form"; })) {
      out.push({ type: "fill_form" });
      return;
    }
    if (action.type !== "set_field" && action.type !== "append_field") return;
    var field = slugify(String(action.field || "")).slice(0, 60);
    var value = String(action.value == null ? "" : action.value).trim().slice(0, 4000);
    if (!field || field === "field" || !value || JAA_AGENT_SENSITIVE_RE.test(field)) return;
    var existing = out.find(function (item) { return (item.type === "set_field" || item.type === "append_field") && item.field === field; });
    if (existing) existing.value = value;
    else out.push({ type: action.type, field: field, value: value });
  });
  return out;
}

function jaaAgentResumeSection(lines, heading, following) {
  var start = lines.findIndex(function (line) { return line.toUpperCase() === heading; });
  if (start < 0) return [];
  var end = lines.length;
  for (var i = start + 1; i < lines.length; i++) {
    if (following.indexOf(lines[i].toUpperCase()) !== -1) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

function jaaAgentResumeMonth(value) {
  var months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06", jul:"07", july:"07", aug:"08", sep:"09", sept:"09", oct:"10", nov:"11", dec:"12" };
  return months[String(value || "").trim().slice(0, 4).toLowerCase()] || months[String(value || "").trim().slice(0, 3).toLowerCase()] || "";
}

function jaaAgentAsksForMissingPageFields(text) {
  var request = String(text || "").trim();
  var missing = /\b(?:missing|empty|unfilled|blank|incomplete)\b/i.test(request) ||
    /\bnot\s+(?:yet\s+)?(?:filled|completed|entered|answered|selected)\b/i.test(request);
  var target = /\b(?:page|form|fields?|inputs?|questions?)\b/i.test(request);
  var requestVerb = /\b(?:which|what|show|list|tell|find|check|identify)\b/i.test(request);
  return missing && target && requestVerb;
}

// Resume imports bypass the language model. A small model should never invent
// application data, and a long pasted resume should not have to fit through an
// ONNX prompt merely to copy facts that are already explicit in the text.
function jaaAgentExtractResumeActions(userText) {
  var raw = String(userText || "").replace(/\r/g, "");
  if (!/\bresume\b/i.test(raw) || !/^WORK EXPERIENCE\s*$/mi.test(raw) || !/^EDUCATION\s*$/mi.test(raw)) return [];
  var lines = raw.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
  var headings = ["PROFILE SUMMARY", "SKILLS", "WORK EXPERIENCE", "EDUCATION", "CERTIFICATION & ACHIEVEMENTS", "CERTIFICATIONS", "PROJECTS"];
  var actions = [];

  var summary = jaaAgentResumeSection(lines, "PROFILE SUMMARY", headings).join(" ").trim();
  if (summary) actions.push({ type: "set_field", field: "profile_summary", value: summary });

  var skillLines = jaaAgentResumeSection(lines, "SKILLS", headings);
  var skills = [];
  skillLines.forEach(function (line) {
    var values = line.indexOf(":") === -1 ? line : line.slice(line.indexOf(":") + 1);
    values.split(",").forEach(function (value) {
      value = value.replace(/\([^)]*$/, "").replace(/[()]+$/g, "").trim();
      if (value && value.length <= 60 && skills.indexOf(value) === -1) skills.push(value);
    });
  });
  skills = skills.slice(0, 8);
  if (skills.length) actions.push({ type: "set_field", field: "type_to_add_skills", value: skills.join(", ") });

  var work = jaaAgentResumeSection(lines, "WORK EXPERIENCE", headings);
  var jobs = [];
  for (var i = 0; i < work.length; i++) {
    var employer = work[i].match(/^(.+?)\s*\|\s*(.+)$/);
    var timing = work[i + 1] && work[i + 1].match(/^(.+?)\s*\|\s*([A-Za-z]+)\s+(\d{4})\s*[–—-]\s*(Present|[A-Za-z]+\s+\d{4})$/i);
    if (!employer || !timing) continue;
    var next = i + 2;
    while (next < work.length) {
      var possibleEmployer = work[next].match(/^(.+?)\s*\|\s*(.+)$/);
      var possibleTiming = work[next + 1] && /\|\s*[A-Za-z]+\s+\d{4}\s*[–—-]\s*(?:Present|[A-Za-z]+\s+\d{4})$/i.test(work[next + 1]);
      if (possibleEmployer && possibleTiming) break;
      next++;
    }
    var endParts = /^Present$/i.test(timing[4]) ? null : timing[4].match(/^([A-Za-z]+)\s+(\d{4})$/);
    jobs.push({
      company: employer[1].trim(), title: employer[2].trim(), location: timing[1].trim(),
      fromMonth: jaaAgentResumeMonth(timing[2]), fromYear: timing[3], current: !endParts,
      toMonth: endParts ? jaaAgentResumeMonth(endParts[1]) : "", toYear: endParts ? endParts[2] : "",
      description: work.slice(i + 2, next).join("\n").trim()
    });
    i = next - 1;
  }
  jobs.slice(0, 6).forEach(function (job, index) {
    var prefix = "work_experience_" + (index + 1) + "_";
    actions.push({ type: "set_field", field: prefix + "job_title", value: job.title });
    actions.push({ type: "set_field", field: prefix + "company", value: job.company });
    actions.push({ type: "set_field", field: prefix + "location", value: job.location });
    actions.push({ type: "set_field", field: prefix + "i_currently_work_here", value: job.current ? "Yes" : "No" });
    if (job.fromMonth) actions.push({ type: "set_field", field: prefix + "from_month", value: job.fromMonth });
    actions.push({ type: "set_field", field: prefix + "from_year", value: job.fromYear });
    if (job.toMonth) actions.push({ type: "set_field", field: prefix + "to_month", value: job.toMonth });
    if (job.toYear) actions.push({ type: "set_field", field: prefix + "to_year", value: job.toYear });
    if (job.description) actions.push({ type: "set_field", field: prefix + "role_description", value: job.description });
  });

  var education = jaaAgentResumeSection(lines, "EDUCATION", headings);
  if (education.length) {
    var school = education[0].match(/^(.+?)\s*\|\s*(.+)$/);
    if (school) {
      var degreeParts = school[2].split(/\s+-\s+/);
      actions.push({ type: "set_field", field: "education_1_school_or_university", value: school[1].trim() });
      actions.push({ type: "set_field", field: "education_1_degree", value: degreeParts[0].trim() });
      if (degreeParts[1]) actions.push({ type: "set_field", field: "education_1_field_of_study", value: degreeParts.slice(1).join(" - ").trim() });
    }
    var gpa = education.join(" ").match(/\bCGPA\s*:\s*([^•\n]+)/i);
    if (gpa) actions.push({ type: "set_field", field: "education_1_overall_result_gpa", value: gpa[1].trim() });
  }

  var certifications = jaaAgentResumeSection(lines, "CERTIFICATION & ACHIEVEMENTS", headings);
  var certification = certifications.map(function (line) {
    var match = line.match(/^•?\s*Certification(?:\s*\([^)]*\))?\s*:\s*(.+?)[.]?$/i);
    return match && match[1];
  }).filter(Boolean)[0];
  if (certification) actions.push({ type: "set_field", field: "certifications_and_achievements", value: certification });

  if (actions.length) actions.push({ type: "fill_form" });
  return jaaAgentValidateActions(actions);
}

function jaaAgentExtractActions(reply, userText) {
  var text = String(reply || "");
  var match = text.match(/<applyonce_actions>([\s\S]*?)<\/applyonce_actions>/i);
  var actions = [];
  if (match) {
    try { actions = jaaAgentValidateActions(JSON.parse(match[1])); } catch (error) { actions = []; }
    text = text.replace(match[0], "").trim();
  }
  // Reliable fallback for small local models on direct, single-field commands.
  if (!actions.length) {
    actions = jaaAgentExtractResumeActions(userText);
  }
  if (!actions.length) {
    var commandText = String(userText || "").trim().replace(/\s*,?\s+(?:and|then)\s+(?:please\s+)?(?:fill|autofill|apply)\b[\s\S]*$/i, "");
    var command = commandText.match(/^(?:please\s+)?(?:set|save|update|change)\s+(?:my\s+)?(.+?)\s+(?:to|as)\s+(.+?)[.!]?$/i);
    if (command) actions = jaaAgentValidateActions([{ type: "set_field", field: command[1], value: command[2] }]);
    var append = commandText.match(/^(?:please\s+)?(?:in|for)\s+(?:my\s+)?(.+?)\s*,?\s+(?:add|append)\s+(.+?)[.!]?$/i) ||
      commandText.match(/^(?:please\s+)?(?:add|append)\s+(.+?)\s+(?:to|in)\s+(?:my\s+)?(.+?)[.!]?$/i);
    if (append) {
      var reversed = /^(?:please\s+)?(?:add|append)/i.test(commandText);
      actions = jaaAgentValidateActions([{ type: "append_field", field: reversed ? append[2] : append[1], value: reversed ? append[1] : append[2] }]);
    }
    if (/\b(?:fill|autofill|apply)\b[\s\S]*\b(?:form|fields?|page|application)\b/i.test(userText || "")) {
      actions = jaaAgentValidateActions(actions.concat([{ type: "fill_form" }]));
    }
  }
  return { text: text, actions: actions };
}

async function jaaAgentDefaultWebTab() {
  var tabs = await jaaBrowser.tabs.query({ lastFocusedWindow: true });
  return (tabs || []).filter(function (tab) { return /^https?:/i.test(tab.url || ""); }).sort(function (a, b) {
    return Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0);
  })[0] || null;
}

function jaaAgentPageConnectionError(error) {
  var message = String((error && error.message) || error || "");
  if (/receiving end does not exist|could not establish connection|message port closed/i.test(message)) {
    return new Error("ApplyOnce was reloaded after this page opened. Reload the selected webpage once, then try again.");
  }
  return error instanceof Error ? error : new Error(message || "Could not reach the selected webpage.");
}

async function jaaAgentInspectForm(tabId) {
  var tab = tabId == null ? await jaaAgentDefaultWebTab() : { id: tabId };
  if (!tab) throw new Error("Open a webpage containing a form, then try again.");
  var result;
  try {
    result = await jaaBrowser.tabs.sendMessage(tab.id, { type: "JAA_AGENT_INSPECT_FORM" }, { frameId: 0 });
  } catch (error) {
    throw jaaAgentPageConnectionError(error);
  }
  if (!result || !result.ok) throw new Error("Could not inspect that page. Reload it and check ApplyOnce's site access.");
  return { tabId: tab.id, result: result };
}

async function jaaAgentDescribeActions(actions, tabId) {
  var profile = await getState();
  var validated = jaaAgentValidateActions(actions);
  var plan = { actions: validated, fields: [], pageFields: [], form: null, tabId: tabId };
  if (validated.some(function (action) { return action.type === "fill_form"; }) ||
      (tabId != null && validated.some(function (action) { return action.type === "set_field" || action.type === "append_field"; }))) {
    var inspected = await jaaAgentInspectForm(tabId);
    plan.tabId = inspected.tabId;
    plan.form = inspected.result;
  }
  function pageFieldFor(fieldName) {
    var wanted = slugify(fieldName);
    return plan.form && plan.form.fields.find(function (field) {
      return field.ref === wanted || field.key === wanted || slugify(field.label) === wanted;
    });
  }
  plan.actions = validated.map(function (action) {
    if (action.type !== "append_field") return action;
    var pageField = pageFieldFor(action.field);
    var stored = profile.fields[action.field];
    var base = pageField && pageField.current || stored && stored.type !== "file" && stored.value || "";
    var value = (String(base).trim() + " " + action.value).trim();
    return { type: "set_field", field: action.field, value: value };
  });
  plan.actions.forEach(function (action) {
    if (action.type !== "set_field") return;
    var current = profile.fields[action.field];
    var pageField = pageFieldFor(action.field);
    var from = pageField ? pageField.current : current && current.type !== "file" ? String(current.value || "") : "";
    plan.fields.push({ field: action.field, label: pageField && pageField.label || action.field.replace(/_/g, " "), from: from, to: action.value });
    if (pageField) {
      plan.pageFields.push({ field: pageField.ref || action.field, label: pageField.label, value: action.value });
    } else if (plan.form && validated.some(function (item) { return item.type === "fill_form"; })) {
      // Resume imports can create repeatable Workday rows only when applied.
      // Forward their scoped field references so the content script can add
      // those rows first, then populate them.
      plan.pageFields.push({ field: action.field, label: action.field.replace(/_/g, " "), value: action.value });
    }
  });
  return plan;
}

async function jaaAgentApplyActions(plan) {
  var actions = jaaAgentValidateActions(plan && plan.actions);
  var updates = actions.filter(function (action) { return action.type === "set_field"; });
  if (updates.length) {
    var profile = await getState();
    if (!profile.activityLog) profile.activityLog = [];
    updates.forEach(function (action) {
      var now = Date.now();
      var field = profile.fields[action.field];
      if (field && field.type === "file") throw new Error("File fields can only be changed with a file picker.");
      if (!field) field = profile.fields[action.field] = { value: "", aliases: [], type: "text", createdAt: now };
      field.value = action.value;
      field.updatedAt = now;
      if (!field.aliases) field.aliases = [];
      var friendly = action.field.replace(/_/g, " ");
      if (!field.aliases.some(function (alias) { return normalizeLabel(alias) === friendly; })) field.aliases.push(friendly);
      profile.activityLog.push({ ts: now, type: "assistant-update", label: friendly, value: action.value.slice(0, 300), url: "assistant" });
    });
    profile.activityLog = profile.activityLog.slice(-JAA_ACTIVITY_LOG_MAX);
    await setState(profile);
  }
  var form = null;
  var pageUpdate = null;
  var needsPage = actions.some(function (action) { return action.type === "fill_form"; }) || (plan.pageFields && plan.pageFields.length);
  if (needsPage) {
    if (plan.tabId == null) throw new Error("The selected form tab is no longer available.");
    var tab = await jaaBrowser.tabs.get(plan.tabId);
    if (!tab || !plan.form || tab.url !== plan.form.url) throw new Error("The selected page changed after review. Ask to fill it again so you can review the current form.");
  }
  if (plan.pageFields && plan.pageFields.length) {
    try {
      pageUpdate = await jaaBrowser.tabs.sendMessage(plan.tabId, { type: "JAA_AGENT_SET_FIELDS", fields: plan.pageFields }, { frameId: 0 });
    } catch (error) {
      throw jaaAgentPageConnectionError(error);
    }
    if (!pageUpdate || !pageUpdate.ok) throw new Error(pageUpdate && pageUpdate.error || "Could not update the selected fields on the page.");
  }
  if (actions.some(function (action) { return action.type === "fill_form"; })) {
    try {
      form = await jaaBrowser.tabs.sendMessage(plan.tabId, { type: "JAA_AGENT_FILL_FORM" }, { frameId: 0 });
    } catch (error) {
      throw jaaAgentPageConnectionError(error);
    }
    if (!form || !form.ok) throw new Error(form && form.error || "Could not fill the selected form.");
  }
  return { updatedCount: updates.length, pageUpdate: pageUpdate, form: form };
}

async function jaaAgentObserve(tabId) {
  var observation = { filled: [], failed: [], errors: [], emptyRequired: [] };
  try {
    var form = await jaaBrowser.tabs.sendMessage(tabId, { type: "JAA_AGENT_INSPECT_FORM" }, { frameId: 0 });
    if (form && form.ok && form.fields) {
      form.fields.forEach(function (field) {
        if (field.current) observation.filled.push(field.label);
        else if (field.fillable) observation.failed.push(field.label);
        if (field.empty && field.required) observation.emptyRequired.push(field.label);
      });
    }
  } catch (error) { /* page may have navigated */ }
  try {
    var validation = await jaaBrowser.tabs.sendMessage(tabId, { type: "JAA_AGENT_GET_VALIDATION" }, { frameId: 0 });
    if (validation && validation.ok) {
      observation.errors = (validation.fieldErrors || []).concat(
        (validation.pageErrors || []).map(function (err) { return { label: err.text, message: err.text }; })
      );
    }
  } catch (error) { /* validation check optional */ }
  return observation;
}

var JAA_AGENT_MAX_ITERATIONS = 10;

async function jaaAgentLoop(options) {
  var tabId = options.tabId;
  var maxIter = options.maxIterations || JAA_AGENT_MAX_ITERATIONS;
  var iteration = 0;
  var agentMessages = options.messages.slice();
  var allWriteActions = [];
  var done = false;

  while (iteration < maxIter && !done) {
    iteration++;
    if (options.signal) options.signal.throwIfAborted();
    if (options.onStep) options.onStep({ iteration: iteration, maxIterations: maxIter, status: "thinking" });

    // Call LLM with tools.
    var response = await sendToLlmWithTools({
      providerId: options.providerId,
      key: options.key,
      model: options.model,
      parameters: options.parameters,
      pageImages: options.providerId === "local" && iteration !== 1 ? [] : options.pageImages,
      system: options.system,
      messages: agentMessages,
      tools: options.tools,
      signal: options.signal,
      onDelta: options.onDelta
    });

    var text = response.text || "";
    var toolCalls = response.toolCalls || [];

    // No tool calls — the model is responding with text only.
    if (!toolCalls.length) {
      // Check if the text contains XML actions (fallback for local models).
      var xmlActions = jaaAgentExtractActions(text, "");
      if (xmlActions.actions.length) {
        allWriteActions = allWriteActions.concat(xmlActions.actions);
        text = xmlActions.text;
      }
      done = true;
      return { text: text, writeActions: allWriteActions, iterations: iteration, done: true };
    }

    // Record assistant message with tool calls.
    if (text) {
      agentMessages.push({ role: "assistant", content: text });
    }

    // Process each tool call.
    var hasWriteTools = false;
    var writeToolCalls = [];
    for (var i = 0; i < toolCalls.length; i++) {
      var tc = toolCalls[i];
      if (options.signal) options.signal.throwIfAborted();

      if (tc.name === "done") {
        done = true;
        return {
          text: text || (tc.args && tc.args.summary) || "Task complete.",
          writeActions: allWriteActions,
          iterations: iteration,
          done: true
        };
      }

      if (jaaLlmIsWriteTool(tc.name)) {
        hasWriteTools = true;
        writeToolCalls.push(tc);
        // Convert tool calls to legacy action format for the review card.
        if (tc.name === "set_fields" && tc.args && tc.args.fields) {
          tc.args.fields.forEach(function (fieldPair) {
            allWriteActions.push({ type: "set_field", field: fieldPair.field, value: fieldPair.value });
          });
        } else if (tc.name === "fill_form") {
          if (!allWriteActions.some(function (a) { return a.type === "fill_form"; })) {
            allWriteActions.push({ type: "fill_form" });
          }
        } else if (tc.name === "click_element") {
          allWriteActions.push({ type: "click_element", text: tc.args && tc.args.text || "", role: tc.args && tc.args.role || "" });
        }
        continue;
      }

      // Read-only tool — execute immediately.
      if (options.onStep) options.onStep({ iteration: iteration, maxIterations: maxIter, status: "tool", tool: tc.name });
      var result;
      try {
        result = await jaaLlmExecuteToolCall(tc.name, tc.args, tabId);
      } catch (error) {
        result = "Error executing " + tc.name + ": " + String((error && error.message) || error);
      }

      // Add tool result to conversation for the next turn.
      agentMessages.push({
        role: "tool",
        content: typeof result === "string" ? result : JSON.stringify(result),
        toolCallId: tc.id,
        name: tc.name
      });
    }

    // If there are write tools, pause and return them for review.
    if (hasWriteTools) {
      done = true;
      return {
        text: text || "I need to make changes to the form. Please review the proposed actions.",
        writeActions: jaaAgentValidateActions(allWriteActions),
        iterations: iteration,
        done: false,
        pendingMessages: agentMessages
      };
    }
  }

  // Max iterations reached.
  return {
    text: text || "I've reached the maximum number of reasoning steps. Here's what I have so far.",
    writeActions: allWriteActions,
    iterations: iteration,
    done: true
  };
}

// Resume the agent loop after write actions have been applied.
async function jaaAgentResumeLoop(options) {
  var tabId = options.tabId;
  var agentMessages = options.messages.slice();

  // Observe the result of applied actions.
  var observation = await jaaAgentObserve(tabId);
  var summary = [];
  if (observation.filled.length) summary.push("Filled: " + observation.filled.join(", "));
  if (observation.failed.length) summary.push("Still empty (has saved value): " + observation.failed.join(", "));
  if (observation.emptyRequired.length) summary.push("Required but empty: " + observation.emptyRequired.join(", "));
  if (observation.errors.length) {
    summary.push("Validation errors: " + observation.errors.map(function (e) { return e.label + " - " + e.message; }).join("; "));
  }
  var observationText = summary.length ? summary.join("\n") : "All actions applied successfully. No validation errors detected.";

  // Add the observation as a tool result.
  agentMessages.push({
    role: "tool",
    content: "Actions applied. Observation:\n" + observationText,
    toolCallId: "post-apply-" + Date.now(),
    name: "fill_form"
  });

  // Continue the agent loop.
  return jaaAgentLoop(Object.assign({}, options, { messages: agentMessages }));
}

function jaaAgentAgenticSystemInstructions() {
  return (
    "\n\n# Agent mode\n" +
    "You are in Agent mode. You have tools available to inspect forms, fill fields, check validation errors, and navigate pages.\n" +
    "Follow this workflow:\n" +
    "1. Call inspect_form to understand the current page state.\n" +
    "2. Call get_profile and/or get_resume to understand what data is available.\n" +
    "3. Use fill_form to fill all matching fields, or set_fields for specific values.\n" +
    "4. After filling, call get_validation_errors to check for problems.\n" +
    "5. If there are errors, use set_fields to fix them.\n" +
    "6. Call done when the task is complete.\n\n" +
    "Important rules:\n" +
    "- Never set passwords, government IDs, banking/payment data, or file fields.\n" +
    "- Never click submit buttons or submit forms.\n" +
    "- Use fill_form for bulk filling and set_fields for targeted corrections.\n" +
    "- Use click_element only for navigation (Next, Continue, Save) buttons, never for submission.\n" +
    "- Always explain what you are doing before calling tools.\n" +
    "- The user reviews and approves all write actions before execution."
  );
}

if (typeof window !== "undefined") {
  window.jaaAgentExtractActions = jaaAgentExtractActions;
  window.jaaAgentExtractResumeActions = jaaAgentExtractResumeActions;
  window.jaaAgentAsksForMissingPageFields = jaaAgentAsksForMissingPageFields;
  window.jaaAgentDescribeActions = jaaAgentDescribeActions;
  window.jaaAgentApplyActions = jaaAgentApplyActions;
  window.jaaAgentLoop = jaaAgentLoop;
  window.jaaAgentResumeLoop = jaaAgentResumeLoop;
  window.jaaAgentObserve = jaaAgentObserve;
  window.jaaAgentAgenticSystemInstructions = jaaAgentAgenticSystemInstructions;
}

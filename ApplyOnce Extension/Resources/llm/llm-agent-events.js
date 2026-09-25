/* User-visible activity is always available. Developer console diagnostics are
 * a separate build-time feature and never contain prompts or response bodies.
 */
function jaaAgentEmit(task, options, type, message, details) {
  var event = Object.assign({ type: type, message: String(message).slice(0, 800),
    iteration: task.iterations || 0, maxIterations: task.maxIterations, time: Date.now() }, details || {});
  task.activity = (task.activity || []).concat([event]).slice(-60);
  if (options && options.onActivity) options.onActivity(event);
  if (typeof jaaDiagnostics !== 'undefined') jaaDiagnostics.log(type, {
    taskId: task.id, stage: task.stage, iteration: event.iteration, maxIterations: task.maxIterations,
    provider: task.providerId, model: event.model || task.model, tool: event.tool, status: event.status,
    durationMs: event.durationMs, chars: event.chars, code: event.code, count: event.count
  });
  return event;
}

function jaaAgentErrorCode(error) {
  if (error && error.code && error.code !== 'TOOL_ERROR') return error.code;
  var message = String(error && error.message || error || '');
  // Also recognize checkpoints/errors from older content scripts after upgrade.
  if (/disabled for this website/i.test(message)) return 'SITE_ACTIONS_DISABLED';
  if (/page actions (?:are|were) disabled/i.test(message)) return 'PAGE_ACTIONS_DISABLED';
  if (/document changed|page URL changed|page changed|page.*navigated/i.test(message)) return 'PAGE_CHANGED';
  if (/Submission, destructive|Sensitive inputs|file uploads cannot/i.test(message)) return 'ACTION_BLOCKED';
  if (/receiving end does not exist|could not establish connection/i.test(message)) return 'PAGE_DISCONNECTED';
  return 'TOOL_ERROR';
}

function jaaAgentStop(task, options, code, reason) {
  var text = String(reason);
  if (code === 'SITE_ACTIONS_DISABLED') text += ' Allow this website in the Sites tab, then resume. No page action was performed.';
  else if (code === 'PAGE_ACTIONS_DISABLED') text += ' Enable Allow agent actions on pages, then resume.';
  else if (code === 'STEP_BUDGET') text = 'Paused after ' + task.iterations + ' model calls (limit ' + task.maxIterations + '). ' + reason + ' The task is not verified complete. Continue the task for another bounded set of calls, or refine the request.';
  else if (code === 'REPEATED_FAILURE' || code === 'NO_PROGRESS') text += ' Repeated attempts were stopped. Change the request or resolve the issue before resuming.';
  jaaAgentEmit(task, options, 'blocked', text, { code: code });
  return Object.assign({}, task, { stage: 'blocked', blockedCode: code, raw: '', pendingTool: null, actions: [], text: text });
}

function jaaAgentBudgetStop(task, options) {
  var reason = task.feedback ? 'Last issue: ' + task.feedback : task.lastToolSummary || 'The model has not produced a final answer or reviewable action.';
  return jaaAgentStop(task, options, 'STEP_BUDGET', reason);
}

function jaaAgentValidationFailure(task, options, error) {
  var count = (task.validationFailures || 0) + 1;
  var reason = String(error.message || error).slice(0, 700);
  jaaAgentEmit(task, options, 'validation_error', 'Could not use the model response: ' + reason, { code: 'INVALID_RESPONSE', count: count });
  var next = Object.assign({}, task, { validationFailures: count, raw: '', feedback: reason, stage: 'plan' });
  return count >= 3 ? jaaAgentStop(next, options, 'REPEATED_FAILURE', 'Three consecutive model responses were invalid. Last issue: ' + reason) : next;
}

function jaaAgentModelStream(task, options) {
  var output = '', reasoning = '', metadata = {}, started = Date.now(), first = true;
  var iteration = task.iterations + 1;
  jaaAgentEmit(task, options, 'model_start', 'Waiting for the model to choose the next step…', { iteration: iteration });
  function publish(complete) {
    var split = jaaLlmSplitReasoning(output);
    if (first && (output || reasoning)) {
      first = false;
      jaaAgentEmit(task, options, 'model_stream', 'Receiving model output…', { iteration: iteration });
    }
    if (options.onModelOutput) options.onModelOutput({ iteration: iteration, output: split.answer.slice(-16000),
      reasoning: (reasoning + (split.reasoning ? '\n' + split.reasoning : '')).trim().slice(-16000), complete: !!complete });
    if (options.onReasoning) options.onReasoning((reasoning + '\n' + split.reasoning).trim());
  }
  return {
    onDelta: function (delta) { output += delta; publish(false); },
    onReasoningDelta: function (delta) { reasoning += delta; publish(false); },
    onResponseMetadata: function (value) {
      var changedModel = value.model && value.model !== task.model && value.model !== metadata.model;
      metadata = Object.assign(metadata, value);
      if (changedModel) jaaAgentEmit(task, options, 'provider_model', 'Provider reported model: ' + value.model, { model: value.model, iteration: iteration });
    },
    finish: function (raw) {
      output = String(raw || output); publish(true);
      jaaAgentEmit(task, options, 'model_end', 'Model response received; checking it…', {
        iteration: iteration, durationMs: Date.now() - started, chars: output.length, status: metadata.finishReason || 'received'
      });
      return { reasoning: (reasoning + '\n' + jaaLlmSplitReasoning(output).reasoning).trim(), responseMetadata: metadata };
    }
  };
}

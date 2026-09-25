/* Live task activity and raw model output are product UI, not debug logging.
 * Every value is inserted as text; model output never becomes executable HTML.
 */
function jaaCreateAgentActivityView(node, history, live) {
  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }
  var panel = element('details', 'llmAgentActivity');
  panel.open = !!live;
  panel.appendChild(element('summary', '', 'Agent activity'));
  var list = element('ol', 'llmAgentEvents');
  panel.appendChild(list);
  var status = element('p', 'llmAgentStatus');
  status.setAttribute('role', 'status');
  var elapsed = element('span', 'llmAgentElapsed');
  if (live) panel.appendChild(elapsed);
  node.appendChild(panel);
  if (live) node.appendChild(status);
  var streams = new Map(), current = null, started = Date.now(), timer;
  function add(event) {
    var item = element('li', event.type === 'blocked' || /error$/.test(event.type) ? 'isError' : '');
    item.textContent = (event.iteration ? 'Call ' + event.iteration + ': ' : '') + event.message;
    list.appendChild(item);
    while (list.children.length > 60) list.firstElementChild.remove();
    list.scrollTop = list.scrollHeight;
    current = event;
    status.textContent = event.message;
  }
  (history || []).forEach(add);
  if (live) timer = setInterval(function () {
    elapsed.textContent = Math.floor((Date.now() - started) / 1000) + 's elapsed' +
      (current && current.type === 'model_start' ? ' · Waiting for provider output' : '');
  }, 1000);
  return {
    event: add,
    modelOutput: function (event) {
      var stream = streams.get(event.iteration);
      if (!stream) {
        var details = element('details', 'llmAgentStream');
        details.setAttribute('aria-live', 'off');
        details.open = true;
        details.appendChild(element('summary', '', 'Model output · call ' + event.iteration));
        var thoughtLabel = element('p', 'llmAgentStreamLabel', 'Reasoning shared by the provider');
        var thought = element('pre', 'llmAgentStreamText');
        var outputLabel = element('p', 'llmAgentStreamLabel', 'Response');
        var output = element('pre', 'llmAgentStreamText');
        var note = element('p', 'llmAgentStreamNote');
        [thoughtLabel, thought, outputLabel, output, note].forEach(function (child) { details.appendChild(child); });
        node.appendChild(details);
        streams.set(event.iteration, stream = { details: details, thought: thought, thoughtLabel: thoughtLabel, output: output, note: note });
      }
      stream.thoughtLabel.hidden = stream.thought.hidden = !event.reasoning;
      stream.thought.textContent = event.reasoning || '';
      stream.output.textContent = event.output || (event.reasoning ? 'Waiting for the response…' : 'Waiting for provider output…');
      stream.note.textContent = event.complete ? (event.reasoning ? 'Response received.' : 'The provider supplied no separate reasoning text.') : 'Streaming the output supplied by your provider.';
      stream.output.scrollTop = stream.output.scrollHeight;
      stream.thought.scrollTop = stream.thought.scrollHeight;
    },
    finish: function () { clearInterval(timer); elapsed.remove(); status.remove(); }
  };
}

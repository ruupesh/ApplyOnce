/* Local inference worker. Only selected context crosses into this worker. */
var jaaBrowser = { runtime: { getURL: function (file) { return new URL("../" + file, self.location.href).href; } } };
importScripts("llm-store.js");
importScripts("llm-local.js");
self.onmessage = async function (event) {
  var request = event.data;
  function report(type, value) { self.postMessage({ id: request.id, type: type, value: value }); }
  try {
    request.onProgress = function (value) { report("progress", value); };
    request.onDelta = function (value) { report("delta", value); };
    report("done", await jaaGenerateLocalLlm(request));
  } catch (error) {
    report("error", String(error.message || error));
  }
};

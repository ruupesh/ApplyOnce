importScripts("storage.js");

// Make sure a valid default state exists on first install so the popup and
// options page never see an undefined profile.
jaaBrowser.runtime.onInstalled.addListener(async function () {
  await setState(await getState());
});

// Workday's autocomplete ignores editing events dispatched from an isolated
// content-script world. Run only the text replacement in the page's main
// world; option matching and clicking remain in the guarded content script.
if (jaaBrowser.runtime.onMessage && jaaBrowser.scripting) {
  jaaBrowser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "JAA_MAIN_REPLACE_TEXT") return false;
    if (!sender.tab || typeof sender.tab.id !== "number" || !message.token) {
      sendResponse({ ok: false });
      return false;
    }
    var target = { tabId: sender.tab.id };
    if (typeof sender.frameId === "number") target.frameIds = [sender.frameId];
    jaaBrowser.scripting.executeScript({
      target: target,
      world: "MAIN",
      func: function (token, value) {
        var input = document.querySelector('[data-jaa-main-edit="' + token + '"]');
        if (!input) return { ok: false };
        input.focus();
        if (input.select) input.select();
        document.execCommand("delete", false);
        var inserted = document.execCommand("insertText", false, String(value));

        // Workday's typeahead keeps its search callback on a React class
        // component above the input. Browser editing updates the visible text,
        // but some versions do not request results from that edit alone. Ask
        // the component to run the same Enter search that its key handler uses.
        var reactFiberKey = Object.keys(input).find(function (key) {
          return key.indexOf("__reactFiber$") === 0;
        });
        var fiber = reactFiberKey ? input[reactFiberKey] : null;
        var searchTriggered = false;
        for (var depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
          var component = fiber.stateNode;
          if (!component || typeof component.getSearchType !== "function" ||
              !component.props || typeof component.props.onSearch !== "function") continue;
          try {
            var enterEvent = new KeyboardEvent("keyup", {
              key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true
            });
            component.props.onSearch(
              String(value),
              false,
              component.getSearchType(false, enterEvent)
            );
            searchTriggered = true;
          } catch (error) {}
          break;
        }
        return { ok: !!inserted, value: input.value, searchTriggered: searchTriggered };
      },
      args: [String(message.token), String(message.value == null ? "" : message.value)]
    }).then(function (results) {
      sendResponse(results && results[0] ? results[0].result : { ok: false });
    }).catch(function () {
      sendResponse({ ok: false });
    });
    return true;
  });
}

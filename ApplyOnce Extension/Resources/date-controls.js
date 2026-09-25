// Serialized by scripting.executeScript, so keep this function self-contained.
// Workday's segmented dates are React-controlled spinbuttons. Let each key
// commit before sending the next key, and reacquire inputs after rerenders.
async function jaaSetDateSectionInPage(token, value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return { ok: false, error: "Invalid date target" };
  var original = document.querySelector('[data-jaa-date-edit="' + token + '"]');
  if (!original) return { ok: false, error: "Date field no longer present" };
  var automation = original.getAttribute("data-automation-id") || "";
  var part = automation.match(/^dateSection(Month|Day|Year)-input$/);
  if (!part) return { ok: false, error: "Not a segmented date input" };
  var text = String(value).trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: "Date segment must contain digits only" };
  var number = Number(text);
  if (part[1] === "Month" && (number < 1 || number > 12) ||
      part[1] === "Day" && (number < 1 || number > 31) ||
      part[1] === "Year" && text.length !== 4) return { ok: false, error: "Invalid " + part[1].toLowerCase() };
  var id = original.id;
  var container = original.closest('[data-automation-id^="formField-"]') || original.parentElement;
  function live() {
    return id && document.getElementById(id) || container.querySelector('[data-automation-id="' + automation + '"]');
  }
  function target(input) { return input.closest('[role="spinbutton"]') || input.parentElement; }
  function tick() { return new Promise(function (resolve) { setTimeout(resolve, 30); }); }
  async function key(key, code, keyCode) {
    var input = live();
    if (!input) throw new Error("Date input disappeared during editing");
    var section = target(input);
    if (section.focus) section.focus();
    for (var type of ["keydown", "keypress", "keyup"]) {
      if (type === "keypress" && key.length !== 1) continue;
      // Start on the input so both input and ancestor keyboard handlers run.
      // Dispatching on the wrapper skips handlers installed on the input.
      input.dispatchEvent(new KeyboardEvent(type, { key: key, code: code, keyCode: keyCode, which: keyCode,
        bubbles: true, cancelable: true, composed: true }));
    }
    await tick();
  }
  // Clear the whole segment, including a partially entered year.
  for (var i = 0; i < 8; i++) {
    var input = live();
    if (!input || !/\d/.test(input.value)) break;
    await key("Backspace", "Backspace", 8);
  }
  // A clear key also resets the component's accumulated typing buffer.
  await key("Backspace", "Backspace", 8);
  for (var character of text) await key(character, "Digit" + character, character.charCodeAt(0));
  var input = live();
  if (input) {
    var section = target(input);
    if (section.blur) section.blur();
    if (input.blur) input.blur();
  }
  await tick();
  input = live();
  var actual = input ? input.value : "";
  return { ok: /^\d+$/.test(actual) && Number(actual) === number, value: actual, method: "date-segment-keyboard",
    error: /^\d+$/.test(actual) && Number(actual) === number ? "" : "The date control did not commit the entered value" };
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ApplyOnce Extension/Resources/date-controls.js'), 'utf8');

function control(part, initial = '', accept = true) {
  let value = initial;
  let input;
  let revisions = 0;
  const keys = [];
  const section = {
    focus() {}, blur() {},
    dispatchEvent(event) {
      if (event.type !== 'keydown') return;
      keys.push(event.key);
      if (!accept) return;
      // Emulate React batching: a write reads the previous committed state,
      // and both the value and input node change asynchronously.
      let next = event.key === 'Backspace' ? value.slice(0, -1) : value + event.key;
      if (part === 'Month' && next.length >= 2) next = String(Number(next));
      setTimeout(() => { value = next; input = makeInput(); revisions++; }, 0);
    }
  };
  const container = { querySelector: () => input };
  function makeInput() {
    return {
      id: 'employment-date-' + part,
      get value() { return value; },
      getAttribute: () => 'dateSection' + part + '-input',
      closest: selector => selector.includes('spinbutton') ? section : container,
      parentElement: section, blur() {},
      dispatchEvent: event => section.dispatchEvent(event)
    };
  }
  input = makeInput();
  const ctx = vm.createContext({
    document: { querySelector: () => input, getElementById: () => input },
    setTimeout: fn => setTimeout(fn, 0),
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  });
  vm.runInContext(source, ctx);
  return { ctx, keys, value: () => value, revisions: () => revisions };
}

test('segmented month typing waits for React commits and accepts unpadded display', async () => {
  const h = control('Month', '12');
  const result = await h.ctx.jaaSetDateSectionInPage('target', '03');
  assert.equal(result.ok, true);
  assert.equal(h.value(), '3');
  assert.ok(h.revisions() >= 5);
  assert.deepEqual(h.keys.slice(-2), ['0', '3']);
});

test('segmented year replaces existing digits across rerendered input nodes', async () => {
  const h = control('Year', '2023');
  const result = await h.ctx.jaaSetDateSectionInPage('target', '2025');
  assert.equal(result.ok, true);
  assert.equal(h.value(), '2025');
});

test('date control failure remains a failure without faking the DOM value', async () => {
  const h = control('Month', '12', false);
  const result = await h.ctx.jaaSetDateSectionInPage('target', '03');
  assert.equal(result.ok, false);
  assert.equal(h.value(), '12');
});

test('invalid full dates cannot be typed into one segment', async () => {
  const h = control('Month');
  assert.equal((await h.ctx.jaaSetDateSectionInPage('target', '032025')).ok, false);
  assert.equal((await h.ctx.jaaSetDateSectionInPage('target', 'March 2025')).ok, false);
  assert.equal(h.keys.length, 0);
});

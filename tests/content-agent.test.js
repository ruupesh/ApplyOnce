const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../ApplyOnce Extension/Resources');

function date(name) {
  return `<div data-automation-id="formField-${name}"><label>${name} *</label>
    <div role="spinbutton" tabindex="0"><input id="${name}-month" aria-label="Month" readonly data-automation-id="dateSectionMonth-input"></div>
    <div role="spinbutton" tabindex="0"><input id="${name}-year" aria-label="Year" readonly data-automation-id="dateSectionYear-input"></div>
    <button aria-label="Open calendar">Calendar</button></div>`;
}

async function page(t, acceptKeys = true, extraFields = {}) {
  const dom = new JSDOM(`<section role="group"><h5>Work Experience 1</h5>${date('From')}${date('To')}
    <label for="title">Job Title</label><input id="title" value="Previous title">
    <input readonly aria-label="Read-only summary" value="Leave alone">
    <div data-automation-id="formField-country"><label>Country</label><button>Select One</button></div></section>`,
    { url: 'https://example.myworkdayjobs.com/apply', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  let listener;
  const records = { jaaPageActionsAllowed: true };
  w.browser = {
    storage: { local: {
      get: async key => ({ [key]: structuredClone(records[key]) }),
      set: async data => Object.assign(records, structuredClone(data))
    }, onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener: callback => { listener = callback; } },
      sendMessage: async message => {
        assert.equal(message.type, 'JAA_MAIN_SET_DATE_SECTION');
        return w.jaaSetDateSectionInPage(message.token, message.value);
      }
    }
  };
  w.eval(fs.readFileSync(path.join(root, 'storage.js'), 'utf8'));
  records.jaaState = { ...w.jaaDefaultState(), fields: {
    work_experience_1_job_title: { value: 'Saved old title', aliases: ['Job Title'], type: 'text' }, ...extraFields
  } };
  // Commit asynchronously and replace the DOM node, as controlled inputs do.
  // Listen on the INPUT itself: wrapper-only key dispatch must fail this test.
  function attach(input) {
    input.addEventListener('keydown', event => {
      if (!acceptKeys || !/^\d$|^Backspace$/.test(event.key)) return;
      const next = event.key === 'Backspace' ? input.value.slice(0, -1) : input.value + event.key;
      w.setTimeout(() => {
        const replacement = input.cloneNode(true);
        replacement.value = next;
        input.replaceWith(replacement);
        attach(replacement);
      }, 0);
    });
  }
  w.document.querySelectorAll('[data-automation-id^="dateSection"]').forEach(attach);
  w.eval(fs.readFileSync(path.join(root, 'date-controls.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'page-policy.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'page-tools.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'content.js'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const send = message => new Promise(resolve => listener(message, {}, resolve));
  return { w, records, send };
}

test('calendar buttons do not hide segmented inputs or turn dates into dropdowns', async t => {
  const h = await page(t);
  const snapshot = await h.send({ type: 'JAA_AGENT_INSPECT_FORM' });
  const segments = snapshot.fields.filter(field => field.datePart);
  assert.deepEqual(Array.from(segments, field => field.ref), [
    'work_experience_1_from_month', 'work_experience_1_from_year',
    'work_experience_1_to_month', 'work_experience_1_to_year'
  ]);
  assert.equal(snapshot.fields.some(field => /summary/i.test(field.label)), false);
  assert.ok(segments.every(field => field.required));
  assert.deepEqual(Array.from(snapshot.fields.filter(field => field.type === 'custom-widget'), field => field.label), ['Country']);
});

test('reviewed date edits reach input handlers, survive rerenders, and report exact refs', async t => {
  const h = await page(t);
  const result = await h.send({ type: 'JAA_AGENT_SET_FIELDS', scoped: true, fields: [
    { field: 'work_experience_1_from_month', value: '03' },
    { field: 'work_experience_1_from_year', value: '2025' }
  ] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.updatedCount, 2);
  assert.equal(result.results[0].status, 'filled');
  assert.equal(result.results[0].method, 'date-segment-keyboard');
  assert.equal(h.w.document.getElementById('From-year').value, '2025');
  assert.equal(h.w.document.getElementById('To-year').value, '');
});

test('date rejection reaches the caller with actual value and editing error', async t => {
  const h = await page(t, false);
  const result = await h.send({ type: 'JAA_AGENT_SET_FIELDS', scoped: true, fields: [
    { field: 'work_experience_1_from_month', value: '03' }
  ] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].actual, '');
  assert.match(result.results[0].error, /did not commit/);
});

test('profile autofill cannot replace a reviewed page value after a rerender', async t => {
  const h = await page(t);
  const result = await h.send({ type: 'JAA_AGENT_SET_FIELDS', scoped: true, fields: [
    { field: 'work_experience_1_job_title', value: 'Reviewed new title' }
  ] });
  assert.equal(result.updatedCount, 1, result.error);
  const input = h.w.document.getElementById('title');
  const replacement = input.cloneNode(true);
  replacement.value = input.value;
  input.replaceWith(replacement);
  await h.send({ type: 'JAA_RESCAN' });
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(replacement.value, 'Reviewed new title');
  assert.equal(h.records.jaaState.fields.work_experience_1_job_title.value, 'Saved old title');
});

test('passive date autofill uses the asynchronous editor instead of dropping digits', async t => {
  const h = await page(t, true, {
    work_experience_1_from_month: { value: '03', type: 'text', aliases: [] },
    work_experience_1_from_year: { value: '2025', type: 'text', aliases: [] }
  });
  await h.send({ type: 'JAA_RESCAN' });
  for (let i = 0; i < 30 && h.w.document.getElementById('From-year').value !== '2025'; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(h.w.document.getElementById('From-year').value, '2025');
  assert.equal(h.w.document.getElementById('From-month').value, '03');
});

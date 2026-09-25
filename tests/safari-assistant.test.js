const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = path.resolve(__dirname, '../ApplyOnce Extension/Resources');
// Also exercise the actual Xcode bundle, where directory flattening broke Safari.
const root = process.env.JAA_TEST_EXTENSION_ROOT || source;

test('Safari project preserves script and runtime subdirectories', () => {
  const project = fs.readFileSync(path.resolve(__dirname, '../ApplyOnce.xcodeproj/project.pbxproj'), 'utf8');
  const folders = project.match(/explicitFolders = \(([\s\S]*?)\);/)[1];
  for (const folder of ['llm', 'vendor']) assert.ok(folders.includes('Resources/' + folder));
});

for (const namespace of ['browser', 'chrome']) {
  test(`${namespace}: packaged assistant initializes providers, keys, attachments and page selection`, async t => {
    const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'https://extension.test/options.html#assistant', runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const w = dom.window;
    const records = {};
    w[namespace] = {
      runtime: { getURL: file => 'https://extension.test/' + file },
      storage: { local: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in records).map(k => [k, records[k]])),
        set: async values => Object.assign(records, values)
      }, onChanged: { addListener() {} } },
      tabs: { query: async () => [{ id: 7, url: 'https://example.test/job', title: 'Example job', active: true }] }
    };
    w.fetch = async () => ({ ok: false }); // Optional on-device runtime need not be installed.
    for (const script of w.document.querySelectorAll('script[src]')) {
      const file = script.getAttribute('src');
      assert.ok(fs.existsSync(path.join(root, file)), 'Missing packaged script: ' + file);
      if (file !== 'options.js') w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    assert.ok(fs.existsSync(path.join(root, 'llm/llm-worker.js')));
    assert.ok(fs.existsSync(path.join(root, 'vendor/agent/graph.mjs')));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const byId = id => w.document.getElementById(id);
    assert.ok(byId('llmProvider').options.length > 1);
    assert.ok(byId('llmModel').options.length > 0);
    const wasHidden = byId('llmKeysPanel').hidden;
    byId('llmKeysBtn').click();
    assert.equal(byId('llmKeysPanel').hidden, !wasHidden);
    const chips = [...byId('llmChips').querySelectorAll('button')];
    assert.ok(chips.some(b => b.textContent === 'Profile'));
    assert.ok(chips.some(b => b.textContent === 'Resume'));
    const page = chips.find(b => b.textContent === 'This page');
    assert.ok(page);
    if (page.getAttribute('aria-pressed') !== 'true') page.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(byId('llmPageRow').hidden, false);
    assert.equal(byId('llmPageSelect').value, '7');
    const style = w.document.createElement('style');
    style.textContent = fs.readFileSync(path.join(root, 'options.css'), 'utf8');
    w.document.head.append(style);
    const inputStyle = w.getComputedStyle(byId('llmInput'));
    assert.equal(inputStyle.color, 'rgb(31, 41, 55)');
    assert.equal(inputStyle.backgroundColor, 'rgb(255, 255, 255)');
  });
}

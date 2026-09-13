/**
 * Functional tests for the BUILT artifact (dist/main.js).
 *
 * These deliberately exercise the bundle rather than the TypeScript source,
 * because the bundle is what Obsidian actually evaluates. The 'obsidian'
 * module is stubbed the same way Obsidian injects it, and a minimal document
 * shim lets the modal render so the link-suggestion flow can be driven to
 * completion.
 *
 * Run: node test/run-tests.js
 */

const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------- assertions */

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
  }
}

/* ------------------------------------------------------------- DOM shim */

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    classList: { _v: [], add(c) { this._v.push(c); }, remove() {}, contains(c) { return this._v.includes(c); } },
    _listeners: {},
    textContent: '',
    type: '',
    checked: false,
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    click() { (this._listeners.click || []).forEach((fn) => fn({})); },
    dispatchChange() { (this._listeners.change || []).forEach((fn) => fn({})); },
  };
}

global.document = { createElement: makeEl };

/** Depth-first walk of the shim element tree. */
function walk(el, out) {
  out = out || [];
  out.push(el);
  (el.children || []).forEach((c) => walk(c, out));
  return out;
}

/* --------------------------------------------------------- obsidian stub */

const NOTICES = [];
let REQUEST_HANDLER = null;

class Notice {
  constructor(message) { NOTICES.push(String(message)); }
  setMessage() { return this; }
  hide() {}
}

const MODALS = [];

class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = makeEl('div');
    this.contentEl = makeEl('div');
    this.titleEl = makeEl('div');
    MODALS.push(this);
  }
  open() { this.onOpen(); }
  close() { this.onClose(); }
  onOpen() {}
  onClose() {}
}

function component(extra) {
  const base = {
    inputEl: makeEl('input'),
    setName() { return this; },
    setDesc() { return this; },
    setValue() { return this; },
    getValue() { return ''; },
    setPlaceholder() { return this; },
    onChange() { return this; },
    setLimits() { return this; },
    setDynamicTooltip() { return this; },
    addOption() { return this; },
    setButtonText() { return this; },
    setCta() { return this; },
    setWarning() { return this; },
    onClick() { return this; },
  };
  return Object.assign(base, extra || {});
}

const DROPDOWNS = [];

class Setting {
  constructor(containerEl) { this.settingEl = containerEl; }
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addText(cb) { cb(component()); return this; }
  addToggle(cb) { cb(component()); return this; }
  addDropdown(cb) {
    const dropdown = component({ options: [], addOption(value, display) { this.options.push([value, display]); return this; } });
    DROPDOWNS.push(dropdown);
    cb(dropdown);
    return this;
  }
  addSlider(cb) { cb(component()); return this; }
  addButton(cb) { cb(component()); return this; }
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this._commands = [];
    this._tabs = [];
    this._data = null;
  }
  addCommand(command) { this._commands.push(command); return command; }
  addSettingTab(tab) { this._tabs.push(tab); }
  addRibbonIcon() { return makeEl('div'); }
  async loadData() { return this._data; }
  async saveData(data) { this._data = data; }
  onload() {}
  onunload() {}
  load() {}
  unload() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl('div');
  }
  hide() {}
}

class View {}
class MarkdownView extends View {}
class TFile {}
class Editor {}
class Vault {}
class Workspace {}
class MetadataCache {}

async function requestUrl(param) {
  if (!REQUEST_HANDLER) throw new Error('no request handler installed in test');
  return REQUEST_HANDLER(param);
}

const obsidianStub = {
  Notice, Modal, Setting, Plugin, PluginSettingTab,
  View, MarkdownView, TFile, Editor, Vault, Workspace, MetadataCache,
  requestUrl,
  normalizePath: (p) => p,
};

// Intercept require('obsidian') exactly the way Obsidian's own shim does.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------ test doubles */

class MockEditor {
  constructor(text) { this.text = text; this.selection = ''; }
  getValue() { return this.text; }
  setValue(v) { this.text = v; }
  getSelection() { return this.selection; }
  replaceSelection(r) { this.text = this.text.replace(this.selection, r); }
  getCursor() { return { line: 0, ch: 0 }; }
  setCursor() {}
  getLine(n) { return this.text.split('\n')[n] || ''; }
  lineCount() { return this.text.split('\n').length; }
  lastLine() { return this.text.split('\n').length - 1; }
  focus() {}
  _offset(pos) {
    const lines = this.text.split('\n');
    let off = 0;
    for (let i = 0; i < pos.line && i < lines.length; i += 1) off += lines[i].length + 1;
    return off + pos.ch;
  }
  replaceRange(replacement, from, to) {
    const s = this._offset(from);
    const e = to ? this._offset(to) : s;
    this.text = this.text.slice(0, s) + replacement + this.text.slice(e);
  }
}

function mkFile(basename, folder) {
  const dir = folder ? folder + '/' : '';
  return { basename, path: dir + basename + '.md', name: basename + '.md', extension: 'md' };
}

/** Lets queued promise chains (backend calls, modal callbacks) settle. */
async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/** Clicks the confirm button, found by its text, in the most recently opened modal. */
function confirmLatestModal(buttonText) {
  const modal = MODALS[MODALS.length - 1];
  const nodes = walk(modal.contentEl);
  const button = nodes.find((n) => n.tagName === 'BUTTON' && n.textContent === buttonText);
  if (button) button.click();
  return { nodes, button };
}

/* -------------------------------------------------------------- the tests */

async function main() {
  console.log('\n=== Elias HiveMind :: functional tests against dist/main.js ===\n');

  const bundlePath = path.resolve(__dirname, '..', 'dist', 'main.js');
  const PluginClass = require(bundlePath);

  console.log('[1] bundle shape');
  check('dist/main.js exports a function/class', typeof PluginClass === 'function');
  check('exported class extends the injected Plugin', PluginClass.prototype instanceof Plugin);

  const activeFile = mkFile('Daily Note');
  const vaultFiles = [
    activeFile,
    mkFile('Bionic Workflow'),
    mkFile('Crown Operations'),
    mkFile('Forge Memory Vault'),
    mkFile('Template Scratch', 'templates'),
    mkFile('Zed'),
  ];

  const fileCaches = {
    'Daily Note.md': { links: [{ link: 'Forge Memory Vault', original: '[[Forge Memory Vault]]' }] },
    'Crown Operations.md': { frontmatter: { aliases: ['Crown Ops'] } },
  };

  const app = {
    vault: {
      getName: () => 'TestVault',
      getMarkdownFiles: () => vaultFiles,
      getFiles: () => vaultFiles,
      getAbstractFileByPath: (p) => vaultFiles.find((f) => f.path === p) || null,
      read: async () => '',
      cachedRead: async () => '',
      modify: async () => {},
    },
    workspace: { getActiveFile: () => activeFile, getActiveViewOfType: () => null },
    metadataCache: {
      resolvedLinks: {}, unresolvedLinks: {},
      getFileCache: (f) => fileCaches[f.path] || null,
      getFirstLinkpathDest: () => null,
    },
  };

  const manifest = { id: 'elias-hivemind', name: 'Elias HiveMind Plugin', version: '1.0.0', minAppVersion: '1.0.0', description: 'test', author: 'test' };

  const plugin = new PluginClass(app, manifest);
  await plugin.onload();

  console.log('\n[2] command registration');
  const ids = plugin._commands.map((c) => c.id);
  const expected = [
    'summarize-note-local',
    'summarize-note-backend',
    'summarize-selection-local',
    'generate-tags-local',
    'generate-tags-backend',
    'suggest-links',
    'test-backend-connection',
  ];
  expected.forEach((id) => check('registered command: ' + id, ids.includes(id), 'got: ' + ids.join(', ')));
  check('a settings tab was registered', plugin._tabs.length === 1);

  console.log('\n[3] settings tab renders without throwing');
  let displayErr = null;
  try { plugin._tabs[0].display(); } catch (e) { displayErr = e; }
  check('settingTab.display() ran clean', displayErr === null, displayErr && displayErr.message);

  console.log('\n[4] local summarization (offline, deterministic)');
  const note = [
    '---', 'tags: [test]', '---', '',
    '# Pressure Notes', '',
    'The vault stores durable memory for the project. ',
    'Durable memory matters because context windows are small.',
    '',
    '```js', 'const ignored = "this code must not be summarised";', '```',
    '',
    'Memory in the vault is reviewed weekly. Weekly review keeps the vault durable.',
    'Unrelated filler sentence about nothing in particular.',
  ].join('\n');

  const ed = new MockEditor(note);
  const localCmd = plugin._commands.find((c) => c.id === 'summarize-note-local');
  NOTICES.length = 0;
  localCmd.editorCallback(ed, { file: activeFile });

  // insertMode defaults to 'top', so the note becomes:
  //   line 0: '## Summary'   line 1: <the summary>   then a blank line, then the original note.
  // Assertions must look at line 1 ONLY - anything wider re-reads the original body.
  const summaryLine = ed.text.split('\n')[1];

  check('summary block was inserted', ed.text.includes('## Summary'));
  check('note body preserved', ed.text.includes('# Pressure Notes'));
  check('code-block content excluded from summary',
    !summaryLine.includes('this code must not be summarised'), 'summary line: ' + summaryLine);
  check('frontmatter excluded from summary', !summaryLine.includes('tags:'));
  check('a success notice fired', NOTICES.some((n) => n.includes('locally')), NOTICES.join(' | '));
  check('summary is non-empty prose', summaryLine.trim().length > 20, 'got: ' + summaryLine);

  console.log('\n[5] empty note is handled, not crashed');
  const emptyEd = new MockEditor('   ');
  NOTICES.length = 0;
  localCmd.editorCallback(emptyEd, { file: activeFile });
  check('empty note produced a notice, no insertion', NOTICES.some((n) => n.includes('empty')) && !emptyEd.text.includes('## Summary'));

  console.log('\n[6] backend summarization (Ollama response shape)');
  let capturedBody = null;
  REQUEST_HANDLER = async (param) => {
    capturedBody = JSON.parse(param.body);
    return { status: 200, headers: {}, text: '{"response":"BACKEND SUMMARY TEXT"}', json: { response: 'BACKEND SUMMARY TEXT' } };
  };
  const backendEd = new MockEditor('Some note content that needs summarising by the backend model.');
  const backendCmd = plugin._commands.find((c) => c.id === 'summarize-note-backend');
  NOTICES.length = 0;
  await backendCmd.editorCallback(backendEd, { file: activeFile });
  await new Promise((r) => setImmediate(r));

  check('POSTed a model field', capturedBody && capturedBody.model === 'llama3.2', JSON.stringify(capturedBody));
  check('POSTed a prompt field (ollama shape)', capturedBody && typeof capturedBody.prompt === 'string');
  check('prompt placeholders were substituted',
    capturedBody && !capturedBody.prompt.includes('{{content}}') && !capturedBody.prompt.includes('{{n}}'));
  check('backend text inserted into note', backendEd.text.includes('BACKEND SUMMARY TEXT'));

  console.log('\n[7] backend failure is surfaced, not swallowed (fallback off)');
  check('fallback to local is on by default', plugin.settings.fallbackToLocal === true);
  plugin.settings.fallbackToLocal = false;
  REQUEST_HANDLER = async () => ({ status: 500, headers: {}, text: 'upstream exploded', json: null });
  const failEd = new MockEditor('Content for a failing backend call.');
  NOTICES.length = 0;
  await backendCmd.editorCallback(failEd, { file: activeFile });
  await new Promise((r) => setImmediate(r));
  check('HTTP 500 produced an error notice', NOTICES.some((n) => n.includes('500')), NOTICES.join(' | '));
  check('note was NOT modified on failure', !failEd.text.includes('## Summary'));
  plugin.settings.fallbackToLocal = true;

  console.log('\n[7b] backend offline -> local summary fallback');
  REQUEST_HANDLER = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
  const offlineEd = new MockEditor(note);
  NOTICES.length = 0;
  await backendCmd.editorCallback(offlineEd, { file: activeFile });
  await flush();
  check('local summary inserted when backend refuses connection', offlineEd.text.startsWith('## Summary\n'));
  check('fallback notice names the cause',
    NOTICES.some((n) => n.includes('ECONNREFUSED') && n.includes('Summarised locally instead')), NOTICES.join(' | '));

  console.log('\n[7c] backend hangs -> timeout -> local summary fallback');
  plugin.settings.backendTimeoutMs = 25;
  REQUEST_HANDLER = () => new Promise(() => {});
  const hungEd = new MockEditor(note);
  NOTICES.length = 0;
  await backendCmd.editorCallback(hungEd, { file: activeFile });
  await new Promise((r) => setTimeout(r, 80)); // let the 25 ms timeout fire
  await flush();
  check('local summary inserted after timeout', hungEd.text.startsWith('## Summary\n'));
  check('timeout notice fired', NOTICES.some((n) => n.includes('did not respond within 25 ms')), NOTICES.join(' | '));
  plugin.settings.backendTimeoutMs = 60000;

  console.log('\n[8] OpenAI-compatible response shape');
  plugin.settings.backendFormat = 'openai';
  REQUEST_HANDLER = async (param) => {
    capturedBody = JSON.parse(param.body);
    return { status: 200, headers: {}, text: '', json: { choices: [{ message: { content: 'OPENAI SUMMARY' } }] } };
  };
  const oaEd = new MockEditor('Content for the openai compatible path.');
  await backendCmd.editorCallback(oaEd, { file: activeFile });
  await new Promise((r) => setImmediate(r));
  check('sent messages[] not prompt', capturedBody && Array.isArray(capturedBody.messages));
  check('parsed choices[0].message.content', oaEd.text.includes('OPENAI SUMMARY'));
  plugin.settings.backendFormat = 'ollama';

  console.log('\n[9] link suggestion');
  const linkNote = [
    'Today I worked on the Bionic Workflow and reviewed Crown Operations.',
    'I already linked [[Forge Memory Vault]] earlier so it must not reappear.',
    '`Crown Operations` inside code should not count on its own.',
    'Also mentioned Crown Ops as an alias.',
    'Zed is too short a title to match by default.',
  ].join('\n');

  const linkEd = new MockEditor(linkNote);
  const suggestCmd = plugin._commands.find((c) => c.id === 'suggest-links');
  NOTICES.length = 0;
  MODALS.length = 0;
  await suggestCmd.editorCallback(linkEd, { file: activeFile });
  await new Promise((r) => setImmediate(r));

  // The command only opens a modal; nothing is written until the user confirms.
  // Drive that: find the confirm button in the rendered tree and click it.
  check('a suggestion modal was opened', MODALS.length === 1, 'modals: ' + MODALS.length);
  const modal = MODALS[MODALS.length - 1];
  const nodes = walk(modal.contentEl);
  const checkboxes = nodes.filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  check('modal rendered one checkbox per suggestion', checkboxes.length > 0, 'checkboxes: ' + checkboxes.length);

  const confirm = nodes.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Insert selected');
  check('modal has an "Insert selected" button', Boolean(confirm));
  confirm.click();

  const inserted = linkEd.text;
  check('suggested-links block appended', inserted.includes('## Suggested links'));
  check('suggests Bionic Workflow', inserted.includes('[[Bionic Workflow]]'));
  check('suggests Crown Operations', inserted.includes('[[Crown Operations'));
  check('does NOT re-suggest already-linked note',
    !inserted.split('## Suggested links')[1].includes('[[Forge Memory Vault]]'));
  check('does NOT suggest title shorter than minTitleLength',
    !inserted.split('## Suggested links')[1].includes('[[Zed]]'));
  check('does NOT suggest the active note itself',
    !inserted.split('## Suggested links')[1].includes('[[Daily Note]]'));
  check('ignored folder excluded',
    !inserted.split('## Suggested links')[1].includes('[[Template Scratch]]'));

  console.log('\n[10] no unlinked mentions -> clean notice');
  const cleanEd = new MockEditor('Nothing here refers to any other note at all.');
  NOTICES.length = 0;
  await suggestCmd.editorCallback(cleanEd, { file: activeFile });
  check('reported no unlinked mentions', NOTICES.some((n) => n.includes('no unlinked')), NOTICES.join(' | '));
  check('note untouched', !cleanEd.text.includes('## Suggested links'));

  console.log('\n[10a] local tags merge into existing inline frontmatter tags');
  const tagLocalCmd = plugin._commands.find((c) => c.id === 'generate-tags-local');
  const tagBackendCmd = plugin._commands.find((c) => c.id === 'generate-tags-backend');
  const tagNote = [
    '---', 'title: Vault notes', 'tags: [memory]', '---',
    '# Vault review',
    'The vault keeps durable memory. Weekly review keeps the vault durable.',
    'Durable notes survive weekly review.',
  ].join('\n');
  const tagEd = new MockEditor(tagNote);
  MODALS.length = 0;
  await tagLocalCmd.editorCallback(tagEd, { file: activeFile });
  await flush();
  check('a tag modal was opened', MODALS.length === 1, 'modals: ' + MODALS.length);
  const tagModal = confirmLatestModal('Add selected tags');
  const tagBoxes = tagModal.nodes.filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  check('no more tags offered than maxTags', tagBoxes.length > 0 && tagBoxes.length <= plugin.settings.maxTags, 'boxes: ' + tagBoxes.length);
  check('modal has an "Add selected tags" button', Boolean(tagModal.button));
  const tagHead = tagEd.text.split('\n---\n')[0];
  check('existing tag kept exactly once', (tagHead.match(/- memory/g) || []).length === 1, tagHead);
  check('repeated term added as a tag', tagHead.includes('  - vault') && tagHead.includes('  - durable'), tagHead);
  check('inline tags rewritten as a block list', !tagHead.includes('tags: [memory]'), tagHead);
  check('other frontmatter keys preserved', tagHead.includes('title: Vault notes'));
  check('note body preserved', tagEd.text.includes('# Vault review\nThe vault keeps durable memory.'));

  console.log('\n[10b] backend tags: normalised, deduped, merged into block list');
  REQUEST_HANDLER = async (param) => {
    capturedBody = JSON.parse(param.body);
    return { status: 200, headers: {}, text: '', json: { response: 'Vault, #Memory, weekly review, 123\n- daily-notes' } };
  };
  const btEd = new MockEditor(['---', 'tags:', '  - vault', 'aliases: x', '---', 'Body text about the vault and memory.'].join('\n'));
  MODALS.length = 0;
  await tagBackendCmd.editorCallback(btEd, { file: activeFile });
  await flush();
  check('tag prompt placeholders substituted',
    capturedBody && !capturedBody.prompt.includes('{{') && capturedBody.prompt.includes('Body text about the vault'));
  confirmLatestModal('Add selected tags');
  const btHead = btEd.text.split('\n---\n')[0];
  check('backend tags normalised (#Memory -> memory, spaces -> hyphens)',
    btHead.includes('  - memory') && btHead.includes('  - weekly-review') && btHead.includes('  - daily-notes'), btHead);
  check('numeric tag rejected', !btHead.includes('123'), btHead);
  check('existing tag not duplicated', (btHead.match(/- vault/g) || []).length === 1, btHead);
  check('non-tag key kept after tags list', btHead.includes('aliases: x'), btHead);

  console.log('\n[10c] backend tags fail -> local tags fallback; note without frontmatter');
  REQUEST_HANDLER = async () => ({ status: 503, headers: {}, text: 'model not loaded', json: null });
  const noFmEd = new MockEditor('Gardens need water. Water the gardens daily. Gardens grow fast.');
  NOTICES.length = 0;
  MODALS.length = 0;
  await tagBackendCmd.editorCallback(noFmEd, { file: activeFile });
  await flush();
  check('fallback notice fired', NOTICES.some((n) => n.includes('503') && n.includes('Using local tags instead')), NOTICES.join(' | '));
  confirmLatestModal('Add selected tags');
  check('frontmatter created at top of note', noFmEd.text.startsWith('---\ntags:\n  - gardens\n'), noFmEd.text);
  check('body preserved after new frontmatter', noFmEd.text.endsWith('---\nGardens need water. Water the gardens daily. Gardens grow fast.'), noFmEd.text);

  console.log('\n[10d] installed-model listing (Ollama and OpenAI-compatible)');
  let listedParam = null;
  REQUEST_HANDLER = async (param) => {
    listedParam = param;
    return { status: 200, headers: {}, text: '', json: { models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:latest' }] } };
  };
  const ollamaModels = await plugin.fetchAvailableModels();
  check('Ollama list comes from /api/tags via GET',
    listedParam && listedParam.url === 'http://127.0.0.1:11434/api/tags' && listedParam.method === 'GET', JSON.stringify(listedParam));
  check('model names parsed and sorted', JSON.stringify(ollamaModels) === JSON.stringify(['llama3.2:latest', 'qwen2.5-coder:7b']), JSON.stringify(ollamaModels));

  plugin.settings.backendFormat = 'openai';
  plugin.settings.backendUrl = 'http://127.0.0.1:1234/v1/chat/completions';
  REQUEST_HANDLER = async (param) => {
    listedParam = param;
    return { status: 200, headers: {}, text: '', json: { data: [{ id: 'local-model' }] } };
  };
  const oaModels = await plugin.fetchAvailableModels();
  check('OpenAI-compatible list comes from /v1/models', listedParam.url === 'http://127.0.0.1:1234/v1/models', listedParam.url);
  check('OpenAI-compatible ids parsed', JSON.stringify(oaModels) === '["local-model"]', JSON.stringify(oaModels));

  plugin.settings.backendUrl = 'not a url';
  let badUrlErr = null;
  try { await plugin.fetchAvailableModels(); } catch (e) { badUrlErr = e; }
  check('invalid backend URL rejected with a clear message', badUrlErr && badUrlErr.message.includes('not a valid URL'), badUrlErr && badUrlErr.message);
  plugin.settings.backendFormat = 'ollama';
  plugin.settings.backendUrl = 'http://127.0.0.1:11434/api/generate';

  console.log('\n[10e] settings tab renders the model dropdown after loading');
  REQUEST_HANDLER = async () => ({ status: 200, headers: {}, text: '', json: { models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3.2:latest' }] } });
  const tab = plugin._tabs[0];
  tab.modelState = 'idle';
  DROPDOWNS.length = 0;
  let tabErr = null;
  try { tab.display(); await flush(); } catch (e) { tabErr = e; }
  check('display() with live model list ran clean', tabErr === null, tabErr && tabErr.message);
  const modelDropdown = DROPDOWNS.find((d) => d.options.some(([v]) => v === 'qwen2.5-coder:7b'));
  check('model dropdown lists installed models', Boolean(modelDropdown), JSON.stringify(DROPDOWNS.map((d) => d.options)));
  check('"llama3.2" matches "llama3.2:latest" (no "not installed" entry)',
    modelDropdown && !modelDropdown.options.some(([, label]) => label.includes('not installed')), modelDropdown && JSON.stringify(modelDropdown.options));

  REQUEST_HANDLER = async () => { throw new Error('connect ECONNREFUSED'); };
  tab.modelState = 'idle';
  tabErr = null;
  try { tab.display(); await flush(); } catch (e) { tabErr = e; }
  check('display() with backend offline ran clean', tabErr === null && tab.modelState === 'failed', tabErr ? tabErr.message : tab.modelState);

  console.log('\n[11] settings persistence round-trip');
  plugin.settings.summarySentenceCount = 7;
  await plugin.saveSettings();
  const reloaded = new PluginClass(app, manifest);
  reloaded._data = plugin._data;
  await reloaded.loadSettings();
  check('saved setting survives reload', reloaded.settings.summarySentenceCount === 7);
  check('defaults fill in missing keys', reloaded.settings.backendUrl === 'http://127.0.0.1:11434/api/generate');

  console.log('\n[12] onunload is clean');
  let unloadErr = null;
  try { plugin.onunload(); } catch (e) { unloadErr = e; }
  check('onunload() ran clean', unloadErr === null, unloadErr && unloadErr.message);

  console.log('\n' + '='.repeat(56));
  console.log('  PASSED: ' + passed + '   FAILED: ' + failed);
  console.log('='.repeat(56) + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTEST HARNESS CRASHED:\n', err);
  process.exit(1);
});

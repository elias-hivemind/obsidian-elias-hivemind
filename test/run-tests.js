/**
 * Functional tests for the BUILT artifact (dist/main.js).
 *
 * These deliberately exercise the bundle rather than the TypeScript source,
 * because the bundle is what Obsidian actually evaluates. The 'obsidian'
 * module is stubbed the same way Obsidian injects it, and a minimal document
 * shim - including the Obsidian DOM helpers (createEl, createDiv, createSpan,
 * empty, setText) and a window carrying the timer functions - lets the modal render
 * so the link-suggestion flow can be driven to completion.
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

    /* Obsidian's HTMLElement helpers, mirrored from obsidian.d.ts. */
    setText(value) { this.textContent = value; return this; },
    empty() { this.children.length = 0; this.textContent = ''; },
    createEl(childTag, info, callback) {
      const el = makeEl(childTag);
      applyElInfo(el, info);
      this.appendChild(el);
      if (callback) callback(el);
      return el;
    },
    createDiv(info, callback) { return this.createEl('div', info, callback); },
    createSpan(info, callback) { return this.createEl('span', info, callback); },
  };
}

/** Applies a DomElementInfo object the way Obsidian's createEl does. */
function applyElInfo(el, info) {
  if (!info) return;
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : [info.cls];
    classes.forEach((c) => el.classList.add(c));
  }
  if (info.text !== undefined) el.textContent = info.text;
  if (info.attr) Object.assign(el, info.attr);
}

global.document = { createElement: makeEl };

// Obsidian runs in a browser; the plugin uses window.setTimeout/clearTimeout
// so its timers belong to the window the code runs in (popout windows).
global.window = { setTimeout, clearTimeout };

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
    // Lives in a renamed configuration folder that is NOT in ignoreFolders.
    mkFile('Config Leak', '.hivecfg'),
    mkFile('Zed'),
  ];

  const fileCaches = {
    'Daily Note.md': { links: [{ link: 'Forge Memory Vault', original: '[[Forge Memory Vault]]' }] },
    'Crown Operations.md': { frontmatter: { aliases: ['Crown Ops'] } },
  };

  const app = {
    vault: {
      // Deliberately not ".obsidian": the plugin must read it, not assume it.
      configDir: '.hivecfg',
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
    'weekly-digest-local',
    'backlog-digest',
    'backlog-apply-tags',
    'backlog-mark-read',
    'backlog-archive',
    'backlog-link',
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
    'Config Leak lives in the configuration folder and must never be offered.',
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
  check('vault configDir excluded even when not listed in ignoreFolders',
    !inserted.split('## Suggested links')[1].includes('[[Config Leak]]'));

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

  console.log('\n[10f] declarative settings definitions (Obsidian 1.13.0+)');
  const defs = tab.getSettingDefinitions();
  const groups = defs.map((d) => d.heading);
  check('five groups, in display() order',
    JSON.stringify(groups) === JSON.stringify(['Summarization', 'Backend', 'Tags', 'Link suggestion', 'Backlog']),
    JSON.stringify(groups));

  const allItems = defs.flatMap((g) => g.items || []);
  const controlKeys = allItems.filter((i) => i.control).map((i) => i.control.key).sort();
  const expectedKeys = [
    'backendFormat', 'backendTimeoutMs', 'backendUrl', 'backlogArchiveFolder',
    'backlogFolders', 'backlogStaleDays', 'backlogTags', 'backlogThemesViaBackend', 'fallbackToLocal',
    'ignoreFolders', 'insertMode', 'maxLinkSuggestions', 'maxTags',
    'minTitleLength', 'summaryHeading', 'summarySentenceCount',
  ];
  check('every persisted setting except backendModel has a control',
    JSON.stringify(controlKeys) === JSON.stringify(expectedKeys), JSON.stringify(controlKeys));
  check('every control key exists on the settings object',
    controlKeys.every((k) => k in plugin.settings),
    JSON.stringify(controlKeys.filter((k) => !(k in plugin.settings))));
  check('model row is imperative (render, no control)',
    allItems.some((i) => i.name === 'Model' && typeof i.render === 'function' && !i.control));
  check('every item has a name', allItems.every((i) => typeof i.name === 'string' && i.name.length > 0));

  check('getControlValue reads through to settings',
    tab.getControlValue('summaryHeading') === plugin.settings.summaryHeading);
  tab.setControlValue('summaryHeading', '### Recap');
  check('setControlValue writes through to settings', plugin.settings.summaryHeading === '### Recap');
  tab.setControlValue('backendTimeoutMs', '0');
  check('non-positive timeout falls back to the default', plugin.settings.backendTimeoutMs === 60000,
    String(plugin.settings.backendTimeoutMs));
  tab.setControlValue('backendTimeoutMs', '15000');
  check('valid timeout is stored as a number', plugin.settings.backendTimeoutMs === 15000);
  tab.setControlValue('backendUrl', '  http://127.0.0.1:11434/api/generate  ');
  check('backend URL is trimmed and invalidates the model list',
    plugin.settings.backendUrl === 'http://127.0.0.1:11434/api/generate' && tab.modelState === 'idle',
    plugin.settings.backendUrl + ' / ' + tab.modelState);

  const timeoutDef = allItems.find((i) => i.control && i.control.key === 'backendTimeoutMs');
  check('timeout validate() rejects zero', typeof timeoutDef.control.validate(0) === 'string');
  check('timeout validate() accepts a positive number', timeoutDef.control.validate(1000) === undefined);

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

  console.log('\n[13] weekly digest (local): window, assembly, create');
  const DAY = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const todayStr = fmtDate(nowMs);

  const alphaText = [
    '# Alpha Harvest', '',
    'The harvest planning guide explains soil preparation for winter gardens.',
    'Soil preparation improves harvest yields across winter gardens.',
    'Harvest records track every garden bed through the winter season.',
  ].join('\n');
  const betaText = [
    '---', 'tags: [calendar]', '---',
    '# Beta Notes', '',
    'Beta references the Alpha Harvest while reviewing garden timelines.',
    'Garden timelines align planting with the harvest calendar.',
  ].join('\n');
  const gammaText = [
    '# Gamma Fresh', '',
    'Gamma captures quick ideas for the workshop backlog.',
    'Workshop backlog items get reviewed every Friday afternoon.',
  ].join('\n');
  const fillerText = 'Filler body text with enough ordinary words to summarise safely here.';

  function mkStatFile(basename, ctime, mtime, folder) {
    const f = mkFile(basename, folder);
    f.stat = { ctime, mtime, size: 100 };
    return f;
  }

  /** Lets the digest command's chain of awaited vault calls settle. */
  async function flushMany() {
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  }

  function makeDigestRig(files, contents, digestContent) {
    const store = { created: null, modified: null };
    const digestFile = digestContent === null
      ? null
      : mkStatFile('Weekly Digest', nowMs - DAY, nowMs - 1000);
    const all = digestFile ? files.concat([digestFile]) : files;
    const digestApp = {
      vault: {
        configDir: '.hivecfg',
        getName: () => 'DigestVault',
        getMarkdownFiles: () => all,
        getFiles: () => all,
        getAbstractFileByPath: (p) => (p === 'Weekly Digest.md' ? digestFile : null),
        read: async () => digestContent,
        cachedRead: async (f) => contents[f.path] || '',
        create: async (p, data) => { store.created = { path: p, data }; return digestFile; },
        modify: async (f, data) => { store.modified = data; },
      },
      workspace: { getActiveFile: () => null, getActiveViewOfType: () => null },
      metadataCache: {
        resolvedLinks: {}, unresolvedLinks: {},
        getFileCache: () => null,
        getFirstLinkpathDest: () => null,
      },
    };
    return { digestApp, store };
  }

  async function runDigest(rig) {
    const p = new PluginClass(rig.digestApp, manifest);
    await p.onload();
    const cmd = p._commands.find((c) => c.id === 'weekly-digest-local');
    NOTICES.length = 0;
    cmd.callback();
    await flushMany();
    return p;
  }

  // Beta: created long ago, modified yesterday (mtime leg).
  // Gamma: created an hour ago, mtime old (ctime leg).
  // Delta: both timestamps outside the window. Template: recent but ignored folder.
  const weekFiles = [
    mkStatFile('Alpha Harvest', nowMs - 2 * DAY, nowMs - 2 * DAY),
    mkStatFile('Beta Notes', nowMs - 30 * DAY, nowMs - DAY),
    mkStatFile('Gamma Fresh', nowMs - 60 * 60 * 1000, nowMs - 30 * DAY),
    mkStatFile('Delta Old', nowMs - 30 * DAY, nowMs - 8 * DAY),
    mkStatFile('Fresh Template', nowMs - DAY, nowMs - DAY, 'templates'),
  ];
  const weekContents = {
    'Alpha Harvest.md': alphaText,
    'Beta Notes.md': betaText,
    'Gamma Fresh.md': gammaText,
    'Delta Old.md': fillerText,
    'templates/Fresh Template.md': fillerText,
  };

  const createRig = makeDigestRig(weekFiles, weekContents, null);
  await runDigest(createRig);
  check('digest note created at the vault root', createRig.store.created && createRig.store.created.path === 'Weekly Digest.md');
  check('existing digest note not modified on first run', createRig.store.modified === null);
  const digestText = createRig.store.created ? createRig.store.created.data : '';
  check('digest carries the note title and a dated heading',
    digestText.includes('# Weekly Digest') && digestText.includes('## Weekly Digest — ' + todayStr), digestText.slice(0, 200));
  check('count line names the window start',
    digestText.includes('3 notes created or modified since ' + fmtDate(nowMs - 7 * DAY)), digestText.slice(0, 300));
  check('mtime leg included (Beta), ctime leg included (Gamma)',
    digestText.includes('### [[Beta Notes]]') && digestText.includes('### [[Gamma Fresh]]'));
  check('stale note and ignored-folder note excluded',
    !digestText.includes('[[Delta Old]]') && !digestText.includes('[[Fresh Template]]'));
  check('entries are ordered most recently modified first',
    digestText.indexOf('[[Beta Notes]]') < digestText.indexOf('[[Alpha Harvest]]') &&
    digestText.indexOf('[[Alpha Harvest]]') < digestText.indexOf('[[Gamma Fresh]]'));
  check('per-note local summary is embedded',
    digestText.includes('Soil preparation improves harvest yields across winter gardens.'), digestText.slice(0, 600));
  check('mention of another week note becomes a link line',
    digestText.includes("Links to this week's notes: [[Alpha Harvest]]"), digestText.slice(0, 900));
  check('aggregate tag suggestions close the section',
    digestText.includes('### Suggested tags for this week') && digestText.includes('#harvest'), digestText.slice(-300));
  check('success notice fired',
    NOTICES.some((n) => n.includes('weekly digest updated')), NOTICES.join(' | '));

  console.log('\n[13b] weekly digest: same-day re-run replaces the section');
  const staleDigest = [
    '# Weekly Digest', '',
    '## Weekly Digest — ' + todayStr, '',
    'STALE MARKER paragraph.', '',
    '## Weekly Digest — 2026-01-05', '',
    'Old section stays.', '',
  ].join('\n');
  const updateRig = makeDigestRig([weekFiles[0]], weekContents, staleDigest);
  await runDigest(updateRig);
  const updated = updateRig.store.modified || '';
  check('existing digest note modified, not recreated', Boolean(updateRig.store.modified) && updateRig.store.created === null);
  check('stale section content replaced', !updated.includes('STALE MARKER'), updated.slice(0, 400));
  check("today's heading appears exactly once",
    updated.split('## Weekly Digest — ' + todayStr).length - 1 === 1, updated.slice(0, 400));
  check('older dated sections are preserved',
    updated.includes('## Weekly Digest — 2026-01-05') && updated.includes('Old section stays.'));
  check('the digest note never digests itself', !updated.includes('### [[Weekly Digest]]'), updated.slice(0, 400));

  console.log('\n[13c] weekly digest: empty week writes nothing');
  const emptyRig = makeDigestRig(
    [mkStatFile('Delta Old', nowMs - 30 * DAY, nowMs - 8 * DAY)],
    { 'Delta Old.md': fillerText },
    null
  );
  await runDigest(emptyRig);
  check('empty week produced the no-notes notice',
    NOTICES.some((n) => n.includes('no notes created or modified in the last 7 days')), NOTICES.join(' | '));
  check('empty week created and modified nothing', emptyRig.store.created === null && emptyRig.store.modified === null);

  console.log('\n[13d] weekly digest: a huge week is capped, and the cap is stated');
  const capFiles = [];
  const capContents = {};
  for (let i = 1; i <= 55; i += 1) {
    const base = 'Cap Note ' + String(i).padStart(2, '0');
    capFiles.push(mkStatFile(base, nowMs - i * 60000, nowMs - i * 60000));
    capContents[base + '.md'] = 'Cap topic sentence about orchards and kilns. Orchards and kilns appear in every cap note body.';
  }
  const capRig = makeDigestRig(capFiles, capContents, null);
  await runDigest(capRig);
  const capText = capRig.store.created ? capRig.store.created.data : '';
  check('exactly 50 entries are listed', (capText.match(/### \[\[/g) || []).length === 50,
    'entries: ' + (capText.match(/### \[\[/g) || []).length);
  check('the overflow is counted in the digest',
    capText.includes('and 5 more notes from this week'), capText.slice(-300));
  check('the count line still reports the whole week',
    capText.includes('55 notes created or modified since ' + fmtDate(nowMs - 7 * DAY)), capText.slice(0, 300));
  check('the 51st note is not listed', !capText.includes('### [[Cap Note 51]]'));

  console.log('\n[14] backlog settings defaults');
  check('backlog folders default to Clippings, Inbox', plugin.settings.backlogFolders === 'Clippings, Inbox');
  check('backlog stale default is 30 days', plugin.settings.backlogStaleDays === 30);
  check('backlog archive folder default is Archive', plugin.settings.backlogArchiveFolder === 'Archive');
  check('backlog themes are off by default', plugin.settings.backlogThemesViaBackend === false);
  check('backlog tags default to empty (folders only)', plugin.settings.backlogTags === '');

  console.log('\n[15] backlog digest: scan scope, buckets, per-item assembly');
  function makeBacklogRig(files, contents, caches, digestContent, activePath) {
    const store = { created: null, modified: null, renamed: [], folders: [] };
    const digestFile = digestContent == null
      ? null
      : mkStatFile('Weekly Digest', nowMs - DAY, nowMs - 1000);
    const all = digestFile ? files.concat([digestFile]) : files;
    const rigApp = {
      vault: {
        configDir: '.hivecfg',
        getName: () => 'BacklogVault',
        getMarkdownFiles: () => all,
        getFiles: () => all,
        getAbstractFileByPath: (p) => {
          if (store.folders.includes(p)) return { path: p, name: p };
          return all.find((f) => f.path === p) || null;
        },
        read: async (f) => contents[f.path] ?? '',
        cachedRead: async (f) => contents[f.path] ?? '',
        create: async (p, data) => { store.created = { path: p, data }; contents[p] = data; return mkStatFile('Weekly Digest', nowMs, nowMs); },
        modify: async (f, data) => { store.modified = { path: f.path, data }; contents[f.path] = data; },
        createFolder: async (p) => { store.folders.push(p); return { path: p, name: p }; },
        rename: async (f, newPath) => { store.renamed.push([f.path, newPath]); },
      },
      workspace: {
        getActiveFile: () => all.find((f) => f.path === activePath) || null,
        getActiveViewOfType: () => null,
      },
      metadataCache: {
        resolvedLinks: {}, unresolvedLinks: {},
        getFileCache: (f) => (caches && caches[f.path]) || null,
        getFirstLinkpathDest: () => null,
      },
    };
    return { app: rigApp, store };
  }

  async function runBacklog(rig, settings) {
    const p = new PluginClass(rig.app, manifest);
    await p.onload();
    if (settings) Object.assign(p.settings, settings);
    NOTICES.length = 0;
    p._commands.find((c) => c.id === 'backlog-digest').callback();
    await flushMany();
    return p;
  }

  const atlasText = [
    '# Project Atlas', '',
    'Project Atlas tracks the garden compost schedule carefully.',
    'The compost schedule guides every garden planting decision this season.',
    'Garden beds follow the compost schedule without exception.',
  ].join('\n');
  const workshopText = [
    '# Workshop Log', '',
    'The workshop log records tool repairs and timber orders.',
    'Timber orders arrive before the workshop weekend build session.',
  ].join('\n');
  const relevantText = [
    '# Composting Questions Answered', '',
    'Project Atlas already lays out how our compost schedule should work this spring.',
    'The article explains how a compost pile heats up when greens and browns are layered properly.',
    'Turning the pile every week keeps air moving through the material as it breaks down.',
    'Project Atlas lists the garden beds that receive finished compost first.',
    'Moisture matters as much as temperature when the pile is breaking down slowly.',
    'A dry pile stalls while a soaked pile turns slimy and smells unpleasant.',
    'The finished compost feeds the garden beds before planting begins again.',
  ].join('\n');
  const freshText = [
    '# Star Party Notes', '',
    'The astronomy club meets on the hill above town when skies stay clear.',
    'Telescopes come out after sunset and the first stars appear over the ridge.',
    'Jupiter and Saturn are both visible this month through small telescopes.',
    'Bring warm layers because the hill gets cold once the wind picks up after midnight.',
  ].join('\n');
  const ventPara = [
    'Hydrothermal vents form where seawater seeps into cracks in the ocean floor and is heated by magma below.',
    'The superheated water rises through chimneys of deposited minerals, carrying dissolved metals and sulphur compounds into the cold deep ocean.',
    'Around these black smokers, entire ecosystems thrive without sunlight, built on bacteria that harvest chemical energy from the vent fluids.',
    'Giant tube worms, eyeless shrimp and pale crabs cluster near the warm shimmering water, grazing on microbial mats.',
    'Scientists study vent fields to understand how life might begin on other worlds, where subsurface oceans may hide similar chemistry beneath ice.',
  ].join(' ');
  const deepText = '# Vent Fields\n\n' + [ventPara, ventPara, ventPara, ventPara, ventPara, ventPara].join('\n\n');
  const staleText = [
    '# Handset Review Roundup', '',
    'The flagship handset ships with a brighter display and a noticeably larger battery this year.',
    'Reviewers praised the camera in low light and the faster chip during long gaming sessions.',
    'Battery tests lasted through a full day of heavy use with charge to spare by evening.',
    'The manufacturer promises four years of software updates for every model in the range.',
    'Prices climb again though, and the charger is no longer included in the box.',
    'Preorders open Friday with trade-in bonuses for older devices in good condition.',
  ].join('\n');
  const dupText = [
    '# Sourdough Starter Guide', '',
    'A healthy sourdough starter bubbles vigorously and smells pleasantly tangy after feeding.',
    'Feed the starter equal parts flour and water by weight every twelve hours at room temperature.',
    'Whole grain flour gives the wild yeast and bacteria more minerals to feed on during fermentation.',
    'The starter should double in size within six hours when it is ready to leaven bread dough.',
    'Cold storage in the refrigerator slows fermentation and stretches the feeding schedule to weekly.',
    'Discard half the starter before each feeding so acidity stays balanced and growth stays strong.',
    'Bakers track hydration carefully because dough behaviour changes with small shifts in water content.',
    'A mature starter can live for decades when it is fed regularly and kept reasonably clean.',
  ].join('\n');

  const backlogFiles = [
    mkStatFile('Project Atlas', nowMs - DAY, nowMs - DAY),
    mkStatFile('Workshop Log', nowMs - 2 * DAY, nowMs - 2 * DAY),
    mkStatFile('Relevant Clip', nowMs - 3 * DAY, nowMs - 3 * DAY, 'Clippings'),
    mkStatFile('Quick Save', nowMs - DAY, nowMs - DAY, 'Inbox/Deep'),
    mkStatFile('Deep Reference', nowMs - 90 * DAY, nowMs - 90 * DAY, 'Clippings'),
    mkStatFile('Old News', nowMs - 45 * DAY, nowMs - 45 * DAY, 'Clippings'),
    mkStatFile('Tiny Save', nowMs - 20 * DAY, nowMs - 20 * DAY, 'Inbox'),
    mkStatFile('Dup One', nowMs - 25 * DAY, nowMs - 25 * DAY, 'Clippings'),
    mkStatFile('Dup Two', nowMs - 24 * DAY, nowMs - 24 * DAY, 'Clippings'),
    mkStatFile('Already Read', nowMs - 10 * DAY, nowMs - 10 * DAY, 'Clippings'),
    mkStatFile('Cached Read', nowMs - 11 * DAY, nowMs - 11 * DAY, 'Inbox'),
    mkStatFile('Old Archived', nowMs - 12 * DAY, nowMs - 12 * DAY, 'Archive'),
    mkStatFile('Stray Clip', nowMs - 2 * DAY, nowMs - 2 * DAY, 'Downloads'),
  ];
  const backlogContents = {
    'Project Atlas.md': atlasText,
    'Workshop Log.md': workshopText,
    'Clippings/Relevant Clip.md': relevantText,
    'Inbox/Deep/Quick Save.md': freshText,
    'Clippings/Deep Reference.md': deepText,
    'Clippings/Old News.md': staleText,
    'Inbox/Tiny Save.md': 'Saved link. Check later.',
    'Clippings/Dup One.md': dupText,
    'Clippings/Dup Two.md': dupText,
    'Clippings/Already Read.md': '---\nhivemind-read: true\n---\n# Already Read\n\nTidal pools and shoreline ecology notes with plenty of ordinary prose about tides and rock pools.',
    'Inbox/Cached Read.md': '# Cached Read\n\nGreenhouse ventilation notes with plenty of ordinary prose about airflow and shading.',
    'Archive/Old Archived.md': staleText,
    'Downloads/Stray Clip.md': staleText,
  };
  const backlogCaches = { 'Inbox/Cached Read.md': { frontmatter: { 'hivemind-read': true } } };

  const backlogRig = makeBacklogRig(backlogFiles, backlogContents, backlogCaches, null);
  await runBacklog(backlogRig);
  check('backlog digest note created', backlogRig.store.created && backlogRig.store.created.path === 'Weekly Digest.md');
  const block = backlogRig.store.created ? backlogRig.store.created.data : '';
  check('block opens the standing backlog section inside a dated digest section',
    block.includes('## Weekly Digest — ' + todayStr) && block.includes('### Your backlog'), block.slice(0, 200));
  check('header counts only unarchived, unread clippings in the configured folders',
    block.includes('7 unread clippings in Clippings, Inbox.'), block.slice(0, 400));
  check('read clippings (marker in content and in metadata cache) are skipped and counted',
    block.includes('2 already marked read, skipped.') && !block.includes('[[Already Read]]') && !block.includes('[[Cached Read]]'), block.slice(0, 400));
  check('archive folder and non-backlog folders are out of scope',
    !block.includes('[[Old Archived]]') && !block.includes('[[Stray Clip]]'));
  check('bucket count line summarises all four buckets',
    block.includes('2 worth reading now · 2 reference · 1 gone stale · 2 junk candidates'), block.slice(0, 500));
  const iNow = block.indexOf('#### Worth reading now');
  const iRef = block.indexOf('#### Reference');
  const iStale = block.indexOf('#### Gone stale');
  const iJunk = block.indexOf('#### Junk candidates');
  check('buckets are ordered now, reference, stale, junk',
    iNow !== -1 && iNow < iRef && iRef < iStale && iStale < iJunk);
  check('relevant clip lands in Worth reading now with its mention as the reason',
    block.indexOf('[[Relevant Clip]]', iNow) > iNow && block.indexOf('[[Relevant Clip]]', iNow) < iRef &&
    block.includes('Mentions [[Project Atlas]]'), block.slice(iNow, iRef));
  check('retention hook: the section opens with a single Start here pick',
    block.includes('**Start here:** [[Relevant Clip]]'), block.slice(0, 700));
  check('retention hook: the stale and junk pile is offered as clearable today',
    block.includes('could leave the pile today'), block.slice(0, 700));
  check('the section is honest that summaries are extractive and local',
    block.includes('Summaries are extractive'), block.slice(0, 700));
  check('relevant clip offers its note as where it belongs',
    block.includes('Belongs with: [[Project Atlas]]'));
  check('per-item assembly: wikilink, read time, age, tags',
    block.includes('- [[Relevant Clip]] — 1 min read · saved 3 days ago') && block.includes('#compost'),
    block.slice(iNow, iRef));
  check('fresh clip is Worth reading now because it was just saved',
    block.indexOf('[[Quick Save]]') > iNow && block.indexOf('[[Quick Save]]') < iRef &&
    block.includes('Saved yesterday — still fresh.'), block.slice(iNow, iRef));
  check('deep old article is Reference, not stale (evergreen beats age)',
    block.indexOf('[[Deep Reference]]') > iRef && block.indexOf('[[Deep Reference]]') < iStale &&
    block.includes('Substantial, self-contained read'), block.slice(iRef, iStale));
  check('read time scales with length (deep reference is a 3 min read)',
    block.includes('- [[Deep Reference]] — 3 min read · saved 90 days ago'));
  check('old untouched low-overlap clip is Gone stale with the reason stated',
    block.indexOf('[[Old News]]') > iStale && block.indexOf('[[Old News]]') < iJunk &&
    block.includes('untouched since'), block.slice(iStale, iJunk));
  check('near-empty clip is Junk with its word count as the reason',
    block.indexOf('[[Tiny Save]]') > iJunk && block.includes('Near-empty — only 4 words'), block.slice(iJunk));
  check('the second copy of a duplicated article is Junk, the first is kept as Reference',
    block.indexOf('[[Dup One]]') > iJunk && block.includes('Near-duplicate of [[Dup Two]]') &&
    block.indexOf('[[Dup Two]]') > iRef && block.indexOf('[[Dup Two]]') < iStale &&
    block.includes('No strong signal either way'), block.slice(iJunk));
  check('success notice fired', NOTICES.some((n) => n.includes('backlog digest updated')), NOTICES.join(' | '));
  check('invariant: a digest run renames and deletes nothing',
    backlogRig.store.renamed.length === 0 && backlogRig.store.folders.length === 0);
  check('invariant: the only write is the digest note itself',
    backlogRig.store.modified === null && backlogContents['Clippings/Relevant Clip.md'] === relevantText);

  console.log('\n[15b] backlog digest: empty backlog writes nothing');
  const emptyBacklogRig = makeBacklogRig(
    [mkStatFile('Project Atlas', nowMs - DAY, nowMs - DAY)],
    { 'Project Atlas.md': atlasText },
    null,
    null
  );
  await runBacklog(emptyBacklogRig);
  check('empty backlog produced the no-clippings notice',
    NOTICES.some((n) => n.includes('no unread clippings in Clippings, Inbox')), NOTICES.join(' | '));
  check('empty backlog created and modified nothing',
    emptyBacklogRig.store.created === null && emptyBacklogRig.store.modified === null);

  console.log('\n[15c] backlog digest: everything already read writes nothing');
  const allReadRig = makeBacklogRig(
    [mkStatFile('Already Read', nowMs - 10 * DAY, nowMs - 10 * DAY, 'Clippings')],
    { 'Clippings/Already Read.md': backlogContents['Clippings/Already Read.md'] },
    null,
    null
  );
  await runBacklog(allReadRig);
  check('all-read backlog produced the clear notice',
    NOTICES.some((n) => n.includes('backlog clear')), NOTICES.join(' | '));
  check('all-read backlog wrote nothing', allReadRig.store.created === null && allReadRig.store.modified === null);

  console.log('\n[16] backlog digest: the per-run cap is bounded and stated');
  const capClipFiles = [];
  const capClipContents = {};
  for (let i = 1; i <= 55; i += 1) {
    const base = 'Cap Clip ' + String(i).padStart(2, '0');
    capClipFiles.push(mkStatFile(base, nowMs - i * 3600000, nowMs - i * 3600000, 'Clippings'));
    capClipContents['Clippings/' + base + '.md'] =
      'Cap clip ' + i + ' discusses topic' + i + ' and subject' + i + ' with enough ordinary prose around them ' +
      'to pass the near empty threshold comfortably today. It was saved from a long article page earlier ' +
      'this week for later reading and review purposes.';
  }
  const capBacklogRig = makeBacklogRig(capClipFiles, capClipContents, null, null);
  await runBacklog(capBacklogRig);
  const capBlock = capBacklogRig.store.created ? capBacklogRig.store.created.data : '';
  check('header reports the whole pile', capBlock.includes('55 unread clippings in Clippings, Inbox.'), capBlock.slice(0, 300));
  check('exactly 50 clippings are digested', (capBlock.match(/- \[\[/g) || []).length === 50,
    'items: ' + (capBlock.match(/- \[\[/g) || []).length);
  check('the overflow is counted for the next run',
    capBlock.includes('Digested the 50 most recently saved; 5 more wait for the next run'), capBlock.slice(0, 400));
  check('the most recently saved are digested first',
    capBlock.includes('[[Cap Clip 01]]') && !capBlock.includes('[[Cap Clip 55]]'));

  console.log('\n[17] backlog section rides inside the weekly digest, and merges without duplicating');
  const weeklyClip = mkStatFile('Weekly Clip', nowMs - 40 * DAY, nowMs - 40 * DAY, 'Clippings');
  const weeklyClipText = staleText.replace('Handset Review Roundup', 'Tablet Review Roundup');
  const rideRig = makeDigestRig(
    weekFiles.concat([weeklyClip]),
    Object.assign({}, weekContents, { 'Clippings/Weekly Clip.md': weeklyClipText }),
    null
  );
  await runDigest(rideRig);
  const rideText = rideRig.store.created ? rideRig.store.created.data : '';
  check('weekly digest carries the standing backlog section',
    rideText.includes('### Your backlog') && rideText.includes('[[Weekly Clip]]'), rideText.slice(-600));
  check('the backlog item is bucketed inside the weekly section',
    rideText.indexOf('[[Weekly Clip]]') > rideText.indexOf('#### Gone stale'), rideText.slice(-600));

  const mergeContents = {
    'Alpha Harvest.md': alphaText,
    'Clippings/Weekly Clip.md': weeklyClipText,
    'Weekly Digest.md': rideText,
  };
  const mergeRig = makeBacklogRig(
    [weekFiles[0], weeklyClip],
    mergeContents,
    null,
    rideText
  );
  await runBacklog(mergeRig);
  const merged = mergeRig.store.modified ? mergeRig.store.modified.data : '';
  check('standalone backlog run modifies the digest note in place', Boolean(mergeRig.store.modified) && mergeRig.store.created === null);
  check('the backlog block is replaced, not duplicated',
    merged.split('### Your backlog').length - 1 === 1, merged.slice(-500));
  check("the week's own entries survive a backlog-only run",
    merged.includes('### [[Alpha Harvest]]') && merged.includes('## Weekly Digest — ' + todayStr));

  console.log('\n[18] backlog process actions: explicit, per-item, non-destructive (spec-named)');
  async function runBacklogCommand(rig, commandId, settings) {
    const p = new PluginClass(rig.app, manifest);
    await p.onload();
    if (settings) Object.assign(p.settings, settings);
    NOTICES.length = 0;
    p._commands.find((c) => c.id === commandId).callback();
    await flushMany();
    return p;
  }
  const actionContents = {
    'Clippings/Action Clip.md': '# Action Clip\n\nThe body of this clipping must survive every process action untouched.',
  };
  const actionRig = makeBacklogRig(
    [mkStatFile('Action Clip', nowMs - 5 * DAY, nowMs - 5 * DAY, 'Clippings')],
    Object.assign({}, actionContents),
    null,
    null,
    'Clippings/Action Clip.md'
  );
  await runBacklogCommand(actionRig, 'backlog-mark-read');
  check('mark read writes the read marker into the clipping frontmatter',
    actionRig.store.modified !== null &&
    actionRig.store.modified.path === 'Clippings/Action Clip.md' &&
    actionRig.store.modified.data.startsWith('---\nhivemind-read: true\n---'),
    actionRig.store.modified ? actionRig.store.modified.data.slice(0, 120) : 'no modify');
  check('mark read preserves the clipping body',
    actionRig.store.modified !== null &&
    actionRig.store.modified.data.includes('The body of this clipping must survive'));
  check('mark read moves and deletes nothing',
    actionRig.store.renamed.length === 0 && actionRig.store.folders.length === 0);
  actionRig.store.created = null;
  actionRig.store.modified = null;
  await runBacklog(actionRig);
  check('a marked clipping drops out of the next digest run',
    NOTICES.some((n) => n.includes('backlog clear')) &&
    actionRig.store.created === null && actionRig.store.modified === null,
    NOTICES.join(' | '));

  const outsideRig = makeBacklogRig(
    [mkStatFile('Loose Note', nowMs - 5 * DAY, nowMs - 5 * DAY)],
    { 'Loose Note.md': '# Loose Note\n\nNot a clipping at all.' },
    null,
    null,
    'Loose Note.md'
  );
  await runBacklogCommand(outsideRig, 'backlog-mark-read');
  check('process commands refuse notes outside the backlog',
    NOTICES.some((n) => n.includes('is not in the backlog')) && outsideRig.store.modified === null,
    NOTICES.join(' | '));

  const archiveRig = makeBacklogRig(
    [mkStatFile('Action Clip', nowMs - 5 * DAY, nowMs - 5 * DAY, 'Clippings')],
    Object.assign({}, actionContents),
    null,
    null,
    'Clippings/Action Clip.md'
  );
  await runBacklogCommand(archiveRig, 'backlog-archive');
  check('archive moves the clipping into the archive folder, creating it first',
    JSON.stringify(archiveRig.store.renamed) === JSON.stringify([['Clippings/Action Clip.md', 'Archive/Action Clip.md']]) &&
    archiveRig.store.folders.includes('Archive'),
    JSON.stringify(archiveRig.store.renamed));
  check('archive reports itself in a notice', NOTICES.some((n) => n.includes('archived')), NOTICES.join(' | '));

  const collisionRig = makeBacklogRig(
    [
      mkStatFile('Action Clip', nowMs - 5 * DAY, nowMs - 5 * DAY, 'Clippings'),
      mkStatFile('Action Clip', nowMs - 50 * DAY, nowMs - 50 * DAY, 'Archive'),
    ],
    Object.assign({}, actionContents, { 'Archive/Action Clip.md': '# Older copy\n\nAlready archived long ago.' }),
    null,
    null,
    'Clippings/Action Clip.md'
  );
  await runBacklogCommand(collisionRig, 'backlog-archive');
  check('archive refuses to overwrite a same-named note',
    collisionRig.store.renamed.length === 0 && NOTICES.some((n) => n.includes('already exists')),
    NOTICES.join(' | '));

  const tagActionRig = makeBacklogRig(
    [mkStatFile('Garden Clip', nowMs - 2 * DAY, nowMs - 2 * DAY, 'Clippings')],
    { 'Clippings/Garden Clip.md': '# Garden Notes\n\nGardens need water. Water the gardens daily. Gardens grow fast.' },
    null,
    null,
    'Clippings/Garden Clip.md'
  );
  MODALS.length = 0;
  await runBacklogCommand(tagActionRig, 'backlog-apply-tags');
  check('apply tags opens the usual checklist modal', MODALS.length === 1, 'modals: ' + MODALS.length);
  confirmLatestModal('Add selected tags');
  await flushMany();
  check('apply tags merges the suggested tag into the clipping frontmatter',
    tagActionRig.store.modified !== null && tagActionRig.store.modified.data.includes('- gardens'),
    tagActionRig.store.modified ? tagActionRig.store.modified.data.slice(0, 160) : 'no modify');
  check('apply tags preserves the clipping body',
    tagActionRig.store.modified !== null && tagActionRig.store.modified.data.includes('Gardens grow fast.'));

  const linkRig = makeBacklogRig(
    [
      mkStatFile('Project Atlas', nowMs - DAY, nowMs - DAY),
      mkStatFile('Link Clip', nowMs - 2 * DAY, nowMs - 2 * DAY, 'Clippings'),
    ],
    {
      'Project Atlas.md': atlasText,
      'Clippings/Link Clip.md': '# Link Clip\n\nProject Atlas guides the planting schedule this spring. Project Atlas lists the beds that get compost first.',
    },
    null,
    null,
    'Clippings/Link Clip.md'
  );
  MODALS.length = 0;
  await runBacklogCommand(linkRig, 'backlog-link');
  check('link opens the suggestion checklist for the clipping', MODALS.length === 1, 'modals: ' + MODALS.length);
  confirmLatestModal('Insert selected');
  await flushMany();
  check('link appends the chosen notes under a Suggested links heading',
    linkRig.store.modified !== null &&
    linkRig.store.modified.data.includes('## Suggested links') &&
    linkRig.store.modified.data.includes('- [[Project Atlas]]'),
    linkRig.store.modified ? linkRig.store.modified.data.slice(-200) : 'no modify');

  console.log('\n[19] backlog themes: opt-in backend pass, best-effort');
  const themeFiles = [
    mkStatFile('Project Atlas', nowMs - DAY, nowMs - DAY),
    mkStatFile('Relevant Clip', nowMs - 3 * DAY, nowMs - 3 * DAY, 'Clippings'),
    mkStatFile('Quick Save', nowMs - DAY, nowMs - DAY, 'Inbox/Deep'),
  ];
  const themeContents = {
    'Project Atlas.md': atlasText,
    'Clippings/Relevant Clip.md': relevantText,
    'Inbox/Deep/Quick Save.md': freshText,
  };
  REQUEST_HANDLER = async () => ({
    status: 200, headers: {}, text: '',
    json: { response: '- Gardens: compost, beds and planting schedules' },
  });
  const themeRig = makeBacklogRig(themeFiles, Object.assign({}, themeContents), null, null);
  await runBacklog(themeRig, { backlogThemesViaBackend: true });
  const themeText = themeRig.store.created ? themeRig.store.created.data : '';
  check('an opted-in backend adds a themes section to the backlog block',
    themeText.includes('#### Themes across your backlog') && themeText.includes('Gardens: compost, beds'),
    themeText.slice(-400));
  REQUEST_HANDLER = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
  const themeFailRig = makeBacklogRig(themeFiles, Object.assign({}, themeContents), null, null);
  await runBacklog(themeFailRig, { backlogThemesViaBackend: true });
  const themeFailText = themeFailRig.store.created ? themeFailRig.store.created.data : '';
  check('a dead backend leaves the local digest standing, with no themes section',
    themeFailText.includes('### Your backlog') && !themeFailText.includes('Themes across your backlog'),
    themeFailText.slice(-300));
  REQUEST_HANDLER = null;

  console.log('\n[19b] offline / no-network path (spec-named): local digests make zero requests');
  let requestCount = 0;
  REQUEST_HANDLER = async () => { requestCount += 1; throw new Error('network must not be touched'); };
  const offlineBacklogRig = makeBacklogRig(themeFiles, Object.assign({}, themeContents), null, null);
  await runBacklog(offlineBacklogRig);
  check('backlog digest completes with the network handler armed to fail',
    offlineBacklogRig.store.created !== null && offlineBacklogRig.store.created.data.includes('### Your backlog'));
  const offlineWeekRig = makeDigestRig(weekFiles, weekContents, null);
  await runDigest(offlineWeekRig);
  check('weekly digest (with its backlog section) completes offline too',
    offlineWeekRig.store.created !== null && offlineWeekRig.store.created.data.includes('### Your backlog'));
  check('zero network requests were made by either local digest', requestCount === 0, 'requests: ' + requestCount);
  REQUEST_HANDLER = null;

  console.log('\n[20] summarize re-run replaces the summary block instead of stacking it');
  plugin.settings.summaryHeading = '## Summary';
  plugin.settings.summarySentenceCount = 3;
  const dupEd = new MockEditor(note);
  await localCmd.editorCallback(dupEd, { file: activeFile });
  await localCmd.editorCallback(dupEd, { file: activeFile });
  check('two summarize runs leave exactly one summary heading',
    (dupEd.text.match(/## Summary/g) || []).length === 1, dupEd.text.slice(0, 300));
  check('the note title appears exactly once after re-summarising',
    (dupEd.text.match(/# Pressure Notes/g) || []).length === 1);
  plugin.settings.insertMode = 'bottom';
  const dupBottomEd = new MockEditor(note);
  await localCmd.editorCallback(dupBottomEd, { file: activeFile });
  await localCmd.editorCallback(dupBottomEd, { file: activeFile });
  check('bottom mode also replaces instead of stacking',
    (dupBottomEd.text.match(/## Summary/g) || []).length === 1 &&
    dupBottomEd.text.indexOf('## Summary') > dupBottomEd.text.indexOf('The vault stores durable memory'),
    dupBottomEd.text.slice(-300));
  plugin.settings.insertMode = 'top';

  console.log('\n[21] backlog selection by tags, not just folders');
  const tagSelRig = makeBacklogRig(
    [
      mkStatFile('Tagged Clip', nowMs - DAY, nowMs - DAY, 'Downloads'),
      mkStatFile('Inline Clip', nowMs - DAY, nowMs - DAY, 'Downloads'),
      mkStatFile('Other Clip', nowMs - DAY, nowMs - DAY, 'Downloads'),
      mkStatFile('Folder Clip', nowMs - DAY, nowMs - DAY, 'Clippings'),
    ],
    {
      'Downloads/Tagged Clip.md': '# Tagged Clip\n\nTagged clippings wait in the downloads folder until someone files them properly away.',
      'Downloads/Inline Clip.md': '# Inline Clip\n\nAn inline tagged clipping about telescope mirrors and careful collimation steps.',
      'Downloads/Other Clip.md': '# Other Clip\n\nThis clipping carries a different tag and stays out of the backlog entirely today.',
      'Clippings/Folder Clip.md': '# Folder Clip\n\nA folder clipping about seed starting indoors under lights in late winter cold.',
    },
    {
      'Downloads/Tagged Clip.md': { frontmatter: { tags: ['to-read'] } },
      'Downloads/Inline Clip.md': { tags: [{ tag: '#someday' }] },
      'Downloads/Other Clip.md': { frontmatter: { tags: ['later'] } },
    },
    null
  );
  await runBacklog(tagSelRig, { backlogTags: 'to-read, someday' });
  const tagSelText = tagSelRig.store.created ? tagSelRig.store.created.data : '';
  check('a frontmatter tag selects a clipping outside the backlog folders',
    tagSelText.includes('[[Tagged Clip]]'), tagSelText.slice(0, 500));
  check('an inline #tag selects a clipping too', tagSelText.includes('[[Inline Clip]]'));
  check('folder selection still works alongside tags', tagSelText.includes('[[Folder Clip]]'));
  check('a clipping with an unlisted tag stays out', !tagSelText.includes('[[Other Clip]]'));
  check('the section header names the tag selection',
    tagSelText.includes('or tagged #to-read, #someday'), tagSelText.slice(0, 300));

  console.log('\n' + '='.repeat(56));
  console.log('  PASSED: ' + passed + '   FAILED: ' + failed);
  console.log('='.repeat(56) + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTEST HARNESS CRASHED:\n', err);
  process.exit(1);
});

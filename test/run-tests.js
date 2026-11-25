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
const TEXTAREAS = [];
const BUTTONS = [];

class Setting {
  constructor(containerEl) { this.settingEl = containerEl; }
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addText(cb) { cb(component()); return this; }
  addToggle(cb) { cb(component()); return this; }
  addDropdown(cb) {
    const dropdown = component({
      options: [],
      _value: '',
      _onChange: null,
      addOption(value, display) { this.options.push([value, display]); return this; },
      setValue(v) { this._value = v; return this; },
      getValue() { return this._value; },
      onChange(fn) { this._onChange = fn; return this; },
    });
    DROPDOWNS.push(dropdown);
    cb(dropdown);
    return this;
  }
  addSlider(cb) { cb(component()); return this; }
  addButton(cb) {
    const button = component({
      _text: '',
      _onClick: null,
      setButtonText(t) { this._text = t; return this; },
      onClick(fn) { this._onClick = fn; return this; },
    });
    BUTTONS.push(button);
    cb(button);
    return this;
  }
  addTextArea(cb) {
    const area = component({
      _value: '',
      _onChange: null,
      setValue(v) { this._value = v; return this; },
      getValue() { return this._value; },
      onChange(fn) { this._onChange = fn; return this; },
    });
    TEXTAREAS.push(area);
    cb(area);
    return this;
  }
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
    'housekeeping-sweep',
    'weekly-digest-local',
    'backlog-digest',
    'backlog-apply-tags',
    'backlog-mark-read',
    'backlog-archive',
    'backlog-link',
    'resurface-forgotten-notes',
    'build-embedding-index',
    'related-notes',
    'semantic-lookup',
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
  // v1.5.0 behaviour change (documented): applying no longer appends a
  // "## Suggested links" list - it wraps the mentions in place.
  check('no suggested-links block appended (v1.5.0 in-place behaviour)',
    !inserted.includes('## Suggested links'));
  check('Bionic Workflow mention wrapped in place',
    inserted.includes('worked on the [[Bionic Workflow]] and reviewed'));
  check('Crown Operations mention wrapped in place',
    inserted.includes('reviewed [[Crown Operations]].'));
  check('already-linked note not wrapped a second time',
    (inserted.match(/\[\[Forge Memory Vault\]\]/g) || []).length === 1, inserted);
  check('mention inside inline code NOT wrapped',
    inserted.includes('`Crown Operations` inside code'), inserted);
  check('does NOT suggest title shorter than minTitleLength',
    !inserted.includes('[[Zed]]'));
  check('does NOT suggest the active note itself',
    !inserted.includes('[[Daily Note]]'));
  check('ignored folder excluded',
    !inserted.includes('[[Template Scratch]]'));
  check('vault configDir excluded even when not listed in ignoreFolders',
    !inserted.includes('[[Config Leak]]'));

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
  // v1.6.0: a seventh group, Prompts, joins between Backend and Tags
  // (expected value changed for the new group - documented in the build report).
  // v1.7.0: an eighth group, Embeddings, joins between Prompts and Tags.
  check('eight groups, in display() order',
    JSON.stringify(groups) === JSON.stringify(['Summarization', 'Backend', 'Prompts', 'Embeddings', 'Tags', 'Link suggestion', 'Backlog', 'Resurface']),
    JSON.stringify(groups));

  const allItems = defs.flatMap((g) => g.items || []);
  const controlKeys = allItems.filter((i) => i.control).map((i) => i.control.key).sort();
  const expectedKeys = [
    'backendFormat', 'backendTimeoutMs', 'backendUrl', 'backlogArchiveFolder',
    'backlogFolders', 'backlogStaleDays', 'backlogTags', 'backlogThemesViaBackend', 'embeddingModel', 'fallbackToLocal',
    'ignoreFolders', 'insertMode', 'maxLinkSuggestions', 'maxTags',
    'minTitleLength', 'relatedNotesCount', 'resurfaceColdDays', 'resurfaceInDigest', 'resurfaceQueueSize',
    'summaryHeading', 'summarySentenceCount',
  ];
  // v1.6.0: backendModel, backendPrompt and tagPrompt are render rows, not
  // controls (no textarea exists in the declarative control vocabulary), so
  // the control-key list is unchanged; the render rows are checked in [10g].
  check('every control-backed setting has a control (model + prompts are render rows)',
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

  console.log('\n[10g] backend presets + prompt controls (v1.6.0)');
  const DEFAULT_BACKEND_PROMPT =
    'Summarise the following note in {{n}} concise sentences. ' +
    'Return only the summary, with no preamble.\n\n{{content}}';
  const DEFAULT_TAG_PROMPT =
    'Suggest up to {{n}} short topic tags for the following note. ' +
    'Return only a comma-separated list of lowercase tags, with no preamble.\n\n{{content}}';
  check('plugin settings start from the exact default prompt strings',
    plugin.settings.backendPrompt === DEFAULT_BACKEND_PROMPT &&
    plugin.settings.tagPrompt === DEFAULT_TAG_PROMPT,
    plugin.settings.backendPrompt + ' / ' + plugin.settings.tagPrompt);

  // Declarative path: preset + prompt rows are render items (no textarea or
  // button control exists in the declarative vocabulary - Model precedent).
  check('declarative: Backend preset is a render row in the Backend group',
    (() => { const g = defs.find((d) => d.heading === 'Backend'); const i = g && g.items.find((x) => x.name === 'Backend preset'); return Boolean(i && typeof i.render === 'function' && !i.control); })());
  const promptsGroup = defs.find((d) => d.heading === 'Prompts');
  check('declarative: Prompts group carries Summary prompt, Tag prompt and Reset prompts render rows',
    Boolean(promptsGroup) && ['Summary prompt', 'Tag prompt', 'Reset prompts'].every((n) =>
      promptsGroup.items.some((i) => i.name === n && typeof i.render === 'function' && !i.control)),
    promptsGroup && JSON.stringify(promptsGroup.items.map((i) => i.name)));

  // Preset table correctness + "changes only url/format", driven through the
  // same tab action both settings paths call. REQUEST_HANDLER is armed to
  // fail here, so any model-list refresh fails gracefully offline.
  const PRESET_TABLE = [
    ['ollama', 'http://127.0.0.1:11434/api/generate', 'ollama'],
    ['lmstudio', 'http://127.0.0.1:1234/v1/chat/completions', 'openai'],
    ['llamacpp', 'http://127.0.0.1:8080/v1/chat/completions', 'openai'],
    ['jan', 'http://127.0.0.1:1337/v1/chat/completions', 'openai'],
  ];
  for (const [id, url, format] of PRESET_TABLE) {
    const before = JSON.stringify({ ...plugin.settings, backendUrl: null, backendFormat: null });
    check('preset applies: ' + id, tab.applyBackendPreset(id) === true);
    await flush();
    check('preset ' + id + ' fills the exact URL + format',
      plugin.settings.backendUrl === url && plugin.settings.backendFormat === format,
      plugin.settings.backendUrl + ' / ' + plugin.settings.backendFormat);
    check('preset ' + id + ' changes nothing except backendUrl/backendFormat',
      JSON.stringify({ ...plugin.settings, backendUrl: null, backendFormat: null }) === before);
  }
  check('unknown preset id is rejected', tab.applyBackendPreset('not-a-server') === false);
  check('unknown preset changed nothing',
    plugin.settings.backendUrl === 'http://127.0.0.1:1337/v1/chat/completions' &&
    plugin.settings.backendFormat === 'openai', plugin.settings.backendUrl);

  // Model-list derivation handles every preset URL shape.
  const MODEL_URLS = [];
  REQUEST_HANDLER = async (param) => {
    MODEL_URLS.push(param.url);
    return param.url.includes('/api/tags')
      ? { status: 200, headers: {}, text: '', json: { models: [{ name: 'm1' }] } }
      : { status: 200, headers: {}, text: '', json: { data: [{ id: 'm1' }] } };
  };
  const EXPECTED_MODEL_URLS = [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:1234/v1/models',
    'http://127.0.0.1:8080/v1/models',
    'http://127.0.0.1:1337/v1/models',
  ];
  for (let i = 0; i < PRESET_TABLE.length; i += 1) {
    plugin.settings.backendUrl = PRESET_TABLE[i][1];
    plugin.settings.backendFormat = PRESET_TABLE[i][2];
    const names = await plugin.fetchAvailableModels();
    check('model list derives + parses for preset ' + PRESET_TABLE[i][0],
      MODEL_URLS[MODEL_URLS.length - 1] === EXPECTED_MODEL_URLS[i] && names.join(',') === 'm1',
      MODEL_URLS[MODEL_URLS.length - 1] + ' / ' + names.join(','));
  }
  REQUEST_HANDLER = async () => { throw new Error('connect ECONNREFUSED'); };

  // Imperative path: a fresh display() renders the preset dropdown, both
  // prompt textareas (holding the current values) and the reset button.
  DROPDOWNS.length = 0; TEXTAREAS.length = 0; BUTTONS.length = 0;
  tab.modelState = 'idle';
  let presetDisplayErr = null;
  try { tab.display(); await flush(); } catch (e) { presetDisplayErr = e; }
  check('display() with presets + prompt controls ran clean', presetDisplayErr === null, presetDisplayErr && presetDisplayErr.message);
  const presetDropdown = DROPDOWNS.find((d) => d.options.some(([v]) => v === 'lmstudio'));
  check('preset dropdown offers all four local servers',
    Boolean(presetDropdown) && ['ollama', 'lmstudio', 'llamacpp', 'jan'].every((id) => presetDropdown.options.some(([v]) => v === id)),
    JSON.stringify(DROPDOWNS.map((d) => d.options)));
  check('preset dropdown reflects the currently matching preset (jan)',
    Boolean(presetDropdown) && presetDropdown.getValue() === 'jan',
    presetDropdown && String(presetDropdown.getValue()));
  // The model-list load re-renders the tab once (existing refresh path), so
  // the pair renders twice; every rendered textarea must hold a prompt value.
  check('prompt textareas render, holding the current prompt values',
    TEXTAREAS.length >= 2 && TEXTAREAS.some((a) => a.getValue() === plugin.settings.backendPrompt) &&
    TEXTAREAS.some((a) => a.getValue() === plugin.settings.tagPrompt) &&
    TEXTAREAS.every((a) => a.getValue() === plugin.settings.backendPrompt || a.getValue() === plugin.settings.tagPrompt),
    'textareas: ' + TEXTAREAS.length);
  check('reset-prompts button renders', BUTTONS.some((b) => b._text === 'Reset to defaults'));

  // Selecting a preset in the dropdown applies it (one click, settings only).
  if (presetDropdown && presetDropdown._onChange) presetDropdown._onChange('lmstudio');
  await flush();
  check('preset dropdown selection applies LM Studio url/format',
    plugin.settings.backendUrl === 'http://127.0.0.1:1234/v1/chat/completions' &&
    plugin.settings.backendFormat === 'openai', plugin.settings.backendUrl);

  // Editing a prompt textarea changes only that prompt field.
  const summaryArea = TEXTAREAS.find((a) => a.getValue() === plugin.settings.backendPrompt);
  const otherBefore = plugin.settings.tagPrompt;
  if (summaryArea && summaryArea._onChange) summaryArea._onChange('Custom summary prompt {{n}} {{content}}');
  check('summary prompt textarea edits backendPrompt only',
    plugin.settings.backendPrompt === 'Custom summary prompt {{n}} {{content}}' &&
    plugin.settings.tagPrompt === otherBefore, plugin.settings.backendPrompt);
  tab.setControlValue('tagPrompt', 'Custom tag prompt {{n}} {{content}}');
  check('setControlValue writes tagPrompt through to settings',
    plugin.settings.tagPrompt === 'Custom tag prompt {{n}} {{content}}', plugin.settings.tagPrompt);
  check('getControlValue reads backendPrompt through to settings',
    tab.getControlValue('backendPrompt') === plugin.settings.backendPrompt);

  // Reset restores the exact shipped defaults for both prompts - via the
  // tab action, and via the rendered button.
  tab.resetPromptsToDefaults();
  check('reset restores the exact default summary prompt', plugin.settings.backendPrompt === DEFAULT_BACKEND_PROMPT, plugin.settings.backendPrompt);
  check('reset restores the exact default tag prompt', plugin.settings.tagPrompt === DEFAULT_TAG_PROMPT, plugin.settings.tagPrompt);
  plugin.settings.backendPrompt = 'dirty'; plugin.settings.tagPrompt = 'dirty';
  const resetButton = BUTTONS.find((b) => b._text === 'Reset to defaults');
  if (resetButton && resetButton._onClick) resetButton._onClick({});
  check('rendered Reset to defaults button restores both prompts',
    plugin.settings.backendPrompt === DEFAULT_BACKEND_PROMPT && plugin.settings.tagPrompt === DEFAULT_TAG_PROMPT,
    plugin.settings.backendPrompt + ' / ' + plugin.settings.tagPrompt);

  // Leave the tab's settings in the default backend state for later sections.
  plugin.settings.backendUrl = 'http://127.0.0.1:11434/api/generate';
  plugin.settings.backendFormat = 'ollama';
  tab.modelState = 'idle';

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

  console.log('\n[14b] resurface settings defaults');
  check('resurface cold threshold defaults to 90 days', plugin.settings.resurfaceColdDays === 90);
  check('resurface queue size defaults to 5', plugin.settings.resurfaceQueueSize === 5);
  check('resurface digest section is on by default', plugin.settings.resurfaceInDigest === true);
  check('resurface snooze state starts empty', JSON.stringify(plugin.settings.resurfaceSnoozes) === '{}');
  check('resurface never-show list starts empty', JSON.stringify(plugin.settings.resurfaceNeverShow) === '[]');

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
  // v1.5.0 behaviour change (documented): the backlog link command shares
  // the editor command's in-place apply - mentions are wrapped where they
  // stand and no "## Suggested links" list is appended.
  check('link wraps the chosen mentions in place (v1.5.0, no appended list)',
    linkRig.store.modified !== null &&
    !linkRig.store.modified.data.includes('## Suggested links') &&
    (linkRig.store.modified.data.match(/\[\[Project Atlas\]\]/g) || []).length === 2 &&
    linkRig.store.modified.data.includes('[[Project Atlas]] guides the planting'),
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

  console.log('\n[22] vault-aware tags: canonical form, ranking, nested leaf');
  const vocabCaches = {
    'Compost Guide.md': { frontmatter: { tags: ['Composting', 'garden'] } },
    'Second Guide.md': { frontmatter: { tags: ['Composting'] } },
    'Nested Note.md': { frontmatter: { tags: ['garden/compost'] } },
    'Alpha Garden.md': { frontmatter: { tags: ['Garden'] } },
    'Beta Garden.md': { frontmatter: { tags: ['Garden'] } },
  };
  const vocabRig = makeBacklogRig(
    [
      mkStatFile('Compost Guide', nowMs - DAY, nowMs - DAY),
      mkStatFile('Second Guide', nowMs - DAY, nowMs - DAY),
      mkStatFile('Nested Note', nowMs - DAY, nowMs - DAY),
      mkStatFile('Alpha Garden', nowMs - DAY, nowMs - DAY),
      mkStatFile('Beta Garden', nowMs - DAY, nowMs - DAY),
      mkStatFile('Fresh Thoughts', nowMs - DAY, nowMs - DAY),
    ],
    {},
    vocabCaches,
    null,
    'Fresh Thoughts.md'
  );
  const vocabPlugin = new PluginClass(vocabRig.app, manifest);
  await vocabPlugin.onload();
  const vocabTagCmd = vocabPlugin._commands.find((c) => c.id === 'generate-tags-local');
  const freshFile = vocabRig.app.vault.getMarkdownFiles().find((f) => f.path === 'Fresh Thoughts.md');

  async function tagLabelsFor(text) {
    const ed = new MockEditor(text);
    MODALS.length = 0;
    await vocabTagCmd.editorCallback(ed, { file: freshFile });
    await flush();
    if (MODALS.length === 0) return { labels: [], ed };
    const nodes = walk(MODALS[MODALS.length - 1].contentEl);
    const labels = nodes.filter((n) => n.tagName === 'SPAN').map((n) => n.textContent);
    return { labels, ed };
  }

  const canonRun = await tagLabelsFor(
    'Composting turns kitchen scraps into rich soil. Composting needs air, moisture and patience. A healthy composting pile heats up quickly in spring.'
  );
  check('a candidate matching a vault tag is suggested in the vault canonical form',
    canonRun.labels.includes('#Composting') && !canonRun.labels.includes('#composting'),
    JSON.stringify(canonRun.labels));
  confirmLatestModal('Add selected tags');
  check('the canonical form is what lands in frontmatter',
    canonRun.ed.text.includes('- Composting'), canonRun.ed.text.slice(0, 120));

  const rankRun = await tagLabelsFor('Mulch mulch mulch mulch mulch. Composting composting.');
  check('an established vault tag outranks a more frequent invented word',
    rankRun.labels[0] === '#Composting' && rankRun.labels[1] === '#mulch',
    JSON.stringify(rankRun.labels));

  const leafRun = await tagLabelsFor(
    'Compost feeds the beds before planting. Compost breaks down fast in warm weather. Good compost smells earthy and rich.'
  );
  check('a candidate matching the leaf of a nested vault tag suggests the full nested tag',
    leafRun.labels.includes('#garden/compost'), JSON.stringify(leafRun.labels));

  const caseRun = await tagLabelsFor(
    'The garden wakes early in March. Garden work starts at dawn every day. Every garden needs a plan for the season.'
  );
  check('the canonical form is the spelling most notes use (Garden, 2 of 3)',
    caseRun.labels.includes('#Garden') && !caseRun.labels.includes('#garden'),
    JSON.stringify(caseRun.labels));

  console.log('\n[23] backlog digest tag suggestions use the vault vocabulary');
  const digestVocabRig = makeBacklogRig(
    [
      mkStatFile('Garden Guide', nowMs - DAY, nowMs - DAY),
      mkStatFile('Clip One', nowMs - 2 * DAY, nowMs - 2 * DAY, 'Clippings'),
    ],
    {
      'Garden Guide.md': '# Garden Guide\n\nOur standing notes on soil care and bed rotation for the season.',
      'Clippings/Clip One.md': '# Clip One\n\nComposting turns scraps into soil for the beds. Composting needs air and regular turning. The composting pile heats up quickly in spring weather.',
    },
    { 'Garden Guide.md': { frontmatter: { tags: ['Composting'] } } },
    null
  );
  await runBacklog(digestVocabRig);
  const digestVocabText = digestVocabRig.store.created ? digestVocabRig.store.created.data : '';
  check('the digest item carries the canonical vault tag, not a lowercase reinvention',
    digestVocabText.includes('#Composting') && !digestVocabText.includes('#composting'),
    digestVocabText.slice(0, 900));

  console.log('\n[24] housekeeping sweep: scope, exclusions, confirm gate, frontmatter-only writes');
  function makeSweepRig(files, contents, caches, digestContent) {
    const base = makeBacklogRig(files, contents, caches, digestContent);
    const store = { modifies: [] };
    base.app.vault.modify = async (f, data) => {
      store.modifies.push({ path: f.path, data });
      contents[f.path] = data;
    };
    return { app: base.app, store };
  }

  const sweepContents = {
    'Clippings/Sweep One.md': '# Sweep One\n\nGardens need water. Water the gardens daily. Gardens grow fast.',
    'Clippings/Sweep Two.md': '---\ntags:\n  - gardens\n---\n# Sweep Two\n\nRoses need pruning. Pruning roses keeps them healthy. Roses bloom in June.',
    'templates/Sweep Template.md': '# Sweep Template\n\nGardens need water. Water the gardens daily. Gardens grow fast.',
    '.hivecfg/Sweep Config.md': '# Sweep Config\n\nGardens need water. Water the gardens daily. Gardens grow fast.',
    'Weekly Digest.md': '# Weekly Digest\n\nWeekly digest weekly digest. Digest notes digest notes weekly.',
  };
  const sweepRig = makeSweepRig(
    [
      mkStatFile('Sweep One', nowMs - DAY, nowMs - DAY, 'Clippings'),
      mkStatFile('Sweep Two', nowMs - DAY, nowMs - DAY, 'Clippings'),
      mkStatFile('Sweep Template', nowMs - DAY, nowMs - DAY, 'templates'),
      mkStatFile('Sweep Config', nowMs - DAY, nowMs - DAY, '.hivecfg'),
    ],
    Object.assign({}, sweepContents),
    null,
    sweepContents['Weekly Digest.md']
  );
  const sweepPlugin = new PluginClass(sweepRig.app, manifest);
  await sweepPlugin.onload();
  MODALS.length = 0;
  sweepPlugin._commands.find((c) => c.id === 'housekeeping-sweep').callback();
  await flushMany();
  check('the sweep opens a scope picker first', MODALS.length === 1, 'modals: ' + MODALS.length);
  const scopeNodes = walk(MODALS[MODALS.length - 1].contentEl);
  const wholeVaultButton = scopeNodes.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Whole vault');
  check('the scope picker offers the whole vault and each folder',
    Boolean(wholeVaultButton) && scopeNodes.some((n) => n.tagName === 'BUTTON' && n.textContent === 'Clippings'));
  wholeVaultButton.click();
  await flushMany();
  check('confirm gate: the dry run itself writes nothing', sweepRig.store.modifies.length === 0,
    JSON.stringify(sweepRig.store.modifies.map((m) => m.path)));
  const reviewNodes = walk(MODALS[MODALS.length - 1].contentEl);
  const sweepBoxes = reviewNodes.filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  check('review lists one row per note needing tags - ignored folder, config folder and digest note excluded',
    sweepBoxes.length === 2, 'rows: ' + sweepBoxes.length);
  check('review rows name the proposed tags',
    reviewNodes.some((n) => n.textContent.includes('#gardens')) &&
    reviewNodes.some((n) => n.textContent.includes('#roses')),
    reviewNodes.map((n) => n.textContent).join(' | '));
  sweepBoxes[1].checked = false;
  sweepBoxes[1].dispatchChange();
  const applyButton = reviewNodes.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Apply tags to selected notes');
  check('review has an explicit apply button', Boolean(applyButton));
  applyButton.click();
  await flushMany();
  check('only the ticked note was written', sweepRig.store.modifies.length === 1 &&
    sweepRig.store.modifies[0].path === 'Clippings/Sweep One.md',
    JSON.stringify(sweepRig.store.modifies.map((m) => m.path)));
  check('the write is a frontmatter tag merge',
    sweepRig.store.modifies[0].data.startsWith('---\ntags:\n  - gardens') &&
    sweepRig.store.modifies[0].data.includes('  - water'),
    sweepRig.store.modifies[0].data.slice(0, 160));
  check('the note body survives the sweep untouched',
    sweepRig.store.modifies[0].data.includes('# Sweep One\n\nGardens need water. Water the gardens daily. Gardens grow fast.'));
  check('a completion notice fired', NOTICES.some((n) => n.includes('sweep added tags to 1 note')), NOTICES.join(' | '));

  console.log('\n[24b] housekeeping sweep: cancelling the review writes nothing');
  const cancelRig = makeSweepRig(
    [mkStatFile('Sweep One', nowMs - DAY, nowMs - DAY, 'Clippings')],
    { 'Clippings/Sweep One.md': sweepContents['Clippings/Sweep One.md'] },
    null,
    null
  );
  const cancelPlugin = new PluginClass(cancelRig.app, manifest);
  await cancelPlugin.onload();
  MODALS.length = 0;
  cancelPlugin._commands.find((c) => c.id === 'housekeeping-sweep').callback();
  await flushMany();
  walk(MODALS[MODALS.length - 1].contentEl)
    .find((n) => n.tagName === 'BUTTON' && n.textContent === 'Clippings')
    .click();
  await flushMany();
  walk(MODALS[MODALS.length - 1].contentEl)
    .find((n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel')
    .click();
  await flushMany();
  check('folder scope works and cancel leaves every note untouched',
    cancelRig.store.modifies.length === 0, JSON.stringify(cancelRig.store.modifies));

  console.log('\n[24c] housekeeping sweep: the per-run cap is bounded and stated');
  const capSweepFiles = [];
  const capSweepContents = {};
  for (let i = 1; i <= 55; i += 1) {
    const base = 'Cap Sweep ' + String(i).padStart(2, '0');
    capSweepFiles.push(mkStatFile(base, nowMs - DAY, nowMs - DAY, 'Clippings'));
    capSweepContents['Clippings/' + base + '.md'] =
      '# ' + base + '\n\nGardens need water. Water the gardens daily. Gardens grow fast.';
  }
  const capSweepRig = makeSweepRig(capSweepFiles, capSweepContents, null, null);
  const capSweepPlugin = new PluginClass(capSweepRig.app, manifest);
  await capSweepPlugin.onload();
  MODALS.length = 0;
  capSweepPlugin._commands.find((c) => c.id === 'housekeeping-sweep').callback();
  await flushMany();
  walk(MODALS[MODALS.length - 1].contentEl)
    .find((n) => n.tagName === 'BUTTON' && n.textContent === 'Whole vault')
    .click();
  await flushMany();
  const capReviewNodes = walk(MODALS[MODALS.length - 1].contentEl);
  const capBoxes = capReviewNodes.filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
  check('exactly 50 notes are scanned in one run', capBoxes.length === 50, 'rows: ' + capBoxes.length);
  check('the overflow is stated in the review',
    capReviewNodes.some((n) => n.textContent.includes('5 more notes were not scanned')),
    capReviewNodes.map((n) => n.textContent).join(' | ').slice(0, 300));
  check('the capped dry run also writes nothing', capSweepRig.store.modifies.length === 0);

  console.log('\n[25] backlog progress line: first run silent, later runs report the movement');
  const progressContents = {
    'Clippings/Pile One.md': '# Pile One\n\nAstronomy notes about telescopes, dark skies and the planets visible this month from the hill.',
    'Clippings/Pile Two.md': '# Pile Two\n\nSourdough baking notes about starters, hydration, fermentation timing and crust development at home.',
    'Clippings/Pile Three.md': '# Pile Three\n\nKayaking notes about river levels, paddle technique, safety checks and planning weekend trips downstream.',
    'Weekly Digest.md': '',
  };
  const progressRig = makeBacklogRig(
    [
      mkStatFile('Pile One', nowMs - 2 * DAY, nowMs - 2 * DAY, 'Clippings'),
      mkStatFile('Pile Two', nowMs - 3 * DAY, nowMs - 3 * DAY, 'Clippings'),
      mkStatFile('Pile Three', nowMs - 4 * DAY, nowMs - 4 * DAY, 'Clippings'),
    ],
    progressContents,
    null,
    ''
  );
  const progressPlugin1 = new PluginClass(progressRig.app, manifest);
  await progressPlugin1.onload();
  NOTICES.length = 0;
  progressPlugin1._commands.find((c) => c.id === 'backlog-digest').callback();
  await flushMany();
  const progressText1 = progressRig.store.modified ? progressRig.store.modified.data : '';
  check('first run writes the backlog block with no progress line',
    progressText1.includes('### Your backlog') && !progressText1.includes('Since the last run'),
    progressText1.slice(0, 500));
  check('first run still records the baseline for next time',
    progressPlugin1._data && progressPlugin1._data.backlogLastUnread === 3 &&
    progressPlugin1._data.backlogLastRunDate === todayStr,
    JSON.stringify(progressPlugin1._data));

  progressContents['Clippings/Pile One.md'] =
    '---\nhivemind-read: true\n---\n' + progressContents['Clippings/Pile One.md'];
  const progressPlugin2 = new PluginClass(progressRig.app, manifest);
  progressPlugin2._data = progressPlugin1._data;
  await progressPlugin2.onload();
  await progressPlugin2.loadSettings();
  progressPlugin2._commands.find((c) => c.id === 'backlog-digest').callback();
  await flushMany();
  const progressText2 = progressRig.store.modified ? progressRig.store.modified.data : '';
  check('a later run reports how many clippings left the pile',
    progressText2.includes('1 clipping left the pile — 2 unread now'), progressText2.slice(0, 500));
  check('the baseline moves to the new count',
    progressPlugin2._data && progressPlugin2._data.backlogLastUnread === 2,
    JSON.stringify(progressPlugin2._data));

  progressRig.store.modified = null;
  progressPlugin2._commands.find((c) => c.id === 'backlog-digest').callback();
  await flushMany();
  const progressText3 = progressRig.store.modified ? progressRig.store.modified.data : '';
  check('an unchanged pile says so plainly',
    progressText3.includes('No change since the last run'), progressText3.slice(0, 500));

  console.log('\n[26] resurface: ranking, why-lines, threshold, exclusions');
  function makeResurfaceRig(files, contents, caches, resolvedLinks) {
    const rig = makeBacklogRig(files, contents, caches || {}, null);
    rig.store.opened = [];
    rig.app.metadataCache.resolvedLinks = resolvedLinks || {};
    rig.app.workspace.getLeaf = () => ({
      openFile: async (f) => { rig.store.opened.push(f.path); },
    });
    return rig;
  }
  async function runResurface(rig, data) {
    const p = new PluginClass(rig.app, manifest);
    if (data) p._data = data;
    await p.onload();
    await p.loadSettings();
    NOTICES.length = 0;
    MODALS.length = 0;
    p._commands.find((c) => c.id === 'resurface-forgotten-notes').callback();
    await flushMany();
    return p;
  }
  function modalNodes(modal) { return walk(modal.contentEl); }
  function modalTitles(modal) {
    return modalNodes(modal).filter((n) => n.tagName === 'SPAN').map((n) => n.textContent);
  }
  function modalWhys(modal) {
    return modalNodes(modal)
      .filter((n) => n.classList && n.classList.contains('ehm-resurface-why'))
      .map((n) => n.textContent);
  }
  function modalButtons(modal) {
    return modalNodes(modal).filter((n) => n.tagName === 'BUTTON');
  }
  function modalAllText(modal) {
    return modalNodes(modal).map((n) => n.textContent || '').join('\n');
  }

  const resurfaceFiles = [
    mkStatFile('Recent Editor', nowMs - 2 * DAY, nowMs - 2 * DAY),
    mkStatFile('Hub Note', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Orphan Note', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Edge 89', nowMs - 89 * DAY, nowMs - 89 * DAY),
    mkStatFile('Edge 90', nowMs - 90 * DAY, nowMs - 90 * DAY),
    mkStatFile('Weekly Digest', nowMs - 300 * DAY, nowMs - 300 * DAY),
    mkStatFile('Buried', nowMs - 200 * DAY, nowMs - 200 * DAY, 'templates'),
    mkStatFile('Cfg Note', nowMs - 200 * DAY, nowMs - 200 * DAY, '.hivecfg'),
    mkStatFile('Unread Clip', nowMs - 200 * DAY, nowMs - 200 * DAY, 'Clippings'),
    mkStatFile('Read Clip', nowMs - 200 * DAY, nowMs - 200 * DAY, 'Clippings'),
    mkStatFile('Tagged Clip', nowMs - 200 * DAY, nowMs - 200 * DAY),
  ];
  const resurfaceContents = {
    'Recent Editor.md': 'Compost turning notes. The compost pile needs turning and the compost heats up when turned. Garden compost feeds the beds.',
    'Hub Note.md': '# Hub Note\n\nThe compost hub collects garden compost knowledge for every bed and season in the garden.',
    'Orphan Note.md': '# Orphan Note\n\nXylophone mallets rest beside the metronome while tuning forks hum quietly nearby.',
    'Edge 89.md': 'Edge eighty nine placeholder prose about nothing in particular at all.',
    'Edge 90.md': 'Edge ninety placeholder prose about nothing in particular at all.',
    'Weekly Digest.md': '# Weekly Digest\n\nAn old digest.',
    'templates/Buried.md': 'A buried template note with ordinary prose inside it here.',
    '.hivecfg/Cfg Note.md': 'A configuration folder note with ordinary prose inside it.',
    'Clippings/Unread Clip.md': '# Unread Clip\n\nSome clipping prose that nobody has read yet at all.',
    'Clippings/Read Clip.md': '---\nhivemind-read: true\n---\n# Read Clip\n\nTidal pools and shoreline ecology notes with plenty of ordinary prose.',
    'Tagged Clip.md': '# Tagged Clip\n\nA tagged clipping with ordinary prose and no read marker anywhere.',
  };
  const resurfaceCaches = {
    'Recent Editor.md': { frontmatter: { tags: ['compost'] } },
    'Hub Note.md': { frontmatter: { tags: ['compost'] } },
    'Tagged Clip.md': { frontmatter: { tags: ['to-read'] } },
  };
  const resurfaceLinks = {
    'Recent Editor.md': { 'Hub Note.md': 1 },
    'Alpha Source.md': { 'Hub Note.md': 1 },
    'Beta Source.md': { 'Hub Note.md': 2 },
    'Gamma Source.md': { 'Hub Note.md': 1 },
    'Delta Source.md': { 'Hub Note.md': 1 },
    'Epsilon Source.md': { 'Hub Note.md': 1 },
    'Hub Note.md': { 'Hub Note.md': 3 },
  };
  const resurfaceRig = makeResurfaceRig(resurfaceFiles, resurfaceContents, resurfaceCaches, resurfaceLinks);
  await runResurface(resurfaceRig, { backlogTags: 'to-read' });
  check('resurface opens a review modal', MODALS.length === 1, 'modals: ' + MODALS.length);
  const resurfaceModal = MODALS[MODALS.length - 1];
  const resurfaceTitles = modalTitles(resurfaceModal);
  const resurfaceWhys = modalWhys(resurfaceModal);
  const resurfaceText = modalAllText(resurfaceModal);
  check('a 200-day note with 6 backlinks outranks a 200-day orphan',
    resurfaceTitles.indexOf('Hub Note') !== -1 &&
    resurfaceTitles.indexOf('Orphan Note') !== -1 &&
    resurfaceTitles.indexOf('Hub Note') < resurfaceTitles.indexOf('Orphan Note'),
    JSON.stringify(resurfaceTitles));
  check('why-line states age, backlinks and the shared tag, all true',
    resurfaceWhys.length > 0 &&
    resurfaceWhys[0].includes('untouched 6 months') &&
    resurfaceWhys[0].includes('linked from 6 notes') &&
    resurfaceWhys[0].includes('shares #compost with 1 note you edited this month'),
    JSON.stringify(resurfaceWhys));
  check('zero-value clauses are omitted (orphan why-line is age alone)',
    resurfaceWhys[1] === 'untouched 6 months', JSON.stringify(resurfaceWhys));
  check('threshold boundary: 90 days is in, 89 days is out',
    resurfaceTitles.includes('Edge 90') && !resurfaceTitles.includes('Edge 89'),
    JSON.stringify(resurfaceTitles));
  check('digest note, ignored folder and config folder are excluded',
    !resurfaceTitles.includes('Weekly Digest') && !resurfaceTitles.includes('Buried') &&
    !resurfaceTitles.includes('Cfg Note'),
    JSON.stringify(resurfaceTitles));
  check('unread backlog population is excluded (folder and tag selection)',
    !resurfaceTitles.includes('Unread Clip') && !resurfaceTitles.includes('Tagged Clip'),
    JSON.stringify(resurfaceTitles));
  check('a backlog note marked read is not backlog population and can resurface',
    resurfaceTitles.includes('Read Clip'), JSON.stringify(resurfaceTitles));
  check('each queued note offers Open, Snooze and Never show',
    modalButtons(resurfaceModal).filter((b) => b.textContent === 'Open').length === 4 &&
    modalButtons(resurfaceModal).filter((b) => b.textContent === 'Snooze').length === 4 &&
    modalButtons(resurfaceModal).filter((b) => b.textContent === 'Never show').length === 4,
    JSON.stringify(modalButtons(resurfaceModal).map((b) => b.textContent)));
  check('resurface wording says untouched, never unread',
    resurfaceText.includes('untouched') && !resurfaceText.toLowerCase().includes('unread'),
    resurfaceText.slice(0, 300));

  console.log('\n[26b] resurface: queue size setting caps the modal');
  const manyCold = [];
  const manyContents = {};
  for (let i = 1; i <= 7; i += 1) {
    manyCold.push(mkStatFile('Cold ' + i, nowMs - (100 + i * 10) * DAY, nowMs - (100 + i * 10) * DAY));
    manyContents['Cold ' + i + '.md'] = 'Cold note number ' + i + ' with ordinary prose about storage and winter.';
  }
  const queueRig = makeResurfaceRig(manyCold, manyContents, {}, {});
  await runResurface(queueRig);
  check('default queue shows 5 of 7 cold notes',
    modalButtons(MODALS[MODALS.length - 1]).filter((b) => b.textContent === 'Open').length === 5);
  const queueRig2 = makeResurfaceRig(manyCold, manyContents, {}, {});
  await runResurface(queueRig2, { resurfaceQueueSize: 2 });
  check('queue size setting of 2 shows 2 notes',
    modalButtons(MODALS[MODALS.length - 1]).filter((b) => b.textContent === 'Open').length === 2);

  console.log('\n[26c] resurface: snooze, never-show and open act on plugin state only');
  const abFiles = [
    mkStatFile('Note A', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Note B', nowMs - 200 * DAY, nowMs - 200 * DAY),
  ];
  const abContents = {
    'Note A.md': 'Note A prose about harbour lights and ferry timetables in winter.',
    'Note B.md': 'Note B prose about mountain trails and alpine weather in summer.',
  };
  const abLinks = { 'Source One.md': { 'Note A.md': 1 }, 'Source Two.md': { 'Note A.md': 1 } };
  const abRig = makeResurfaceRig(abFiles, abContents, {}, abLinks);
  const abPlugin = await runResurface(abRig);
  const abModal = MODALS[MODALS.length - 1];
  check('the backlinked note ranks first', modalTitles(abModal)[0] === 'Note A',
    JSON.stringify(modalTitles(abModal)));
  // Row order is A then B; each row is Open / Snooze / Never show, then Close.
  modalButtons(abModal)[1].click();
  await flushMany();
  const snoozeA = abPlugin._data && abPlugin._data.resurfaceSnoozes
    ? abPlugin._data.resurfaceSnoozes['Note A.md'] : null;
  check('snoozing writes a plugin-internal snooze record, count 1',
    Boolean(snoozeA) && snoozeA.count === 1, JSON.stringify(abPlugin._data));
  check('first snooze lasts about 30 days',
    Boolean(snoozeA) && Date.parse(snoozeA.until) - Date.now() > 29 * DAY &&
    Date.parse(snoozeA.until) - Date.now() < 31 * DAY,
    snoozeA && snoozeA.until);
  check('snoozing writes no note file',
    abRig.store.created === null && abRig.store.modified === null);
  check('the snoozed row leaves the modal, the other stays',
    !modalTitles(abModal).includes('Note A') && modalTitles(abModal).includes('Note B'),
    JSON.stringify(modalTitles(abModal)));
  modalButtons(abModal)[2].click();
  await flushMany();
  check('never show writes the path to the plugin-internal exclude list',
    Boolean(abPlugin._data) && abPlugin._data.resurfaceNeverShow.includes('Note B.md'),
    JSON.stringify(abPlugin._data));
  check('dismissing the last row says all caught up',
    modalAllText(abModal).includes('All caught up'), modalAllText(abModal).slice(0, 200));
  check('never-show also writes no note file',
    abRig.store.created === null && abRig.store.modified === null);

  const abPlugin2 = await runResurface(abRig, abPlugin._data);
  const abModal2 = MODALS[MODALS.length - 1];
  check('snoozed and never-listed notes stay suppressed on the next run',
    modalAllText(abModal2).includes('Nothing has gone cold yet'),
    modalAllText(abModal2).slice(0, 200));
  check('the suppressed run queues no notes',
    modalButtons(abModal2).filter((b) => b.textContent === 'Open').length === 0);

  abPlugin._data.resurfaceSnoozes['Note A.md'].until = new Date(Date.now() - DAY).toISOString();
  const abPlugin3 = await runResurface(abRig, abPlugin._data);
  const abModal3 = MODALS[MODALS.length - 1];
  check('an expired snooze lets the note resurface (never-listed stays out)',
    modalTitles(abModal3).includes('Note A') && !modalTitles(abModal3).includes('Note B'),
    JSON.stringify(modalTitles(abModal3)));
  modalButtons(abModal3)[1].click();
  await flushMany();
  const snoozeA2 = abPlugin3._data.resurfaceSnoozes['Note A.md'];
  check('second snooze doubles the interval to about 60 days, count 2',
    snoozeA2.count === 2 && Date.parse(snoozeA2.until) - Date.now() > 59 * DAY &&
    Date.parse(snoozeA2.until) - Date.now() < 61 * DAY,
    JSON.stringify(snoozeA2));

  const cRig = makeResurfaceRig(
    [mkStatFile('Note C', nowMs - 200 * DAY, nowMs - 200 * DAY)],
    { 'Note C.md': 'Note C prose about desert roads and canyon weather in autumn.' }, {}, {});
  await runResurface(cRig);
  const cModal = MODALS[MODALS.length - 1];
  modalButtons(cModal)[0].click();
  await flushMany();
  check('Open opens the note in the workspace', JSON.stringify(cRig.store.opened) === '["Note C.md"]',
    JSON.stringify(cRig.store.opened));
  check('Open closes the modal', walk(cModal.contentEl).length === 1);

  console.log('\n[26d] resurface: preset suppression state and threshold setting');
  const presetRig = makeResurfaceRig(abFiles, abContents, {}, abLinks);
  await runResurface(presetRig, {
    resurfaceSnoozes: { 'Note A.md': { until: new Date(Date.now() + 10 * DAY).toISOString(), count: 3 } },
    resurfaceNeverShow: ['Note B.md'],
  });
  check('a future snooze and a never-listing suppress both notes',
    modalAllText(MODALS[MODALS.length - 1]).includes('Nothing has gone cold yet'));
  const thresholdRig = makeResurfaceRig(abFiles, abContents, {}, abLinks);
  await runResurface(thresholdRig, { resurfaceColdDays: 300 });
  check('a 300-day threshold leaves 200-day notes out',
    modalAllText(MODALS[MODALS.length - 1]).includes('Nothing has gone cold yet'));

  console.log('\n[26e] resurface: honest empty states');
  const resurfaceEmptyRig = makeResurfaceRig([], {}, {}, {});
  await runResurface(resurfaceEmptyRig);
  const resurfaceEmptyText = modalAllText(MODALS[MODALS.length - 1]);
  check('empty vault says plainly that nothing has gone cold yet',
    resurfaceEmptyText.includes('Nothing has gone cold yet'), resurfaceEmptyText.slice(0, 200));
  check('empty vault queues no filler entries',
    modalButtons(MODALS[MODALS.length - 1]).filter((b) => b.textContent === 'Open').length === 0);
  const resurfaceRecentRig = makeResurfaceRig(
    [mkStatFile('Fresh One', nowMs - DAY, nowMs - DAY), mkStatFile('Fresh Two', nowMs - 2 * DAY, nowMs - 2 * DAY)],
    { 'Fresh One.md': 'Fresh prose one.', 'Fresh Two.md': 'Fresh prose two.' }, {}, {});
  await runResurface(resurfaceRecentRig);
  const resurfaceRecentText = modalAllText(MODALS[MODALS.length - 1]);
  check('all-recent vault says plainly that nothing has gone cold yet',
    resurfaceRecentText.includes('Nothing has gone cold yet') && resurfaceRecentText.includes('untouched'),
    resurfaceRecentText.slice(0, 200));

  console.log('\n[26f] resurface in the weekly digest: section, cap, byte-identical gate');
  async function runWeeklyResurface(rig, data) {
    const p = new PluginClass(rig.digestApp, manifest);
    if (data) p._data = data;
    await p.onload();
    await p.loadSettings();
    NOTICES.length = 0;
    MODALS.length = 0;
    p._commands.find((c) => c.id === 'weekly-digest-local').callback();
    await flushMany();
    return rig.store.created ? rig.store.created.data : (rig.store.modified || '');
  }
  const weekOnlyFiles = [mkStatFile('Fresh Week Note', nowMs - DAY, nowMs - DAY)];
  const weekOnlyContents = {
    'Fresh Week Note.md': '# Fresh Week Note\n\nHarbour lights guide the ferry across the winter water every evening.',
  };
  const gateRigOn = makeDigestRig(weekOnlyFiles, weekOnlyContents, null);
  const gateTextOn = await runWeeklyResurface(gateRigOn, null);
  const gateRigOff = makeDigestRig(weekOnlyFiles, weekOnlyContents, null);
  const gateTextOff = await runWeeklyResurface(gateRigOff, { resurfaceInDigest: false });
  check('digest with no cold notes is byte-identical with the resurface toggle on or off',
    gateTextOn === gateTextOff && gateTextOn.length > 0,
    'on: ' + gateTextOn.length + ' bytes, off: ' + gateTextOff.length + ' bytes');
  check('no resurface section appears when nothing has gone cold',
    !gateTextOn.includes('Worth another look'));

  const digestColdFiles = [
    mkStatFile('Fresh Week Note', nowMs - DAY, nowMs - DAY),
    mkStatFile('Hub Note', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Cold Two', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Cold Three', nowMs - 200 * DAY, nowMs - 200 * DAY),
    mkStatFile('Cold Four', nowMs - 200 * DAY, nowMs - 200 * DAY),
  ];
  const digestColdContents = {
    'Fresh Week Note.md': weekOnlyContents['Fresh Week Note.md'],
    'Hub Note.md': 'The hub note prose about harbour lights and ferry routes in winter.',
    'Cold Two.md': 'Cold two prose about mountain trails and alpine weather in summer.',
    'Cold Three.md': 'Cold three prose about desert roads and canyon weather in autumn.',
    'Cold Four.md': 'Cold four prose about forest paths and river weather in spring.',
  };
  const digestRig = makeDigestRig(digestColdFiles, digestColdContents, null);
  digestRig.digestApp.metadataCache.resolvedLinks = {
    'S1.md': { 'Hub Note.md': 1 }, 'S2.md': { 'Hub Note.md': 1 }, 'S3.md': { 'Hub Note.md': 1 },
  };
  const resurfaceDigestText = await runWeeklyResurface(digestRig, null);
  check('weekly digest gains a Worth another look section when notes are cold',
    resurfaceDigestText.includes('### Worth another look'), resurfaceDigestText.slice(0, 600));
  check('the section follows the backlog section inside the dated digest',
    resurfaceDigestText.indexOf('### Worth another look') > resurfaceDigestText.indexOf('### Your backlog'));
  check('the section lists the top note with its why-line',
    resurfaceDigestText.includes('- [[Hub Note]] — untouched 6 months · linked from 3 notes'),
    resurfaceDigestText.slice(resurfaceDigestText.indexOf('### Worth another look')));
  const resurfaceSection = resurfaceDigestText.slice(resurfaceDigestText.indexOf('### Worth another look'));
  check('the digest section is capped at 3 notes',
    (resurfaceSection.match(/- \[\[/g) || []).length === 3,
    resurfaceSection.slice(0, 400));
  const digestOffRig = makeDigestRig(digestColdFiles, digestColdContents, null);
  const digestOffText = await runWeeklyResurface(digestOffRig, { resurfaceInDigest: false });
  check('the toggle off keeps cold notes out of the digest entirely',
    !digestOffText.includes('Worth another look') && digestOffText.includes('### Your backlog'));

  console.log('\n[26g] resurface offline path: zero network requests');
  let resurfaceRequestCount = 0;
  REQUEST_HANDLER = () => { resurfaceRequestCount += 1; throw new Error('network disabled in test'); };
  const offlineResurfaceRig = makeResurfaceRig(abFiles, abContents, {}, abLinks);
  await runResurface(offlineResurfaceRig);
  check('resurface command completes with the network handler armed to fail',
    modalTitles(MODALS[MODALS.length - 1]).includes('Note A'));
  const offlineDigestRig = makeDigestRig(digestColdFiles, digestColdContents, null);
  offlineDigestRig.digestApp.metadataCache.resolvedLinks = {
    'S1.md': { 'Hub Note.md': 1 }, 'S2.md': { 'Hub Note.md': 1 }, 'S3.md': { 'Hub Note.md': 1 },
  };
  const offlineDigestText = await runWeeklyResurface(offlineDigestRig, null);
  check('weekly digest with its resurface section completes offline too',
    offlineDigestText.includes('### Worth another look'));
  check('zero network requests were made by either resurface path',
    resurfaceRequestCount === 0, 'requests: ' + resurfaceRequestCount);
  REQUEST_HANDLER = null;

  console.log('\n[27] inline links (v1.5.0): in-place wrapping, widened matching, exclusions');
  async function runSuggestLinks(rig, active, text) {
    const p = new PluginClass(rig.app, manifest);
    await p.onload();
    await flush();
    MODALS.length = 0;
    NOTICES.length = 0;
    const ed = new MockEditor(text);
    await p._commands.find((c) => c.id === 'suggest-links').editorCallback(ed, { file: active });
    await flushMany();
    return ed;
  }
  function linkRigFor(basenames, caches) {
    const files = basenames.map((b) => mkStatFile(b, nowMs - DAY, nowMs - DAY));
    const rig = makeBacklogRig(files, {}, caches || {}, null, files[0].path);
    return { rig, files };
  }

  // Alias mentions wrap as [[Note|alias]]; the best-matching form per note wins.
  {
    const { rig, files } = linkRigFor(['Inline Host', 'Garden Guide'],
      { 'Garden Guide.md': { frontmatter: { aliases: ['Garden Handbook'] } } });
    const ed = await runSuggestLinks(rig, files[0],
      'Garden Guide is mentioned once. The garden handbook helps, and the Garden Handbook helps again.');
    check('alias scenario opens the checklist modal', MODALS.length === 1, 'modals: ' + MODALS.length);
    confirmLatestModal('Insert selected');
    check('alias mentions wrapped in place as [[Garden Guide|Garden Handbook]]',
      (ed.text.match(/\[\[Garden Guide\|Garden Handbook\]\]/g) || []).length === 2, ed.text);
    check('the single title mention is left plain (alias was the best match for the note)',
      ed.text.startsWith('Garden Guide is mentioned once.'), ed.text);
  }

  // Plural handling, both directions, preserving the surface text.
  {
    const { rig, files } = linkRigFor(['Plural Host', 'Garden Beds']);
    const ed = await runSuggestLinks(rig, files[0], 'One garden bed was planted early.');
    confirmLatestModal('Insert selected');
    check('plural title matches a singular mention, surface preserved',
      ed.text.includes('One [[Garden Beds|garden bed]] was planted early.'), ed.text);
  }
  {
    const { rig, files } = linkRigFor(['Plural Host', 'Compost Pile']);
    const ed = await runSuggestLinks(rig, files[0], 'Two compost piles steamed in the cold.');
    confirmLatestModal('Insert selected');
    check('singular title matches a plural mention, surface preserved',
      ed.text.includes('Two [[Compost Pile|compost piles]] steamed'), ed.text);
  }

  // Hyphen/space variation in a multi-word title.
  {
    const { rig, files } = linkRigFor(['Hyphen Host', 'Alpha Harvest']);
    const ed = await runSuggestLinks(rig, files[0], 'The alpha-harvest festival opened.');
    confirmLatestModal('Insert selected');
    check('hyphenated surface matches a spaced title, surface preserved',
      ed.text.includes('The [[Alpha Harvest|alpha-harvest]] festival opened.'), ed.text);
  }

  // Exclusions: frontmatter, fenced code, inline code, existing links, markdown links, URLs.
  {
    const { rig, files } = linkRigFor(['Secret Host', 'Secret Topic']);
    const text = [
      '---', 'title: Secret Topic notes', '---', '# Secret Host', '',
      'The Secret Topic is discussed here.', '',
      '```', 'Secret Topic in a fence', '```', '',
      '`Secret Topic` inline.', '',
      'Already [[Secret Topic]] linked.', '',
      '[Secret Topic](https://example.com/secret) is a markdown link.', '',
      'Visit https://example.com/Secret-Topic today.',
    ].join('\n');
    const ed = await runSuggestLinks(rig, files[0], text);
    confirmLatestModal('Insert selected');
    check('only the plain mention is wrapped (exactly one new link)',
      (ed.text.match(/\[\[Secret Topic\]\]/g) || []).length === 2 &&
      ed.text.includes('The [[Secret Topic]] is discussed here.'), ed.text);
    check('frontmatter mention NOT wrapped', ed.text.includes('title: Secret Topic notes'), ed.text);
    check('fenced code mention NOT wrapped', ed.text.includes('```\nSecret Topic in a fence\n```'), ed.text);
    check('inline code mention NOT wrapped', ed.text.includes('`Secret Topic` inline.'), ed.text);
    check('markdown link and URL mentions NOT wrapped',
      ed.text.includes('[Secret Topic](https://example.com/secret)') &&
      ed.text.includes('https://example.com/Secret-Topic'), ed.text);
  }

  // Re-running on the wrapped output wraps nothing twice.
  {
    const { rig, files } = linkRigFor(['Plural Host', 'Compost Pile']);
    const ed = await runSuggestLinks(rig, files[0], 'Two compost piles steamed in the cold.');
    confirmLatestModal('Insert selected');
    const once = ed.text;
    const ed2 = await runSuggestLinks(rig, files[0], once);
    check('re-run finds no unlinked mentions in its own output',
      NOTICES.some((n) => n.includes('no unlinked')), NOTICES.join(' | '));
    check('re-run leaves the text byte-identical (no duplicate wrapping)', ed2.text === once, ed2.text);
  }

  // Widening stays conservative: no substring, prefix or partial-title matches.
  {
    const { rig, files } = linkRigFor(['Strict Host', 'Garden Guide']);
    const ed = await runSuggestLinks(rig, files[0],
      'The garden guided tour differs, and Garden alone is not the full title.');
    check('no suggestion for near-miss or partial-title text',
      MODALS.length === 0 && NOTICES.some((n) => n.includes('no unlinked')),
      'modals: ' + MODALS.length + ' / ' + NOTICES.join(' | '));
    check('near-miss note untouched', !ed.text.includes('[['), ed.text);
  }

  // Offline guarantee for the new path.
  {
    let linkRequests = 0;
    REQUEST_HANDLER = () => { linkRequests += 1; throw new Error('network disabled in test'); };
    const { rig, files } = linkRigFor(['Offline Host', 'Compost Pile']);
    const ed = await runSuggestLinks(rig, files[0], 'Two compost piles steamed in the cold.');
    confirmLatestModal('Insert selected');
    check('inline linking completes with the network handler armed to fail',
      ed.text.includes('[[Compost Pile|compost piles]]'), ed.text);
    check('zero network requests were made by inline linking', linkRequests === 0, 'requests: ' + linkRequests);
    REQUEST_HANDLER = null;
  }

  console.log('\n[27] embeddings: local-server index, related notes, semantic lookup');
  // A deterministic fake embedding server: a text's vector counts its
  // 'compost' and 'timber' mentions, plus a constant - so every cosine
  // ranking below is computable by hand and asserted exactly.
  function fakeVector(text) {
    const lower = String(text).toLowerCase();
    const count = (word) => lower.split(word).length - 1;
    return [count('compost'), count('timber'), 1];
  }
  function ollamaEmbedHandler(record) {
    return async (param) => {
      const body = JSON.parse(param.body);
      record.push({ url: param.url, body });
      if (Array.isArray(body.input) && body.input.length === 1) {
        // Legacy single-text shape, exercised by the lookup's query embed.
        return { status: 200, headers: {}, text: '', json: { embedding: fakeVector(body.input[0]) } };
      }
      return { status: 200, headers: {}, text: '', json: { embeddings: body.input.map(fakeVector) } };
    };
  }
  function makeEmbeddingRig(activePath) {
    const files = [
      mkFile('Compost Guide'),
      mkFile('Compost Schedule'),
      mkFile('Timber Orders'),
      mkFile('Empty Note'),
      mkFile('Template Scratch', 'templates'),
    ];
    const contents = {
      'Compost Guide.md': 'compost compost compost compost weekly turning notes',
      'Compost Schedule.md': 'compost compost seasonal planting calendar',
      'Timber Orders.md': 'timber timber timber order arrives friday',
      'Empty Note.md': '',
      'templates/Template Scratch.md': 'compost compost compost scratchings',
      'Weekly Digest.md': 'compost compost digest body',
    };
    const rig = makeBacklogRig(files, contents, {}, 'digest present', activePath);
    rig.contents = contents;
    rig.store.opened = [];
    rig.app.workspace.getLeaf = () => ({
      openFile: async (f) => { rig.store.opened.push(f.path); },
    });
    return rig;
  }
  async function runEmbeddingPlugin(rig, data) {
    const p = new PluginClass(rig.app, manifest);
    if (data) p._data = data;
    await p.onload();
    await p.loadSettings();
    NOTICES.length = 0;
    MODALS.length = 0;
    return p;
  }

  // Defaults and settings wiring.
  {
    const fresh = new PluginClass(app, manifest);
    await fresh.onload();
    check('embedding defaults: local model, five results, empty index',
      fresh.settings.embeddingModel === 'nomic-embed-text' && fresh.settings.relatedNotesCount === 5 &&
      JSON.stringify(fresh.settings.embeddingIndex) === '{}' && fresh.settings.embeddingIndexModel === '',
      fresh.settings.embeddingModel + ' / ' + fresh.settings.relatedNotesCount);
    const embGroup = tab.getSettingDefinitions().find((g) => g.heading === 'Embeddings');
    check('the Embeddings group carries the Build index render row',
      !!embGroup && embGroup.items.some((i) => i.name === 'Build embedding index' && typeof i.render === 'function' && !i.control));
    tab.setControlValue('embeddingModel', '  mxbai-embed-large  ');
    check('setControlValue trims the embedding model like the chat model',
      plugin.settings.embeddingModel === 'mxbai-embed-large', plugin.settings.embeddingModel);
    tab.setControlValue('embeddingModel', 'nomic-embed-text');
  }

  // Index build (Ollama shape), then the incremental rules.
  {
    const requests = [];
    REQUEST_HANDLER = ollamaEmbedHandler(requests);
    const rig = makeEmbeddingRig(null);
    const p = await runEmbeddingPlugin(rig);
    const build = () => p._commands.find((c) => c.id === 'build-embedding-index').callback();

    build();
    await flushMany();
    check('index build posts to the Ollama embed endpoint',
      requests.length === 1 && requests[0].url === 'http://127.0.0.1:11434/api/embed',
      JSON.stringify(requests.map((r) => r.url)));
    check('the embed request carries the configured model', requests[0].body.model === 'nomic-embed-text');
    check('only notes with text, outside ignored folders and the digest, are embedded',
      JSON.stringify(requests[0].body.input) === JSON.stringify([
        'compost compost compost compost weekly turning notes',
        'compost compost seasonal planting calendar',
        'timber timber timber order arrives friday',
      ]), JSON.stringify(requests[0].body.input));
    check('the index holds one entry per embedded note',
      JSON.stringify(Object.keys(p.settings.embeddingIndex).sort()) ===
      JSON.stringify(['Compost Guide.md', 'Compost Schedule.md', 'Timber Orders.md']),
      JSON.stringify(Object.keys(p.settings.embeddingIndex)));
    check('stored vectors are the server vectors',
      JSON.stringify(p.settings.embeddingIndex['Compost Guide.md'].vector) === '[4,0,1]',
      JSON.stringify(p.settings.embeddingIndex['Compost Guide.md']));
    check('the index records the model it was built with', p.settings.embeddingIndexModel === 'nomic-embed-text');
    check('the build notice reports the counts',
      NOTICES.some((n) => n.includes('3 notes indexed (3 embedded, 0 removed)')), NOTICES.join(' | '));

    requests.length = 0;
    NOTICES.length = 0;
    build();
    await flushMany();
    check('an unchanged vault re-embeds nothing', requests.length === 0, 'requests: ' + requests.length);
    check('the rebuild notice says so', NOTICES.some((n) => n.includes('(0 embedded, 0 removed)')));

    rig.contents['Timber Orders.md'] = 'timber timber compost delivery';
    requests.length = 0;
    build();
    await flushMany();
    check('one changed note re-embeds exactly that note',
      requests.length === 1 && JSON.stringify(requests[0].body.input) === JSON.stringify(['timber timber compost delivery']),
      JSON.stringify(requests.map((r) => r.body.input)));
    check('the changed note vector updated',
      JSON.stringify(p.settings.embeddingIndex['Timber Orders.md'].vector) === '[1,2,1]');

    rig.contents['Compost Schedule.md'] = '';
    requests.length = 0;
    NOTICES.length = 0;
    build();
    await flushMany();
    check('an emptied note drops out of the index', !('Compost Schedule.md' in p.settings.embeddingIndex));
    check('the removal is reported', NOTICES.some((n) => n.includes('(0 embedded, 1 removed)')), NOTICES.join(' | '));

    rig.contents['Compost Schedule.md'] = 'compost compost seasonal planting calendar';
    p.settings.embeddingModel = 'mxbai-embed-large';
    requests.length = 0;
    build();
    await flushMany();
    check('a model change re-embeds the whole vault',
      requests.length === 1 && requests[0].body.input.length === 3 && requests[0].body.model === 'mxbai-embed-large',
      JSON.stringify(requests.map((r) => r.body)));
    check('the index model follows the setting', p.settings.embeddingIndexModel === 'mxbai-embed-large');

    const revived = new PluginClass(rig.app, manifest);
    revived._data = p._data;
    await revived.onload();
    await revived.loadSettings();
    check('the index survives a settings round-trip',
      Object.keys(revived.settings.embeddingIndex).length === 3 &&
      revived.settings.embeddingIndexModel === 'mxbai-embed-large',
      JSON.stringify(Object.keys(revived.settings.embeddingIndex)));
    REQUEST_HANDLER = null;
  }

  // Related notes: ranking, labels, Open.
  {
    const requests = [];
    REQUEST_HANDLER = ollamaEmbedHandler(requests);
    const rig = makeEmbeddingRig('Compost Guide.md');
    const p = await runEmbeddingPlugin(rig);
    const guide = rig.app.vault.getMarkdownFiles().find((f) => f.path === 'Compost Guide.md');
    p._commands.find((c) => c.id === 'related-notes').editorCallback(new MockEditor(''), { file: guide });
    await flushMany();
    const modal = MODALS[MODALS.length - 1];
    check('related notes opens a results modal titled for the current note',
      !!modal && modal.titleEl.textContent === 'Related to "Compost Guide"',
      modal ? modal.titleEl.textContent : 'no modal');
    check('related notes rank by cosine similarity',
      JSON.stringify(modalTitles(modal)) === JSON.stringify(['Compost Schedule', 'Timber Orders']),
      JSON.stringify(modalTitles(modal)));
    const whys = modalWhys(modal);
    check('similarity labels are the true cosines',
      whys.length === 2 && whys[0].startsWith('98% similar') && whys[1].startsWith('8% similar'),
      JSON.stringify(whys));
    modalButtons(modal).filter((b) => b.textContent === 'Open')[0].click();
    await flushMany();
    check('Open opens the related note',
      JSON.stringify(rig.store.opened) === JSON.stringify(['Compost Schedule.md']),
      JSON.stringify(rig.store.opened));
    REQUEST_HANDLER = null;
  }

  // Semantic lookup: the query is embedded (legacy single-vector shape)
  // and the whole index ranks against it.
  {
    const requests = [];
    REQUEST_HANDLER = ollamaEmbedHandler(requests);
    const rig = makeEmbeddingRig(null);
    const p = await runEmbeddingPlugin(rig);
    p._commands.find((c) => c.id === 'semantic-lookup').callback();
    await flushMany();
    const modal = MODALS[MODALS.length - 1];
    check('semantic lookup opens its modal',
      !!modal && modal.titleEl.textContent === 'Semantic lookup',
      modal ? modal.titleEl.textContent : 'no modal');
    const input = modalNodes(modal).find((n) => n.tagName === 'INPUT');
    input.value = 'compost';
    modalButtons(modal).find((b) => b.textContent === 'Search').click();
    await flushMany();
    check('lookup ranks the vault against the query vector',
      JSON.stringify(modalTitles(modal)) === JSON.stringify(['Compost Schedule', 'Compost Guide', 'Timber Orders']),
      JSON.stringify(modalTitles(modal)));
    const whys = modalWhys(modal);
    check('lookup similarity labels are the true cosines',
      whys.length === 3 && whys[0].startsWith('95% similar') && whys[1].startsWith('86% similar') && whys[2].startsWith('22% similar'),
      JSON.stringify(whys));
    REQUEST_HANDLER = null;
  }

  // OpenAI-compatible shape: /v1/embeddings URL, data[] response.
  {
    const requests = [];
    REQUEST_HANDLER = async (param) => {
      const body = JSON.parse(param.body);
      requests.push({ url: param.url, body });
      return {
        status: 200, headers: {}, text: '',
        json: { data: body.input.map((t, i) => ({ embedding: fakeVector(t), index: i })) },
      };
    };
    const rig = makeEmbeddingRig(null);
    const p = await runEmbeddingPlugin(rig);
    p.settings.backendFormat = 'openai';
    p.settings.backendUrl = 'http://127.0.0.1:1234/v1/chat/completions';
    p._commands.find((c) => c.id === 'build-embedding-index').callback();
    await flushMany();
    check('OpenAI-compatible servers are called at /v1/embeddings',
      requests.length === 1 && requests[0].url === 'http://127.0.0.1:1234/v1/embeddings',
      JSON.stringify(requests.map((r) => r.url)));
    check('the data-shape response fills the index', Object.keys(p.settings.embeddingIndex).length === 3);
    REQUEST_HANDLER = null;
  }

  // Failure honesty: a dead server, and a count-mismatched response.
  {
    REQUEST_HANDLER = async () => ({ status: 500, headers: {}, text: 'model missing', json: null });
    const rig = makeEmbeddingRig(null);
    const p = await runEmbeddingPlugin(rig);
    p._commands.find((c) => c.id === 'build-embedding-index').callback();
    await flushMany();
    check('a dead embedding server fails the build honestly',
      NOTICES.some((n) => n.includes('embedding index failed')), NOTICES.join(' | '));
    check('a failed build leaves the index untouched', Object.keys(p.settings.embeddingIndex).length === 0);
    NOTICES.length = 0;
    MODALS.length = 0;
    const guide = rig.app.vault.getMarkdownFiles().find((f) => f.path === 'Compost Guide.md');
    p._commands.find((c) => c.id === 'related-notes').editorCallback(new MockEditor(''), { file: guide });
    await flushMany();
    check('related notes with a dead server shows no modal, only the failure',
      MODALS.length === 0 && NOTICES.some((n) => n.includes('related notes failed')), NOTICES.join(' | '));
    REQUEST_HANDLER = null;
  }
  {
    REQUEST_HANDLER = async () => ({ status: 200, headers: {}, text: '', json: { embeddings: [[1, 0, 1]] } });
    const rig = makeEmbeddingRig(null);
    const p = await runEmbeddingPlugin(rig);
    p._commands.find((c) => c.id === 'build-embedding-index').callback();
    await flushMany();
    check('a vector-count mismatch fails instead of corrupting the index',
      NOTICES.some((n) => n.includes('returned 1 vector(s) for 3 text(s)')) &&
      Object.keys(p.settings.embeddingIndex).length === 0,
      NOTICES.join(' | '));
    REQUEST_HANDLER = null;
  }

  // The settings tab's Build index button runs the same build.
  {
    const requests = [];
    REQUEST_HANDLER = ollamaEmbedHandler(requests);
    BUTTONS.length = 0;
    NOTICES.length = 0;
    tab.display();
    const buildButton = BUTTONS.find((b) => b._text === 'Build index');
    check('settings renders a Build index button', !!buildButton);
    if (buildButton) buildButton._onClick();
    await flushMany();
    check('the settings button runs the build (empty-text vault: nothing to embed)',
      NOTICES.some((n) => n.includes('embedding index ready — 0 notes indexed')), NOTICES.join(' | '));
    REQUEST_HANDLER = null;
  }

  console.log('\n[28] non-English notes (v1.8.0): Unicode tokenization, multilingual stopwords, CJK bigrams');
  {
    // Drive everything through the public commands, like every other
    // section. Pin the summary settings this section depends on (earlier
    // sections mutate them) and restore them at the end.
    const savedSentenceCount = plugin.settings.summarySentenceCount;
    const savedHeading = plugin.settings.summaryHeading;
    const savedInsertMode = plugin.settings.insertMode;
    plugin.settings.summarySentenceCount = 2;
    plugin.settings.summaryHeading = '## Summary';
    plugin.settings.insertMode = 'top';
    const uniLocalCmd = plugin._commands.find((c) => c.id === 'summarize-note-local');
    const uniTagCmd = plugin._commands.find((c) => c.id === 'generate-tags-local');
    const uniTagBackendCmd = plugin._commands.find((c) => c.id === 'generate-tags-backend');

    const summarise = async (text) => {
      const ed = new MockEditor(text);
      NOTICES.length = 0;
      uniLocalCmd.editorCallback(ed, { file: activeFile });
      await flush();
      return ed.text.split('\n')[1] || '';
    };
    const localTags = async (text) => {
      const ed = new MockEditor(text);
      MODALS.length = 0;
      await uniTagCmd.editorCallback(ed, { file: activeFile });
      await flush();
      const modal = confirmLatestModal('Add selected tags');
      const boxes = modal.nodes.filter((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
      return { head: ed.text.split('\n---\n')[0], text: ed.text, boxes: boxes.length };
    };

    // Spanish summary: accented words stay whole, Spanish stopwords
    // (el, las, del, en, de) carry no score, the two garden sentences win.
    const esSummary = await summarise([
      'El jardín necesita agua durante el verano.',
      'Las plantas del jardín crecen con agua y sol.',
      'El agua del río riega las plantas del jardín.',
      'María compra libros en la librería del barrio.',
      'Los libros de historia ocupan un estante completo.',
      'El jardín recibe agua cada mañana de verano.',
    ].join(' '));
    check('Spanish summary is non-empty', esSummary.trim().length > 20, esSummary);
    check('Spanish summary picks the top garden sentence',
      esSummary.includes('El jardín necesita agua durante el verano.'), esSummary);
    check('Spanish summary picks the second garden sentence',
      esSummary.includes('Las plantas del jardín crecen con agua y sol.'), esSummary);
    check('Spanish summary keeps accented words intact',
      esSummary.includes('jardín') && !esSummary.includes('jardí n'), esSummary);
    check('Spanish summary drops the off-topic sentences',
      !esSummary.includes('María compra') && !esSummary.includes('estante completo'), esSummary);

    // French tags: café (accented) is the top tag, étudiants survives
    // whole, and the repeated French stopword "dans" is never offered.
    const fr = await localTags(
      'Le café est dans le centre. Les étudiants lisent dans le café. ' +
      'Les professeurs lisent dans le café aussi. Le café accueille les étudiants et les professeurs.');
    check('French tags include accented café, kept whole', fr.head.includes('  - café'), fr.head);
    check('French tags include étudiants, kept whole', fr.head.includes('  - étudiants'), fr.head);
    check('French stopword "dans" is not suggested as a tag', !fr.head.includes('- dans'), fr.head);
    check('French stopword "aussi" is not suggested as a tag', !fr.head.includes('- aussi'), fr.head);
    check('French tags offered within maxTags', fr.boxes > 0 && fr.boxes <= plugin.settings.maxTags,
      'boxes: ' + fr.boxes);

    // German summary + tags: Garten/Wasser carry the note, the repeated
    // German stopword "durch" is filtered, Vögel keeps its umlaut.
    const deSummary = await summarise(
      'Der Garten braucht Wasser. Die Blumen im Garten blühen durch den Regen. ' +
      'Der Regen gibt dem Garten Wasser. Die Vögel fliegen durch den Garten.');
    check('German summary is non-empty and led by the Garten sentence',
      deSummary.includes('Der Garten braucht Wasser.'), deSummary);
    const de = await localTags(
      'Der Garten braucht Wasser. Die Blumen im Garten blühen durch den Regen. ' +
      'Der Regen gibt dem Garten Wasser. Die Vögel fliegen durch den Garten.');
    check('German tags include garten and wasser',
      de.head.includes('  - garten') && de.head.includes('  - wasser'), de.head);
    check('German stopword "durch" is not suggested as a tag', !de.head.includes('- durch'), de.head);

    // Tag normalisation preserves Unicode letters (backend path returns
    // free text, so this exercises normaliseTag directly): accented tags
    // survive, spaces become hyphens, the numeric tag is still rejected.
    REQUEST_HANDLER = async () => ({
      status: 200, headers: {}, text: '',
      json: { response: 'Café, Crème Brûlée, 123' },
    });
    const btUniEd = new MockEditor('Body text about coffee and desserts in the café.');
    MODALS.length = 0;
    await uniTagBackendCmd.editorCallback(btUniEd, { file: activeFile });
    await flush();
    confirmLatestModal('Add selected tags');
    const btUniHead = btUniEd.text.split('\n---\n')[0];
    check('accented backend tag survives normalisation (café)',
      btUniHead.includes('  - café'), btUniHead);
    check('accented multi-word tag survives as crème-brûlée',
      btUniHead.includes('  - crème-brûlée'), btUniHead);
    check('numeric tag still rejected beside Unicode tags', !btUniHead.includes('123'), btUniHead);
    REQUEST_HANDLER = null;

    // CJK: no spaces, no dictionary - overlapping bigrams. The summary
    // of a Chinese note is non-empty and keeps its text; the top
    // Japanese tag is the 東京 bigram (Han + Katakana runs tokenise).
    const zhSummary = await summarise('我喜欢学习中文。中文很有趣。学习中文需要每天练习。');
    check('Chinese summary is non-empty', zhSummary.trim().length > 0, zhSummary);
    check('Chinese summary keeps CJK text intact', zhSummary.includes('中文'), zhSummary);
    const ja = await localTags(
      '東京は大きな都市です。東京タワーは有名な建物です。多くの観光客が東京タワーを訪れます。');
    check('Japanese tags are offered (CJK bigrams)', ja.boxes > 0, 'boxes: ' + ja.boxes);
    check('Japanese top tag is the 東京 bigram', ja.head.includes('  - 東京'), ja.head);

    // English regression inside this section: the pre-1.8.0 behaviour
    // for plain ASCII notes is unchanged.
    const en = await localTags('Gardens need water. Water the gardens daily. Gardens grow fast.');
    check('English tags unchanged: gardens suggested', en.head.includes('  - gardens'), en.head);
    const enSummary = await summarise([
      'The vault stores durable memory for the project.',
      'Durable memory matters because context windows are small.',
      'Memory in the vault is reviewed weekly.',
      'Weekly review keeps the vault durable.',
      'Unrelated filler sentence about nothing in particular.',
      'Another unrelated sentence about entirely different things.',
    ].join(' '));
    check('English summary still favours the repeated-term sentences',
      enSummary.includes('durable') || enSummary.includes('vault'), enSummary);

    plugin.settings.summarySentenceCount = savedSentenceCount;
    plugin.settings.summaryHeading = savedHeading;
    plugin.settings.insertMode = savedInsertMode;
  }

  console.log('\n' + '='.repeat(56));
  console.log('  PASSED: ' + passed + '   FAILED: ' + failed);
  console.log('='.repeat(56) + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTEST HARNESS CRASHED:\n', err);
  process.exit(1);
});

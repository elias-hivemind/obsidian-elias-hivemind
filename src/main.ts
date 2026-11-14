/**
 * Elias HiveMind Plugin for Obsidian.
 *
 * Three capabilities, each exposed as commands:
 *
 *   Summarization
 *     - "local"   : fully offline extractive summariser. No network, no model,
 *                   deterministic. Always available.
 *     - "backend" : delegates to a configurable HTTP endpoint. Defaults to a
 *                   local Ollama/Forge server on 127.0.0.1, so nothing leaves
 *                   the machine unless the user repoints it. If the backend is
 *                   offline, times out or errors, the local summariser is used
 *                   instead (unless fallback is switched off).
 *
 *   Tag suggestion
 *     - local frequency-based tagging, or backend tagging with the same local
 *       fallback. Chosen tags are merged into the note's frontmatter.
 *
 *   Link suggestion
 *     - scans the vault for notes whose title or alias appears verbatim in the
 *       current note but is not yet linked, and offers to insert wikilinks.
 *
 *   Weekly digest
 *     - local only: collects the notes created or modified in the last seven
 *       days, summarises each with the local summariser, and writes the
 *       results into a single digest note. A backend variant would mean one
 *       model call per note in the set, so the digest stays offline.
 *
 *   Backlog digest
 *     - local only: scans the folders where saved clippings pile up, and
 *       writes a "Your backlog" section into the same digest note - per item
 *       a short summary, suggested tags, read time and age, bucketed by
 *       relevance to the user's recent notes. It never deletes anything,
 *       and never moves or marks a note without an explicit command run on
 *       that note. An optional backend pass can add cross-item themes, but
 *       only when the user switches it on.
 *
 * Obsidian loads this file as CommonJS and instantiates the default export.
 */

import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginManifest,
  PluginSettingTab,
  RequestUrlParam,
  RequestUrlResponse,
  Setting,
  SettingDefinitionItem,
  TFile,
  requestUrl,
} from 'obsidian';

/* ========================================================================== */
/*                                  settings                                  */
/* ========================================================================== */

type BackendFormat = 'ollama' | 'openai';
type InsertMode = 'cursor' | 'top' | 'bottom';

interface EliasHiveMindSettings {
  backendUrl: string;
  backendFormat: BackendFormat;
  backendModel: string;
  backendTimeoutMs: number;
  backendPrompt: string;
  fallbackToLocal: boolean;
  summarySentenceCount: number;
  summaryHeading: string;
  insertMode: InsertMode;
  tagPrompt: string;
  maxTags: number;
  maxLinkSuggestions: number;
  minTitleLength: number;
  ignoreFolders: string;
  backlogFolders: string;
  backlogTags: string;
  backlogStaleDays: number;
  backlogArchiveFolder: string;
  backlogThemesViaBackend: boolean;
}

const DEFAULT_SETTINGS: EliasHiveMindSettings = {
  // Local by default. Nothing is sent off this machine unless the user changes it.
  backendUrl: 'http://127.0.0.1:11434/api/generate',
  backendFormat: 'ollama',
  backendModel: 'llama3.2',
  backendTimeoutMs: 60000,
  backendPrompt:
    'Summarise the following note in {{n}} concise sentences. ' +
    'Return only the summary, with no preamble.\n\n{{content}}',
  fallbackToLocal: true,
  summarySentenceCount: 3,
  summaryHeading: '## Summary',
  insertMode: 'top',
  tagPrompt:
    'Suggest up to {{n}} short topic tags for the following note. ' +
    'Return only a comma-separated list of lowercase tags, with no preamble.\n\n{{content}}',
  maxTags: 5,
  maxLinkSuggestions: 20,
  minTitleLength: 4,
  ignoreFolders: '.trash, templates',
  backlogFolders: 'Clippings, Inbox',
  backlogTags: '',
  backlogStaleDays: 30,
  backlogArchiveFolder: 'Archive',
  backlogThemesViaBackend: false,
};

/* ========================================================================== */
/*                             markdown utilities                             */
/* ========================================================================== */

/** Strips YAML frontmatter from the top of a note. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf('\n', end + 1);
  return after === -1 ? '' : markdown.slice(after + 1);
}

/**
 * Reduces markdown to readable prose. Used both as summariser input and as the
 * haystack for link matching, so code blocks and existing links never produce
 * spurious matches.
 */
function toPlainText(markdown: string): string {
  let text = stripFrontmatter(markdown);

  text = text.replace(/```[\s\S]*?```/g, ' '); // fenced code
  text = text.replace(/~~~[\s\S]*?~~~/g, ' '); // alternate fences
  text = text.replace(/`[^`\n]*`/g, ' '); // inline code
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
  text = text.replace(/!\[\[[^\]]*\]\]/g, ' '); // embeds
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2'); // [[page|alias]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1'); // [[page]]
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [text](url)
  text = text.replace(/https?:\/\/\S+/g, ' '); // bare urls
  text = text.replace(/<[^>]+>/g, ' '); // html
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  text = text.replace(/^\s{0,3}>\s?/gm, ''); // blockquotes
  text = text.replace(/^\s*[-*+]\s+/gm, ''); // bullets
  text = text.replace(/^\s*\d+\.\s+/gm, ''); // ordered lists
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, ' '); // rules
  text = text.replace(/[*_~]{1,3}/g, ''); // emphasis
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');

  return text.trim();
}

/**
 * Removes the parts of a note that must never yield a link suggestion:
 * frontmatter, code, URLs and anything already linked.
 */
function toLinkHaystack(markdown: string): string {
  let text = stripFrontmatter(markdown);
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  text = text.replace(/`[^`\n]*`/g, ' ');
  text = text.replace(/!?\[\[[^\]]*\]\]/g, ' '); // existing wikilinks and embeds
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, ' '); // existing markdown links
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  return text;
}

// Sentence boundaries are found by matching forwards rather than by using a
// lookbehind assertion. obsidianmd/regex-lookbehind is an ERROR for any plugin
// with isDesktopOnly:false, because older iOS WebKit cannot compile them.
const SENTENCE_CHUNK = /[^.!?]+[.!?]*\s*/g;

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    // matchAll clones the regex internally, so the shared /g literal is safe.
    for (const match of paragraph.matchAll(SENTENCE_CHUNK)) {
      const sentence = match[0].replace(/\s+/g, ' ').trim();
      if (sentence.length > 0) sentences.push(sentence);
    }
  }
  return sentences;
}

const STOPWORDS = new Set(
  ('a about above after again against all am an and any are as at be because been before being below ' +
    'between both but by can cannot could did do does doing down during each few for from further had ' +
    'has have having he her here hers herself him himself his how i if in into is it its itself just me ' +
    'more most my myself no nor not of off on once only or other ought our ours ourselves out over own ' +
    'same she should so some such than that the their theirs them themselves then there these they this ' +
    'those through to too under until up very was we were what when where which while who whom why will ' +
    'with would you your yours yourself yourselves')
    .split(' ')
);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g);
  return matches ? matches : [];
}

/* ========================================================================== */
/*                           local summarisation                              */
/* ========================================================================== */

/**
 * Frequency-based extractive summariser.
 *
 * Scores each sentence by the summed frequency of its non-stopword terms,
 * normalised by length so long sentences do not automatically win, with a
 * mild positional boost because notes tend to state their point early.
 * Selected sentences are returned in original document order.
 */
function summariseLocally(markdown: string, sentenceCount: number): string {
  const plain = toPlainText(markdown);
  const sentences = splitSentences(plain);

  if (sentences.length === 0) return '';
  if (sentences.length <= sentenceCount) return sentences.join(' ');

  const freq = new Map<string, number>();
  for (const word of tokenize(plain)) {
    if (STOPWORDS.has(word) || word.length < 3) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  let maxFreq = 0;
  freq.forEach((v) => {
    if (v > maxFreq) maxFreq = v;
  });
  if (maxFreq === 0) return sentences.slice(0, sentenceCount).join(' ');

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence).filter((w) => !STOPWORDS.has(w) && w.length >= 3);
    if (words.length === 0) return { index, sentence, score: 0 };

    let score = 0;
    for (const w of words) score += (freq.get(w) ?? 0) / maxFreq;
    score = score / Math.sqrt(words.length);

    // Early sentences carry disproportionate signal in notes.
    const positionBoost = 1 + 0.25 * (1 - index / sentences.length);
    return { index, sentence, score: score * positionBoost };
  });

  return scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, sentenceCount)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence)
    .join(' ');
}

/* ========================================================================== */
/*                          backend summarisation                             */
/* ========================================================================== */

function buildPrompt(template: string, content: string, n: number): string {
  return template.replace(/\{\{n\}\}/g, String(n)).replace(/\{\{content\}\}/g, content);
}

/** Pulls generated text out of the several response shapes backends use. */
function extractGeneratedText(payload: unknown, rawText: string): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    if (typeof obj.response === 'string') return obj.response; // Ollama
    if (typeof obj.summary === 'string') return obj.summary;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.output === 'string') return obj.output;
    if (typeof obj.content === 'string') return obj.content;

    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const message = first.message as Record<string, unknown> | undefined;
      if (message && typeof message.content === 'string') return message.content; // OpenAI chat
      if (typeof first.text === 'string') return first.text; // OpenAI completions
    }

    const message = obj.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') return message.content; // Ollama chat
  }

  return rawText;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Obsidian's response.json is a getter that throws on a non-JSON body. */
function safeJson(response: RequestUrlResponse): unknown {
  try {
    return response.json;
  } catch {
    return null;
  }
}

async function requestWithTimeout(
  param: RequestUrlParam,
  timeoutMs: number
): Promise<RequestUrlResponse> {
  // requestUrl is used rather than fetch: it runs outside the renderer's CORS
  // sandbox, which is what makes calling a local server work at all.
  const request = requestUrl({ ...param, throw: false });

  // requestUrl exposes no timeout, so the promise is raced instead. The
  // underlying request is not aborted; this only stops the UI hanging.
  // window.setTimeout / window.clearTimeout rather than the bare globals, so
  // the timer belongs to the window the code runs in (popout windows included).
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(`Backend did not respond within ${timeoutMs} ms.`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** Sends one prompt to the configured backend and returns the generated text. */
async function generateViaBackend(
  settings: EliasHiveMindSettings,
  prompt: string
): Promise<string> {
  const body =
    settings.backendFormat === 'openai'
      ? JSON.stringify({
          model: settings.backendModel,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        })
      : JSON.stringify({
          model: settings.backendModel,
          prompt,
          stream: false,
        });

  const response = await requestWithTimeout(
    {
      url: settings.backendUrl,
      method: 'POST',
      contentType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
    settings.backendTimeoutMs
  );

  if (response.status >= 400) {
    throw new Error(`Backend returned HTTP ${response.status}. ${response.text.slice(0, 300)}`);
  }

  const generated = extractGeneratedText(safeJson(response), response.text).trim();
  if (!generated) throw new Error('Backend returned an empty response.');
  return generated;
}

async function summariseViaBackend(
  settings: EliasHiveMindSettings,
  markdown: string
): Promise<string> {
  const plain = toPlainText(markdown);
  if (!plain) throw new Error('Note has no readable text to summarise.');

  const prompt = buildPrompt(settings.backendPrompt, plain, settings.summarySentenceCount);
  return generateViaBackend(settings, prompt);
}

/* ========================================================================== */
/*                               model listing                                */
/* ========================================================================== */

/**
 * Derives the model-list endpoint from the generation URL: Ollama serves
 * /api/tags at the server root, OpenAI-compatible servers serve /v1/models.
 */
function modelListUrl(settings: EliasHiveMindSettings): string {
  let url: URL;
  try {
    url = new URL(settings.backendUrl);
  } catch {
    throw new Error(`Backend URL is not a valid URL: "${settings.backendUrl}".`);
  }

  if (settings.backendFormat === 'openai') {
    const idx = url.pathname.indexOf('/v1/');
    const prefix = idx === -1 ? '/v1' : url.pathname.slice(0, idx + 3);
    return `${url.origin}${prefix}/models`;
  }
  return `${url.origin}/api/tags`;
}

/** Lists the model names the backend reports as installed, sorted. */
async function listBackendModels(settings: EliasHiveMindSettings): Promise<string[]> {
  const url = modelListUrl(settings);
  // Capped so an unreachable server never leaves the settings tab waiting a minute.
  const response = await requestWithTimeout(
    { url, method: 'GET' },
    Math.min(settings.backendTimeoutMs, 10000)
  );

  if (response.status >= 400) {
    throw new Error(`Model list returned HTTP ${response.status}.`);
  }

  const payload = safeJson(response);
  const names = new Set<string>();

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    // Ollama: { models: [{ name }] }. OpenAI-compatible: { data: [{ id }] }.
    const entries = Array.isArray(obj.models) ? obj.models : Array.isArray(obj.data) ? obj.data : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const name =
        typeof e.name === 'string' ? e.name : typeof e.model === 'string' ? e.model : typeof e.id === 'string' ? e.id : '';
      if (name) names.add(name);
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/* ========================================================================== */
/*                               tag suggestion                               */
/* ========================================================================== */

/**
 * Coerces free text into a valid Obsidian tag: lowercase, no leading '#',
 * spaces become hyphens, only letters, digits, '_', '-' and '/' survive.
 * Returns '' for anything unusable, including purely numeric tags, which
 * Obsidian does not treat as tags.
 */
function normaliseTag(raw: string): string {
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/['"]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_/-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');

  if (!tag || tag.length > 40) return '';
  if (!/[a-z_/-]/.test(tag) || !Number.isNaN(Number(tag))) return '';
  return tag;
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter((t) => t.length > 0)));
}

/** A leading YAML frontmatter block: its full text (fences included) and inner lines. */
function frontmatterBlock(markdown: string): { text: string; lines: string[] } | null {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  return { text: match[0], lines: match[1] ? match[1].split(/\r?\n/) : [] };
}

/**
 * Finds the `tags:` key in frontmatter lines. Handles the inline forms
 * (`tags: a, b` and `tags: [a, b]`) and the block-list form (`- a` lines).
 */
function tagsKeyRange(lines: string[]): { start: number; end: number; values: string[] } | null {
  const start = lines.findIndex((line) => /^tags\s*:/.test(line));
  if (start === -1) return null;

  const inline = lines[start].replace(/^tags\s*:/, '').trim();
  const raw: string[] = [];
  let end = start + 1;

  if (inline) {
    raw.push(...inline.replace(/^\[|\]$/g, '').split(/[,\s]+/));
  } else {
    while (end < lines.length && /^\s*-(\s|$)/.test(lines[end])) {
      raw.push(lines[end].replace(/^\s*-\s*/, ''));
      end += 1;
    }
  }

  return { start, end, values: uniqueTags(raw.map(normaliseTag)) };
}

function existingFrontmatterTags(markdown: string): string[] {
  const block = frontmatterBlock(markdown);
  const range = block ? tagsKeyRange(block.lines) : null;
  return range ? range.values : [];
}

/**
 * Returns the note's current frontmatter text and its replacement with `add`
 * merged into `tags:` as a block list. Other keys are left untouched; a
 * frontmatter block is created if the note has none.
 */
function mergeTagsIntoFrontmatter(
  markdown: string,
  add: string[]
): { oldHead: string; newHead: string } {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const block = frontmatterBlock(markdown);
  const lines = block ? block.lines.slice() : [];
  const range = tagsKeyRange(lines);

  const merged = uniqueTags([...(range ? range.values : []), ...add]);
  const tagLines = ['tags:', ...merged.map((t) => `  - ${t}`)];

  if (range) lines.splice(range.start, range.end - range.start, ...tagLines);
  else lines.push(...tagLines);

  return { oldHead: block ? block.text : '', newHead: ['---', ...lines, '---'].join(eol) + eol };
}

/** Frequency-based tags: repeated non-stopword terms, most frequent first. */
function suggestTagsLocally(markdown: string, max: number, existing: string[]): string[] {
  const skip = new Set(existing);
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  tokenize(toPlainText(markdown)).forEach((word, index) => {
    if (word.length < 4 || STOPWORDS.has(word)) return;
    const tag = normaliseTag(word);
    if (!tag || skip.has(tag)) return;
    freq.set(tag, (freq.get(tag) ?? 0) + 1);
    if (!firstSeen.has(tag)) firstSeen.set(tag, index);
  });

  const ranked = Array.from(freq.keys()).sort(
    (a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0)
  );

  // Single mentions are mostly noise; use them only when nothing repeats.
  const repeated = ranked.filter((t) => (freq.get(t) ?? 0) >= 2);
  return (repeated.length > 0 ? repeated : ranked).slice(0, max);
}

async function suggestTagsViaBackend(
  settings: EliasHiveMindSettings,
  markdown: string,
  existing: string[]
): Promise<string[]> {
  const plain = toPlainText(markdown);
  if (!plain) throw new Error('Note has no readable text to tag.');

  const reply = await generateViaBackend(
    settings,
    buildPrompt(settings.tagPrompt, plain, settings.maxTags)
  );

  const skip = new Set(existing);
  const tags = uniqueTags(
    reply
      .split(/[,\n]/)
      .map((part) => normaliseTag(part.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')))
  ).filter((t) => !skip.has(t));

  if (tags.length === 0) throw new Error('Backend returned no usable tags.');
  return tags.slice(0, settings.maxTags);
}

/* ========================================================================== */
/*                             link suggestion                                */
/* ========================================================================== */

interface LinkSuggestion {
  title: string;
  path: string;
  basename: string;
  occurrences: number;
  viaAlias: boolean;
}

function isWordChar(ch: string): boolean {
  return ch !== '' && /[A-Za-z0-9_'-]/.test(ch);
}

/**
 * Counts whole-word occurrences without regex, so note titles containing
 * regex metacharacters need no escaping and multi-word titles work correctly.
 */
function countWholeWordOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0;

  let count = 0;
  let idx = haystackLower.indexOf(needleLower);

  while (idx !== -1) {
    const before = idx === 0 ? '' : haystackLower.charAt(idx - 1);
    const afterIdx = idx + needleLower.length;
    const after = afterIdx >= haystackLower.length ? '' : haystackLower.charAt(afterIdx);

    if (!isWordChar(before) && !isWordChar(after)) count += 1;
    idx = haystackLower.indexOf(needleLower, idx + needleLower.length);
  }

  return count;
}

function parseIgnoreFolders(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, '').toLowerCase())
    .filter((s) => s.length > 0);
}

function collectAliases(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function findLinkSuggestions(
  app: App,
  activeFile: TFile,
  markdown: string,
  settings: EliasHiveMindSettings
): LinkSuggestion[] {
  const haystack = toLinkHaystack(markdown).toLowerCase();
  // The user can rename the configuration folder, so its name is read from
  // the vault and it is always ignored, on top of whatever the user listed.
  const ignored = parseIgnoreFolders(
    `${app.vault.configDir}, ${settings.ignoreFolders}`
  );

  // Titles already linked from this note are not worth suggesting again.
  const alreadyLinked = new Set<string>();
  const cache = app.metadataCache.getFileCache(activeFile);
  if (cache && cache.links) {
    for (const link of cache.links) {
      alreadyLinked.add(link.link.split('#')[0].split('|')[0].trim().toLowerCase());
    }
  }

  const suggestions: LinkSuggestion[] = [];

  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path === activeFile.path) continue;

    const lowerPath = file.path.toLowerCase();
    if (ignored.some((folder) => lowerPath.startsWith(folder + '/'))) continue;

    const fileCache = app.metadataCache.getFileCache(file);
    const aliases = fileCache?.frontmatter
      ? collectAliases(fileCache.frontmatter.aliases)
      : [];

    const candidates: Array<{ title: string; viaAlias: boolean }> = [
      { title: file.basename, viaAlias: false },
      ...aliases.map((a) => ({ title: a, viaAlias: true })),
    ];

    let best: LinkSuggestion | null = null;

    for (const candidate of candidates) {
      const title = candidate.title.trim();
      if (title.length < settings.minTitleLength) continue;
      if (alreadyLinked.has(title.toLowerCase())) continue;
      if (alreadyLinked.has(file.basename.toLowerCase())) continue;

      const occurrences = countWholeWordOccurrences(haystack, title.toLowerCase());
      if (occurrences === 0) continue;

      if (!best || occurrences > best.occurrences || title.length > best.title.length) {
        best = {
          title,
          path: file.path,
          basename: file.basename,
          occurrences,
          viaAlias: candidate.viaAlias,
        };
      }
    }

    if (best) suggestions.push(best);
  }

  // Most-mentioned first; longer titles break ties as they are more specific.
  suggestions.sort(
    (a, b) => b.occurrences - a.occurrences || b.title.length - a.title.length
  );

  return suggestions.slice(0, settings.maxLinkSuggestions);
}

function wikilinkFor(suggestion: LinkSuggestion): string {
  return suggestion.viaAlias
    ? `[[${suggestion.basename}|${suggestion.title}]]`
    : `[[${suggestion.basename}]]`;
}

/* ========================================================================== */
/*                              weekly digest                                 */
/* ========================================================================== */

/** The single note every digest run writes to, at the vault root. */
const DIGEST_NOTE_PATH = 'Weekly Digest.md';

const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound on notes listed in one digest section. A very active week
 * would otherwise produce an unreadable note (and a very long run); the
 * overflow is counted in the section rather than silently dropped.
 */
const DIGEST_MAX_NOTES = 50;

interface DigestEntry {
  basename: string;
  path: string;
  summary: string;
  links: LinkSuggestion[];
}

/** Local calendar date as YYYY-MM-DD (toISOString would shift it to UTC). */
function formatDigestDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Assembles one dated digest section, without a trailing newline. */
function buildDigestSection(
  date: string,
  since: string,
  entries: DigestEntry[],
  tags: string[],
  omitted: number
): string {
  const lines: string[] = [
    `## Weekly Digest — ${date}`,
    '',
    `${entries.length + omitted} note${entries.length + omitted === 1 ? '' : 's'} created or modified since ${since}.`,
  ];

  for (const entry of entries) {
    lines.push('', `### [[${entry.basename}]]`, '');
    lines.push(entry.summary ? entry.summary : '*No summarisable text in this note.*');
    if (entry.links.length > 0) {
      lines.push('', `Links to this week's notes: ${entry.links.map(wikilinkFor).join(', ')}`);
    }
  }

  if (omitted > 0) {
    lines.push(
      '',
      `*…and ${omitted} more note${omitted === 1 ? '' : 's'} from this week, not shown (the digest lists at most ${DIGEST_MAX_NOTES}).*`
    );
  }

  if (tags.length > 0) {
    lines.push('', '### Suggested tags for this week', '', tags.map((t) => `#${t}`).join(' '));
  }

  return lines.join('\n');
}

/**
 * Returns the digest note's new full text. A section for `date` that is
 * already present is replaced (re-running the command the same day refreshes
 * that day's digest instead of duplicating it); otherwise the new section
 * goes directly under the note's `# Weekly Digest` title, or at the top of
 * whatever the note already holds.
 */
function upsertDigestSection(existing: string, section: string, date: string): string {
  const heading = `## Weekly Digest — ${date}`;
  const start = existing.indexOf(heading);

  if (start !== -1) {
    const rest = existing.slice(start + heading.length);
    const next = rest.indexOf('\n## ');
    const after = next === -1 ? '' : rest.slice(next + 1);
    const before = existing.slice(0, start);
    return after ? `${before}${section}\n\n${after}` : `${before}${section}\n`;
  }

  if (!existing.trim()) return `# Weekly Digest\n\n${section}\n`;

  const firstBreak = existing.indexOf('\n');
  if (firstBreak !== -1 && existing.slice(0, firstBreak).trim() === '# Weekly Digest') {
    const tail = existing.slice(firstBreak + 1).replace(/^\n+/, '');
    return `# Weekly Digest\n\n${section}\n\n${tail}`;
  }

  return `${section}\n\n${existing}`;
}

/* ========================================================================== */
/*                              backlog digest                                */
/* ========================================================================== */

/**
 * Frontmatter key the plugin writes when the user marks a clipping read with
 * the dedicated command. Obsidian has no read state of its own; this marker
 * is the backlog's, it is only ever written by that explicit command, and a
 * marked clipping drops out of later digests.
 */
const BACKLOG_READ_KEY = 'hivemind-read';

/**
 * Upper bound on unread clippings digested in one run, for the same reason
 * as the weekly digest's cap: an unbounded first run over a 500-clipping
 * pile would be slow (doubly so on a phone) and unreadable. The overflow is
 * counted in the section, and because a run takes the most recently saved
 * first, repeated runs chew through the pile.
 */
const BACKLOG_MAX_ITEMS = 50;

/** A clipping with fewer readable words than this is a stub, not a read. */
const BACKLOG_NEAR_EMPTY_WORDS = 25;

/** Significant-word overlap (Jaccard) at which two clippings are the same article twice. */
const BACKLOG_DUPLICATE_JACCARD = 0.6;

/** Relevance score at which a clipping counts as tied to the user's current work. */
const BACKLOG_RELEVANCE_THRESHOLD = 4;

/** Word count at which a clipping counts as a substantial, keepable read. */
const BACKLOG_REFERENCE_WORDS = 400;

/** Distinct significant words at which a shorter clipping still counts as dense. */
const BACKLOG_REFERENCE_UNIQUE = 80;

const BACKLOG_DAY_MS = 24 * 60 * 60 * 1000;

/** Reading speed behind the read-time estimate, in words per minute. */
const WORDS_PER_MINUTE = 200;

type BacklogBucket = 'now' | 'reference' | 'stale' | 'junk';

/** Display order: act first, keep second, archive candidates, then junk. */
const BACKLOG_BUCKET_ORDER: BacklogBucket[] = ['now', 'reference', 'stale', 'junk'];

const BACKLOG_BUCKET_HEADINGS: Record<BacklogBucket, string> = {
  now: 'Worth reading now',
  reference: 'Reference',
  stale: 'Gone stale',
  junk: 'Junk candidates',
};

interface BacklogItem {
  basename: string;
  path: string;
  summary: string;
  tags: string[];
  readMinutes: number;
  ageDays: number;
  wordCount: number;
  relevance: number;
  bucket: BacklogBucket;
  reasons: string[];
  /** The recent note this clipping most belongs with, when it mentions one. */
  belongsTo: LinkSuggestion | null;
}

interface BacklogScan {
  items: BacklogItem[];
  /** Unread clippings left unscanned because the per-run cap was reached. */
  omitted: number;
  /** Clippings skipped because they already carry the read marker. */
  readCount: number;
  foldersLabel: string;
  /** Cross-item themes from the optional backend pass; '' when not run. */
  themes: string;
}

interface BacklogFacts {
  wordCount: number;
  uniqueWords: number;
  ageDays: number;
  staleDays: number;
  relevance: number;
  relevanceReasons: string[];
  duplicateOf: string | null;
  neverModified: boolean;
}

/** Backlog folders use the same comma-separated shape as Ignore folders. */
function parseBacklogFolders(raw: string): string[] {
  return parseIgnoreFolders(raw);
}

/** The configured folder names as the user typed them, for display. */
function backlogFolderLabel(raw: string): string {
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? names.join(', ') : DEFAULT_SETTINGS.backlogFolders;
}

function parseBacklogTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const tag = normaliseTag(part);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Every tag on a file, from the metadata cache only (frontmatter tags and
 * inline #tags) — no file read, so backlog selection stays cheap.
 */
function fileTags(app: App, file: TFile): string[] {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return [];
  const out: string[] = [];
  const push = (value: unknown): void => {
    const tag = normaliseTag(String(value ?? ''));
    if (tag && !out.includes(tag)) out.push(tag);
  };
  const frontmatter = cache.frontmatter as Record<string, unknown> | undefined;
  if (frontmatter && frontmatter.tags != null) {
    const raw = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
    for (const value of raw) push(value);
  }
  for (const entry of cache.tags ?? []) push(entry?.tag);
  return out;
}

/** True when `path` sits inside one of the (lowercased) folders. */
function fileInAnyFolder(path: string, folders: string[]): boolean {
  const lower = path.toLowerCase();
  return folders.some((folder) => lower.startsWith(folder + '/'));
}

function countWords(plain: string): number {
  return plain.split(/\s+/).filter((w) => w.length > 0).length;
}

function estimateReadMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/** The content words of a text: four-plus letters, no stopwords. */
function significantWordSet(plain: string): Set<string> {
  const set = new Set<string>();
  for (const word of tokenize(plain)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) set.add(word);
  }
  return set;
}

/** Jaccard similarity of two word sets: shared words over all words. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  a.forEach((w) => {
    if (b.has(w)) shared += 1;
  });
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Buckets one clipping. The rules run in a fixed order and each returns its
 * reason in plain words, so the digest can say *why* an item sits where it
 * sits; the same facts always produce the same bucket.
 */
function classifyBacklogItem(facts: BacklogFacts): { bucket: BacklogBucket; reasons: string[] } {
  if (facts.wordCount < BACKLOG_NEAR_EMPTY_WORDS) {
    return {
      bucket: 'junk',
      reasons: [`Near-empty — only ${facts.wordCount} words of readable text.`],
    };
  }

  if (facts.duplicateOf) {
    return {
      bucket: 'junk',
      reasons: [`Near-duplicate of [[${facts.duplicateOf}]] — the same significant words.`],
    };
  }

  if (facts.relevance >= BACKLOG_RELEVANCE_THRESHOLD) {
    return { bucket: 'now', reasons: facts.relevanceReasons };
  }

  if (facts.ageDays <= 7) {
    const when =
      facts.ageDays === 0 ? 'today' : facts.ageDays === 1 ? 'yesterday' : `${facts.ageDays} days ago`;
    return { bucket: 'now', reasons: [`Saved ${when} — still fresh.`] };
  }

  if (facts.wordCount >= BACKLOG_REFERENCE_WORDS || facts.uniqueWords >= BACKLOG_REFERENCE_UNIQUE) {
    return {
      bucket: 'reference',
      reasons: [
        `Substantial, self-contained read (${facts.wordCount} words) — keeps its value as reference.`,
      ],
    };
  }

  if (facts.ageDays >= facts.staleDays && facts.neverModified) {
    return {
      bucket: 'stale',
      reasons: [
        `Saved ${facts.ageDays} days ago, untouched since, and no overlap with your recent work — an archive candidate.`,
      ],
    };
  }

  return { bucket: 'reference', reasons: ['No strong signal either way — kept as reference.'] };
}

/** Within a bucket: most actionable first, then path order for stability. */
function compareBacklogItems(a: BacklogItem, b: BacklogItem): number {
  const rank = BACKLOG_BUCKET_ORDER.indexOf(a.bucket) - BACKLOG_BUCKET_ORDER.indexOf(b.bucket);
  if (rank !== 0) return rank;

  let within = 0;
  if (a.bucket === 'now') within = b.relevance - a.relevance || a.ageDays - b.ageDays;
  else if (a.bucket === 'reference') within = b.wordCount - a.wordCount;
  else within = b.ageDays - a.ageDays;

  return within || a.path.localeCompare(b.path);
}

function formatSavedAgo(ageDays: number): string {
  if (ageDays === 0) return 'saved today';
  if (ageDays === 1) return 'saved yesterday';
  return `saved ${ageDays} days ago`;
}

/** Assembles the "Your backlog" block, without a trailing newline. */
function buildBacklogBlock(scan: BacklogScan): string {
  const lines: string[] = ['### Your backlog', ''];

  if (scan.items.length === 0 && scan.omitted === 0) {
    lines.push(`No unread clippings waiting in ${scan.foldersLabel}.`);
    if (scan.readCount > 0) {
      lines.push('', `${scan.readCount} clipping${scan.readCount === 1 ? '' : 's'} already marked read.`);
    }
    return lines.join('\n');
  }

  const total = scan.items.length + scan.omitted;
  lines.push(`${total} unread clipping${total === 1 ? '' : 's'} in ${scan.foldersLabel}.`);

  const counts = BACKLOG_BUCKET_ORDER.map((bucket) => {
    const n = scan.items.filter((item) => item.bucket === bucket).length;
    return n > 0 ? `${n} ${BACKLOG_BUCKET_HEADINGS[bucket].toLowerCase()}` : '';
  }).filter((s) => s.length > 0);
  if (counts.length > 0) lines.push(counts.join(' · ') + '.');

  if (scan.omitted > 0) {
    lines.push(
      `Digested the ${scan.items.length} most recently saved; ${scan.omitted} more wait for the next run (one run covers at most ${BACKLOG_MAX_ITEMS}).`
    );
  }
  if (scan.readCount > 0) {
    lines.push(`${scan.readCount} already marked read, skipped.`);
  }

  lines.push(
    '',
    '*Summaries are extractive — each article\'s own key sentences, picked on this device. ' +
      'Nothing left the vault.*'
  );

  // The return-visit hook: one clear place to start, and a visible way to
  // shrink the pile today, so the section earns its place in the digest.
  const topPick = scan.items.find((item) => item.bucket === 'now');
  if (topPick) {
    lines.push(
      '',
      `**Start here:** [[${topPick.basename}]] — ${topPick.reasons[0] ?? 'Closest to your recent work.'}`
    );
  }
  const clearable = scan.items.filter(
    (item) => item.bucket === 'stale' || item.bucket === 'junk'
  ).length;
  if (clearable > 0) {
    lines.push(
      '',
      `${clearable} item${clearable === 1 ? '' : 's'} could leave the pile today — open one and ` +
        'archive it or mark it read, and this section shrinks on the next run.'
    );
  }

  for (const bucket of BACKLOG_BUCKET_ORDER) {
    const items = scan.items.filter((item) => item.bucket === bucket);
    if (items.length === 0) continue;

    lines.push('', `#### ${BACKLOG_BUCKET_HEADINGS[bucket]}`);

    for (const item of items) {
      lines.push(
        '',
        `- [[${item.basename}]] — ${item.readMinutes} min read · ${formatSavedAgo(item.ageDays)}`
      );
      lines.push(`  ${item.summary ? item.summary : '*No summarisable text in this note.*'}`);
      const meta: string[] = [];
      if (item.tags.length > 0) meta.push(`Tags: ${item.tags.map((t) => `#${t}`).join(' ')}`);
      meta.push(`Why here: ${item.reasons.join(' ')}`);
      lines.push(`  ${meta.join(' · ')}`);
      if (item.belongsTo) {
        lines.push(`  Belongs with: ${wikilinkFor(item.belongsTo)}`);
      }
    }
  }

  if (scan.themes) {
    lines.push('', '#### Themes across your backlog', '', scan.themes);
  }

  lines.push(
    '',
    '*To process an item, open it and run a Backlog command from the command palette: ' +
      'apply suggested tags, link it, mark as read, or archive. Nothing is deleted or moved automatically.*'
  );

  return lines.join('\n');
}

/**
 * Returns the note text with the backlog block for `date` inserted or
 * replaced. The block lives inside that date's weekly digest section: if
 * the section already holds a backlog block it is swapped in place, if the
 * section exists without one the block is appended to it, and if there is
 * no section for the date yet one is created holding only the block. Other
 * days' sections and the week's own entries are never touched.
 */
function upsertBacklogBlock(existing: string, block: string, date: string): string {
  const heading = `## Weekly Digest — ${date}`;
  const start = existing.indexOf(heading);

  if (start === -1) {
    return upsertDigestSection(existing, `${heading}\n\n${block}`, date);
  }

  const rest = existing.slice(start + heading.length);
  const nextSection = rest.indexOf('\n## ');
  const sectionEnd =
    nextSection === -1 ? existing.length : start + heading.length + nextSection + 1;
  const section = existing.slice(start, sectionEnd);

  const marker = '### Your backlog';
  const blockStart = section.indexOf(marker);
  let newSection: string;

  if (blockStart === -1) {
    newSection = `${section.replace(/\n+$/, '')}\n\n${block}\n`;
  } else {
    const after = section.slice(blockStart + marker.length);
    const nextSub = after.search(/\n#{2,3} /);
    const blockEnd =
      nextSub === -1 ? section.length : blockStart + marker.length + nextSub + 1;
    newSection =
      blockEnd < section.length
        ? `${section.slice(0, blockStart)}${block}\n\n${section.slice(blockEnd)}`
        : `${section.slice(0, blockStart)}${block}\n`;
  }

  return existing.slice(0, start) + newSection + existing.slice(sectionEnd);
}

/** Reads one `key: value` line out of a note's frontmatter, or null. */
function frontmatterValue(markdown: string, key: string): string | null {
  const block = frontmatterBlock(markdown);
  if (!block) return null;

  for (const line of block.lines) {
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/** True when the note carries the backlog read marker. */
function isMarkedRead(markdown: string): boolean {
  const value = frontmatterValue(markdown, BACKLOG_READ_KEY);
  return value !== null && /^(true|yes)$/i.test(value);
}

/**
 * Returns the note's current frontmatter text and its replacement with
 * `key: value` set - the same head-splice shape as the tag merge, so the
 * body is never rewritten.
 */
function withFrontmatterValue(
  markdown: string,
  key: string,
  value: string
): { oldHead: string; newHead: string } {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const block = frontmatterBlock(markdown);
  const lines = block ? block.lines.slice() : [];

  const line = `${key}: ${value}`;
  const index = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (index >= 0) lines[index] = line;
  else lines.push(line);

  return { oldHead: block ? block.text : '', newHead: ['---', ...lines, '---'].join(eol) + eol };
}

/**
 * Locates an existing summary block in a note: the line carrying the
 * configured summary heading, plus everything up to the next heading or the
 * end of the note. Returns character offsets, or null when there is no such
 * block (including when the heading setting is blank - with no heading there
 * is nothing recognisable to replace).
 */
function findSummaryBlock(text: string, heading: string): { start: number; end: number } | null {
  const target = heading.trim();
  if (!target) return null;

  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) {
      let end = text.length;
      let cursor = offset + lines[i].length + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,6}\s/.test(lines[j])) {
          end = cursor;
          break;
        }
        cursor += lines[j].length + 1;
      }
      return { start: offset, end };
    }
    offset += lines[i].length + 1;
  }

  return null;
}

/** Converts a character offset in `text` to an editor line/character position. */
function offsetToPos(text: string, offset: number): { line: number; ch: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, ch: offset - lineStart };
}

/* ========================================================================== */
/*                                   modal                                    */
/* ========================================================================== */

interface ChoiceModalConfig<T> {
  title: string;
  intro: string;
  confirmText: string;
  items: T[];
  label: (item: T) => string;
  meta?: (item: T) => string;
  onSubmit: (chosen: T[]) => void;
}

/** A checklist of items, all pre-selected; nothing is applied until confirmed. */
class ChoiceModal<T> extends Modal {
  private readonly config: ChoiceModalConfig<T>;
  private readonly selected: Set<number>;

  constructor(app: App, config: ChoiceModalConfig<T>) {
    super(app);
    this.config = config;
    this.selected = new Set(config.items.map((_item, i) => i));
  }

  onOpen(): void {
    // Nodes are built with Obsidian's createEl helpers, which create them in
    // the element's own document, so the modal renders correctly in popout
    // windows. All presentation lives in styles.css; inline static styles
    // trip obsidianmd/no-static-styles-assignment at ERROR severity.
    const { contentEl, titleEl, config } = this;
    titleEl.setText(config.title);
    contentEl.empty();

    contentEl.createEl('p', { text: config.intro });

    const list = contentEl.createDiv({ cls: 'ehm-suggestion-list' });

    config.items.forEach((item, index) => {
      const row = list.createEl('label', { cls: 'ehm-suggestion-row' });

      const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
      checkbox.checked = true;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(index);
        else this.selected.delete(index);
      });

      row.createSpan({ text: config.label(item) });

      if (config.meta) {
        row.createEl('small', { cls: 'ehm-suggestion-meta', text: config.meta(item) });
      }
    });

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });

    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const insert = buttons.createEl('button', {
      cls: 'mod-cta',
      text: config.confirmText,
    });
    insert.addEventListener('click', () => {
      const chosen = config.items.filter((_item, i) => this.selected.has(i));
      this.close();
      config.onSubmit(chosen);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ========================================================================== */
/*                                   plugin                                   */
/* ========================================================================== */

export default class EliasHiveMindPlugin extends Plugin {
  settings: EliasHiveMindSettings = DEFAULT_SETTINGS;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  onload(): void {
    // Deliberately not async: Component declares onload(): void, and
    // returning a promise here is no-misused-promises at ERROR severity.
    // Settings load in the background - the `settings` field is already
    // initialised to DEFAULT_SETTINGS, and commands read this.settings when
    // invoked, not when registered, so nothing observes an unloaded value.
    void this.loadSettings();

    this.addCommand({
      id: 'summarize-note-local',
      name: 'Summarize current note (local)',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.runLocalSummary(editor, view);
      },
    });

    this.addCommand({
      id: 'summarize-note-backend',
      name: 'Summarize current note (backend)',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.runBackendSummary(editor, view);
      },
    });

    this.addCommand({
      id: 'summarize-selection-local',
      name: 'Summarize selection (local)',
      editorCallback: (editor: Editor) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          new Notice('Elias HiveMind: nothing selected.');
          return;
        }
        const summary = summariseLocally(selection, this.settings.summarySentenceCount);
        if (!summary) {
          new Notice('Elias HiveMind: selection has no summarisable text.');
          return;
        }
        editor.replaceSelection(`${selection}\n\n${this.settings.summaryHeading}\n${summary}\n`);
        new Notice('Elias HiveMind: selection summarised.');
      },
    });

    this.addCommand({
      id: 'generate-tags-local',
      name: 'Suggest tags for current note (local)',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.runTagSuggestions(editor, view, false);
      },
    });

    this.addCommand({
      id: 'generate-tags-backend',
      name: 'Suggest tags for current note (backend)',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.runTagSuggestions(editor, view, true);
      },
    });

    this.addCommand({
      id: 'suggest-links',
      name: 'Suggest links for current note',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.runLinkSuggestions(editor, view);
      },
    });

    this.addCommand({
      id: 'weekly-digest-local',
      name: 'Weekly digest (local)',
      callback: () => {
        void this.runWeeklyDigest();
      },
    });

    this.addCommand({
      id: 'backlog-digest',
      name: 'Backlog digest',
      callback: () => {
        void this.runBacklogDigest();
      },
    });

    this.addCommand({
      id: 'backlog-apply-tags',
      name: 'Backlog: apply suggested tags to current note',
      callback: () => {
        void this.runBacklogApplyTags();
      },
    });

    this.addCommand({
      id: 'backlog-mark-read',
      name: 'Backlog: mark current note as read',
      callback: () => {
        void this.runBacklogMarkRead();
      },
    });

    this.addCommand({
      id: 'backlog-archive',
      name: 'Backlog: archive current note',
      callback: () => {
        void this.runBacklogArchive();
      },
    });

    this.addCommand({
      id: 'backlog-link',
      name: 'Backlog: link current note to the notes it mentions',
      callback: () => {
        void this.runBacklogLink();
      },
    });

    this.addCommand({
      id: 'test-backend-connection',
      name: 'Test backend connection',
      callback: () => {
        void this.testBackend();
      },
    });

    this.addSettingTab(new EliasHiveMindSettingTab(this.app, this));
  }

  onunload(): void {
    // Nothing to release: commands and the settings tab are unregistered by Obsidian.
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<EliasHiveMindSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Lists the models the configured backend reports as installed. */
  async fetchAvailableModels(): Promise<string[]> {
    return listBackendModels(this.settings);
  }

  /* ------------------------------------------------------------ summaries */

  private runLocalSummary(editor: Editor, view: MarkdownView): void {
    const markdown = editor.getValue();
    if (!markdown.trim()) {
      new Notice('Elias HiveMind: note is empty.');
      return;
    }

    const summary = summariseLocally(markdown, this.settings.summarySentenceCount);
    if (!summary) {
      new Notice('Elias HiveMind: no summarisable text found.');
      return;
    }

    this.insertSummary(editor, summary);
    const name = view.file ? view.file.basename : 'note';
    new Notice(`Elias HiveMind: summarised "${name}" locally.`);
  }

  private async runBackendSummary(editor: Editor, view: MarkdownView): Promise<void> {
    const markdown = editor.getValue();
    if (!markdown.trim()) {
      new Notice('Elias HiveMind: note is empty.');
      return;
    }

    const pending = new Notice('Elias HiveMind: asking backend...', 0);
    let summary: string;
    try {
      summary = await summariseViaBackend(this.settings, markdown);
    } catch (error) {
      const message = describeError(error);
      console.error('Elias HiveMind backend error', error);

      const local = this.settings.fallbackToLocal
        ? summariseLocally(markdown, this.settings.summarySentenceCount)
        : '';
      if (local) {
        this.insertSummary(editor, local);
        new Notice(
          `Elias HiveMind: backend unavailable (${message}). Summarised locally instead.`,
          10000
        );
      } else {
        new Notice(`Elias HiveMind backend error: ${message}`, 10000);
      }
      return;
    } finally {
      pending.hide();
    }

    this.insertSummary(editor, summary);
    const name = view.file ? view.file.basename : 'note';
    new Notice(`Elias HiveMind: summarised "${name}" via backend.`);
  }

  private insertSummary(editor: Editor, summary: string): void {
    const heading = this.settings.summaryHeading.trim();
    const block = heading ? `${heading}\n${summary}\n` : `${summary}\n`;

    // Re-running Summarize on a note that already carries a summary under
    // the configured heading replaces that block where it sits - the same
    // replace-rather-than-duplicate rule the weekly digest applies to its
    // dated sections - instead of stacking a second summary section.
    if (heading) {
      const text = editor.getValue();
      const existing = findSummaryBlock(text, heading);
      if (existing) {
        const replacement = existing.end < text.length ? `${block}\n` : block;
        editor.replaceRange(
          replacement,
          offsetToPos(text, existing.start),
          offsetToPos(text, existing.end)
        );
        return;
      }
    }

    if (this.settings.insertMode === 'top') {
      editor.replaceRange(`${block}\n`, { line: 0, ch: 0 });
      return;
    }

    if (this.settings.insertMode === 'bottom') {
      const lastLine = editor.lastLine();
      const lastCh = editor.getLine(lastLine).length;
      editor.replaceRange(`\n\n${block}`, { line: lastLine, ch: lastCh });
      return;
    }

    editor.replaceRange(`\n${block}\n`, editor.getCursor());
  }

  /* ----------------------------------------------------------------- tags */

  private async runTagSuggestions(
    editor: Editor,
    view: MarkdownView,
    useBackend: boolean
  ): Promise<void> {
    const markdown = editor.getValue();
    if (!markdown.trim()) {
      new Notice('Elias HiveMind: note is empty.');
      return;
    }

    const existing = existingFrontmatterTags(markdown);
    let tags: string[];
    let source = 'locally';

    if (useBackend) {
      const pending = new Notice('Elias HiveMind: asking backend for tags...', 0);
      try {
        tags = await suggestTagsViaBackend(this.settings, markdown, existing);
        source = 'via backend';
      } catch (error) {
        const message = describeError(error);
        console.error('Elias HiveMind backend error', error);
        if (!this.settings.fallbackToLocal) {
          new Notice(`Elias HiveMind backend error: ${message}`, 10000);
          return;
        }
        new Notice(
          `Elias HiveMind: backend unavailable (${message}). Using local tags instead.`,
          10000
        );
        tags = suggestTagsLocally(markdown, this.settings.maxTags, existing);
      } finally {
        pending.hide();
      }
    } else {
      tags = suggestTagsLocally(markdown, this.settings.maxTags, existing);
    }

    if (tags.length === 0) {
      new Notice('Elias HiveMind: no new tags found.');
      return;
    }

    const name = view.file ? view.file.basename : 'note';
    new ChoiceModal(this.app, {
      title: 'Suggested tags',
      intro: `${tags.length} tag${tags.length === 1 ? '' : 's'} suggested ${source} for "${name}".`,
      confirmText: 'Add selected tags',
      items: tags,
      label: (tag) => `#${tag}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;
        this.applyTags(editor, chosen);
        new Notice(`Elias HiveMind: added ${chosen.length} tag${chosen.length === 1 ? '' : 's'}.`);
      },
    }).open();
  }

  /** Rewrites only the frontmatter range, so the body and undo history are untouched. */
  private applyTags(editor: Editor, tags: string[]): void {
    const { oldHead, newHead } = mergeTagsIntoFrontmatter(editor.getValue(), tags);
    const oldLines = oldHead.split('\n');
    const end = { line: oldLines.length - 1, ch: oldLines[oldLines.length - 1].length };
    editor.replaceRange(newHead, { line: 0, ch: 0 }, end);
  }

  /* -------------------------------------------------------------- linking */

  private async runLinkSuggestions(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file ?? this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Elias HiveMind: no active note.');
      return;
    }

    const markdown = editor.getValue();
    const suggestions = findLinkSuggestions(this.app, file, markdown, this.settings);

    if (suggestions.length === 0) {
      new Notice('Elias HiveMind: no unlinked mentions found.');
      return;
    }

    new ChoiceModal(this.app, {
      title: 'Suggested links',
      intro: `${suggestions.length} note${
        suggestions.length === 1 ? '' : 's'
      } mentioned in this note but not yet linked.`,
      confirmText: 'Insert selected',
      items: suggestions,
      label: (s) => s.title,
      meta: (s) => `${s.occurrences}x${s.viaAlias ? ' (alias)' : ''}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;

        const lines = chosen.map((s) => `- ${wikilinkFor(s)}`).join('\n');
        const block = `\n\n## Suggested links\n${lines}\n`;

        const lastLine = editor.lastLine();
        const lastCh = editor.getLine(lastLine).length;
        editor.replaceRange(block, { line: lastLine, ch: lastCh });

        new Notice(
          `Elias HiveMind: inserted ${chosen.length} link${chosen.length === 1 ? '' : 's'}.`
        );
      },
    }).open();
  }

  /* -------------------------------------------------------------- digest */

  private async runWeeklyDigest(): Promise<void> {
    const now = new Date();
    const cutoff = now.getTime() - DIGEST_WINDOW_MS;
    // Same exclusions as link suggestion: the configuration folder plus
    // whatever the user listed, and the digest note itself - its mtime
    // changes on every run, so without the path check it would digest itself.
    const ignored = parseIgnoreFolders(
      `${this.app.vault.configDir}, ${this.settings.ignoreFolders}`
    );

    const week = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          file.path !== DIGEST_NOTE_PATH &&
          (file.stat.ctime >= cutoff || file.stat.mtime >= cutoff) &&
          !ignored.some((folder) => file.path.toLowerCase().startsWith(folder + '/'))
      )
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (week.length === 0) {
      new Notice('Elias HiveMind: no notes created or modified in the last 7 days. No digest written.');
      return;
    }

    const shown = week.slice(0, DIGEST_MAX_NOTES);
    const shownPaths = new Set(shown.map((file) => file.path));

    const pending = new Notice('Elias HiveMind: building weekly digest...', 0);
    try {
      const entries: DigestEntry[] = [];
      const combined: string[] = [];
      const existingTags: string[] = [];

      for (const file of shown) {
        const markdown = await this.app.vault.cachedRead(file);
        combined.push(markdown);
        existingTags.push(...existingFrontmatterTags(markdown));
        entries.push({
          basename: file.basename,
          path: file.path,
          summary: summariseLocally(markdown, this.settings.summarySentenceCount),
          // Mentions of notes outside this week's set are not the digest's
          // business; the finder is only reused to spot links within it.
          links: findLinkSuggestions(this.app, file, markdown, this.settings).filter(
            (suggestion) => shownPaths.has(suggestion.path)
          ),
        });
      }

      const date = formatDigestDate(now);
      const section = buildDigestSection(
        date,
        formatDigestDate(new Date(cutoff)),
        entries,
        suggestTagsLocally(combined.join('\n\n'), this.settings.maxTags, existingTags),
        week.length - shown.length
      );

      // The dated section also carries the standing backlog section. The
      // section replacement below wipes any earlier backlog block for
      // today, so the fresh scan is upserted into the result before the
      // single write. A backlog failure must not cost the weekly digest
      // itself, so it is guarded separately.
      let backlogBlock: string | null = null;
      try {
        backlogBlock = buildBacklogBlock(await this.collectBacklog(now));
      } catch (backlogError) {
        console.error('Elias HiveMind backlog section error', backlogError);
      }
      const withBacklog = (text: string): string =>
        backlogBlock ? upsertBacklogBlock(text, backlogBlock, date) : text;

      const existing = this.app.vault.getAbstractFileByPath(DIGEST_NOTE_PATH);
      if (existing) {
        const current = await this.app.vault.read(existing as TFile);
        await this.app.vault.modify(
          existing as TFile,
          withBacklog(upsertDigestSection(current, section, date))
        );
      } else {
        await this.app.vault.create(
          DIGEST_NOTE_PATH,
          withBacklog(upsertDigestSection('', section, date))
        );
      }

      new Notice(
        `Elias HiveMind: weekly digest updated in "${DIGEST_NOTE_PATH}" — ${week.length} note${week.length === 1 ? '' : 's'} from the last 7 days.`
      );
    } catch (error) {
      console.error('Elias HiveMind weekly digest error', error);
      new Notice(`Elias HiveMind: weekly digest failed. ${describeError(error)}`, 10000);
    } finally {
      pending.hide();
    }
  }

  /* -------------------------------------------------------------- backlog */

  /**
   * Scans the configured backlog folders and classifies every unread
   * clipping found. Bounded by design: at most BACKLOG_MAX_ITEMS unread
   * items are read and processed per run (the rest are counted), and the
   * recent-notes corpus behind the relevance score is capped the same way
   * the weekly digest caps its week.
   */
  private async collectBacklog(now: Date): Promise<BacklogScan> {
    const settings = this.settings;
    const folders = parseBacklogFolders(settings.backlogFolders);
    const tagSet = new Set(parseBacklogTags(settings.backlogTags));
    const scan: BacklogScan = {
      items: [],
      omitted: 0,
      readCount: 0,
      foldersLabel: backlogFolderLabel(settings.backlogFolders),
      themes: '',
    };
    if (tagSet.size > 0) {
      scan.foldersLabel += `, or tagged ${Array.from(tagSet)
        .map((t) => `#${t}`)
        .join(', ')}`;
    }
    if (folders.length === 0 && tagSet.size === 0) return scan;

    // The same exclusions as everywhere else - configuration folder and the
    // user's ignored folders - plus the archive folder: archived clippings
    // have been processed, wherever the archive lives.
    const ignored = parseIgnoreFolders(`${this.app.vault.configDir}, ${settings.ignoreFolders}`);
    const archive = settings.backlogArchiveFolder
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    const isExcluded = (file: TFile): boolean => {
      const lower = file.path.toLowerCase();
      return (
        file.path === DIGEST_NOTE_PATH ||
        ignored.some((folder) => lower.startsWith(folder + '/')) ||
        (archive !== '' && (lower === archive || lower.startsWith(archive + '/')))
      );
    };

    const all = this.app.vault.getMarkdownFiles();
    const candidates = all
      .filter(
        (file) =>
          !isExcluded(file) &&
          (fileInAnyFolder(file.path, folders) ||
            (tagSet.size > 0 && fileTags(this.app, file).some((t) => tagSet.has(t))))
      )
      .sort((a, b) => b.stat.ctime - a.stat.ctime);
    const candidatePaths = new Set(candidates.map((f) => f.path));

    // The user's current work: notes touched inside the digest window that
    // are not themselves backlog candidates. Its vocabulary and the notes
    // it links to are what a clipping can be relevant *to*.
    const cutoff = now.getTime() - DIGEST_WINDOW_MS;
    const recent = all
      .filter(
        (file) =>
          !isExcluded(file) &&
          !candidatePaths.has(file.path) &&
          (file.stat.ctime >= cutoff || file.stat.mtime >= cutoff)
      )
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, DIGEST_MAX_NOTES);
    const recentPaths = new Set(recent.map((f) => f.path));

    // The recent notes' working vocabulary: significant words they use at
    // least twice between them.
    const corpusFreq = new Map<string, number>();
    for (const file of recent) {
      for (const word of tokenize(toPlainText(await this.app.vault.cachedRead(file)))) {
        if (word.length < 4 || STOPWORDS.has(word)) continue;
        corpusFreq.set(word, (corpusFreq.get(word) ?? 0) + 1);
      }
    }
    const corpus = new Set(
      Array.from(corpusFreq.keys()).filter((word) => (corpusFreq.get(word) ?? 0) >= 2)
    );

    const seenWordSets: Array<{ basename: string; words: Set<string> }> = [];

    for (const file of candidates) {
      // Read clippings are skipped from the metadata cache where possible,
      // so a large already-processed pile costs no file reads at all.
      const cache = this.app.metadataCache.getFileCache(file);
      const cached = cache?.frontmatter ? cache.frontmatter[BACKLOG_READ_KEY] : undefined;
      if (cached === true || cached === 'true') {
        scan.readCount += 1;
        continue;
      }

      if (scan.items.length >= BACKLOG_MAX_ITEMS) {
        scan.omitted += 1;
        continue;
      }

      const markdown = await this.app.vault.cachedRead(file);
      if (isMarkedRead(markdown)) {
        scan.readCount += 1;
        continue;
      }

      const plain = toPlainText(markdown);
      const wordCount = countWords(plain);
      const words = significantWordSet(plain);

      let duplicateOf: string | null = null;
      if (words.size >= 8) {
        for (const seen of seenWordSets) {
          if (
            seen.words.size >= 8 &&
            jaccardSimilarity(words, seen.words) >= BACKLOG_DUPLICATE_JACCARD
          ) {
            duplicateOf = seen.basename;
            break;
          }
        }
      }
      seenWordSets.push({ basename: file.basename, words });

      // Relevance from the plugin's own machinery: unlinked mentions of
      // notes in the recent set (the link suggester, filtered to that set)
      // plus vocabulary shared with those notes.
      const mentions = findLinkSuggestions(this.app, file, markdown, settings).filter(
        (suggestion) => recentPaths.has(suggestion.path)
      );
      const mentionCount = Math.min(
        5,
        mentions.reduce((n, s) => n + s.occurrences, 0)
      );
      let overlap = 0;
      words.forEach((word) => {
        if (corpus.has(word)) overlap += 1;
      });
      overlap = Math.min(overlap, 10);
      const relevance = mentionCount * 2 + overlap;

      const relevanceReasons: string[] = [];
      if (mentions.length > 0) {
        const top = mentions[0];
        relevanceReasons.push(
          mentions.length > 1
            ? `Mentions ${wikilinkFor(top)} and ${mentions.length - 1} more of this week's notes without linking them.`
            : `Mentions ${wikilinkFor(top)} without linking it.`
        );
      }
      if (overlap > 0) {
        relevanceReasons.push(
          `Shares ${overlap} significant word${overlap === 1 ? '' : 's'} with your recent notes.`
        );
      }

      const created = file.stat.ctime > 0 ? file.stat.ctime : file.stat.mtime;
      const ageDays = Math.max(0, Math.floor((now.getTime() - created) / BACKLOG_DAY_MS));
      const { bucket, reasons } = classifyBacklogItem({
        wordCount,
        uniqueWords: words.size,
        ageDays,
        staleDays: settings.backlogStaleDays,
        relevance,
        relevanceReasons,
        duplicateOf,
        neverModified: file.stat.mtime - created < BACKLOG_DAY_MS,
      });

      scan.items.push({
        basename: file.basename,
        path: file.path,
        summary: summariseLocally(markdown, Math.min(3, settings.summarySentenceCount)),
        tags: suggestTagsLocally(markdown, settings.maxTags, existingFrontmatterTags(markdown)),
        readMinutes: estimateReadMinutes(wordCount),
        ageDays,
        wordCount,
        relevance,
        bucket,
        reasons,
        belongsTo: mentions.length > 0 ? mentions[0] : null,
      });
    }

    scan.items.sort(compareBacklogItems);

    // Optional, opt-in: a backend pass that groups the pile into themes.
    // Best-effort only - any failure leaves the fully local digest standing,
    // and with the toggle off (the default) no request is made at all.
    if (settings.backlogThemesViaBackend && scan.items.length >= 2) {
      try {
        const list = scan.items
          .map((item) => `- ${item.basename}: ${item.summary ? item.summary : '(no summary)'}`)
          .join('\n');
        const prompt =
          'The following are summaries of articles saved to read later. Group them into ' +
          'a few themes. Return only markdown bullet lines of the form ' +
          '"- Theme: the article titles that belong to it", with no preamble.\n\n' +
          list;
        scan.themes = (await generateViaBackend(settings, prompt)).trim();
      } catch (error) {
        console.error('Elias HiveMind backlog themes error', error);
        scan.themes = '';
      }
    }

    return scan;
  }

  /** Standalone run: refreshes the backlog block in the digest note. */
  private async runBacklogDigest(): Promise<void> {
    const now = new Date();
    const pending = new Notice('Elias HiveMind: digesting your backlog...', 0);
    try {
      const scan = await this.collectBacklog(now);

      if (scan.items.length === 0 && scan.omitted === 0) {
        new Notice(
          scan.readCount > 0
            ? `Elias HiveMind: backlog clear — ${scan.readCount} clipping${scan.readCount === 1 ? '' : 's'} already marked read in ${scan.foldersLabel}. Nothing written.`
            : `Elias HiveMind: no unread clippings in ${scan.foldersLabel}. Nothing written.`
        );
        return;
      }

      const date = formatDigestDate(now);
      const block = buildBacklogBlock(scan);
      const existing = this.app.vault.getAbstractFileByPath(DIGEST_NOTE_PATH);
      if (existing) {
        const current = await this.app.vault.read(existing as TFile);
        await this.app.vault.modify(existing as TFile, upsertBacklogBlock(current, block, date));
      } else {
        await this.app.vault.create(DIGEST_NOTE_PATH, upsertBacklogBlock('', block, date));
      }

      new Notice(
        `Elias HiveMind: backlog digest updated in "${DIGEST_NOTE_PATH}" — ${scan.items.length} unread clipping${scan.items.length === 1 ? '' : 's'}.`
      );
    } catch (error) {
      console.error('Elias HiveMind backlog digest error', error);
      new Notice(`Elias HiveMind: backlog digest failed. ${describeError(error)}`, 10000);
    } finally {
      pending.hide();
    }
  }

  /**
   * The note the Backlog processing commands act on: the active file, when
   * it sits in a backlog folder. Anything else gets an explanation instead
   * of an action - these commands never touch notes outside the backlog.
   */
  private backlogActiveFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Elias HiveMind: no active note.');
      return null;
    }
    const inFolder = fileInAnyFolder(
      file.path,
      parseBacklogFolders(this.settings.backlogFolders)
    );
    const tagSet = new Set(parseBacklogTags(this.settings.backlogTags));
    const tagged = tagSet.size > 0 && fileTags(this.app, file).some((t) => tagSet.has(t));
    if (!inFolder && !tagged) {
      new Notice(
        `Elias HiveMind: "${file.basename}" is not in the backlog (${backlogFolderLabel(this.settings.backlogFolders)}).`
      );
      return null;
    }
    return file;
  }

  /** Applies the local tag suggestions to the open clipping, via the usual checklist. */
  private async runBacklogApplyTags(): Promise<void> {
    const file = this.backlogActiveFile();
    if (!file) return;

    const markdown = await this.app.vault.read(file);
    const tags = suggestTagsLocally(
      markdown,
      this.settings.maxTags,
      existingFrontmatterTags(markdown)
    );
    if (tags.length === 0) {
      new Notice('Elias HiveMind: no new tags found for this clipping.');
      return;
    }

    new ChoiceModal(this.app, {
      title: 'Suggested tags',
      intro: `${tags.length} tag${tags.length === 1 ? '' : 's'} suggested locally for "${file.basename}".`,
      confirmText: 'Add selected tags',
      items: tags,
      label: (tag) => `#${tag}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;
        void (async () => {
          try {
            // Re-read at apply time: the note may have changed since the
            // checklist opened. Only the frontmatter head is spliced.
            const current = await this.app.vault.read(file);
            const { oldHead, newHead } = mergeTagsIntoFrontmatter(current, chosen);
            await this.app.vault.modify(file, newHead + current.slice(oldHead.length));
            new Notice(
              `Elias HiveMind: added ${chosen.length} tag${chosen.length === 1 ? '' : 's'}.`
            );
          } catch (error) {
            console.error('Elias HiveMind backlog tag error', error);
            new Notice(`Elias HiveMind: adding tags failed. ${describeError(error)}`, 10000);
          }
        })();
      },
    }).open();
  }

  /** Writes the read marker into the open clipping's frontmatter. */
  private async runBacklogMarkRead(): Promise<void> {
    const file = this.backlogActiveFile();
    if (!file) return;

    const markdown = await this.app.vault.read(file);
    if (isMarkedRead(markdown)) {
      new Notice(`Elias HiveMind: "${file.basename}" is already marked read.`);
      return;
    }

    const { oldHead, newHead } = withFrontmatterValue(markdown, BACKLOG_READ_KEY, 'true');
    await this.app.vault.modify(file, newHead + markdown.slice(oldHead.length));
    new Notice(
      `Elias HiveMind: marked "${file.basename}" as read. It drops out of the backlog digest.`
    );
  }

  /**
   * Moves the open clipping into the archive folder. This is the plugin's
   * only move, it runs only from this explicit command, and it refuses -
   * rather than overwriting - when a note of the same name is archived
   * already. Nothing in the plugin deletes, here or anywhere else.
   */
  private async runBacklogArchive(): Promise<void> {
    const file = this.backlogActiveFile();
    if (!file) return;

    const folder = this.settings.backlogArchiveFolder.trim().replace(/^\/+|\/+$/g, '');
    if (!folder) {
      new Notice('Elias HiveMind: set an archive folder in settings first.');
      return;
    }
    if (file.path.toLowerCase().startsWith(folder.toLowerCase() + '/')) {
      new Notice(`Elias HiveMind: "${file.basename}" is already in ${folder}.`);
      return;
    }

    const target = `${folder}/${file.name}`;
    if (this.app.vault.getAbstractFileByPath(target)) {
      new Notice(`Elias HiveMind: "${target}" already exists — "${file.basename}" was not moved.`);
      return;
    }

    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      await this.app.vault.rename(file, target);
      new Notice(`Elias HiveMind: archived "${file.basename}" to ${folder}/.`);
    } catch (error) {
      console.error('Elias HiveMind backlog archive error', error);
      new Notice(`Elias HiveMind: archive failed. ${describeError(error)}`, 10000);
    }
  }

  /**
   * The digest's "link" action: the same unlinked-mention suggestions as
   * the editor command, appended to the open clipping under a
   * "## Suggested links" heading once the user confirms the checklist.
   */
  private async runBacklogLink(): Promise<void> {
    const file = this.backlogActiveFile();
    if (!file) return;

    const markdown = await this.app.vault.read(file);
    const suggestions = findLinkSuggestions(this.app, file, markdown, this.settings);
    if (suggestions.length === 0) {
      new Notice('Elias HiveMind: no unlinked mentions found in this clipping.');
      return;
    }

    new ChoiceModal(this.app, {
      title: 'Suggested links',
      intro: `${suggestions.length} note${
        suggestions.length === 1 ? '' : 's'
      } mentioned in this clipping but not yet linked.`,
      confirmText: 'Insert selected',
      items: suggestions,
      label: (s) => s.title,
      meta: (s) => `${s.occurrences}x${s.viaAlias ? ' (alias)' : ''}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;
        const lines = chosen.map((s) => `- ${wikilinkFor(s)}`).join('\n');
        const block = `\n\n## Suggested links\n${lines}\n`;
        void (async () => {
          const current = await this.app.vault.read(file);
          await this.app.vault.modify(file, current + block);
          new Notice(
            `Elias HiveMind: inserted ${chosen.length} link${chosen.length === 1 ? '' : 's'}.`
          );
        })();
      },
    }).open();
  }

  /* ------------------------------------------------------------ diagnostic */

  private async testBackend(): Promise<void> {
    const pending = new Notice('Elias HiveMind: testing backend...', 0);
    try {
      const summary = await summariseViaBackend(
        this.settings,
        'The quick brown fox jumps over the lazy dog. ' +
          'This sentence exists only to verify the backend connection works.'
      );
      pending.hide();
      new Notice(`Elias HiveMind: backend OK. Replied: ${summary.slice(0, 120)}`, 8000);
    } catch (error) {
      pending.hide();
      new Notice(`Elias HiveMind: backend FAILED. ${describeError(error)}`, 10000);
    }
  }
}

/* ========================================================================== */
/*                                settings tab                                */
/* ========================================================================== */

type ModelListState = 'idle' | 'loading' | 'loaded' | 'failed';

class EliasHiveMindSettingTab extends PluginSettingTab {
  private readonly plugin: EliasHiveMindPlugin;
  private visible = false;
  private modelState: ModelListState = 'idle';
  private models: string[] = [];
  private modelError = '';

  constructor(app: App, plugin: EliasHiveMindPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    this.visible = false;
    super.hide();
  }

  /** Fetches the installed model list, then re-renders if the tab is still open. */
  private loadModels(): void {
    this.modelState = 'loading';
    void this.plugin
      .fetchAvailableModels()
      .then(
        (models) => {
          this.models = models;
          this.modelError = '';
          this.modelState = 'loaded';
        },
        (error: unknown) => {
          this.models = [];
          this.modelError = describeError(error);
          this.modelState = 'failed';
        }
      )
      .then(() => {
        if (this.visible) this.refresh();
      });
  }

  /**
   * Re-renders the tab. On Obsidian 1.13.0+ the tab is built from
   * getSettingDefinitions(), so update() is the refresh path; on older
   * versions display() still owns the DOM.
   */
  private refresh(): void {
    if (typeof this.update === 'function') this.update();
    else this.display();
  }

  private renderModelSetting(containerEl: HTMLElement): void {
    this.configureModelSetting(new Setting(containerEl));
  }

  /** Applies the Model row's description, control and Refresh button. */
  private configureModelSetting(setting: Setting): void {
    setting.setName('Model');
    this.visible = true;
    if (this.modelState === 'idle') this.loadModels();
    const current = this.plugin.settings.backendModel;

    if (this.modelState === 'loaded' && this.models.length > 0) {
      setting
        .setDesc(
          `${this.models.length} model${this.models.length === 1 ? '' : 's'} installed on the backend.`
        )
        .addDropdown((dropdown) => {
          if (!current) dropdown.addOption('', 'Select a model');
          for (const name of this.models) dropdown.addOption(name, name);

          // Ollama resolves "llama3.2" to "llama3.2:latest", so treat them as one.
          const match = this.models.includes(current)
            ? current
            : this.models.find((m) => m === `${current}:latest`);
          if (current && !match) dropdown.addOption(current, `${current} (not installed)`);

          dropdown.setValue(match ?? current).onChange((value) => {
            this.plugin.settings.backendModel = value;
            void this.plugin.saveSettings();
          });
        });
    } else {
      const status =
        this.modelState === 'loading' || this.modelState === 'idle'
          ? 'Loading installed models...'
          : this.modelState === 'failed'
            ? `Could not list models (${this.modelError}). Type a model name instead.`
            : 'The backend reported no installed models. Type a model name instead.';

      setting.setDesc(status).addText((text) =>
        text
          .setPlaceholder('llama3.2')
          .setValue(current)
          .onChange((value) => {
            this.plugin.settings.backendModel = value.trim();
            void this.plugin.saveSettings();
          })
      );
    }

    setting.addButton((button) =>
      button.setButtonText('Refresh').onClick(() => {
        this.loadModels();
        this.refresh();
      })
    );
  }

  /**
   * Imperative fallback for Obsidian versions older than 1.13.0. On 1.13.0+
   * this is never called - getSettingDefinitions() below renders the tab and
   * feeds the settings search index.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.visible = true;

    new Setting(containerEl).setName('Summarization').setHeading();

    new Setting(containerEl)
      .setName('Summary length')
      .setDesc('How many sentences the local summariser keeps, and what the backend is asked for.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.summarySentenceCount)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.summarySentenceCount = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Summary heading')
      .setDesc('Markdown heading placed above an inserted summary. Leave blank for none.')
      .addText((text) =>
        text
          .setPlaceholder('## Summary')
          .setValue(this.plugin.settings.summaryHeading)
          .onChange((value) => {
            this.plugin.settings.summaryHeading = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Insert position')
      .setDesc('Where a generated summary is written into the note.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('top', 'Top of note')
          .addOption('bottom', 'Bottom of note')
          .addOption('cursor', 'At cursor')
          .setValue(this.plugin.settings.insertMode)
          .onChange((value) => {
            this.plugin.settings.insertMode = value as InsertMode;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Backend').setHeading();

    new Setting(containerEl)
      .setName('Backend URL')
      .setDesc(
        'Full endpoint URL. Defaults to a local Ollama server, so note content stays on this machine. ' +
          'Point this elsewhere only if you intend note text to leave the device.'
      )
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:11434/api/generate')
          .setValue(this.plugin.settings.backendUrl)
          .onChange((value) => {
            this.plugin.settings.backendUrl = value.trim();
            // Refetched on the next open or Refresh; re-rendering per keystroke would steal focus.
            this.modelState = 'idle';
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Request format')
      .setDesc('Ollama uses {model, prompt}. OpenAI-compatible uses {model, messages[]}.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('ollama', 'Ollama')
          .addOption('openai', 'OpenAI-compatible')
          .setValue(this.plugin.settings.backendFormat)
          .onChange((value) => {
            this.plugin.settings.backendFormat = value as BackendFormat;
            void this.plugin.saveSettings();
            this.loadModels();
            this.refresh();
          })
      );

    this.renderModelSetting(containerEl);

    new Setting(containerEl)
      .setName('Fall back to local')
      .setDesc(
        'If the backend is offline, times out or returns an error, use the local summariser and tagger instead of failing.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.fallbackToLocal).onChange((value) => {
          this.plugin.settings.fallbackToLocal = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Timeout (ms)')
      .setDesc('How long to wait before giving up on the backend.')
      .addText((text) =>
        text
          .setPlaceholder('60000')
          .setValue(String(this.plugin.settings.backendTimeoutMs))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.backendTimeoutMs =
              Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.backendTimeoutMs;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Tags').setHeading();

    new Setting(containerEl)
      .setName('Maximum tags')
      .setDesc('Upper bound on how many new tags are suggested at once.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 15, 1)
          .setValue(this.plugin.settings.maxTags)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.maxTags = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Link suggestion').setHeading();

    new Setting(containerEl)
      .setName('Maximum suggestions')
      .setDesc('Upper bound on how many unlinked mentions are offered at once.')
      .addSlider((slider) =>
        slider
          .setLimits(5, 100, 5)
          .setValue(this.plugin.settings.maxLinkSuggestions)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.maxLinkSuggestions = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Minimum title length')
      .setDesc('Ignore note titles shorter than this, which otherwise match noisily.')
      .addSlider((slider) =>
        slider
          .setLimits(2, 15, 1)
          .setValue(this.plugin.settings.minTitleLength)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.minTitleLength = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Ignore folders')
      .setDesc('Comma-separated folder paths excluded from link suggestions.')
      .addText((text) =>
        text
          .setPlaceholder(this.ignoreFoldersPlaceholder())
          .setValue(this.plugin.settings.ignoreFolders)
          .onChange((value) => {
            this.plugin.settings.ignoreFolders = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName('Backlog').setHeading();

    new Setting(containerEl)
      .setName('Backlog folders')
      .setDesc('Comma-separated folder paths the backlog digest scans - where saved clippings pile up.')
      .addText((text) =>
        text
          .setPlaceholder('Clippings, Inbox')
          .setValue(this.plugin.settings.backlogFolders)
          .onChange((value) => {
            this.plugin.settings.backlogFolders = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Backlog tags')
      .setDesc('Comma-separated tags - notes carrying any of these tags count as backlog too, wherever they live. Leave empty to scan folders only.')
      .addText((text) =>
        text
          .setPlaceholder('to-read')
          .setValue(this.plugin.settings.backlogTags)
          .onChange((value) => {
            this.plugin.settings.backlogTags = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Stale after (days)')
      .setDesc('A clipping untouched for this many days, with no overlap with your recent notes, is listed as gone stale.')
      .addSlider((slider) =>
        slider
          .setLimits(7, 180, 1)
          .setValue(this.plugin.settings.backlogStaleDays)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.backlogStaleDays = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Archive folder')
      .setDesc('Folder the "Backlog: archive current note" command moves a clipping into. Archiving never deletes anything.')
      .addText((text) =>
        text
          .setPlaceholder('Archive')
          .setValue(this.plugin.settings.backlogArchiveFolder)
          .onChange((value) => {
            this.plugin.settings.backlogArchiveFolder = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Backlog themes via backend')
      .setDesc('When on, a backlog digest also asks your configured backend to group the clippings into themes. Off by default; the digest itself always works fully offline.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.backlogThemesViaBackend).onChange((value) => {
          this.plugin.settings.backlogThemesViaBackend = value;
          void this.plugin.saveSettings();
        })
      );
  }

  /** The configuration folder is user-renameable, so the hint is built at runtime. */
  private ignoreFoldersPlaceholder(): string {
    return `${this.app.vault.configDir}, .trash, templates`;
  }

  /* ------------------------------------------------------------------------ */
  /*                    declarative settings (Obsidian 1.13.0+)               */
  /* ------------------------------------------------------------------------ */

  /** Reads a control's current value out of the plugin's own settings object. */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /** Persists a control's new value, preserving the coercions display() applies. */
  setControlValue(key: string, value: unknown): void {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;

    switch (key) {
      case 'backendUrl':
        settings[key] = String(value).trim();
        // Refetched on the next open or Refresh, not per keystroke.
        this.modelState = 'idle';
        break;

      case 'backendModel':
        settings[key] = String(value).trim();
        break;

      case 'backendTimeoutMs': {
        const parsed = Number.parseInt(String(value), 10);
        settings[key] =
          Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.backendTimeoutMs;
        break;
      }

      case 'backendFormat':
        settings[key] = value;
        void this.plugin.saveSettings();
        this.loadModels();
        this.refresh();
        return;

      default:
        settings[key] = value;
    }

    void this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: 'Summarization',
        items: [
          {
            name: 'Summary length',
            desc: 'How many sentences the local summariser keeps, and what the backend is asked for.',
            control: {
              type: 'slider',
              key: 'summarySentenceCount',
              min: 1,
              max: 10,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.summarySentenceCount,
            },
          },
          {
            name: 'Summary heading',
            desc: 'Markdown heading placed above an inserted summary. Leave blank for none.',
            control: {
              type: 'text',
              key: 'summaryHeading',
              placeholder: '## Summary',
              defaultValue: DEFAULT_SETTINGS.summaryHeading,
            },
          },
          {
            name: 'Insert position',
            desc: 'Where a generated summary is written into the note.',
            control: {
              type: 'dropdown',
              key: 'insertMode',
              options: {
                top: 'Top of note',
                bottom: 'Bottom of note',
                cursor: 'At cursor',
              },
              defaultValue: DEFAULT_SETTINGS.insertMode,
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Backend',
        items: [
          {
            name: 'Backend URL',
            desc:
              'Full endpoint URL. Defaults to a local Ollama server, so note content stays on this machine. ' +
              'Point this elsewhere only if you intend note text to leave the device.',
            control: {
              type: 'text',
              key: 'backendUrl',
              placeholder: DEFAULT_SETTINGS.backendUrl,
              defaultValue: DEFAULT_SETTINGS.backendUrl,
            },
          },
          {
            name: 'Request format',
            desc: 'Ollama uses {model, prompt}. OpenAI-compatible uses {model, messages[]}.',
            control: {
              type: 'dropdown',
              key: 'backendFormat',
              options: { ollama: 'Ollama', openai: 'OpenAI-compatible' },
              defaultValue: DEFAULT_SETTINGS.backendFormat,
            },
          },
          {
            // The model row switches between a dropdown and a text field as the
            // installed-model list loads, so it stays imperative.
            name: 'Model',
            aliases: ['ollama', 'llama'],
            render: (setting) => {
              this.configureModelSetting(setting);
            },
          },
          {
            name: 'Fall back to local',
            desc: 'If the backend is offline, times out or returns an error, use the local summariser and tagger instead of failing.',
            control: {
              type: 'toggle',
              key: 'fallbackToLocal',
              defaultValue: DEFAULT_SETTINGS.fallbackToLocal,
            },
          },
          {
            name: 'Timeout (ms)',
            desc: 'How long to wait before giving up on the backend.',
            control: {
              type: 'number',
              key: 'backendTimeoutMs',
              placeholder: String(DEFAULT_SETTINGS.backendTimeoutMs),
              min: 1,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.backendTimeoutMs,
              validate: (value) =>
                Number.isFinite(value) && value > 0
                  ? undefined
                  : 'Enter a positive whole number of milliseconds.',
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Tags',
        items: [
          {
            name: 'Maximum tags',
            desc: 'Upper bound on how many new tags are suggested at once.',
            control: {
              type: 'slider',
              key: 'maxTags',
              min: 1,
              max: 15,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.maxTags,
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Link suggestion',
        items: [
          {
            name: 'Maximum suggestions',
            desc: 'Upper bound on how many unlinked mentions are offered at once.',
            control: {
              type: 'slider',
              key: 'maxLinkSuggestions',
              min: 5,
              max: 100,
              step: 5,
              defaultValue: DEFAULT_SETTINGS.maxLinkSuggestions,
            },
          },
          {
            name: 'Minimum title length',
            desc: 'Ignore note titles shorter than this, which otherwise match noisily.',
            control: {
              type: 'slider',
              key: 'minTitleLength',
              min: 2,
              max: 15,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.minTitleLength,
            },
          },
          {
            name: 'Ignore folders',
            desc: 'Comma-separated folder paths excluded from link suggestions. The vault configuration folder is always excluded.',
            control: {
              type: 'text',
              key: 'ignoreFolders',
              placeholder: this.ignoreFoldersPlaceholder(),
              defaultValue: DEFAULT_SETTINGS.ignoreFolders,
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Backlog',
        items: [
          {
            name: 'Backlog folders',
            desc: 'Comma-separated folder paths the backlog digest scans - where saved clippings pile up.',
            control: {
              type: 'text',
              key: 'backlogFolders',
              placeholder: 'Clippings, Inbox',
              defaultValue: DEFAULT_SETTINGS.backlogFolders,
            },
          },
          {
            name: 'Backlog tags',
            desc: 'Comma-separated tags - notes carrying any of these tags count as backlog too, wherever they live. Leave empty to scan folders only.',
            control: {
              type: 'text',
              key: 'backlogTags',
              placeholder: 'to-read',
              defaultValue: DEFAULT_SETTINGS.backlogTags,
            },
          },
          {
            name: 'Stale after (days)',
            desc: 'A clipping untouched for this many days, with no overlap with your recent notes, is listed as gone stale.',
            control: {
              type: 'slider',
              key: 'backlogStaleDays',
              min: 7,
              max: 180,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.backlogStaleDays,
            },
          },
          {
            name: 'Archive folder',
            desc: 'Folder the "Backlog: archive current note" command moves a clipping into. Archiving never deletes anything.',
            control: {
              type: 'text',
              key: 'backlogArchiveFolder',
              placeholder: 'Archive',
              defaultValue: DEFAULT_SETTINGS.backlogArchiveFolder,
            },
          },
          {
            name: 'Backlog themes via backend',
            desc: 'When on, a backlog digest also asks your configured backend to group the clippings into themes. Off by default; the digest itself always works fully offline.',
            control: {
              type: 'toggle',
              key: 'backlogThemesViaBackend',
              defaultValue: DEFAULT_SETTINGS.backlogThemesViaBackend,
            },
          },
        ],
      },
    ];
  }
}

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
 *       fallback. Chosen tags are merged into the note's frontmatter. The
 *       local tagger is vault-aware: it reads the vault's existing tag
 *       vocabulary from the metadata cache and prefers those tags - in the
 *       form the vault already uses - over words it would otherwise invent.
 *
 *   Housekeeping sweep
 *     - the tagger run over a whole folder (or the vault) at once. A dry
 *       run is presented for review first; nothing is written until the
 *       user approves notes in the review, and approving writes frontmatter
 *       tag merges only.
 *
 *   Link suggestion
 *     - scans the vault for notes whose title or alias is mentioned in the
 *       current note but not yet linked, and offers to wrap those mentions
 *       in wikilinks in place. Matching is case-insensitive, handles simple
 *       plurals, and tolerates hyphen/space and minor punctuation variation
 *       in multi-word titles - all deterministic local text processing.
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
 *   Resurface
 *     - local only: finds notes that were read or written and then went
 *       cold - untouched past a threshold the user sets - and ranks them by
 *       how connected and relevant they still are (backlinks from the
 *       metadata cache, tags and vocabulary shared with the last 30 days of
 *       notes). A command shows the top few in a review modal; the weekly
 *       digest can carry the top three. Snoozing or dismissing a note
 *       writes only plugin-internal state, never a note file.
 *
 *   Related notes & semantic lookup
 *     - semantic, via the user's OWN local server only: an embedding index
 *       of the vault is built by the configured local backend (Ollama
 *       /api/embed, or an OpenAI-compatible /v1/embeddings), stored in the
 *       plugin's own data, and kept fresh by content hash. "Related notes"
 *       ranks the vault against the current note by cosine similarity;
 *       "Semantic lookup" does the same for a typed phrase. No cloud
 *       endpoint, no API key, no telemetry - and no local approximation
 *       pretending to be semantic: with no local server running, these
 *       commands say so and stop.
 *
 *   Non-English notes
 *     - the local engine is Unicode-aware: tokenization keeps accented
 *       and non-Latin words whole, stopword lists cover English, Spanish,
 *       French, German, Portuguese and Italian (applied as one union -
 *       see the STOPWORDS comment), tag normalisation preserves Unicode
 *       letters, and CJK text is tokenised as overlapping bigrams (no
 *       dictionary segmentation - see cjkTokens). All still fully local
 *       and deterministic.
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
  /**
   * Internal state, not a user setting (no settings-tab control): the
   * unread-clipping count and date of the most recent backlog scan, kept
   * so the next digest can say how the pile moved. -1 / '' means no scan
   * has run yet. Persisted with the settings because loadData/saveData is
   * the plugin's one storage slot.
   */
  backlogLastUnread: number;
  backlogLastRunDate: string;
  /** Days a note must go untouched before Resurface counts it as cold. */
  resurfaceColdDays: number;
  /** How many forgotten notes the Resurface command shows at once. */
  resurfaceQueueSize: number;
  /** Whether the weekly digest carries a "Worth another look" section. */
  resurfaceInDigest: boolean;
  /**
   * Internal state, not user settings (no settings-tab controls), following
   * the backlogLastUnread precedent: per-path snooze records written by the
   * Resurface modal. `until` is an ISO timestamp; `count` is how many times
   * the note has been snoozed, which drives the doubling interval.
   */
  resurfaceSnoozes: Record<string, ResurfaceSnooze>;
  /** Internal state: paths the user chose to never resurface again. */
  resurfaceNeverShow: string[];
  /** Model the user's local server uses for embeddings. */
  embeddingModel: string;
  /** How many notes Related notes / Semantic lookup show at once. */
  relatedNotesCount: number;
  /**
   * Internal state, not user settings (no settings-tab controls), following
   * the resurfaceSnoozes precedent: the semantic index, one entry per note
   * path - the content hash of the exact text that was embedded (so a
   * changed note is re-embedded and an unchanged one is not) and the
   * vector the user's own local server returned for it. Vectors are
   * computed on the user's machine and stored only here, in the plugin's
   * own data; nothing about them is transmitted anywhere.
   */
  embeddingIndex: Record<string, EmbeddingIndexEntry>;
  /** The embedding model the stored index was built with ('' = no index). */
  embeddingIndexModel: string;
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
  backlogLastUnread: -1,
  backlogLastRunDate: '',
  resurfaceColdDays: 90,
  resurfaceQueueSize: 5,
  resurfaceInDigest: true,
  resurfaceSnoozes: {},
  resurfaceNeverShow: [],
  embeddingModel: 'nomic-embed-text',
  relatedNotesCount: 5,
  embeddingIndex: {},
  embeddingIndexModel: '',
};

/* ========================================================================== */
/*                             backend presets                                */
/* ========================================================================== */

/**
 * One-click backend presets. Every preset is a server the user runs on
 * their own machine - local only, no cloud endpoint, no API key, no
 * telemetry. Applying a preset only fills in `backendUrl` and
 * `backendFormat`; it makes no network call.
 *
 * URL convention (matches how the values are consumed): `backendUrl` is
 * the full generation endpoint, not a server root. `generateViaBackend`
 * POSTs to it verbatim, and `modelListUrl` derives the model list from
 * it - `/api/tags` at the origin for Ollama, `<prefix>/v1/models` for
 * OpenAI-compatible servers - so each preset URL below already carries
 * the path its server expects.
 */
interface BackendPreset {
  id: string;
  name: string;
  backendUrl: string;
  backendFormat: BackendFormat;
}

const BACKEND_PRESETS: readonly BackendPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    backendUrl: 'http://127.0.0.1:11434/api/generate',
    backendFormat: 'ollama',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    backendUrl: 'http://127.0.0.1:1234/v1/chat/completions',
    backendFormat: 'openai',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    backendUrl: 'http://127.0.0.1:8080/v1/chat/completions',
    backendFormat: 'openai',
  },
  {
    id: 'jan',
    name: 'Jan',
    backendUrl: 'http://127.0.0.1:1337/v1/chat/completions',
    backendFormat: 'openai',
  },
];

/** Looks a preset up by id; returns undefined for an unknown id. */
function findBackendPreset(id: string): BackendPreset | undefined {
  return BACKEND_PRESETS.find((preset) => preset.id === id);
}

/**
 * Fills `backendUrl` + `backendFormat` from a preset - and nothing else.
 * Returns false (and changes nothing) for an unknown preset id.
 */
function applyBackendPreset(settings: EliasHiveMindSettings, presetId: string): boolean {
  const preset = findBackendPreset(presetId);
  if (!preset) return false;
  settings.backendUrl = preset.backendUrl;
  settings.backendFormat = preset.backendFormat;
  return true;
}

/** The id of the preset the current URL + format exactly match, or ''. */
function backendPresetIdFor(settings: EliasHiveMindSettings): string {
  const match = BACKEND_PRESETS.find(
    (preset) =>
      preset.backendUrl === settings.backendUrl && preset.backendFormat === settings.backendFormat
  );
  return match ? match.id : '';
}

/** Restores both prompt templates to their DEFAULT_SETTINGS values - and nothing else. */
function resetPromptsToDefaults(settings: EliasHiveMindSettings): void {
  settings.backendPrompt = DEFAULT_SETTINGS.backendPrompt;
  settings.tagPrompt = DEFAULT_SETTINGS.tagPrompt;
}

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

/*
 * Stopwords: the union of modest, high-confidence lists for English and
 * the major space-separated languages the local engine tokenises
 * (Spanish, French, German, Portuguese, Italian). Filtering applies the
 * UNION: a word that is a stopword in any supported language is filtered
 * everywhere. That is a deliberate trade-off - it needs no language
 * detection (neither deterministic nor reliable on short notes), at the
 * cost of occasionally filtering a content word that is a function word
 * in another language (German "die", Italian "come" are the stock
 * examples). Lists are kept deliberately short: function words only,
 * never words that carry topic meaning in their own language.
 */
const STOPWORDS = new Set(
  (
    // English
    'a about above after again against all am an and any are as at be because been before being below ' +
    'between both but by can cannot could did do does doing down during each few for from further had ' +
    'has have having he her here hers herself him himself his how i if in into is it its itself just me ' +
    'more most my myself no nor not of off on once only or other ought our ours ourselves out over own ' +
    'same she should so some such than that the their theirs them themselves then there these they this ' +
    'those through to too under until up very was we were what when where which while who whom why will ' +
    'with would you your yours yourself yourselves ' +
    // Spanish
    'el la los las un una unos unas de del al en con por para sin sobre entre hasta desde donde cuando ' +
    'como pero más muy ya no sí si se su sus lo le les me te nos también porque pues así tan solo hay durante ser ' +
    'es son está están fue fueron era eran este esta estos estas ese esa eso ello ' +
    // French
    'le la les un une des de du au aux en et ou mais que qui quoi dont où dans sur sous chez vers entre ' +
    'par pour avec sans ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ' +
    'je tu il elle nous vous ils elles on ne pas plus moins très trop peu beaucoup aussi comme quand si ' +
    'car parce donc alors même déjà encore toujours jamais souvent être est sont suis sommes êtes ont ' +
    'ai as avons avez été avoir tout tous toute toutes autre autres y lui eux moi toi ceci cela ' +
    // German
    'der die das den dem des ein eine einen einem einer eines und oder aber denn wenn als wie wo was wer ' +
    'ist sind war waren sein haben hat hatte wird werden wurde nicht auch nur noch schon sehr mehr vom ' +
    'von zu zum zur im am ans ins für mit nach bei aus über unter zwischen durch gegen ohne um an auf es ' +
    'er sie wir ihr man sich mich dich uns euch mein meine dein seine ihre unser dieser diese diesem ' +
    'diesen jede jedem jeden alle ' +
    // Portuguese
    'o a os as um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas e ou mas que ' +
    'se como quando onde quem com sem para sobre entre até desde já não sim também muito mais menos ser ' +
    'é são era eram foi foram estar está estão ter tem têm ao aos à às seu sua seus suas meu minha meus ' +
    'minhas este esta estes estas esse essa isso aquele aquela aquilo eu tu ele ela nós eles elas lhe ' +
    // Italian
    'il lo la i gli le un uno una di del dello della dei degli delle a da in con su per tra fra e o ma ' +
    'che chi cui non si come quando dove anche più molto poco tanto già ancora sempre mai così questo ' +
    'questa questi queste quello quella quelli quelle mio mia miei mie tuo tua suoi sue nostro nostra ' +
    'vostro loro io tu lui lei noi voi essere è sono era erano fu furono avere ha hanno aveva stare sta ' +
    'stanno'
  ).split(' ')
);

/**
 * True for characters in the CJK script blocks this plugin treats as
 * unsegmented text: Han, Hiragana, Katakana and Hangul. Checked by code
 * point directly, so the behaviour does not depend on regex
 * script-property support in the host WebView.
 */
function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // Han, extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // Han
    (cp >= 0xf900 && cp <= 0xfaff) || // Han compatibility ideographs
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0x31f0 && cp <= 0x31ff) || // Katakana phonetic extensions
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul compatibility jamo
    (cp >= 0xac00 && cp <= 0xd7af) // Hangul syllables
  );
}

/** True when `word` is non-empty and every character of it is a CJK character. */
function isCjkToken(word: string): boolean {
  if (!word) return false;
  for (const ch of word) {
    if (!isCjkChar(ch)) return false;
  }
  return true;
}

/**
 * Splits one maximal CJK run into tokens. There is deliberately NO
 * dictionary segmentation - the plugin ships no dictionary and inventing
 * one would break the deterministic, fully-local rule. The documented,
 * deterministic rule instead: a run of one character is that character, a
 * run of two is the pair, and a longer run becomes its overlapping
 * bigrams (characters 1-2, 2-3, 3-4, ...). Bigrams are the standard
 * dictionary-free unit for CJK retrieval: real words inside the run
 * appear as bigrams, at the cost of some cross-word bigrams too.
 */
function cjkTokens(run: string): string[] {
  const chars = Array.from(run);
  if (chars.length <= 2) return [run];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Unicode-aware tokenizer: a token run is a sequence of Unicode letters
 * or numbers (with internal apostrophes/hyphens, as before), so accented
 * Latin, Cyrillic, Greek and every other script stay whole instead of
 * splitting at the first non-ASCII character. A run is then split into
 * maximal CJK / non-CJK segments; non-CJK segments are whole-word tokens
 * and CJK segments go through the bigram rule in cjkTokens().
 */
function tokenize(text: string): string[] {
  const runs = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu);
  if (!runs) return [];
  const tokens: string[] = [];
  for (const run of runs) {
    let segment = '';
    let segmentIsCjk: boolean | null = null;
    const flush = (): void => {
      if (!segment) return;
      if (segmentIsCjk) tokens.push(...cjkTokens(segment));
      else tokens.push(segment);
      segment = '';
    };
    for (const ch of run) {
      const cjk = isCjkChar(ch);
      if (segmentIsCjk === null || cjk === segmentIsCjk) {
        segment += ch;
        segmentIsCjk = cjk;
      } else {
        flush();
        segment = ch;
        segmentIsCjk = cjk;
      }
    }
    flush();
  }
  return tokens;
}

/**
 * The shared "is this token content?" test behind the summariser, the
 * tagger and the corpus-overlap code: not a stopword (in any supported
 * language), and either at least `minLength` characters or a CJK bigram.
 * A bigram is a complete token unit under the CJK rule above despite
 * being two characters, so the ASCII-era length floors do not silently
 * exclude CJK text a second time.
 */
function isContentWord(word: string, minLength: number): boolean {
  if (STOPWORDS.has(word)) return false;
  if (word.length >= minLength) return true;
  return word.length === 2 && isCjkToken(word);
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
    if (!isContentWord(word, 3)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  let maxFreq = 0;
  freq.forEach((v) => {
    if (v > maxFreq) maxFreq = v;
  });
  if (maxFreq === 0) return sentences.slice(0, sentenceCount).join(' ');

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence).filter((w) => isContentWord(w, 3));
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
/*                                embeddings                                  */
/* ========================================================================== */

/**
 * Local embeddings - the semantic layer. Vectors are computed ONLY by the
 * server the user runs on their own machine (the same backend settings as
 * generation: Ollama's /api/embed, or an OpenAI-compatible /v1/embeddings
 * on LM Studio / llama.cpp / Jan), and the index lives in the plugin's own
 * stored data. Nothing is sent anywhere else, ever. With no local server
 * running these functions throw, the commands say so, and nothing falls
 * back to a local approximation pretending to be semantic.
 */

/** One indexed note: the hash of the embedded text, and its vector. */
interface EmbeddingIndexEntry {
  hash: string;
  vector: number[];
}

/** Characters of a note's plain text sent to the embedding model. */
const EMBEDDING_TEXT_MAX_CHARS = 4000;

/** Notes embedded per request - bounded so a single request stays small. */
const EMBEDDING_BATCH_SIZE = 16;

/**
 * Derives the embeddings endpoint from the generation URL, the same way
 * modelListUrl derives the model list: Ollama serves /api/embed at the
 * server root, OpenAI-compatible servers serve <prefix>/v1/embeddings.
 */
function embeddingUrl(settings: EliasHiveMindSettings): string {
  let url: URL;
  try {
    url = new URL(settings.backendUrl);
  } catch {
    throw new Error(`Backend URL is not a valid URL: "${settings.backendUrl}".`);
  }

  if (settings.backendFormat === 'openai') {
    const idx = url.pathname.indexOf('/v1/');
    const prefix = idx === -1 ? '/v1' : url.pathname.slice(0, idx + 3);
    return `${url.origin}${prefix}/embeddings`;
  }
  return `${url.origin}/api/embed`;
}

/** A value is a usable vector when it is a non-empty array of finite numbers. */
function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector: number[] = [];
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return null;
    vector.push(component);
  }
  return vector;
}

/**
 * Pulls embedding vectors out of the response shapes local servers use:
 * Ollama /api/embed answers { embeddings: [[...], ...] }, Ollama's legacy
 * /api/embeddings answers a single { embedding: [...] }, and
 * OpenAI-compatible servers answer { data: [{ embedding: [...], index }] }
 * (sorted by index, as the spec allows them to arrive out of order).
 * Malformed entries are dropped; an unusable payload yields [].
 */
function extractEmbeddingVectors(payload: unknown): number[][] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.embeddings)) {
    const vectors: number[][] = [];
    for (const entry of obj.embeddings) {
      const vector = asVector(entry);
      if (vector) vectors.push(vector);
    }
    return vectors;
  }

  const single = asVector(obj.embedding);
  if (single) return [single];

  if (Array.isArray(obj.data)) {
    const rows: Array<{ index: number; vector: number[] }> = [];
    obj.data.forEach((entry, position) => {
      if (!entry || typeof entry !== 'object') return;
      const row = entry as Record<string, unknown>;
      const vector = asVector(row.embedding);
      if (!vector) return;
      rows.push({
        index: typeof row.index === 'number' ? row.index : position,
        vector,
      });
    });
    rows.sort((a, b) => a.index - b.index);
    return rows.map((row) => row.vector);
  }

  return [];
}

/**
 * Embeds a batch of texts with the user's local server and returns one
 * vector per text, in order. Throws on any failure - an unreachable
 * server, an HTTP error, a count or dimension mismatch - because a
 * partial or mismatched batch would silently corrupt the index.
 */
async function embedTextsViaBackend(
  settings: EliasHiveMindSettings,
  texts: string[]
): Promise<number[][]> {
  const model = settings.embeddingModel.trim();
  if (!model) throw new Error('No embedding model is set.');

  const response = await requestWithTimeout(
    {
      url: embeddingUrl(settings),
      method: 'POST',
      contentType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    },
    settings.backendTimeoutMs
  );

  if (response.status >= 400) {
    throw new Error(
      `Embedding backend returned HTTP ${response.status}. ${response.text.slice(0, 300)}`
    );
  }

  const vectors = extractEmbeddingVectors(safeJson(response));
  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding backend returned ${vectors.length} vector(s) for ${texts.length} text(s).`
    );
  }
  const dims = vectors.length > 0 ? vectors[0].length : 0;
  if (vectors.some((vector) => vector.length !== dims)) {
    throw new Error('Embedding backend returned vectors with inconsistent dimensions.');
  }
  return vectors;
}

/** FNV-1a 32-bit hash of a string, as 8 hex chars. Deterministic and local. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The exact text a note is embedded as: its plain text, whitespace
 * collapsed, capped at EMBEDDING_TEXT_MAX_CHARS. The index stores the
 * content hash of this string, so the hash and the embedded text can
 * never drift apart.
 */
function embeddingSourceText(markdown: string): string {
  return toPlainText(markdown)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EMBEDDING_TEXT_MAX_CHARS);
}

/** Cosine similarity; 0 for mismatched lengths or a zero-length vector. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** What an index refresh must do: embed these paths, drop these paths. */
interface EmbeddingPlan {
  toEmbed: string[];
  toRemove: string[];
}

/**
 * Plans an incremental index refresh. A note is (re-)embedded when it is
 * missing from the index or its content hash moved; an index entry is
 * removed when its note no longer exists (or no longer has embeddable
 * text, which keeps it out of `entries`). A model change re-embeds
 * everything: vectors from different models are not comparable, even at
 * the same dimension. Both lists are path-sorted so the plan is
 * deterministic for a given vault state.
 */
function planEmbeddingIndex(
  entries: Array<{ path: string; hash: string }>,
  index: Record<string, EmbeddingIndexEntry>,
  indexModel: string,
  model: string
): EmbeddingPlan {
  const current = new Set(entries.map((entry) => entry.path));
  const toRemove = Object.keys(index)
    .filter((path) => !current.has(path))
    .sort();
  const modelChanged = indexModel !== model;
  const toEmbed = entries
    .filter(
      (entry) => modelChanged || !index[entry.path] || index[entry.path].hash !== entry.hash
    )
    .map((entry) => entry.path)
    .sort();
  return { toEmbed, toRemove };
}

/** One note ranked against a query vector. */
interface RelatedNote {
  path: string;
  basename: string;
  score: number;
}

/** The display name for a vault path: last segment, .md stripped. */
function noteBasename(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.md$/i, '');
}

/**
 * Ranks every indexed note against a vector by cosine similarity.
 * The target note itself is excluded, non-positive scores are dropped
 * (an unrelated note is not a result), and ties break by path so the
 * ranking is deterministic.
 */
function rankRelatedNotes(
  index: Record<string, EmbeddingIndexEntry>,
  targetPath: string,
  vector: number[],
  limit: number
): RelatedNote[] {
  const scored: RelatedNote[] = [];
  for (const path of Object.keys(index)) {
    if (path === targetPath) continue;
    const score = cosineSimilarity(vector, index[path].vector);
    if (score > 0) scored.push({ path, basename: noteBasename(path), score });
  }
  scored.sort(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
  return scored.slice(0, Math.max(0, limit));
}

/** The similarity label shown beside a related note. */
function formatSimilarity(score: number): string {
  return `${Math.round(score * 100)}% similar`;
}

/* ========================================================================== */
/*                               tag suggestion                               */
/* ========================================================================== */

/**
 * Coerces free text into a valid Obsidian tag: lowercase, no leading '#',
 * spaces become hyphens, only letters, digits, '_', '-' and '/' survive.
 * Letters and digits are Unicode-wide - Obsidian tags support accented
 * and non-Latin letters, so they are preserved rather than stripped -
 * while every other character is still removed, exactly as before.
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
    .replace(/[^\p{L}\p{N}_/-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');

  if (!tag || tag.length > 40) return '';
  if (!/[\p{L}_/-]/u.test(tag) || !Number.isNaN(Number(tag))) return '';
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

/* ------------------------------------------------------- tag vocabulary */

/** One established vault tag: the form the vault writes it in, and how many notes carry it. */
interface VaultTagEntry {
  /** The tag as the vault writes it (case preserved), safe to write back as-is. */
  canonical: string;
  /** Number of notes carrying the tag. */
  count: number;
}

/** The vault's existing tags, keyed by normalised form. */
type TagVocabulary = Map<string, VaultTagEntry>;

/**
 * Builds the vault's tag vocabulary from the metadata cache ONLY - each
 * note's frontmatter tags and inline #tags, with per-tag note counts. No
 * note content is read, so the cost is one cache lookup per note however
 * large the vault is. The canonical form of a tag is the raw form most
 * notes write it in (ties keep the first form seen, scanning notes in the
 * order the vault lists them), so suggestions come back in the vault's own
 * spelling instead of a lowercased reinvention.
 */
function buildTagVocabulary(app: App): TagVocabulary {
  const counts = new Map<string, number>();
  const forms = new Map<string, Map<string, number>>();

  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;

    const raw: string[] = [];
    const frontmatter = cache.frontmatter as Record<string, unknown> | undefined;
    if (frontmatter && frontmatter.tags != null) {
      const values = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
      for (const value of values) {
        if (typeof value === 'string') raw.push(value);
      }
    }
    for (const entry of cache.tags ?? []) {
      if (entry && typeof entry.tag === 'string') raw.push(entry.tag);
    }

    // A tag counts once per note however often the note repeats it, and a
    // note's first written form is the one that votes for that note.
    const perFile = new Map<string, string>();
    for (const value of raw) {
      const cleaned = value.trim().replace(/^#+/, '').trim().replace(/\s+/g, '-');
      if (!cleaned) continue;
      const normalised = normaliseTag(cleaned);
      if (!normalised) continue;
      // Only forms that round-trip through normalisation are safe to write
      // back verbatim; anything else falls back to the normalised form.
      if (!perFile.has(normalised)) {
        perFile.set(normalised, normaliseTag(cleaned) === normalised ? cleaned : normalised);
      }
    }

    perFile.forEach((form, normalised) => {
      counts.set(normalised, (counts.get(normalised) ?? 0) + 1);
      let byForm = forms.get(normalised);
      if (!byForm) {
        byForm = new Map<string, number>();
        forms.set(normalised, byForm);
      }
      byForm.set(form, (byForm.get(form) ?? 0) + 1);
    });
  }

  const vocabulary: TagVocabulary = new Map();
  counts.forEach((count, normalised) => {
    let canonical = normalised;
    let best = -1;
    forms.get(normalised)?.forEach((formCount, form) => {
      if (formCount > best) {
        canonical = form;
        best = formCount;
      }
    });
    vocabulary.set(normalised, { canonical, count });
  });
  return vocabulary;
}

/**
 * Frequency-based tags: repeated non-stopword terms, most frequent first.
 *
 * When a vault vocabulary is supplied, candidates that correspond to an
 * established vault tag - exactly, or as the leaf of a nested tag such as
 * `garden/compost` - are suggested in the vault's canonical form and rank
 * ahead of invented words within their tier: repeated vault tags before
 * repeated new words, and (when nothing repeats at all) single-mention
 * vault tags before single-mention new words. Without a vocabulary the
 * ranking is exactly the pre-vault-aware one.
 */
function suggestTagsLocally(
  markdown: string,
  max: number,
  existing: string[],
  vocabulary?: TagVocabulary | null
): string[] {
  const skip = new Set(existing);
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  tokenize(toPlainText(markdown)).forEach((word, index) => {
    if (!isContentWord(word, 4)) return;
    const tag = normaliseTag(word);
    if (!tag || skip.has(tag)) return;
    freq.set(tag, (freq.get(tag) ?? 0) + 1);
    if (!firstSeen.has(tag)) firstSeen.set(tag, index);
  });

  // Leaf index over the vocabulary: leaf segment -> the established tag
  // with that leaf, most-used first (ties keep vocabulary order).
  const leafIndex = new Map<string, string>();
  if (vocabulary) {
    vocabulary.forEach((_entry, normalised) => {
      const leaf = normalised.split('/').pop() ?? normalised;
      const current = leafIndex.get(leaf);
      if (!current) {
        leafIndex.set(leaf, normalised);
        return;
      }
      const currentCount = vocabulary.get(current)?.count ?? 0;
      const thisCount = vocabulary.get(normalised)?.count ?? 0;
      if (thisCount > currentCount) leafIndex.set(leaf, normalised);
    });
  }

  interface Candidate {
    out: string;
    outNormalised: string;
    fromVault: boolean;
    vaultCount: number;
    freq: number;
    first: number;
  }

  const seenOut = new Set<string>();
  const candidates: Candidate[] = [];
  for (const tag of freq.keys()) {
    let out = tag;
    let fromVault = false;
    let vaultCount = 0;

    if (vocabulary) {
      const direct = vocabulary.get(tag);
      const viaLeaf = direct ? undefined : vocabulary.get(leafIndex.get(tag) ?? '');
      const hit = direct ?? viaLeaf;
      if (hit) {
        out = hit.canonical;
        fromVault = true;
        vaultCount = hit.count;
      }
    }

    const outNormalised = normaliseTag(out);
    if (!out || skip.has(outNormalised) || seenOut.has(outNormalised)) continue;
    seenOut.add(outNormalised);
    candidates.push({
      out,
      outNormalised,
      fromVault,
      vaultCount,
      freq: freq.get(tag) ?? 0,
      first: firstSeen.get(tag) ?? 0,
    });
  }

  const byRank = (a: Candidate, b: Candidate): number =>
    b.freq - a.freq || b.vaultCount - a.vaultCount || a.first - b.first;
  const byFrequency = (a: Candidate, b: Candidate): number =>
    b.freq - a.freq || a.first - b.first;
  const repeatedVault = candidates.filter((c) => c.fromVault && c.freq >= 2).sort(byRank);
  const repeatedNew = candidates.filter((c) => !c.fromVault && c.freq >= 2).sort(byFrequency);
  const singleVault = candidates.filter((c) => c.fromVault && c.freq < 2).sort(byRank);
  const singleNew = candidates.filter((c) => !c.fromVault && c.freq < 2).sort(byFrequency);

  // Single mentions are mostly noise; use them only when nothing repeats -
  // the pre-vault-aware rule, with vault tags preferred inside each tier.
  const pool =
    repeatedVault.length + repeatedNew.length > 0
      ? [...repeatedVault, ...repeatedNew]
      : [...singleVault, ...singleNew];
  return pool.slice(0, max).map((c) => c.out);
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
/*                           housekeeping sweep                               */
/* ========================================================================== */

/**
 * Upper bound on notes scanned in one sweep run - the same bound the
 * digests use, for the same reason: an unbounded first run over a huge
 * vault would be slow (doubly so on a phone). The overflow is counted and
 * reported, and because a scope is scanned in path order, narrowing the
 * scope (or re-running after applying) works through the rest.
 */
const SWEEP_MAX_NOTES = 50;

/** One note the sweep proposes tags for. Nothing is written at plan time. */
interface SweepPlanEntry {
  file: TFile;
  basename: string;
  path: string;
  tags: string[];
}

/** The dry-run result the review modal presents for approval. */
interface SweepPlan {
  /** Notes with at least one proposed tag, in path order. */
  entries: SweepPlanEntry[];
  /** Notes read and checked in this run. */
  scanned: number;
  /** In-scope notes not scanned because the per-run cap was reached. */
  omitted: number;
  /** Scanned notes that needed no new tags. */
  unchanged: number;
  /** Human-readable scope name for the review and the notices. */
  scopeLabel: string;
}

/**
 * The folders a sweep can target: every folder that directly holds at
 * least one markdown note, sorted. Choosing a folder includes its
 * subfolders, matching the backlog's folder semantics.
 */
function sweepFolderOptions(app: App): string[] {
  const folders = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const slash = file.path.lastIndexOf('/');
    if (slash > 0) folders.add(file.path.slice(0, slash));
  }
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
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
  /** Short snippet around the first mention, for the review modal. */
  context?: string;
}

/** One concrete mention of a title in a text: character offsets and the exact surface text. */
interface MentionSpan {
  start: number;
  end: number;
  text: string;
}

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}_'-]/u.test(ch);
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

/**
 * The title forms a mention may take, lowercased and deduplicated:
 * the title itself, the title with apostrophes/periods dropped
 * ("Maker's Mark" -> "makers mark", "St. John" -> "st john"), and simple
 * plural variants of the LAST word only - title + trailing s/es, and the
 * reverse (a plural title also matches its singular). Deliberately NOT
 * included: substring/prefix matching, stemming beyond s/es (and the
 * consonant-y -> ies pair), edit-distance fuzz, or single-word partial
 * titles - each of those can fire on words the user never meant as a
 * mention, and a false link is worse than a missed one.
 */
function linkTitleVariants(title: string): string[] {
  const base = title.trim().toLowerCase();
  const variants = new Set<string>();
  const add = (v: string): void => {
    const t = v.trim().replace(/\s+/g, ' ');
    if (t) variants.add(t);
  };
  add(base);
  add(base.replace(/'/g, ''));
  add(base.replace(/\./g, ''));
  add(base.replace(/[.']/g, ''));

  const words = base.split(' ');
  const last = words[words.length - 1];
  const withLast = (w: string): string => [...words.slice(0, -1), w].join(' ');
  if (last.length > 1) {
    if (last.endsWith('ies') && last.length > 3) {
      add(withLast(last.slice(0, -3) + 'y'));
    } else if (/(?:ses|xes|zes|ches|shes)$/.test(last)) {
      add(withLast(last.slice(0, -2)));
      add(withLast(last.slice(0, -1)));
    } else if (last.endsWith('es')) {
      add(withLast(last.slice(0, -2)));
      add(withLast(last.slice(0, -1)));
    } else if (last.endsWith('s') && !last.endsWith('ss')) {
      add(withLast(last.slice(0, -1)));
    }
    if (!last.endsWith('s')) {
      add(withLast(last + 's'));
      if (/(?:x|z|ch|sh)$/.test(last)) add(withLast(last + 'es'));
      if (/[^aeiou]y$/.test(last)) add(withLast(last.slice(0, -1) + 'ies'));
    }
  }
  // Apostrophe-dropped forms of every variant, so "Makers Marks" (plural,
  // no apostrophe) still matches the title "Maker's Mark".
  for (const v of Array.from(variants)) add(v.replace(/[.']/g, ''));
  return Array.from(variants);
}

/**
 * Tries to match `needleLower` at `start` in `haystackLower`, returning the
 * end offset or -1. A space or hyphen in the needle matches a run of
 * spaces, hyphens, tabs and commas in the text, so "Alpha Harvest" also
 * matches "alpha-harvest" and "Alpha, Harvest" - the full title must still
 * be present, word for word; only the separators may vary.
 */
function matchNeedleAt(haystackLower: string, start: number, needleLower: string): number {
  let h = start;
  let n = 0;
  while (n < needleLower.length) {
    const nc = needleLower.charAt(n);
    if (nc === ' ' || nc === '-') {
      let sawSeparator = false;
      while (h < haystackLower.length) {
        const hc = haystackLower.charAt(h);
        if (hc === ' ' || hc === '-' || hc === '\t') {
          sawSeparator = true;
          h += 1;
        } else if (hc === ',') {
          h += 1;
        } else {
          break;
        }
      }
      if (!sawSeparator) return -1;
      n += 1;
      while (n < needleLower.length && (needleLower.charAt(n) === ' ' || needleLower.charAt(n) === '-')) {
        n += 1;
      }
      continue;
    }
    if (h >= haystackLower.length || haystackLower.charAt(h) !== nc) return -1;
    h += 1;
    n += 1;
  }
  return h;
}

/** Character ranges of a note that must never yield or receive a link. */
function protectedLinkRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const block = frontmatterBlock(markdown);
  if (block) ranges.push({ start: 0, end: block.text.length });
  const patterns = [
    /```[\s\S]*?```/g, // fenced code
    /~~~[\s\S]*?~~~/g, // alternate fences
    /`[^`\n]*`/g, // inline code
    /!?\[\[[^\]]*\]\]/g, // existing wikilinks and embeds
    /\[[^\]]*\]\([^)]*\)/g, // existing markdown links
    /https?:\/\/\S+/g, // bare urls
    /<[^>]+>/g, // html
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return ranges;
}

function overlapsProtected(
  ranges: Array<{ start: number; end: number }>,
  start: number,
  end: number
): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

/**
 * Every mention of `title` in `text`, as spans in the ORIGINAL text.
 * Whole-word boundaries are required on both sides; when protected ranges
 * are supplied, any span touching one is dropped. When several variants
 * match at one position the longest surface wins, and spans never overlap.
 */
function findMentionSpans(
  text: string,
  title: string,
  ranges?: Array<{ start: number; end: number }>
): MentionSpan[] {
  const haystackLower = text.toLowerCase();
  const variants = linkTitleVariants(title);
  const spans: MentionSpan[] = [];

  for (let pos = 0; pos < haystackLower.length; pos += 1) {
    const ch = haystackLower.charAt(pos);
    let bestEnd = -1;
    for (const needle of variants) {
      if (needle.charAt(0) !== ch) continue;
      const end = matchNeedleAt(haystackLower, pos, needle);
      if (end > bestEnd) bestEnd = end;
    }
    if (bestEnd === -1) continue;

    const before = pos === 0 ? '' : haystackLower.charAt(pos - 1);
    const after = bestEnd >= haystackLower.length ? '' : haystackLower.charAt(bestEnd);
    if (isWordChar(before) || isWordChar(after)) continue;
    if (ranges && overlapsProtected(ranges, pos, bestEnd)) continue;

    spans.push({ start: pos, end: bestEnd, text: text.slice(pos, bestEnd) });
    pos = bestEnd - 1;
  }
  return spans;
}

/** The wikilink that wraps one concrete mention, preserving its surface text when it differs from the canonical form. */
function inlineLinkFor(suggestion: LinkSuggestion, matchedText: string): string {
  if (suggestion.viaAlias) {
    return matchedText.toLowerCase() === suggestion.title.toLowerCase()
      ? `[[${suggestion.basename}|${suggestion.title}]]`
      : `[[${suggestion.basename}|${matchedText}]]`;
  }
  return matchedText.toLowerCase() === suggestion.basename.toLowerCase()
    ? `[[${suggestion.basename}]]`
    : `[[${suggestion.basename}|${matchedText}]]`;
}

/**
 * Wraps every mention of the chosen suggestions in `[[...]]`, in place.
 * Pure and deterministic: the same note and the same choices always give
 * the same result. Mentions inside frontmatter, code, existing links and
 * URLs are never wrapped (they sit in protected ranges), so re-running it
 * on its own output wraps nothing twice. Overlapping mentions of different
 * notes resolve to the earliest, then the longest, span.
 */
function applyInlineLinks(
  markdown: string,
  chosen: LinkSuggestion[]
): { text: string; wrapped: number } {
  const ranges = protectedLinkRanges(markdown);
  const jobs: Array<{ span: MentionSpan; suggestion: LinkSuggestion }> = [];
  for (const suggestion of chosen) {
    for (const span of findMentionSpans(markdown, suggestion.title, ranges)) {
      jobs.push({ span, suggestion });
    }
  }
  jobs.sort(
    (a, b) =>
      a.span.start - b.span.start ||
      b.span.end - b.span.start - (a.span.end - a.span.start)
  );

  let out = '';
  let cursor = 0;
  let wrapped = 0;
  for (const job of jobs) {
    if (job.span.start < cursor) continue;
    out += markdown.slice(cursor, job.span.start);
    out += inlineLinkFor(job.suggestion, job.span.text);
    cursor = job.span.end;
    wrapped += 1;
  }
  out += markdown.slice(cursor);
  return { text: out, wrapped };
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

      const spans = findMentionSpans(haystack, title);
      const occurrences = spans.length;
      if (occurrences === 0) continue;

      if (!best || occurrences > best.occurrences || title.length > best.title.length) {
        const first = spans[0];
        const context = haystack
          .slice(Math.max(0, first.start - 30), Math.min(haystack.length, first.end + 30))
          .replace(/\s+/g, ' ')
          .trim();
        best = {
          title,
          path: file.path,
          basename: file.basename,
          occurrences,
          viaAlias: candidate.viaAlias,
          context,
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
  /** How the pile moved since the previous backlog scan; '' on the first scan. */
  progressLine: string;
}

/**
 * One plain sentence on how the backlog moved since the previous scan.
 * First scan (no previous count/date) gets no line at all: the section
 * already says how big the pile is, and a progress line needs a baseline.
 */
function backlogProgressLine(
  previousCount: number,
  previousDate: string,
  current: number
): string {
  if (previousCount < 0 || !previousDate) return '';

  if (current < previousCount) {
    const cleared = previousCount - current;
    return (
      `Since the last run (${previousDate}), ${cleared} clipping${cleared === 1 ? '' : 's'} ` +
      `left the pile — ${current} unread now.`
    );
  }
  if (current > previousCount) {
    const added = current - previousCount;
    return (
      `Since the last run (${previousDate}), the pile grew by ${added} — ` +
      `${current} unread now.`
    );
  }
  return `No change since the last run (${previousDate}) — still ${current} unread.`;
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

/** The content words of a text: four-plus letters, no stopwords (CJK bigrams count). */
function significantWordSet(plain: string): Set<string> {
  const set = new Set<string>();
  for (const word of tokenize(plain)) {
    if (isContentWord(word, 4)) set.add(word);
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
    // The pile being empty is itself the progress worth reporting.
    if (scan.progressLine) lines.push('', scan.progressLine);
    return lines.join('\n');
  }

  const total = scan.items.length + scan.omitted;
  lines.push(`${total} unread clipping${total === 1 ? '' : 's'} in ${scan.foldersLabel}.`);
  if (scan.progressLine) lines.push(scan.progressLine);

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

/* ========================================================================== */
/*                               resurface                                    */
/* ========================================================================== */

/**
 * Resurface covers the third population of a note's life. The weekly digest
 * covers what was new this week and the backlog digest covers clippings
 * never read; Resurface covers notes that were read or written, then went
 * cold. Candidates are ranked by coldness x connectedness x relevance, all
 * computed locally: file mtimes, backlink counts from the metadata cache,
 * and tag/word overlap with the notes touched in the last 30 days. There
 * is no enrolment and no background pass - the ranking is recomputed on
 * each explicit command or digest run, and note content is read only
 * during such a run (for the word-overlap term), mirroring the backlog
 * digest. Snoozing and dismissing write only the plugin's own data.
 */

/** How far back "notes you edited this month" reaches, for relevance. */
const RESURFACE_RECENT_WINDOW_MS = 30 * BACKLOG_DAY_MS;

/** Snooze interval for a first snooze; each later snooze doubles it. */
const RESURFACE_SNOOZE_BASE_DAYS = 30;

/** One note's snooze record, persisted in the plugin's own data. */
interface ResurfaceSnooze {
  /** ISO timestamp at which the note may resurface again. */
  until: string;
  /** How many times the note has been snoozed (drives the doubling). */
  count: number;
}

/** The measured facts behind one resurfaced note's rank and why-line. */
interface ResurfaceFacts {
  /** Whole days since the note was last modified. */
  ageDays: number;
  /** Distinct notes linking to this one, from the metadata cache. */
  backlinks: number;
  /** Canonical form of the strongest tag shared with recent notes. */
  sharedTag: string | null;
  /** How many recent notes carry that shared tag. */
  sharedTagNotes: number;
  /** Significant words shared with the recent notes' vocabulary. */
  wordOverlap: number;
}

/** One ranked forgotten note, ready for the modal or the digest. */
interface ResurfaceItem extends ResurfaceFacts {
  basename: string;
  path: string;
  score: number;
  /** Plain-words explanation, composed only from true factors. */
  why: string;
}

/**
 * Counts the distinct notes that link to `path`, from the metadata cache's
 * resolvedLinks (source path -> destination path -> link count). A note
 * never counts as its own backlink. Cache only - no content is read.
 */
function countBacklinks(
  resolvedLinks: Record<string, Record<string, number>>,
  path: string
): number {
  let count = 0;
  for (const source of Object.keys(resolvedLinks ?? {})) {
    if (source === path) continue;
    const destinations = resolvedLinks[source];
    if (destinations && (destinations[path] ?? 0) > 0) count += 1;
  }
  return count;
}

/**
 * The deterministic Resurface score: coldness (log of days untouched, so
 * extreme age alone cannot swamp the other terms) x connectedness
 * (1 + backlinks) x relevance (1 + shared-tag strength + word overlap,
 * each capped so one loud signal cannot dominate). The same facts always
 * produce the same score.
 */
function scoreResurfaceCandidate(facts: ResurfaceFacts): number {
  const coldness = Math.log(Math.max(1, facts.ageDays));
  const connectedness = 1 + facts.backlinks;
  const relevance =
    1 + Math.min(facts.sharedTagNotes, 5) + Math.min(facts.wordOverlap, 10) * 0.2;
  return coldness * connectedness * relevance;
}

/** "untouched 6 months" / "untouched 45 days" / "untouched 1 year 2 months". */
function formatUntouched(ageDays: number): string {
  if (ageDays < 60) return `untouched ${ageDays} day${ageDays === 1 ? '' : 's'}`;
  const months = Math.floor(ageDays / 30);
  if (months < 12) return `untouched ${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const yearPart = `${years} year${years === 1 ? '' : 's'}`;
  return rest > 0
    ? `untouched ${yearPart} ${rest} month${rest === 1 ? '' : 's'}`
    : `untouched ${yearPart}`;
}

/**
 * The why-line for one resurfaced note, composed only from factors that
 * are actually true of it: zero-value clauses are omitted entirely, so an
 * orphan with no recent overlap is introduced by its age alone.
 */
function buildResurfaceWhy(facts: ResurfaceFacts): string {
  const parts: string[] = [formatUntouched(facts.ageDays)];
  if (facts.backlinks > 0) {
    parts.push(`linked from ${facts.backlinks} note${facts.backlinks === 1 ? '' : 's'}`);
  }
  if (facts.sharedTag && facts.sharedTagNotes > 0) {
    parts.push(
      `shares #${facts.sharedTag} with ${facts.sharedTagNotes} note${facts.sharedTagNotes === 1 ? '' : 's'} you edited this month`
    );
  } else if (facts.wordOverlap > 0) {
    parts.push(
      `shares ${facts.wordOverlap} significant word${facts.wordOverlap === 1 ? '' : 's'} with notes you edited this month`
    );
  }
  return parts.join(' · ');
}

/** Rank order: score, then coldest, then path - fully deterministic. */
function compareResurfaceItems(a: ResurfaceItem, b: ResurfaceItem): number {
  return b.score - a.score || b.ageDays - a.ageDays || a.path.localeCompare(b.path);
}

/**
 * The snooze record after one more snooze of a note: the interval is
 * 30 days x 2^(count-1) - 30 days the first time, then 60, 120, and so on.
 */
function nextResurfaceSnooze(
  existing: ResurfaceSnooze | undefined,
  nowMs: number
): ResurfaceSnooze {
  const count = (existing?.count ?? 0) + 1;
  const days = RESURFACE_SNOOZE_BASE_DAYS * Math.pow(2, count - 1);
  return { until: new Date(nowMs + days * BACKLOG_DAY_MS).toISOString(), count };
}

/** True when a note is never-listed, or snoozed and the snooze still runs. */
function isResurfaceSuppressed(
  path: string,
  snoozes: Record<string, ResurfaceSnooze>,
  neverShow: string[],
  nowMs: number
): boolean {
  if (neverShow.includes(path)) return true;
  const snooze = snoozes ? snoozes[path] : undefined;
  if (!snooze) return false;
  const until = Date.parse(snooze.until);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * True when the backlog digest's own selection would pick this note up as
 * unread backlog - in a backlog folder or carrying a backlog tag, and not
 * marked read. Mirrors collectBacklog's selection (including its archive
 * exclusion) so the two features never double-count a note: Resurface
 * leaves unread backlog to the backlog digest. The read marker is proven
 * from the metadata cache where possible; `markdown` (read during the
 * caller's explicit run) settles it otherwise.
 */
function isUnreadBacklogSelection(
  app: App,
  file: TFile,
  folders: string[],
  tagSet: Set<string>,
  archiveFolder: string,
  markdown: string | null
): boolean {
  const lower = file.path.toLowerCase();
  if (archiveFolder !== '' && (lower === archiveFolder || lower.startsWith(archiveFolder + '/'))) {
    return false;
  }
  const inScope =
    fileInAnyFolder(file.path, folders) ||
    (tagSet.size > 0 && fileTags(app, file).some((t) => tagSet.has(t)));
  if (!inScope) return false;

  const cache = app.metadataCache.getFileCache(file);
  const cached = cache?.frontmatter ? cache.frontmatter[BACKLOG_READ_KEY] : undefined;
  if (cached === true || cached === 'true') return false;
  if (markdown !== null && isMarkedRead(markdown)) return false;
  return true;
}

/** Assembles the digest's "Worth another look" block, no trailing newline. */
function buildResurfaceBlock(items: ResurfaceItem[]): string {
  const lines: string[] = ['### Worth another look', ''];
  for (const item of items) {
    lines.push(`- [[${item.basename}]] — ${item.why}`);
  }
  lines.push(
    '',
    '*Forgotten notes, ranked by how connected and relevant they still are. ' +
      'Run "Resurface forgotten notes" to open, snooze or dismiss them.*'
  );
  return lines.join('\n');
}

/**
 * Returns the note text with the resurface block for `date` inserted or
 * replaced - the same placement rules as the backlog block: the block
 * lives inside that date's weekly digest section, is swapped in place when
 * the section already holds one, appended to the section when it does not,
 * and a section holding only the block is created when the date has none.
 */
function upsertResurfaceBlock(existing: string, block: string, date: string): string {
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

  const marker = '### Worth another look';
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

interface SweepModalConfig {
  /** Scope choices: '' is the whole vault, anything else a folder path. */
  scopes: Array<{ folder: string; label: string }>;
  /** Runs the dry run for a chosen scope. Resolves with the plan to review. */
  chooseScope: (folder: string) => Promise<SweepPlan>;
  /** Applies the approved entries. Only ever called from the confirm button. */
  onApply: (chosen: SweepPlanEntry[]) => void;
}

/**
 * Two-phase review for the housekeeping sweep. Phase one picks the scope;
 * phase two shows the dry run - one row per note, its proposed tags beside
 * it - and writes NOTHING: the only path to a write is the confirm button
 * at the bottom of phase two, and it applies exactly the rows still
 * ticked. Closing the modal at either phase changes no note.
 */
class SweepModal extends Modal {
  private readonly config: SweepModalConfig;
  private plan: SweepPlan | null = null;
  private readonly selected = new Set<number>();

  constructor(app: App, config: SweepModalConfig) {
    super(app);
    this.config = config;
  }

  onOpen(): void {
    this.renderScopePhase();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderScopePhase(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Housekeeping sweep');
    contentEl.empty();

    contentEl.createEl('p', {
      text:
        'Pick a scope to scan for tag suggestions. You will review every ' +
        'proposed change before anything is written - the scan itself ' +
        'changes nothing.',
    });

    const list = contentEl.createDiv({ cls: 'ehm-suggestion-list' });
    for (const scope of this.config.scopes) {
      const button = list.createEl('button', { text: scope.label });
      button.addEventListener('click', () => {
        void this.pickScope(scope.folder);
      });
    }

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  private async pickScope(folder: string): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: 'Scanning...' });

    this.plan = await this.config.chooseScope(folder);
    this.selected.clear();
    this.plan.entries.forEach((_entry, i) => this.selected.add(i));
    this.renderReviewPhase();
  }

  private renderReviewPhase(): void {
    const plan = this.plan;
    if (!plan) return;

    const { contentEl, titleEl } = this;
    titleEl.setText('Housekeeping sweep — review');
    contentEl.empty();

    const intro: string[] = [
      `Scanned ${plan.scanned} note${plan.scanned === 1 ? '' : 's'} in ${plan.scopeLabel}. ` +
        `${plan.entries.length} would gain tags; ${plan.unchanged} needed none.`,
    ];
    if (plan.omitted > 0) {
      intro.push(
        `${plan.omitted} more note${plan.omitted === 1 ? '' : 's'} were not scanned - ` +
          `one run covers at most ${SWEEP_MAX_NOTES}. Narrow the scope or run again after applying.`
      );
    }
    contentEl.createEl('p', { text: intro.join(' ') });

    if (plan.entries.length === 0) {
      contentEl.createEl('p', { text: 'No tag changes to propose in this scope.' });
      const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
      const close = buttons.createEl('button', { cls: 'mod-cta', text: 'Close' });
      close.addEventListener('click', () => this.close());
      return;
    }

    const list = contentEl.createDiv({ cls: 'ehm-suggestion-list' });
    plan.entries.forEach((entry, index) => {
      const row = list.createEl('label', { cls: 'ehm-suggestion-row' });

      const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
      checkbox.checked = true;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(index);
        else this.selected.delete(index);
      });

      row.createSpan({ text: entry.basename });
      row.createEl('small', {
        cls: 'ehm-suggestion-meta',
        text: `${entry.tags.map((t) => `#${t}`).join(' ')} · ${entry.path}`,
      });
    });

    contentEl.createEl('p', {
      text: 'Applying writes only frontmatter tag merges - note bodies are never touched.',
    });

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });

    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const apply = buttons.createEl('button', {
      cls: 'mod-cta',
      text: 'Apply tags to selected notes',
    });
    apply.addEventListener('click', () => {
      const chosen = plan.entries.filter((_entry, i) => this.selected.has(i));
      this.close();
      this.config.onApply(chosen);
    });
  }
}

/* ========================================================================== */
/*                                   plugin                                   */
/* ========================================================================== */

interface ResurfaceModalConfig {
  /** The ranked queue to review, already sliced to the queue size. */
  items: ResurfaceItem[];
  /** Plain statement shown when nothing has gone cold. */
  emptyText: string;
  /** Opens the note in the workspace. The modal closes first. */
  onOpen: (item: ResurfaceItem) => void;
  /** Snoozes the note (plugin-internal state only) and drops its row. */
  onSnooze: (item: ResurfaceItem) => void;
  /** Never shows the note again (plugin-internal state only). */
  onNever: (item: ResurfaceItem) => void;
}

/**
 * Review for Resurface: one row per forgotten note - its title, how long
 * it has been untouched and why it ranked - with three per-note actions.
 * Open leaves for the note; Snooze and Never show update only the
 * plugin's own snooze/exclude state (the callbacks own persistence) and
 * remove the row. No note file is ever written from this modal.
 */
class ResurfaceModal extends Modal {
  private readonly config: ResurfaceModalConfig;
  private items: ResurfaceItem[];

  constructor(app: App, config: ResurfaceModalConfig) {
    super(app);
    this.config = config;
    this.items = config.items.slice();
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, titleEl, config } = this;
    titleEl.setText('Resurface forgotten notes');
    contentEl.empty();

    if (this.items.length === 0) {
      contentEl.createEl('p', {
        text:
          config.items.length === 0
            ? config.emptyText
            : 'All caught up — nothing else has gone cold.',
      });
      const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
      const close = buttons.createEl('button', { cls: 'mod-cta', text: 'Close' });
      close.addEventListener('click', () => this.close());
      return;
    }

    contentEl.createEl('p', {
      text:
        `${this.items.length} forgotten note${this.items.length === 1 ? '' : 's'}, ` +
        'ranked by how connected and relevant they still are. Snoozing or ' +
        'dismissing a note changes no note — it only updates this plugin’s own list.',
    });

    const list = contentEl.createDiv({ cls: 'ehm-suggestion-list' });
    this.items.forEach((item) => {
      const row = list.createDiv({ cls: 'ehm-resurface-row' });

      const main = row.createDiv({ cls: 'ehm-resurface-main' });
      main.createSpan({ text: item.basename });
      main.createEl('small', { cls: 'ehm-resurface-why', text: item.why });

      const actions = row.createDiv({ cls: 'ehm-modal-buttons' });

      const open = actions.createEl('button', { text: 'Open' });
      open.addEventListener('click', () => {
        this.close();
        config.onOpen(item);
      });

      const snooze = actions.createEl('button', { text: 'Snooze' });
      snooze.addEventListener('click', () => {
        config.onSnooze(item);
        this.items = this.items.filter((i) => i.path !== item.path);
        this.render();
      });

      const never = actions.createEl('button', { text: 'Never show' });
      never.addEventListener('click', () => {
        config.onNever(item);
        this.items = this.items.filter((i) => i.path !== item.path);
        this.render();
      });
    });

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
    const close = buttons.createEl('button', { cls: 'mod-cta', text: 'Close' });
    close.addEventListener('click', () => this.close());
  }
}

interface RelatedNotesModalConfig {
  title: string;
  intro: string;
  /** The ranked results, already sliced to the configured count. */
  items: RelatedNote[];
  /** Plain statement shown when nothing ranked. */
  emptyText: string;
  /** Opens the note in the workspace. The modal closes first. */
  onOpen: (item: RelatedNote) => void;
}

/**
 * Results for Related notes: one row per note - its title, how similar
 * the local embedding model found it, and its path - with an Open action.
 * Read-only: nothing is written from this modal, to any note or to the
 * index.
 */
class RelatedNotesModal extends Modal {
  private readonly config: RelatedNotesModalConfig;

  constructor(app: App, config: RelatedNotesModalConfig) {
    super(app);
    this.config = config;
  }

  onOpen(): void {
    const { contentEl, titleEl, config } = this;
    titleEl.setText(config.title);
    contentEl.empty();

    if (config.items.length === 0) {
      contentEl.createEl('p', { text: config.emptyText });
    } else {
      contentEl.createEl('p', { text: config.intro });

      const list = contentEl.createDiv({ cls: 'ehm-suggestion-list' });
      config.items.forEach((item) => {
        const row = list.createDiv({ cls: 'ehm-resurface-row' });

        const main = row.createDiv({ cls: 'ehm-resurface-main' });
        main.createSpan({ text: item.basename });
        main.createEl('small', {
          cls: 'ehm-resurface-why',
          text: `${formatSimilarity(item.score)} · ${item.path}`,
        });

        const actions = row.createDiv({ cls: 'ehm-modal-buttons' });
        const open = actions.createEl('button', { text: 'Open' });
        open.addEventListener('click', () => {
          this.close();
          config.onOpen(item);
        });
      });
    }

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
    const close = buttons.createEl('button', { cls: 'mod-cta', text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface SemanticLookupModalConfig {
  intro: string;
  /** Embeds the query and ranks the index; throws when the server fails. */
  onSearch: (query: string) => Promise<RelatedNote[]>;
  /** Opens the note in the workspace. The modal closes first. */
  onOpen: (item: RelatedNote) => void;
}

/**
 * Semantic lookup: a text field and a Search button over the embedding
 * index. Results render under the field with the same rows Related notes
 * uses. The query is embedded by the user's local server when Search is
 * pressed - opening this modal makes no request by itself.
 */
class SemanticLookupModal extends Modal {
  private readonly config: SemanticLookupModalConfig;
  private resultsEl: HTMLElement | null = null;

  constructor(app: App, config: SemanticLookupModalConfig) {
    super(app);
    this.config = config;
  }

  onOpen(): void {
    const { contentEl, titleEl, config } = this;
    titleEl.setText('Semantic lookup');
    contentEl.empty();

    contentEl.createEl('p', { text: config.intro });

    const input = contentEl.createEl('input', {
      cls: 'ehm-lookup-input',
      attr: { type: 'text', placeholder: 'Describe what you are looking for...' },
    });

    const buttons = contentEl.createDiv({ cls: 'ehm-modal-buttons' });
    const search = buttons.createEl('button', { cls: 'mod-cta', text: 'Search' });
    search.addEventListener('click', () => {
      void this.runSearch(input.value);
    });

    this.resultsEl = contentEl.createDiv();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async runSearch(rawQuery: string): Promise<void> {
    const resultsEl = this.resultsEl;
    if (!resultsEl) return;
    const query = rawQuery.trim();
    resultsEl.empty();

    if (!query) {
      resultsEl.createEl('p', { text: 'Type what you are looking for, then Search.' });
      return;
    }

    resultsEl.createEl('p', { text: 'Searching...' });
    let items: RelatedNote[];
    try {
      items = await this.config.onSearch(query);
    } catch (error) {
      resultsEl.empty();
      resultsEl.createEl('p', {
        text: `Lookup failed: ${describeError(error)}`,
      });
      return;
    }

    resultsEl.empty();
    if (items.length === 0) {
      resultsEl.createEl('p', {
        text: 'No notes in the index are similar to that. The index only covers notes with readable text, outside the ignored folders.',
      });
      return;
    }

    const list = resultsEl.createDiv({ cls: 'ehm-suggestion-list' });
    items.forEach((item) => {
      const row = list.createDiv({ cls: 'ehm-resurface-row' });

      const main = row.createDiv({ cls: 'ehm-resurface-main' });
      main.createSpan({ text: item.basename });
      main.createEl('small', {
        cls: 'ehm-resurface-why',
        text: `${formatSimilarity(item.score)} · ${item.path}`,
      });

      const actions = row.createDiv({ cls: 'ehm-modal-buttons' });
      const open = actions.createEl('button', { text: 'Open' });
      open.addEventListener('click', () => {
        this.close();
        this.config.onOpen(item);
      });
    });
  }
}

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
      id: 'housekeeping-sweep',
      name: 'Housekeeping sweep: suggest tags for a folder or the vault',
      callback: () => {
        this.runHousekeepingSweep();
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
      id: 'resurface-forgotten-notes',
      name: 'Resurface forgotten notes',
      callback: () => {
        void this.runResurface();
      },
    });

    this.addCommand({
      id: 'build-embedding-index',
      name: 'Build embedding index (local server)',
      callback: () => {
        void this.runBuildEmbeddingIndex();
      },
    });

    this.addCommand({
      id: 'related-notes',
      name: 'Related notes for current note (semantic)',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.runRelatedNotes(editor, view);
      },
    });

    this.addCommand({
      id: 'semantic-lookup',
      name: 'Semantic lookup: find notes by meaning',
      callback: () => {
        void this.runSemanticLookup();
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
        tags = suggestTagsLocally(
          markdown,
          this.settings.maxTags,
          existing,
          buildTagVocabulary(this.app)
        );
      } finally {
        pending.hide();
      }
    } else {
      tags = suggestTagsLocally(
        markdown,
        this.settings.maxTags,
        existing,
        buildTagVocabulary(this.app)
      );
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

  /* --------------------------------------------------------- housekeeping */

  /**
   * Opens the sweep: scope picker first, dry run second, writes only from
   * the review's confirm button. The vocabulary is built once here and
   * shared by every scope the user tries in this session.
   */
  private runHousekeepingSweep(): void {
    const vocabulary = buildTagVocabulary(this.app);
    const scopes = [
      { folder: '', label: 'Whole vault' },
      ...sweepFolderOptions(this.app).map((folder) => ({ folder, label: folder })),
    ];

    new SweepModal(this.app, {
      scopes,
      chooseScope: (folder) => this.planSweep(folder, vocabulary),
      onApply: (chosen) => {
        void this.applySweepEntries(chosen);
      },
    }).open();
  }

  /**
   * The sweep's dry run over one scope ('' = whole vault; a folder covers
   * its subfolders). Same exclusions as everywhere else - the
   * configuration folder and the user's ignored folders - plus the digest
   * note. Reads at most SWEEP_MAX_NOTES notes, in path order; the rest
   * are counted, never silently skipped. Proposes tags only: this
   * function writes nothing.
   */
  private async planSweep(folder: string, vocabulary: TagVocabulary): Promise<SweepPlan> {
    const ignored = parseIgnoreFolders(
      `${this.app.vault.configDir}, ${this.settings.ignoreFolders}`
    );
    const prefix = folder ? folder.toLowerCase() + '/' : '';

    const inScope = this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        if (file.path === DIGEST_NOTE_PATH) return false;
        const lower = file.path.toLowerCase();
        if (prefix && !lower.startsWith(prefix)) return false;
        return !ignored.some((f) => lower.startsWith(f + '/'));
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    const plan: SweepPlan = {
      entries: [],
      scanned: 0,
      omitted: Math.max(0, inScope.length - SWEEP_MAX_NOTES),
      unchanged: 0,
      scopeLabel: folder ? `folder "${folder}"` : 'the whole vault',
    };

    for (const file of inScope.slice(0, SWEEP_MAX_NOTES)) {
      const markdown = await this.app.vault.cachedRead(file);
      plan.scanned += 1;
      const tags = suggestTagsLocally(
        markdown,
        this.settings.maxTags,
        existingFrontmatterTags(markdown),
        vocabulary
      );
      if (tags.length > 0) {
        plan.entries.push({ file, basename: file.basename, path: file.path, tags });
      } else {
        plan.unchanged += 1;
      }
    }

    return plan;
  }

  /**
   * Applies an approved sweep plan: for each approved note, the proposed
   * tags are merged into its frontmatter via the same head-splice the
   * backlog tag command uses - the note is re-read at apply time and only
   * its frontmatter head is replaced, so bodies are never rewritten.
   */
  private async applySweepEntries(chosen: SweepPlanEntry[]): Promise<void> {
    if (chosen.length === 0) {
      new Notice('Elias HiveMind: sweep applied to no notes - nothing was ticked.');
      return;
    }

    let applied = 0;
    for (const entry of chosen) {
      try {
        const current = await this.app.vault.read(entry.file);
        const { oldHead, newHead } = mergeTagsIntoFrontmatter(current, entry.tags);
        await this.app.vault.modify(entry.file, newHead + current.slice(oldHead.length));
        applied += 1;
      } catch (error) {
        console.error(`Elias HiveMind sweep error on ${entry.path}`, error);
      }
    }

    new Notice(
      applied > 0
        ? `Elias HiveMind: sweep added tags to ${applied} note${applied === 1 ? '' : 's'}.`
        : 'Elias HiveMind: sweep could not update any of the selected notes.',
      8000
    );
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
      } mentioned in this note but not yet linked. Applying wraps each mention in a wikilink where it stands.`,
      confirmText: 'Insert selected',
      items: suggestions,
      label: (s) => s.title,
      meta: (s) =>
        `${s.occurrences}x${s.viaAlias ? ' (alias)' : ''}${s.context ? ` · \u2026${s.context}\u2026` : ''}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;

        const { text, wrapped } = applyInlineLinks(editor.getValue(), chosen);
        if (wrapped === 0) {
          new Notice('Elias HiveMind: no mentions could be linked in place.');
          return;
        }
        editor.setValue(text);

        new Notice(
          `Elias HiveMind: linked ${wrapped} mention${wrapped === 1 ? '' : 's'} in place.`
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
        suggestTagsLocally(
          combined.join('\n\n'),
          this.settings.maxTags,
          existingTags,
          buildTagVocabulary(this.app)
        ),
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
      // The dated section also carries the Resurface list, under the same
      // rules as the backlog section: best-effort (a resurface failure must
      // not cost the digest), and only when the setting is on and at least
      // one note has gone cold - with no cold notes (or the toggle off)
      // the digest text is exactly what it was before Resurface existed.
      let resurfaceBlock: string | null = null;
      if (this.settings.resurfaceInDigest) {
        try {
          const resurfaced = await this.collectResurface(now);
          if (resurfaced.length > 0) {
            resurfaceBlock = buildResurfaceBlock(resurfaced.slice(0, 3));
          }
        } catch (resurfaceError) {
          console.error('Elias HiveMind resurface section error', resurfaceError);
        }
      }
      const withBacklog = (text: string): string => {
        let out = backlogBlock ? upsertBacklogBlock(text, backlogBlock, date) : text;
        if (resurfaceBlock) out = upsertResurfaceBlock(out, resurfaceBlock, date);
        return out;
      };

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
      progressLine: '',
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

    // The vault's tag vocabulary, built once per scan from the metadata
    // cache, so every item's tag suggestions prefer the tags (and the
    // spelling) the vault already uses.
    const vocabulary = buildTagVocabulary(this.app);

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
        if (!isContentWord(word, 4)) continue;
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
        tags: suggestTagsLocally(
          markdown,
          settings.maxTags,
          existingFrontmatterTags(markdown),
          vocabulary
        ),
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

    // The progress line compares this scan's pile against the previous
    // scan's, then this scan becomes the baseline for the next one. The
    // baseline lives in the settings object (the plugin's one storage
    // slot) and is written even when the pile is empty - an emptied pile
    // is exactly the progress the next run should be able to report.
    const totalUnread = scan.items.length + scan.omitted;
    scan.progressLine = backlogProgressLine(
      settings.backlogLastUnread,
      settings.backlogLastRunDate,
      totalUnread
    );
    const today = formatDigestDate(now);
    if (settings.backlogLastUnread !== totalUnread || settings.backlogLastRunDate !== today) {
      settings.backlogLastUnread = totalUnread;
      settings.backlogLastRunDate = today;
      void this.saveSettings();
    }

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

  /* ------------------------------------------------------------ resurface */

  /**
   * Ranks the vault's cold notes for Resurface. Candidates are markdown
   * notes untouched for at least the cold threshold, excluding the digest
   * note, the configuration folder, ignored folders, snoozed and
   * never-listed notes, and the unread backlog population (so the two
   * digests never double-count). Scoring is metadata-first - mtimes,
   * resolvedLinks backlink counts and metadata-cache tags; note content
   * is read only here, during an explicit command or digest run, for the
   * word-overlap relevance term, mirroring the backlog digest. The full
   * ranked list is returned; callers slice it (queue size for the modal,
   * three for the digest).
   */
  private async collectResurface(now: Date): Promise<ResurfaceItem[]> {
    const settings = this.settings;
    const nowMs = now.getTime();
    const thresholdDays = Math.max(1, Math.floor(settings.resurfaceColdDays) || 90);
    const ignored = parseIgnoreFolders(
      `${this.app.vault.configDir}, ${settings.ignoreFolders}`
    );
    const isExcluded = (file: TFile): boolean => {
      const lower = file.path.toLowerCase();
      return (
        file.path === DIGEST_NOTE_PATH ||
        ignored.some((folder) => lower.startsWith(folder + '/'))
      );
    };

    const all = this.app.vault.getMarkdownFiles();

    // The user's last 30 days of work: what a cold note can still be
    // relevant *to*. Capped like the digests cap their scans.
    const recentCutoff = nowMs - RESURFACE_RECENT_WINDOW_MS;
    const recent = all
      .filter((file) => !isExcluded(file) && file.stat.mtime >= recentCutoff)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, DIGEST_MAX_NOTES);

    // How many recent notes carry each tag (metadata cache only).
    const recentTagNotes = new Map<string, number>();
    for (const file of recent) {
      for (const tag of fileTags(this.app, file)) {
        recentTagNotes.set(tag, (recentTagNotes.get(tag) ?? 0) + 1);
      }
    }

    // The recent notes' working vocabulary: significant words they use at
    // least twice between them - the backlog digest's corpus rule.
    const corpusFreq = new Map<string, number>();
    for (const file of recent) {
      for (const word of tokenize(toPlainText(await this.app.vault.cachedRead(file)))) {
        if (!isContentWord(word, 4)) continue;
        corpusFreq.set(word, (corpusFreq.get(word) ?? 0) + 1);
      }
    }
    const corpus = new Set(
      Array.from(corpusFreq.keys()).filter((word) => (corpusFreq.get(word) ?? 0) >= 2)
    );

    const vocabulary = buildTagVocabulary(this.app);
    const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};
    const backlogFolders = parseBacklogFolders(settings.backlogFolders);
    const backlogTagSet = new Set(parseBacklogTags(settings.backlogTags));
    const archive = settings.backlogArchiveFolder
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    const snoozes = settings.resurfaceSnoozes ?? {};
    const neverShow = settings.resurfaceNeverShow ?? [];

    const items: ResurfaceItem[] = [];
    for (const file of all) {
      if (isExcluded(file)) continue;

      const ageDays = Math.floor((nowMs - file.stat.mtime) / BACKLOG_DAY_MS);
      if (ageDays < thresholdDays) continue;
      if (isResurfaceSuppressed(file.path, snoozes, neverShow, nowMs)) continue;

      // Unread backlog belongs to the backlog digest. The read marker is
      // proven from the metadata cache where possible; otherwise the
      // note's content - read below anyway - settles it.
      const cache = this.app.metadataCache.getFileCache(file);
      const cachedRead = cache?.frontmatter
        ? cache.frontmatter[BACKLOG_READ_KEY]
        : undefined;
      const provenRead = cachedRead === true || cachedRead === 'true';
      let markdown: string | null = null;
      if (!provenRead) {
        const inBacklogScope =
          fileInAnyFolder(file.path, backlogFolders) ||
          (backlogTagSet.size > 0 &&
            fileTags(this.app, file).some((t) => backlogTagSet.has(t)));
        if (inBacklogScope) {
          markdown = await this.app.vault.cachedRead(file);
          if (
            isUnreadBacklogSelection(
              this.app,
              file,
              backlogFolders,
              backlogTagSet,
              archive,
              markdown
            )
          ) {
            continue;
          }
        }
      }

      if (markdown === null) markdown = await this.app.vault.cachedRead(file);

      // The strongest tag this note shares with the recent notes: most
      // recent notes carrying it wins, the normalised tag breaks ties.
      let sharedTag: string | null = null;
      let sharedTagKey = '';
      let sharedTagNotes = 0;
      for (const tag of fileTags(this.app, file)) {
        const count = recentTagNotes.get(tag) ?? 0;
        if (
          count > sharedTagNotes ||
          (count === sharedTagNotes && count > 0 && tag < sharedTagKey)
        ) {
          sharedTagNotes = count;
          sharedTagKey = tag;
          sharedTag = vocabulary.get(tag)?.canonical ?? tag;
        }
      }

      let wordOverlap = 0;
      significantWordSet(toPlainText(markdown)).forEach((word) => {
        if (corpus.has(word)) wordOverlap += 1;
      });

      const facts: ResurfaceFacts = {
        ageDays,
        backlinks: countBacklinks(resolvedLinks, file.path),
        sharedTag,
        sharedTagNotes,
        wordOverlap,
      };
      items.push({
        ...facts,
        basename: file.basename,
        path: file.path,
        score: scoreResurfaceCandidate(facts),
        why: buildResurfaceWhy(facts),
      });
    }

    items.sort(compareResurfaceItems);
    return items;
  }

  /** Opens the Resurface review modal with the top of the ranked queue. */
  private async runResurface(): Promise<void> {
    try {
      const ranked = await this.collectResurface(new Date());
      const queueSize = Math.max(1, Math.floor(this.settings.resurfaceQueueSize) || 5);
      new ResurfaceModal(this.app, {
        items: ranked.slice(0, queueSize),
        emptyText:
          'Nothing has gone cold yet — no note has been untouched for ' +
          `${Math.max(1, Math.floor(this.settings.resurfaceColdDays) || 90)} days or more.`,
        onOpen: (item) => {
          this.openResurfaceItem(item);
        },
        onSnooze: (item) => {
          this.applyResurfaceSnooze(item);
        },
        onNever: (item) => {
          this.applyResurfaceNever(item);
        },
      }).open();
    } catch (error) {
      console.error('Elias HiveMind resurface error', error);
      new Notice(`Elias HiveMind: resurface failed. ${describeError(error)}`, 10000);
    }
  }

  /** Opens a resurfaced note in the workspace. Reads and writes no content. */
  private openResurfaceItem(item: ResurfaceItem): void {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (!file) {
      new Notice(`Elias HiveMind: "${item.basename}" no longer exists.`);
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(file as TFile);
  }

  /**
   * Snoozes a note: only the plugin's own snooze map changes - no note
   * file is touched. The interval doubles with each snooze of the note.
   */
  private applyResurfaceSnooze(item: ResurfaceItem): void {
    const snoozes = { ...(this.settings.resurfaceSnoozes ?? {}) };
    const next = nextResurfaceSnooze(snoozes[item.path], Date.now());
    snoozes[item.path] = next;
    this.settings.resurfaceSnoozes = snoozes;
    void this.saveSettings();
    const days = RESURFACE_SNOOZE_BASE_DAYS * Math.pow(2, next.count - 1);
    new Notice(
      `Elias HiveMind: snoozed "${item.basename}" for ${days} days. It can resurface after that if it is still cold.`
    );
  }

  /** Excludes a note from Resurface permanently. Plugin-internal state only. */
  private applyResurfaceNever(item: ResurfaceItem): void {
    const neverShow = [...(this.settings.resurfaceNeverShow ?? [])];
    if (!neverShow.includes(item.path)) {
      neverShow.push(item.path);
      this.settings.resurfaceNeverShow = neverShow;
      void this.saveSettings();
    }
    new Notice(`Elias HiveMind: "${item.basename}" will not be resurfaced again.`);
  }

  /* ------------------------------------------------------- semantic index */

  /**
   * The files the semantic index covers: every markdown note outside the
   * digest note and the ignored folders - the Resurface exclusion shape.
   */
  private embeddingCandidateFiles(): TFile[] {
    const ignored = parseIgnoreFolders(
      `${this.app.vault.configDir}, ${this.settings.ignoreFolders}`
    );
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const lower = file.path.toLowerCase();
      return (
        file.path !== DIGEST_NOTE_PATH &&
        !ignored.some((folder) => lower.startsWith(folder + '/'))
      );
    });
  }

  /**
   * Builds or refreshes the embedding index with the user's local server
   * and persists it in the plugin's own data. Incremental: unchanged
   * notes are not re-embedded (their content hash still matches), deleted
   * or emptied notes drop out, and a model change rebuilds everything.
   * Progress is saved after every batch, so a server failure mid-build
   * keeps the batches that already landed; the failure itself propagates
   * to the caller. Returns the run's counts.
   */
  async buildEmbeddingIndex(): Promise<{ embedded: number; removed: number; total: number }> {
    const settings = this.settings;
    const model = settings.embeddingModel.trim();
    if (!model) throw new Error('No embedding model is set.');

    const sources = new Map<string, string>();
    const entries: Array<{ path: string; hash: string }> = [];
    for (const file of this.embeddingCandidateFiles()) {
      const source = embeddingSourceText(await this.app.vault.cachedRead(file));
      if (!source) continue; // No readable text: nothing to embed.
      sources.set(file.path, source);
      entries.push({ path: file.path, hash: contentHash(source) });
    }

    const index: Record<string, EmbeddingIndexEntry> = { ...(settings.embeddingIndex ?? {}) };
    const plan = planEmbeddingIndex(entries, index, settings.embeddingIndexModel ?? '', model);
    for (const path of plan.toRemove) delete index[path];

    let embedded = 0;
    for (let i = 0; i < plan.toEmbed.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = plan.toEmbed.slice(i, i + EMBEDDING_BATCH_SIZE);
      const vectors = await embedTextsViaBackend(
        settings,
        batch.map((path) => sources.get(path) ?? '')
      );
      batch.forEach((path, j) => {
        index[path] = { hash: contentHash(sources.get(path) ?? ''), vector: vectors[j] };
      });
      embedded += batch.length;
      this.settings.embeddingIndex = { ...index };
      this.settings.embeddingIndexModel = model;
      await this.saveSettings();
    }

    if (plan.toRemove.length > 0 || plan.toEmbed.length === 0) {
      this.settings.embeddingIndex = { ...index };
      this.settings.embeddingIndexModel = model;
      await this.saveSettings();
    }

    return { embedded, removed: plan.toRemove.length, total: Object.keys(index).length };
  }

  /** Command wrapper: build/refresh the index, reporting the outcome. */
  private async runBuildEmbeddingIndex(): Promise<void> {
    const pending = new Notice('Elias HiveMind: building the embedding index...', 0);
    try {
      const stats = await this.buildEmbeddingIndex();
      new Notice(
        `Elias HiveMind: embedding index ready — ${stats.total} note${stats.total === 1 ? '' : 's'} indexed ` +
          `(${stats.embedded} embedded, ${stats.removed} removed) by "${this.settings.embeddingModel.trim()}".`
      );
    } catch (error) {
      console.error('Elias HiveMind embedding index error', error);
      new Notice(
        `Elias HiveMind: embedding index failed. ${describeError(error)} ` +
          'Semantic features need your local server running with an embedding model.',
        10000
      );
    } finally {
      pending.hide();
    }
  }

  /** The configured result count for the semantic surfaces, clamped sane. */
  private relatedNotesLimit(): number {
    return Math.max(1, Math.floor(this.settings.relatedNotesCount) || 5);
  }

  /**
   * Related notes for the note in the editor: refresh the index, then
   * rank the vault against the current note's own vector. Read-only for
   * notes - the only writes are the index refresh in plugin data.
   */
  private async runRelatedNotes(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file ?? this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('Elias HiveMind: no active note.');
      return;
    }

    const pending = new Notice('Elias HiveMind: finding related notes...', 0);
    try {
      await this.buildEmbeddingIndex();
      const entry = (this.settings.embeddingIndex ?? {})[file.path];
      if (!entry) {
        new Notice(
          `Elias HiveMind: "${file.basename}" has no embeddable text, or sits in an ignored folder - nothing to compare.`
        );
        return;
      }
      const related = rankRelatedNotes(
        this.settings.embeddingIndex,
        file.path,
        entry.vector,
        this.relatedNotesLimit()
      );
      new RelatedNotesModal(this.app, {
        title: `Related to "${file.basename}"`,
        intro:
          `${related.length} note${related.length === 1 ? '' : 's'} closest in meaning, ` +
          `ranked by your local model "${this.settings.embeddingModel.trim()}". Nothing was written.`,
        items: related,
        emptyText:
          'No other indexed note is similar to this one yet. Similarity is computed ' +
          'locally from the embedding index - broaden the note, or build the index ' +
          'again once more of the vault is written.',
        onOpen: (item) => {
          this.openRelatedNote(item);
        },
      }).open();
    } catch (error) {
      console.error('Elias HiveMind related notes error', error);
      new Notice(
        `Elias HiveMind: related notes failed. ${describeError(error)} ` +
          'Semantic features need your local server running with an embedding model.',
        10000
      );
    } finally {
      pending.hide();
    }
  }

  /**
   * Semantic lookup: refresh the index, then open the lookup modal. The
   * query itself is embedded only when the user presses Search.
   */
  private async runSemanticLookup(): Promise<void> {
    const pending = new Notice('Elias HiveMind: preparing the embedding index...', 0);
    try {
      await this.buildEmbeddingIndex();
    } catch (error) {
      console.error('Elias HiveMind semantic lookup error', error);
      new Notice(
        `Elias HiveMind: semantic lookup failed. ${describeError(error)} ` +
          'Semantic features need your local server running with an embedding model.',
        10000
      );
      return;
    } finally {
      pending.hide();
    }

    new SemanticLookupModal(this.app, {
      intro:
        'Find notes by meaning, not keywords. Your phrase is embedded by your ' +
        `local model "${this.settings.embeddingModel.trim()}" and ranked against the index. Nothing leaves this device.`,
      onSearch: async (query) => {
        const vectors = await embedTextsViaBackend(this.settings, [
          embeddingSourceText(query),
        ]);
        return rankRelatedNotes(
          this.settings.embeddingIndex ?? {},
          '',
          vectors[0],
          this.relatedNotesLimit()
        );
      },
      onOpen: (item) => {
        this.openRelatedNote(item);
      },
    }).open();
  }

  /** Opens a related note in the workspace. Reads and writes no content. */
  private openRelatedNote(item: RelatedNote): void {
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (!file) {
      new Notice(`Elias HiveMind: "${item.basename}" no longer exists.`);
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(file as TFile);
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
      existingFrontmatterTags(markdown),
      buildTagVocabulary(this.app)
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
   * the editor command, applied the same way - once the user confirms the
   * checklist, each chosen mention in the open clipping is wrapped in a
   * wikilink in place via the shared applyInlineLinks helper.
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
      } mentioned in this clipping but not yet linked. Applying wraps each mention in a wikilink where it stands.`,
      confirmText: 'Insert selected',
      items: suggestions,
      label: (s) => s.title,
      meta: (s) =>
        `${s.occurrences}x${s.viaAlias ? ' (alias)' : ''}${s.context ? ` \u00b7 \u2026${s.context}\u2026` : ''}`,
      onSubmit: (chosen) => {
        if (chosen.length === 0) return;
        void (async () => {
          const current = await this.app.vault.read(file);
          const { text, wrapped } = applyInlineLinks(current, chosen);
          if (wrapped === 0) {
            new Notice('Elias HiveMind: no mentions could be linked in place.');
            return;
          }
          await this.app.vault.modify(file, text);
          new Notice(
            `Elias HiveMind: linked ${wrapped} mention${wrapped === 1 ? '' : 's'} in place.`
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
   * Applies a backend preset to the plugin settings: fills the URL and
   * request format only, saves, and refreshes the model list and the tab
   * (the URL/format rows show the preset's values). No network call is
   * made by applying a preset itself; the model-list refresh that follows
   * is the same one the Request format control already triggers.
   * Returns false for an unknown preset id, changing nothing.
   */
  applyBackendPreset(presetId: string): boolean {
    if (!applyBackendPreset(this.plugin.settings, presetId)) return false;
    // The model list belongs to the old endpoint; refetch for the new one.
    this.modelState = 'idle';
    void this.plugin.saveSettings();
    this.loadModels();
    this.refresh();
    return true;
  }

  /** Restores both prompt templates to their defaults, saves and re-renders. */
  resetPromptsToDefaults(): void {
    resetPromptsToDefaults(this.plugin.settings);
    void this.plugin.saveSettings();
    this.refresh();
  }

  /** Applies the Backend preset row's description and one-click dropdown. */
  private configurePresetSetting(setting: Setting): void {
    setting
      .setName('Backend preset')
      .setDesc(
        'Fill in the Backend URL and Request format for a local server you run yourself. ' +
          'Applies on selection and makes no connection by itself.'
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Choose a local server...');
        for (const preset of BACKEND_PRESETS) dropdown.addOption(preset.id, preset.name);
        dropdown.setValue(backendPresetIdFor(this.plugin.settings)).onChange((value) => {
          if (value) this.applyBackendPreset(value);
        });
      });
  }

  private renderPresetSetting(containerEl: HTMLElement): void {
    this.configurePresetSetting(new Setting(containerEl));
  }

  /** Applies one prompt row's textarea, bound to a single prompt field. */
  private configurePromptSetting(
    setting: Setting,
    key: 'backendPrompt' | 'tagPrompt',
    name: string,
    desc: string
  ): void {
    setting
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) =>
        text.setValue(this.plugin.settings[key]).onChange((value) => {
          // Verbatim, like the other free-text controls: prompts are the
          // user's words, so no trimming or coercion is applied.
          this.plugin.settings[key] = value;
          void this.plugin.saveSettings();
        })
      );
  }

  private renderPromptSetting(
    containerEl: HTMLElement,
    key: 'backendPrompt' | 'tagPrompt',
    name: string,
    desc: string
  ): void {
    this.configurePromptSetting(new Setting(containerEl), key, name, desc);
  }

  /** Applies the Reset prompts row's button. */
  private configureResetPromptsSetting(setting: Setting): void {
    setting
      .setName('Reset prompts')
      .setDesc('Restore both prompt templates to their defaults.')
      .addButton((button) =>
        button.setButtonText('Reset to defaults').onClick(() => {
          this.resetPromptsToDefaults();
        })
      );
  }

  private renderResetPromptsSetting(containerEl: HTMLElement): void {
    this.configureResetPromptsSetting(new Setting(containerEl));
  }

  /**
   * Builds/refreshes the embedding index from the settings tab: the same
   * public plugin method the command runs, with the outcome reported as a
   * notice. The index build is the one settings action that talks to the
   * user's local server - embedding the vault is what the button says.
   */
  buildEmbeddingIndexFromSettings(): void {
    void this.plugin
      .buildEmbeddingIndex()
      .then((stats) => {
        new Notice(
          `Elias HiveMind: embedding index ready — ${stats.total} note${stats.total === 1 ? '' : 's'} indexed ` +
            `(${stats.embedded} embedded, ${stats.removed} removed).`
        );
      })
      .catch((error: unknown) => {
        console.error('Elias HiveMind embedding index error', error);
        new Notice(
          `Elias HiveMind: embedding index failed. ${describeError(error)}`,
          10000
        );
      });
  }

  /** Applies the Build embedding index row's button. */
  private configureBuildIndexSetting(setting: Setting): void {
    setting
      .setName('Build embedding index')
      .setDesc(
        'Embed every note with your local server and store the index in this plugin’s data. ' +
          'Unchanged notes are skipped; the first build of a large vault can take a while.'
      )
      .addButton((button) =>
        button.setButtonText('Build index').onClick(() => {
          this.buildEmbeddingIndexFromSettings();
        })
      );
  }

  private renderBuildIndexSetting(containerEl: HTMLElement): void {
    this.configureBuildIndexSetting(new Setting(containerEl));
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

    this.renderPresetSetting(containerEl);

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

    new Setting(containerEl).setName('Prompts').setHeading();

    this.renderPromptSetting(
      containerEl,
      'backendPrompt',
      'Summary prompt',
      'Template sent to the backend when summarising. {{n}} is the summary length, {{content}} the note text.'
    );

    this.renderPromptSetting(
      containerEl,
      'tagPrompt',
      'Tag prompt',
      'Template sent to the backend when suggesting tags. {{n}} is the maximum number of tags, {{content}} the note text.'
    );

    this.renderResetPromptsSetting(containerEl);

    new Setting(containerEl).setName('Embeddings').setHeading();

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Model your local server uses for Related notes and Semantic lookup. An embedding model (e.g. nomic-embed-text), not a chat model. Changing it rebuilds the index.')
      .addText((text) =>
        text
          .setPlaceholder('nomic-embed-text')
          .setValue(this.plugin.settings.embeddingModel)
          .onChange((value) => {
            this.plugin.settings.embeddingModel = value.trim();
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Related notes shown')
      .setDesc('How many notes Related notes and Semantic lookup list at once.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.relatedNotesCount)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.relatedNotesCount = value;
            void this.plugin.saveSettings();
          })
      );

    this.renderBuildIndexSetting(containerEl);

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

    new Setting(containerEl).setName('Resurface').setHeading();

    new Setting(containerEl)
      .setName('Cold threshold (days)')
      .setDesc('A note untouched for at least this many days counts as gone cold and can be resurfaced.')
      .addSlider((slider) =>
        slider
          .setLimits(7, 365, 1)
          .setValue(this.plugin.settings.resurfaceColdDays)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.resurfaceColdDays = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Resurface queue size')
      .setDesc('How many forgotten notes the Resurface forgotten notes command shows at once.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.resurfaceQueueSize)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.resurfaceQueueSize = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Resurface section in weekly digest')
      .setDesc('When on, each weekly digest carries a "Worth another look" list of the three highest-ranked cold notes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.resurfaceInDigest).onChange((value) => {
          this.plugin.settings.resurfaceInDigest = value;
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

      case 'embeddingModel':
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
            // The declarative control vocabulary has no "apply a preset"
            // control, so the preset dropdown stays imperative, like the
            // Model row below: same control, same behaviour, both paths.
            name: 'Backend preset',
            aliases: ['ollama', 'lm studio', 'llama.cpp', 'jan'],
            render: (setting) => {
              this.configurePresetSetting(setting);
            },
          },
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
        heading: 'Prompts',
        items: [
          {
            // No textarea control exists in the declarative vocabulary
            // (toggle/text/dropdown/number/slider only), so the prompt
            // rows stay imperative via render - the Model-row precedent -
            // giving both settings paths the identical textarea.
            name: 'Summary prompt',
            aliases: ['backendPrompt', 'prompt'],
            render: (setting) => {
              this.configurePromptSetting(
                setting,
                'backendPrompt',
                'Summary prompt',
                'Template sent to the backend when summarising. {{n}} is the summary length, {{content}} the note text.'
              );
            },
          },
          {
            name: 'Tag prompt',
            aliases: ['tagPrompt', 'prompt'],
            render: (setting) => {
              this.configurePromptSetting(
                setting,
                'tagPrompt',
                'Tag prompt',
                'Template sent to the backend when suggesting tags. {{n}} is the maximum number of tags, {{content}} the note text.'
              );
            },
          },
          {
            // No button control exists declaratively either; render again.
            name: 'Reset prompts',
            render: (setting) => {
              this.configureResetPromptsSetting(setting);
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Embeddings',
        items: [
          {
            name: 'Embedding model',
            desc: 'Model your local server uses for Related notes and Semantic lookup. An embedding model (e.g. nomic-embed-text), not a chat model. Changing it rebuilds the index.',
            control: {
              type: 'text',
              key: 'embeddingModel',
              placeholder: 'nomic-embed-text',
              defaultValue: DEFAULT_SETTINGS.embeddingModel,
            },
          },
          {
            name: 'Related notes shown',
            desc: 'How many notes Related notes and Semantic lookup list at once.',
            control: {
              type: 'slider',
              key: 'relatedNotesCount',
              min: 1,
              max: 10,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.relatedNotesCount,
            },
          },
          {
            // No button control exists in the declarative vocabulary, so
            // the build action stays imperative via render - the Reset
            // prompts precedent - identical in both settings paths.
            name: 'Build embedding index',
            render: (setting) => {
              this.configureBuildIndexSetting(setting);
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
      {
        type: 'group',
        heading: 'Resurface',
        items: [
          {
            name: 'Cold threshold (days)',
            desc: 'A note untouched for at least this many days counts as gone cold and can be resurfaced.',
            control: {
              type: 'slider',
              key: 'resurfaceColdDays',
              min: 7,
              max: 365,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.resurfaceColdDays,
            },
          },
          {
            name: 'Resurface queue size',
            desc: 'How many forgotten notes the Resurface forgotten notes command shows at once.',
            control: {
              type: 'slider',
              key: 'resurfaceQueueSize',
              min: 1,
              max: 20,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.resurfaceQueueSize,
            },
          },
          {
            name: 'Resurface section in weekly digest',
            desc: 'When on, each weekly digest carries a "Worth another look" list of the three highest-ranked cold notes.',
            control: {
              type: 'toggle',
              key: 'resurfaceInDigest',
              defaultValue: DEFAULT_SETTINGS.resurfaceInDigest,
            },
          },
        ],
      },
    ];
  }
}

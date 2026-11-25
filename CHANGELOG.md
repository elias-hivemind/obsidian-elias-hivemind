# Changelog

All notable changes to Elias HiveMind. Versions match `manifest.json`; each
release is cut from the tag of the same name (no `v` prefix).

## 1.8.0

- **Non-English notes: Unicode tokenization + multilingual stopwords.**
  The local engine (summarizer, tagger, link finder, backlog and
  resurface relevance) no longer assumes plain English ASCII. Until
  now the tokenizer only matched `[a-z0-9...]`, so accented words
  split apart and CJK text produced almost no tokens - summaries came
  out empty or mangled and tags were stripped of their accents, with
  no error telling the user why.
- **Unicode-aware tokenization.** A token is now a sequence of Unicode
  letters/numbers, so accented Latin, Cyrillic, Greek and other
  scripts stay whole. Every local path shares the one tokenizer, so
  the fix applies everywhere at once.
- **Stopwords for six languages.** The English list is joined by
  modest, high-confidence lists for Spanish, French, German,
  Portuguese and Italian, applied as one union: a word that is a
  stopword in any supported language is filtered everywhere. That is
  a deliberate trade-off - the plugin does no language detection -
  and it can occasionally filter a content word that is a function
  word in another language (German *die* is the stock example).
- **CJK tokenization, honestly stated.** Chinese, Japanese and Korean
  text has no spaces, and the plugin ships no segmentation
  dictionary. Each run of CJK characters is instead tokenised as
  overlapping bigrams (characters 1-2, 2-3, 3-4, ...); a
  one-character run stays a single character and a two-character run
  stays whole. Real words appear as bigrams, so summaries, tags and
  relevance work; some bigrams straddle word boundaries, so CJK
  results are useful rather than exact.
- **Tag normalisation preserves Unicode letters.** Accented
  characters survive (`café` stays `café`) instead of being stripped;
  lowercasing, spaces-to-hyphens, the purely-numeric rejection and
  the 40-character cap are unchanged, and ASCII behaviour is
  identical.
- **Verification:** test suite 361 checks, all passing (339 at 1.7.0;
  +22 in a new section covering Spanish/French/German summaries and
  tags with stopwords excluded, accented tags surviving
  normalisation, Chinese/Japanese summaries and tags via the bigram
  rule, and English regression). No existing check was removed,
  weakened or changed. Typecheck (`tsc --noEmit`) clean. The built
  `dist/main.js` is byte-identical when the patch is applied to a
  pristine copy of the previous release's tree and rebuilt
  (reproduce-from-patch).

## 1.7.0

- **Local embeddings: related notes and semantic lookup.** Three new
  commands compute note vectors with an embedding model on the same
  local server as the other backend features - no new server to
  configure, because the embedding endpoint is derived from the backend
  already set up (Ollama `/api/embed`, or `/v1/embeddings` on
  OpenAI-compatible servers: LM Studio, llama.cpp, Jan). The vectors
  are stored only in the plugin's own `data.json`, on this device, and
  no embedding request is ever made in the background.
- **Build embedding index (local server)** embeds every note with
  text - the digest note, the configuration folder and ignored folders
  excluded, the same candidate shape as Resurface - keyed by a hash of
  the exact text embedded. Rebuilds are incremental: unchanged notes
  cost no requests, changed notes re-embed, deleted or emptied notes
  drop out, and changing the embedding model rebuilds everything,
  because vectors from different models are not comparable. A build
  saves after every batch of 16, so a server dying mid-build keeps the
  batches that landed; a response whose vector count or dimensions do
  not match the request fails the build instead of writing a corrupt
  index.
- **Related notes for current note (semantic)** ranks the rest of the
  vault against the open note by cosine similarity and shows the top
  matches in a review modal, each with its similarity as a percentage
  and an **Open** button. Zero or negative similarity is never shown:
  an unrelated note is not a result.
- **Semantic lookup: find notes by meaning** embeds a phrase you type
  and ranks the whole vault against it, in the same modal. Opening the
  modal makes no request; the search runs when you click **Search**.
- **Settings** gain an **Embeddings** group between Prompts and Tags:
  **Embedding model** (default `nomic-embed-text`), **Related notes
  shown** (1-10, default 5) and a **Build index** button that runs the
  same build and reports its counts.
- **Commands and modals, not a sidebar pane.** The roadmap said
  "sidebar pane"; the plugin has no view infrastructure at all, and
  every discovery feature it has - Resurface above all - is a command
  plus a modal, so that is the shape this ships in. Same ranking, same
  honesty, no new surface to learn.
- **Honest costs, stated in the README:** a first index of a
  ~5,000-note vault takes tens of minutes on a local server, and
  embedding is heavy on mobile - build on desktop and let the index
  sync. With no local server running, the three commands fail plainly
  and change nothing; everything else works exactly as before, fully
  offline.
- **Verification:** test suite 339 checks, all passing (302 at 1.6.0;
  +37, including hand-computed cosine rankings against a deterministic
  fake embedding server, the incremental-index rules, and both
  endpoint shapes). Two existing expectations changed, both for the
  new feature and both marked in the suite: the registered-command
  list gains the three embedding commands, and the settings-definition
  groups go from seven to eight with two new control keys. Typecheck
  (`tsc --noEmit`) clean. The built `dist/main.js` is byte-identical
  when the patch is applied to a pristine checkout of the previous
  release and rebuilt (reproduce-from-patch).

## 1.6.0

- **One-click backend presets.** The Backend settings now open with a
  **Backend preset** dropdown: pick Ollama, LM Studio, llama.cpp server
  or Jan and the **Backend URL** and **Request format** are filled in for
  you - Ollama at `http://127.0.0.1:11434/api/generate` (Ollama format),
  LM Studio at `http://127.0.0.1:1234/v1/chat/completions`, llama.cpp
  server at `http://127.0.0.1:8080/v1/chat/completions` and Jan at
  `http://127.0.0.1:1337/v1/chat/completions` (all three
  OpenAI-compatible). All four are servers you run on your own machine:
  no cloud endpoint, no API key, and applying a preset makes no
  connection - it only fills in the two fields (the model list then
  refreshes for the new endpoint, as it already does when the format
  changes). The preset row shows the matching preset when the current
  URL and format match one exactly. Hand-typed URLs keep working exactly
  as before, including the model-list derivation (`/api/tags` for
  Ollama, `/v1/models` for OpenAI-compatible servers).
- **The prompts are editable in Settings.** The summary and tag prompt
  templates (`backendPrompt` / `tagPrompt`), previously editable only by
  hand-editing `data.json` with Obsidian closed, now have text areas in
  a new **Prompts** settings group, in both settings interfaces, plus a
  **Reset to defaults** button that restores both templates to their
  shipped values. Editing a prompt changes only that field; the
  `{{n}}` and `{{content}}` placeholders work as before.

## 1.5.0

- **Link suggestions now link in place.** **Suggest links for current
  note** used to append a `- [[link]]` list under a `## Suggested links`
  heading at the bottom of the note, leaving you to wire up the actual
  mentions by hand. Applying a suggestion now wraps every mention of the
  chosen note in a wikilink where it stands — alias mentions as
  `[[Note name|alias]]` — and appends nothing. The review checklist is
  unchanged in shape (you still approve per note before any write) and
  now shows a snippet of the first mention in context beside each count.
  A mention whose surface differs from the note's title keeps its own
  words as the link's display text (`[[Compost Pile|compost piles]]`), so
  the sentence reads exactly as written. Mentions inside frontmatter,
  code blocks and inline code, existing links and URLs are never
  wrapped, and re-running the command on its own output wraps nothing
  twice. The **Backlog: link current note** command applies links the
  same way, through the same helper.
- **Wider, still conservative matching.** Link matching stays
  case-insensitive and whole-word, and now also recognises simple
  plurals — a title and its plural mention find each other either way
  round (trailing `s`/`es`, plus consonant-`y` → `ies`) — and a full
  multi-word title written with different separators (`Alpha Harvest`
  also matches `alpha-harvest` or `Alpha, Harvest`) or without its
  apostrophes/periods. Deliberately not added: substring or prefix
  matching, partial titles, stemming beyond plurals, or edit-distance
  fuzz — each can fire on words never meant as a mention, and a false
  link is worse than a missed one. All matching is deterministic local
  text processing: no embeddings, no backend, no network.

## 1.4.0

- **New: Resurface forgotten notes.** A new command, **Resurface
  forgotten notes**, builds a review queue of the notes that were read or
  written and then went cold — untouched for at least the *Cold
  threshold (days)* setting (default 90) — ranked by coldness ×
  connectedness (backlinks, from the metadata cache) × relevance (tags
  and vocabulary shared with the notes you edited in the last 30 days,
  using the vault tag vocabulary). Each entry says in plain words why it
  ranked — how long untouched, how many notes link to it, which shared
  tag ties it to this month's work — with clauses omitted when they are
  not true. Per note: **Open**, **Snooze** (30 days, doubling with each
  later snooze of the same note) or **Never show**; snoozing and
  dismissing write only the plugin's own data, never a note. The digest
  note, the configuration folder, ignored folders and the unread backlog
  population are excluded, so Resurface and the backlog digest never
  double-count. Nothing is enrolled and nothing runs in the background:
  the ranking is recomputed on each run, fully offline.
- **Weekly digest: "Worth another look".** Each dated digest section now
  also lists the top 3 resurfaced notes with their why-lines, gated by
  the *Resurface section in weekly digest* setting (on by default). With
  the setting off — or when no note has gone cold — the digest output is
  unchanged from 1.3.0.
- **New settings:** *Cold threshold (days)* (default 90), *Resurface
  queue size* (default 5) and *Resurface section in weekly digest*
  (default on), in a new Resurface settings group.

## 1.3.0

- **Vault-aware local tag suggestions.** The local tagger now reads the
  vault's existing tag vocabulary from the metadata cache (frontmatter and
  inline tags, counted per note — no note content is read) and prefers it
  over words it would otherwise invent: a candidate that matches an
  established tag is suggested in the form the vault writes it, casing
  included, and a candidate matching the last part of a nested tag
  suggests the full nested tag (`garden/compost`). Established tags rank
  ahead of new words. This applies everywhere the local tagger runs —
  the tag commands, the weekly digest's aggregate tags, the Backlog
  digest's per-item tags and the backlog apply-tags command. The backend
  tag path is unchanged.
- **New: Housekeeping sweep.** A new command, **Housekeeping sweep:
  suggest tags for a folder or the vault**, runs the local tagger over a
  scope you pick — the whole vault, or a folder including its subfolders —
  and presents a dry-run review: one row per note with the tags it would
  gain, for you to tick or untick. Nothing is written until you confirm,
  and applying writes frontmatter tag merges only — note bodies are never
  touched. At most 50 notes are scanned per run, in path order; the rest
  are counted in the review. The configuration folder, ignored folders
  and the digest note are excluded.
- **Backlog progress line.** From the second backlog scan on, the
  **Your backlog** section opens with a one-line progress report — how
  many clippings left the pile since the last run, or that it grew, or
  that nothing changed. The plugin remembers the previous run's unread
  count and date between runs; the first scan sets the baseline and shows
  no line.

## 1.2.0

- **New: Backlog digest.** A new command, **Backlog digest**, scans the
  folders where saved clippings pile up (settings: *Backlog folders*,
  default `Clippings, Inbox`) — plus any note carrying one of the
  *Backlog tags*, wherever it lives — and writes a **Your backlog** section into
  `Weekly Digest.md`; the weekly digest carries the same section as a
  standing part of each dated entry, so the pile shrinks weekly. Per
  clipping: a short local summary, suggested tags, read time and age,
  bucketed by relevance to your recent notes — *Worth reading now*
  (mentions or vocabulary shared with this week's notes, or just saved),
  *Reference* (substantial, evergreen), *Gone stale* (untouched past the
  *Stale after (days)* setting, default 30) and *Junk candidates*
  (near-empty or near-duplicate). Every bucket states its reason. At most
  50 unread clippings are digested per run, most recently saved first; the
  rest are counted for the next run. Clippings already in the archive
  folder, the configuration folder and ignored folders are excluded.
- **Processing commands for clippings** (each acts only on the note you run
  it on, and only when that note is in the backlog): **Backlog: apply
  suggested tags to current note**, **Backlog: link current note to the
  notes it mentions** (the usual unlinked-mention checklist, appended under
  a `## Suggested links` heading), **Backlog: mark current note as read**
  (writes a `hivemind-read: true` frontmatter marker, after which the
  clipping drops out of digests) and **Backlog: archive current note**
  (moves it into the *Archive folder*, default `Archive`, creating the
  folder if needed and refusing rather than overwriting a same-named
  note). The plugin never deletes anything, and nothing is moved or marked
  without one of these explicit commands.
- **Optional backlog themes:** with *Backlog themes via backend* on (off
  by default), a digest run also asks your configured backend to group the
  clippings into themes. The core digest needs no model and no network,
  and works on mobile exactly as on desktop.
- **Fixed:** running a Summarize command on a note that already has a
  summary under the configured heading now replaces that summary in place
  instead of stacking a second `## Summary` section. (A note whose summary
  heading setting has since been changed keeps the old section; only the
  current heading is recognised.)

## 1.1.0

- **New command: Weekly digest (local).** Collects the notes created or
  modified in the last seven days and writes a dated
  `## Weekly Digest — YYYY-MM-DD` section into a single `Weekly Digest.md`
  note: a wikilink heading and a local summary per note (most recently
  modified first), suggested links between notes in the same week, and tag
  suggestions aggregated across the week's notes. Re-running the command on
  the same day replaces that day's section; a week with nothing changed
  writes nothing. Weeks with more than 50 changed notes list the 50 most
  recent and count the rest. Fully offline, like the other local commands.
- `npm test` now builds first (a `pretest` script), so the test suite runs
  on a fresh clone instead of failing until `dist/main.js` exists.

## 1.0.2

- Fixed the community directory scan findings: `createSpan()` instead of
  `createEl('span')`, and a redundant type assertion removed.
- Release workflow attaches build provenance attestations for `main.js`,
  `manifest.json` and `styles.css`, and generates release notes.

## 1.0.1

- Fixed review warnings from the community directory scan.
- Release workflow moved to current action versions and Node 24.

## 1.0.0

- First release: local and backend note summarization, local and backend
  tag suggestions merged into frontmatter, and unlinked-mention link
  suggestions.

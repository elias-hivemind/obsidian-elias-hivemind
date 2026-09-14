# Elias HiveMind

Summaries, tag suggestions and link suggestions for Obsidian, working offline by default and using a local Ollama model when you want one.

- **Plugin id:** `elias-hivemind`
- **Version:** 1.0.2
- **Minimum Obsidian version:** 1.0.0
- **License:** MIT

---

## Contents

- [Features](#features)
- [Privacy](#privacy)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting to Ollama](#connecting-to-ollama)
- [Offline fallback](#offline-fallback)
- [Commands](#commands)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Features

### Local extractive summarization

Works with no network and no model. The summarizer:

1. Reduces the note to plain prose. Frontmatter, fenced and inline code, images, embeds, URLs and HTML are removed, and links are replaced by their display text.
2. Scores each sentence by how often its meaningful words (common stopwords excluded) appear across the note. Scores are normalised by sentence length, and earlier sentences get a small boost.
3. Keeps the highest-scoring sentences and returns them in their original order.

The same note always produces the same summary.

### Summaries with a local model

Sends the note's plain text to a model served by Ollama (or any OpenAI-compatible server) and inserts the reply. If the server can't be reached, the plugin can fall back to the local summarizer. See [Offline fallback](#offline-fallback).

### Tag suggestions

Suggests tags either locally or from your model. Local suggestions use the note's most frequent words of four or more letters, and prefer words that appear more than once. The suggestions appear in a checklist, and the tags you keep are merged into the note's frontmatter:

- Tags are normalised to valid Obsidian tags: lowercase, no leading `#`, spaces become hyphens, and only letters, digits, `_`, `-` and `/` are kept. Purely numeric tags and tags over 40 characters are dropped.
- Tags already in the frontmatter are never suggested again or duplicated.
- The `tags:` field is written as a YAML list. Other frontmatter fields and the note body are not changed.
- If the note has no frontmatter, a frontmatter block is created at the top.

### Internal link suggestions

Finds other notes whose **title or alias** appears in the current note as a whole word (case-insensitive) but isn't linked yet, and lets you choose which ones to link. It skips:

- the current note itself
- notes already linked from the current note
- mentions inside frontmatter, code, existing links and URLs
- titles shorter than the minimum title length
- notes in ignored folders

The chosen links are appended to the end of the note under a `## Suggested links` heading. Mentions found through an alias are inserted as `[[Note name|alias]]`.

---

## Privacy

- **Local commands** (every command marked *local*, and *Suggest links for current note*) make no network requests.
- **Suggest links for current note** reads the file list of the whole vault (the names, paths and aliases of your notes) to find mentions of them in the current note. It does this only when you run the command, and nothing it reads is stored or sent anywhere.
- **Backend commands** send the note's plain text, with frontmatter and code blocks removed, to the **Backend URL** you configure. The default is `http://127.0.0.1:11434/api/generate`, a local Ollama server, so the text doesn't leave your computer unless you change that URL.
- **Opening the settings tab** sends one request to the same server for its list of installed models. No note content is included.
- The plugin doesn't collect or send any usage data.

---

## Requirements

| For | You need |
|---|---|
| Local commands | Obsidian 1.0.0 or newer. Nothing else. |
| Backend commands | [Ollama](https://ollama.com) installed and running, with at least one model pulled. Any OpenAI-compatible server also works. |
| Building from source | Node.js 24 LTS (what the release workflow uses), plus npm. |

---

## Installation

Obsidian loads a plugin from `<vault>/.obsidian/plugins/<plugin-id>/`. The folder **must** be named `elias-hivemind` to match the id in `manifest.json`, and it must contain:

```
<vault>/.obsidian/plugins/elias-hivemind/
├── manifest.json
├── main.js
└── styles.css
```

`main.js` must sit directly in that folder. `styles.css` isn't needed for the plugin to load, but without it the suggestion dialog is unstyled. A plugin whose code is only at `dist/main.js` will show up in Obsidian but fail to load when enabled.

### Option 1: Build from source and install manually

```bash
npm ci
npm run build
```

This creates `dist/main.js`. Then:

1. Create the folder `<vault>/.obsidian/plugins/elias-hivemind/`.
2. Copy `manifest.json` into it.
3. Copy `dist/main.js` into it as `main.js`.
4. Copy `styles.css` into it.
5. In Obsidian, open **Settings → Community plugins**, turn on community plugins if they're off, and enable **Elias HiveMind**. If it isn't listed, use the reload button next to *Installed plugins*.

### Option 2: Use an install script

Both scripts copy `main.js` directly into the plugin folder.

**Node (any OS).** This script doesn't build, so run `npm run build` first:

```bash
npm run build
node scripts/install-to-vault.js --vault "/path/to/your/vault"
```

You can set the `OBSIDIAN_VAULT` environment variable instead of passing `--vault`. One of the two is required: without either, the script stops and prints usage. It checks the installed files, confirms your saved settings (`data.json`) weren't changed, and prints the size and SHA-256 hash of `main.js`.

**Bash (macOS / Linux / Git Bash).** This script builds the plugin itself:

```bash
./install.sh /path/to/your/vault
```

This runs `npm ci` and `npm run build`, then copies `main.js`, `manifest.json` and `styles.css` into the plugin folder in that vault, creating the folder if needed. Existing files are overwritten, and saved settings (`data.json`) are kept.

### Option 3: From a GitHub release

Every release includes `main.js`, `manifest.json` and `styles.css` as separate downloads, the same three files Obsidian installs from the community directory. From 1.0.2 each file has a build provenance attestation.

1. From the project's GitHub **Releases** page, download `main.js`, `manifest.json` and `styles.css`.
2. Optionally, confirm a file was built from this repository: `gh attestation verify main.js --repo elias-hivemind/obsidian-elias-hivemind`.
3. Put the files directly into `<vault>/.obsidian/plugins/elias-hivemind/`.
4. Enable the plugin under **Settings → Community plugins**.

---

## Connecting to Ollama

### 1. Install Ollama and pull a model

Install Ollama from [ollama.com](https://ollama.com), then pull a model. The plugin's default model is `llama3.2`:

```bash
ollama pull llama3.2
```

### 2. Make sure the server is running

The Ollama desktop app starts the server automatically. Otherwise run:

```bash
ollama serve
```

By default Ollama listens on `127.0.0.1:11434`. To check it's up:

```bash
curl http://127.0.0.1:11434/api/tags
```

This should return a JSON list of your installed models.

### 3. Configure the plugin

Open **Settings → Elias HiveMind Plugin → Backend**:

| Setting | Value for Ollama |
|---|---|
| Backend URL | `http://127.0.0.1:11434/api/generate` (the default). `http://localhost:11434/api/generate` also works if `localhost` resolves to `127.0.0.1` on your machine. |
| Request format | `Ollama` |
| Model | Choose from the dropdown. It lists the models Ollama reports as installed. Click **Refresh** after pulling a new model. |
| Timeout (ms) | `60000` by default. Raise it for large models or slow hardware. |

The model dropdown treats `llama3.2` and `llama3.2:latest` as the same model, as Ollama does.

### 4. Test the connection

Open the command palette and run **Elias HiveMind Plugin: Test backend connection**. It sends a short test sentence to the model and shows the reply, or the error if the request failed. This command always reports the raw result and never falls back.

### Using Ollama's OpenAI-compatible endpoint (or another server)

| Setting | Value |
|---|---|
| Backend URL | e.g. `http://127.0.0.1:11434/v1/chat/completions` |
| Request format | `OpenAI-compatible` |

In this mode the model list is read from `/v1/models` on the same server. The plugin sends no API key or authorization header, so it is meant for local servers that don't require one.

---

## Offline fallback

With **Fall back to local** turned on (the default), backend commands keep working when the model server doesn't:

| Situation | Summarize current note (backend) | Suggest tags for current note (backend) |
|---|---|---|
| Server not running / connection refused | Local summary inserted | Local tag suggestions shown |
| No response within the timeout | Local summary inserted | Local tag suggestions shown |
| HTTP error (e.g. model not found) | Local summary inserted | Local tag suggestions shown |
| Empty reply, or no usable tags | Local summary inserted | Local tag suggestions shown |

Each fallback shows a notice with the reason, for example: *backend unavailable (Backend did not respond within 60000 ms.). Summarised locally instead.*

With **Fall back to local** turned off, the same situations show an error notice and leave the note unchanged.

Notes:

- The timeout only stops the plugin waiting. The request to the server isn't cancelled.
- The first request after Ollama starts includes the time needed to load the model, which can take much longer than later requests. If that first request times out, raise **Timeout (ms)** or run it again once the model has loaded.

---

## Commands

All commands appear in the command palette prefixed with **Elias HiveMind:**.

| Command | Network | What it does |
|---|---|---|
| Summarize current note (local) | None | Inserts a local summary under the summary heading, at the configured insert position. |
| Summarize current note (backend) | Backend URL | Inserts a model-generated summary. Falls back to local if enabled. |
| Summarize selection (local) | None | Summarizes the selected text and inserts the heading and summary directly after the selection. Ignores the insert-position setting. |
| Suggest tags for current note (local) | None | Suggests tags from the note's most frequent words; you pick which to add to frontmatter. |
| Suggest tags for current note (backend) | Backend URL | Asks the model for tags; you pick which to add to frontmatter. Falls back to local if enabled. |
| Suggest links for current note | None | Lists notes mentioned but not linked; you pick which links to append. |
| Test backend connection | Backend URL | Sends a test sentence and shows the reply or the error. |

---

## Settings reference

### Summarization

| Setting | Default | Description |
|---|---|---|
| Summary length | `3` | Sentences to keep (1–10). The backend prompt asks the model for the same number. |
| Summary heading | `## Summary` | Markdown heading placed above an inserted summary. Leave blank for no heading. |
| Insert position | Top of note | Where a note summary is inserted: *Top of note*, *Bottom of note* or *At cursor*. |

### Backend

| Setting | Default | Description |
|---|---|---|
| Backend URL | `http://127.0.0.1:11434/api/generate` | Full endpoint URL that note text is sent to. |
| Request format | Ollama | *Ollama* sends `{ model, prompt }`. *OpenAI-compatible* sends `{ model, messages[] }`. |
| Model | `llama3.2` | A dropdown of the models installed on the backend, with a **Refresh** button. Shows a text field instead if the list can't be loaded. |
| Fall back to local | On | Use the local summarizer and tagger when the backend fails. |
| Timeout (ms) | `60000` | How long to wait for the backend. Invalid or non-positive values reset to the default. |

### Tags

| Setting | Default | Description |
|---|---|---|
| Maximum tags | `5` | Upper bound on new tags suggested at once (1–15). |

### Link suggestion

| Setting | Default | Description |
|---|---|---|
| Maximum suggestions | `20` | Upper bound on unlinked mentions offered at once (5–100). |
| Minimum title length | `4` | Titles and aliases shorter than this are ignored (2–15). |
| Ignore folders | `.trash, templates` | Comma-separated folder paths excluded from link suggestions. The vault's configuration folder (`.obsidian` unless you renamed it) is always excluded, whether or not it is listed here. |

### Prompts (no settings-tab control)

The prompts sent to the model are stored in the plugin's `data.json` (in the plugin folder) and can be edited there while Obsidian is closed. Both support two placeholders: `{{n}}` (summary length or maximum tags) and `{{content}}` (the note's plain text).

| Key | Default |
|---|---|
| `backendPrompt` | `Summarise the following note in {{n}} concise sentences. Return only the summary, with no preamble.` followed by the content |
| `tagPrompt` | `Suggest up to {{n}} short topic tags for the following note. Return only a comma-separated list of lowercase tags, with no preamble.` followed by the content |

Tag replies are split on commas and new lines. Leading list markers (`-`, `*`, `1.`) are removed before each tag is normalised.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Plugin is listed but fails to enable | `main.js` isn't directly in the plugin folder, or the folder name doesn't match `elias-hivemind`. See [Installation](#installation). |
| Model setting says *Could not list models* | Ollama isn't running, or the Backend URL is wrong. Start Ollama, check the URL, then click **Refresh**. |
| Model shows *(not installed)* | The configured model isn't installed on the server. Pull it (`ollama pull <model>`) or choose another. |
| Backend commands always fall back to local | Run **Test backend connection** to see the actual error. |
| *Backend did not respond within … ms* | The model is still loading or too slow for the timeout. Raise **Timeout (ms)**. |
| *Backend returned HTTP 404* | With Ollama this usually means the model name is wrong or the model isn't pulled. |
| No tags suggested locally | Local tagging ignores common stopwords, words under four letters and tags already in the frontmatter. A very short note may have nothing left. |

---

## Development

```bash
npm ci              # install exact dependency versions from package-lock.json
npm run dev         # rebuild on change
npm run build       # build dist/main.js
npm run typecheck   # TypeScript check, no output
npm test            # functional tests against the built dist/main.js
npm run health      # confirm dist/main.js exists and is not empty
npm run clean       # delete dist/
npm run package     # zip main.js + manifest.json + styles.css into build/elias-hivemind-<version>.zip
```

`npm run package` needs no extra dependencies. Before writing the zip, it checks that `manifest.json`, `package.json` and `versions.json` all have the same version. After writing, it reads the zip back to verify every file.

### Releasing

1. Set the new version in `manifest.json` and `package.json`, and add it to `versions.json` mapped to the minimum Obsidian version, e.g. `"1.0.2": "1.0.0"`.
2. Commit, then push a tag that is exactly that version, with no `v` prefix:

   ```bash
   git tag -a 1.0.2 -m "Elias HiveMind 1.0.2"
   git push origin 1.0.2
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) runs typecheck, build, tests and packaging, and fails if the tag doesn't match `manifest.json`. It then creates build provenance attestations for `main.js`, `manifest.json` and `styles.css`, and publishes a GitHub release with those three files and generated release notes. The verified zip is kept as a workflow artifact, not a release asset.

`npm test` runs `test/run-tests.js`, which loads the **built bundle** with a stubbed Obsidian API and exercises every command: local and backend summaries, fallback on refused connections, timeouts and HTTP errors, tag normalisation and frontmatter merging, link suggestions, model listing for both request formats, and settings persistence. Run `npm run build` before `npm test`.

### Project layout

| Path | Purpose |
|---|---|
| `src/main.ts` | Plugin source: commands, summarizer, tagging, link suggestion, backend client, settings tab |
| `types/obsidian.d.ts` | Minimal hand-written type declarations for the Obsidian API used by the plugin |
| `rollup.config.js` | Bundles `src/main.ts` into a single CommonJS `dist/main.js` |
| `test/run-tests.js` | Functional test suite |
| `scripts/install-to-vault.js` | Installs the build into a vault |
| `scripts/package.js` | Builds and verifies the release zip |
| `scripts/health.js` | Build artifact check |
| `manifest.json` | Obsidian plugin manifest |
| `versions.json` | Maps each plugin version to its minimum Obsidian version |
| `.github/workflows/release.yml` | Tag-triggered release workflow |

---

## License

MIT License

Copyright (c) 2026 Elias HiveMind

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

See [LICENSE](LICENSE) for the full text.

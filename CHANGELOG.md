# Changelog

All notable changes to Elias HiveMind. Versions match `manifest.json`; each
release is cut from the tag of the same name (no `v` prefix).

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

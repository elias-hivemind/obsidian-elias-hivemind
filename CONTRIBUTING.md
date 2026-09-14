# Contributing to Elias HiveMind

Thanks for taking the time to help. This is a small plugin, so the process is short.

## Getting set up

You need Node.js 24 LTS (what the release workflow uses), plus npm, and an Obsidian
vault you don't mind experimenting in.

```bash
git clone https://github.com/elias-hivemind/obsidian-elias-hivemind.git
cd obsidian-elias-hivemind
npm ci              # exact versions from package-lock.json
npm run build       # produces dist/main.js
```

To load your build into a vault:

```bash
node scripts/install-to-vault.js --vault "/path/to/your/vault"
```

Then enable **Elias HiveMind** in **Settings → Community plugins**. `npm run dev`
rebuilds on change; reload the plugin in Obsidian to pick up a new build.

See the [Development](README.md#development) section of the README for the full
script list and the [Project layout](README.md#project-layout) table for where
things live.

## Before you open a pull request

Run all three. The release workflow runs the same checks and fails the release if
any of them fail.

```bash
npm run typecheck   # TypeScript, no emit
npm run build       # dist/main.js
npm test            # functional suite against the built bundle
```

`npm test` loads the **built** bundle, so build before you test.

## Code guidelines

- **Build DOM with Obsidian's helpers**, not `document.createElement`. Use
  `createDiv()`, `createSpan()` and `createEl('input' | 'button' | ...)` on a parent
  element. Never assign `innerHTML`, `outerHTML` or use `insertAdjacentHTML` — the
  community directory review flags it, and it is an injection risk.
- **Don't add type assertions that the target type already accepts.** `npm run typecheck`
  and the directory review both flag redundant `as T`.
- **Add types to `types/obsidian.d.ts`** when you use an Obsidian API the file doesn't
  declare yet, and mirror it in the test shim in `test/run-tests.js`.
- **No new runtime dependencies.** The plugin ships as a single bundled `dist/main.js`
  and everything in `package.json` is a devDependency. Keep it that way.
- **No network requests outside the configured Backend URL.** Local commands must stay
  offline. Anything that changes what leaves the user's machine has to be reflected in
  the [Privacy](README.md#privacy) section of the README in the same pull request.
- **Cover new behaviour in `test/run-tests.js`**, including the failure path — refused
  connections, timeouts and HTTP errors are already covered for the backend client and
  new backend work should match.
- Target the `minAppVersion` in `manifest.json`; the plugin runs on desktop and mobile,
  so don't reach for Node or Electron APIs.

## Reporting a bug

Open an issue with your Obsidian version, your operating system, the plugin version,
the command you ran and what happened. If a backend command is involved, say which
server and model you pointed it at — with the URL redacted if it isn't local.

Please don't paste note content you'd rather not publish.

## Releasing

Maintainers only, and the steps are in
[Releasing](README.md#releasing). In short: bump `manifest.json`, `package.json` and
`versions.json` together, then push a tag equal to that version with no `v` prefix.
Pull requests should not bump the version — that happens in the release commit.

## License

Contributions are accepted under the [MIT License](LICENSE) that covers this project.

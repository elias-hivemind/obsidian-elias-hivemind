# Elias HiveMind — The Beginner Guide

**New to Obsidian? Start here.** Elias HiveMind reads the notes and articles
piling up in your vault and hands you a short digest: what each thing says,
what's worth reading now, what's gone stale, and what you can probably throw
away. It runs entirely on your own device — no account, no API key, nothing
leaves your phone or computer.

---

## The 3 steps (this is the whole thing)

### 1. Open any note and pull down

Open **any** note in your vault. Put your thumb at the **top of the note,
drag down, and let go.** A panel slides in — that's called the *command
palette*.

**How to know you got the right panel:** it has a **search box at the top**
("Type a command…"). If there's no search box, you're in Settings — back out
and pull down again.

> **The trap almost everyone hits first:** Settings → Command palette is
> *not* the palette. That screen is just a pin board — pinning a command
> there parks it at the top of the real palette for later. It does not run
> anything. And typing a command's name into a note does nothing either —
> commands only run from the real palette.

### 2. Tap "Elias HiveMind: Backlog digest"

Type `Backlog digest` in the search box (or find it under **Pinned
commands** if you pinned it) and tap it **once**. The panel closes and the
plugin reads your backlog. Give it a few seconds.

### 3. Open the "Weekly Digest" note

Tap the **folder icon** (top-left) to open your file list, then open the
note called **Weekly Digest**. Everything the plugin produced is in there:

- **The week's notes**, each with a short summary
- **Your backlog**, sorted into four piles, each with its reason:
  - **Worth reading now** — recent and on topics your vault cares about
  - **Reference** — older, but the kind of thing you keep to look up
  - **Gone stale** — old and untouched; probably safe to let go
  - **Junk candidates** — near-empty or scraped noise

That's it. Run it whenever the pile starts to feel heavy.

---

## Adding your stuff (feeding the backlog)

The digest can only chew on what's in the vault. Three ways to feed it:

- **Clip articles** with the free **Obsidian Web Clipper** browser
  extension — clips land in a folder called **Clippings**, which is exactly
  where HiveMind looks first.
- **Use the Inbox folder** — drop any notes you haven't dealt with into
  **Inbox** and they count as backlog too.
- **Different folder names?** Go to Settings → Elias HiveMind → **Backlog
  folders** and type your folder names there (one per line). You can also
  point it at **tags** instead: anything tagged with your backlog tag (set
  it under **Backlog tags**) counts, wherever it lives.

## Cleaning up from the digest

Inside the Weekly Digest, each backlog item offers one-tap actions:
**tag it, mark it read, archive it, or link it** to a related note.
Archiving moves the note to your **Archive** folder.

**HiveMind never deletes or moves anything on its own.** Nothing happens
to a note until you tap.

## The other commands (same palette, same pull-down)

- **Weekly digest (local)** — rebuild the digest from the last 7 days
- **Summarize note (local)** — a 2–3 line summary at the top of the open note
- **Summarize selection (local)** — summarize just the text you highlighted
- **Suggest tags (local)** — tag ideas for the open note, from your own vault
- **Suggest links** — notes this one should probably link to
- **Backlog: mark current note as read** — takes the open note out of the pile

## Optional: a model backend (desktop only)

On a computer running **Ollama**, HiveMind can optionally ask a local model
for richer summaries and cross-article themes. It's **off by default** and
never required — everything above works with no model at all.

**On a phone, don't bother:** there is no model server on a phone, so leave
**"Backlog themes via backend" OFF** and **"Fall back to local" ON**. If the
Model line in settings says *"Could not connect to the server,"* that's
normal on a phone — the built-in engine is doing the work.

## Make it one-tap

Pin the commands you use: Settings → Command palette → add **Backlog
digest** and **Weekly digest (local)**. They'll sit at the top of the real
palette every time you pull down.

## If something looks wrong

| What you see | What it means |
|---|---|
| Panel with no search box | You're in Settings, not the palette. Back out, pull down on a note. |
| "Could not connect to the server" (Model line) | Normal on phones. Local engine is working. |
| "No unread clippings waiting" | The folders in settings are empty. Clip something, or check your folder names in settings. |
| "No summarisable text in this note" | That note is empty or nearly empty — the plugin says so instead of guessing. |

---

*Elias HiveMind — offline summaries, tags, links & a weekly digest for Obsidian.*

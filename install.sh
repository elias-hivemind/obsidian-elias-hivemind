#!/usr/bin/env bash
set -euo pipefail
VAULT_DIR="${1:-}"
if [[ -z "$VAULT_DIR" ]]; then
  echo "Usage: $0 /path/to/obsidian/vault"
  exit 1
fi
if [[ ! -d "$VAULT_DIR/.obsidian" ]]; then
  echo "No .obsidian folder in $VAULT_DIR - that is not an Obsidian vault."
  exit 1
fi
PLUGIN_ID="elias-hivemind"
DEST="$VAULT_DIR/.obsidian/plugins/$PLUGIN_ID"
echo "Building plugin..."
npm ci
npm run build
echo "Copying to vault: $DEST"
# Files are overwritten in place rather than deleting the folder, so the
# user's saved settings (data.json) survive a reinstall.
mkdir -p "$DEST"
cp dist/main.js "$DEST/main.js"
cp manifest.json "$DEST/manifest.json"
if [[ -f styles.css ]]; then cp styles.css "$DEST/styles.css"; fi
echo "Installed into $DEST. In Obsidian, enable the plugin under Settings -> Community plugins."

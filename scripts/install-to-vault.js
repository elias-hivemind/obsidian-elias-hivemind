#!/usr/bin/env node
/**
 * Installs the built plugin into an Obsidian vault.
 *
 * The critical detail: Obsidian loads plugin code from the hard-coded path
 * `<plugin-dir>/main.js`. Folder discovery is non-recursive, and PluginManifest
 * has no field that redirects the entry point. A layout of
 * `<plugin-dir>/dist/main.js` makes the plugin APPEAR in Installed plugins and
 * then fail on toggle with "Plugin failure: <id>".
 *
 * So the build may output wherever it likes, but the install must FLATTEN:
 * manifest.json and main.js land as siblings at the plugin folder root.
 *
 * Usage (the vault is required; there is deliberately no default):
 *   node scripts/install-to-vault.js --vault "/path/to/Vault"
 *   OBSIDIAN_VAULT="/path/to/Vault" node scripts/install-to-vault.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE =
  'Usage:\n' +
  '    node scripts/install-to-vault.js --vault "/path/to/Vault"\n' +
  '    OBSIDIAN_VAULT="/path/to/Vault" node scripts/install-to-vault.js';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasBom(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(3);
  fs.readSync(fd, buf, 0, 3, 0);
  fs.closeSync(fd);
  return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function fail(message) {
  console.error('\n  INSTALL FAILED: ' + message + '\n');
  process.exit(1);
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const vaultArg = arg('--vault') || process.env.OBSIDIAN_VAULT;
  if (!vaultArg || !vaultArg.trim()) fail('no vault given.\n\n  ' + USAGE);
  const vaultPath = path.resolve(vaultArg.trim());

  const manifestSrc = path.join(repoRoot, 'manifest.json');
  const bundleSrc = path.join(repoRoot, 'dist', 'main.js');
  const stylesSrc = path.join(repoRoot, 'styles.css');

  if (!fs.existsSync(manifestSrc)) fail('manifest.json not found. Nothing to install.');
  if (!fs.existsSync(bundleSrc)) fail('dist/main.js not found. Run `npm run build` first.');

  const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
  if (!manifest.id) fail('manifest.json has no "id".');

  const vaultConfig = path.join(vaultPath, '.obsidian');
  if (!fs.existsSync(vaultConfig)) {
    fail('No .obsidian folder at ' + vaultPath + ' - that is not an Obsidian vault.');
  }

  // Folder name MUST equal manifest.id, or in-app updates create a duplicate
  // folder with the same id and external-settings detection never fires.
  const pluginDir = path.join(vaultConfig, 'plugins', manifest.id);
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });

  const manifestDst = path.join(pluginDir, 'manifest.json');
  const mainDst = path.join(pluginDir, 'main.js');
  const distDst = path.join(pluginDir, 'dist', 'main.js');
  const stylesDst = path.join(pluginDir, 'styles.css');

  // data.json holds the user's saved settings. It is never copied, and this
  // records its state so the checks can prove a reinstall left it untouched.
  const dataPath = path.join(pluginDir, 'data.json');
  const dataBefore = fs.existsSync(dataPath) ? sha256(dataPath) : null;

  fs.copyFileSync(manifestSrc, manifestDst);
  fs.copyFileSync(bundleSrc, mainDst); // <- the one Obsidian actually loads
  fs.copyFileSync(bundleSrc, distDst); // <- kept only to mirror the requested layout; inert
  const hasStyles = fs.existsSync(stylesSrc);
  if (hasStyles) fs.copyFileSync(stylesSrc, stylesDst);

  console.log('\n=== INSTALLED ===');
  console.log('  vault      : ' + vaultPath);
  console.log('  plugin dir : ' + pluginDir);
  console.log('  plugin id  : ' + manifest.id);
  console.log('');

  const checks = [];
  const add = (label, ok, detail) => {
    checks.push(ok);
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  };

  add('folder name matches manifest.id', path.basename(pluginDir) === manifest.id);
  add('manifest.json at plugin ROOT', fs.existsSync(manifestDst));
  add('main.js at plugin ROOT (required by loader)', fs.existsSync(mainDst));
  add('manifest.json is BOM-free', !hasBom(manifestDst));
  add('main.js byte-identical to build output',
    sha256(mainDst) === sha256(bundleSrc), sha256(mainDst).slice(0, 16) + '...');
  add('dist/main.js mirror present', fs.existsSync(distDst));
  if (hasStyles) add('styles.css at plugin ROOT', fs.existsSync(stylesDst));
  add('saved settings (data.json) left untouched',
    (fs.existsSync(dataPath) ? sha256(dataPath) : null) === dataBefore,
    dataBefore ? 'existing settings preserved' : 'none present');

  const bundle = fs.readFileSync(mainDst, 'utf8');
  add('bundle is CommonJS', /module\.exports\s*=/.test(bundle));
  add('bundle does not require tslib', !/require\(['"]tslib['"]\)/.test(bundle));

  console.log('');
  console.log('  main.js    : ' + fs.statSync(mainDst).size + ' bytes');
  console.log('  sha256     : ' + sha256(mainDst));

  if (checks.some((c) => !c)) fail('one or more post-install checks failed.');

  console.log('\n  Files are in place. To load them, enable the plugin in Obsidian under');
  console.log('  Settings -> Community plugins (reload the plugin list if it is not shown).');
  console.log('');
}

main();

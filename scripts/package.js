#!/usr/bin/env node
/**
 * Packages the built plugin into build/<id>-<version>.zip for a release.
 *
 * The zip is FLAT: main.js, manifest.json and (if present) styles.css sit at
 * the archive root, exactly as Obsidian expects them inside
 * <vault>/.obsidian/plugins/<id>/. main.js is taken from dist/main.js.
 *
 * Uses only Node built-ins (zlib for deflate), so no packaging dependency is
 * needed. Entries carry a fixed 1980-01-01 timestamp, so the same inputs
 * always produce a byte-identical zip.
 *
 * Before writing, it checks that manifest.json, package.json and
 * versions.json agree on the version. After writing, it reads the zip back
 * and verifies every entry inflates to the original bytes.
 *
 * Run: npm run build && npm run package
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'build');

function fail(message) {
  console.error('\n  PACKAGE FAILED: ' + message + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------- zip */

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra length, comment length, disk start, internal attrs: all zero
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, compressed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, end]);
}

/** Reads a zip written by buildZip back into { name: Buffer }, verifying CRCs. */
function readZip(zip) {
  const endAt = zip.length - 22;
  if (zip.readUInt32LE(endAt) !== 0x06054b50) throw new Error('end of central directory not found');
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const files = {};

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const localAt = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);

    const localNameLen = zip.readUInt16LE(localAt + 26);
    const localExtraLen = zip.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const data = zlib.inflateRawSync(zip.subarray(dataAt, dataAt + csize));
    if (crc32(data) !== crc) throw new Error('CRC mismatch for ' + name);

    files[name] = data;
    p += 46 + nameLen;
  }
  return files;
}

/* ------------------------------------------------------------------- main */

function main() {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel));
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  if (!exists('dist/main.js')) fail('dist/main.js not found. Run `npm run build` first.');
  if (!exists('manifest.json')) fail('manifest.json not found.');

  const manifest = JSON.parse(read('manifest.json').toString('utf8'));
  const pkg = JSON.parse(read('package.json').toString('utf8'));
  if (!manifest.id || !manifest.version) fail('manifest.json needs "id" and "version".');
  if (pkg.version !== manifest.version) {
    fail(`version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}.`);
  }
  if (!exists('versions.json')) fail('versions.json not found.');
  const versions = JSON.parse(read('versions.json').toString('utf8'));
  if (versions[manifest.version] !== manifest.minAppVersion) {
    fail(`versions.json must map "${manifest.version}" to minAppVersion "${manifest.minAppVersion}".`);
  }

  const entries = [
    { name: 'main.js', data: read('dist/main.js') },
    { name: 'manifest.json', data: read('manifest.json') },
  ];
  if (exists('styles.css')) entries.push({ name: 'styles.css', data: read('styles.css') });

  const zip = buildZip(entries);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${manifest.id}-${manifest.version}.zip`);
  fs.writeFileSync(outPath, zip);

  const back = readZip(fs.readFileSync(outPath));
  for (const { name, data } of entries) {
    if (!back[name] || !back[name].equals(data)) fail('read-back verification failed for ' + name);
  }
  if (Object.keys(back).length !== entries.length) fail('unexpected entries in zip.');

  console.log(`\n  ${path.relative(repoRoot, outPath)}  (${zip.length} bytes)`);
  for (const { name, data } of entries) console.log(`    ${name.padEnd(14)} ${data.length} bytes`);
  console.log('  read-back verified: every entry inflates to the original bytes.\n');
}

main();

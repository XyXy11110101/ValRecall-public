// Zips dist into build/release/ValRecall-<version>.zip with manifest.json at the zip root, and adds
// the licence files. Refuses a dist that must not be shared. Writes the same bytes for the same files.
//
//   node scripts/package-release.mjs
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const MAX_ENTRIES = 0xffff;
const MAX_ZIP_BYTES = 0xffffffff;
const UTF8_NAMES = 0x0800;
const VERSION_NEEDED = 20;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01, the first date a zip can hold. A fixed date keeps the bytes the same. */
const DOS_DATE = 0x0021;

const ROOT_LICENCES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const FONT_LICENCES = ['OFL.txt', 'LXGW-OFL.txt', 'FONT-COPYRIGHT.txt'];

/** Why this file must not be in a release, or null if it may be. */
export function refusalFor(name) {
  if (/(^|\/)assets\/companion(\/|$)/i.test(name)) return 'character art';
  if (/misans/i.test(name)) return 'a MiSans file';
  if (/\.map$/i.test(name)) return 'a source map';
  return null;
}

/** A zip file from `[{ name, data }]`, in the order given. */
export function buildZip(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error('Too many files for a zip.');
  const body = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const smaller = deflated.length < data.length;
    const stored = smaller ? deflated : data;
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(VERSION_NEEDED, 0);
    shared.writeUInt16LE(UTF8_NAMES, 2);
    shared.writeUInt16LE(smaller ? DEFLATED : STORED, 4);
    shared.writeUInt16LE(0, 6);
    shared.writeUInt16LE(DOS_DATE, 8);
    shared.writeUInt32LE(crc32(data), 10);
    shared.writeUInt32LE(stored.length, 14);
    shared.writeUInt32LE(data.length, 18);
    shared.writeUInt16LE(nameBytes.length, 22);
    shared.writeUInt16LE(0, 24);

    const signature = Buffer.alloc(4);
    signature.writeUInt32LE(0x04034b50, 0);
    body.push(signature, shared, nameBytes, stored);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    shared.copy(header, 6);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += signature.length + shared.length + nameBytes.length + stored.length;
    if (offset > MAX_ZIP_BYTES) throw new Error('Too many bytes for a zip.');
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, centralBytes, end]);
}

async function listDist(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      names.push(...(await listDist(join(directory, entry.name), `${name}/`)));
    else if (entry.isFile()) names.push(name);
    else throw new Error(`dist has something that is not a file: ${name}`);
  }
  return names;
}

/** Writes the zip under `root` and returns its path and the names inside it. */
export async function packageRelease({ root = process.cwd() } = {}) {
  const dist = resolve(root, 'dist');
  const manifestPath = join(dist, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('dist has no manifest.json. Run npm run build first.');
  }
  const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error('dist/manifest.json has no valid version.');
  }

  const names = await listDist(dist);
  const refused = names.flatMap((name) => {
    const reason = refusalFor(name);
    return reason === null ? [] : [`${name}: ${reason}`];
  });
  if (refused.length > 0) {
    throw new Error(`dist must not be released like this:\n  ${refused.join('\n  ')}`);
  }

  const files = new Map(names.map((name) => [name, join(dist, ...name.split('/'))]));
  for (const name of ROOT_LICENCES) {
    if (files.has(name)) throw new Error(`dist already has ${name}.`);
    files.set(name, resolve(root, name));
  }
  for (const name of FONT_LICENCES) {
    const path = `fonts/${name}`;
    if (!files.has(path)) files.set(path, resolve(root, 'public', 'fonts', name));
  }

  const entries = [];
  for (const name of [...files.keys()].sort()) {
    const path = files.get(name);
    if (!existsSync(path)) throw new Error(`Missing licence file: ${name}`);
    entries.push({ name, data: await readFile(path) });
  }

  const output = resolve(root, 'build', 'release', `ValRecall-${version}.zip`);
  await mkdir(resolve(root, 'build', 'release'), { recursive: true });
  await writeFile(output, buildZip(entries));
  return { path: output, names: entries.map((entry) => entry.name) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { path, names } = await packageRelease();
    console.log(`Wrote ${path} with ${names.length} files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

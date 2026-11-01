// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { buildZip, packageRelease, refusalFor } from './package-release.mjs';

const temporaryDirectories = [];

async function createProject(distFiles) {
  const root = await mkdtemp(join(tmpdir(), 'valrecall-zip-test-'));
  temporaryDirectories.push(root);
  const files = {
    LICENSE: 'licence',
    'THIRD_PARTY_NOTICES.md': 'notices',
    'public/fonts/OFL.txt': 'ofl',
    'public/fonts/LXGW-OFL.txt': 'lxgw ofl',
    'public/fonts/FONT-COPYRIGHT.txt': 'font copyright',
    ...Object.fromEntries(Object.entries(distFiles).map(([name, text]) => [`dist/${name}`, text])),
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, ...name.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

/** Reads a zip back through its central directory and checks every CRC. */
function readZip(zip) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let position = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(position)).toBe(0x02014b50);
    const method = zip.readUInt16LE(position + 10);
    const crc = zip.readUInt32LE(position + 16);
    const storedSize = zip.readUInt32LE(position + 20);
    const nameLength = zip.readUInt16LE(position + 28);
    const offset = zip.readUInt32LE(position + 42);
    const name = zip.toString('utf8', position + 46, position + 46 + nameLength);
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const stored = zip.subarray(start, start + storedSize);
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    expect(crc32(data)).toBe(crc);
    files.set(name, data.toString('utf8'));
    position += 46 + nameLength;
  }
  return files;
}

const MANIFEST = JSON.stringify({ manifest_version: 3, version: '1.2.3' });

describe('package-release', () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      await rm(temporaryDirectories.pop(), { recursive: true, force: true });
    }
  });

  it('writes a zip that reads back the same, compressed or not', () => {
    const repeated = 'abc'.repeat(1000);
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from(repeated) },
      { name: 'folder/中文.txt', data: Buffer.from('字') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]);
    expect(zip.length).toBeLessThan(repeated.length);
    expect([...readZip(zip)]).toEqual([
      ['a.txt', repeated],
      ['folder/中文.txt', '字'],
      ['empty.txt', ''],
    ]);
  });

  it('puts the manifest at the root and adds the licence files', async () => {
    const root = await createProject({
      'manifest.json': MANIFEST,
      'assets/app.js': 'code',
      'fonts/OFL.txt': 'built ofl',
    });
    const { path } = await packageRelease({ root });
    expect(path).toBe(join(root, 'build', 'release', 'ValRecall-1.2.3.zip'));
    const files = readZip(await readFile(path));
    expect(Object.fromEntries(files)).toEqual({
      'manifest.json': MANIFEST,
      'assets/app.js': 'code',
      'fonts/OFL.txt': 'built ofl',
      'fonts/LXGW-OFL.txt': 'lxgw ofl',
      'fonts/FONT-COPYRIGHT.txt': 'font copyright',
      LICENSE: 'licence',
      'THIRD_PARTY_NOTICES.md': 'notices',
    });
  });

  it('writes the same bytes twice', async () => {
    const root = await createProject({ 'manifest.json': MANIFEST, 'app.js': 'code' });
    const { path } = await packageRelease({ root });
    const first = await readFile(path);
    await packageRelease({ root });
    expect((await readFile(path)).equals(first)).toBe(true);
  });

  it('refuses a dist without a manifest', async () => {
    const root = await createProject({ 'app.js': 'code' });
    await expect(packageRelease({ root })).rejects.toThrow('no manifest.json');
  });

  it.each([
    ['assets/companion/a.svg', 'character art'],
    ['assets/MiSans-Bold.woff2', 'a MiSans file'],
    ['fonts/misans-licence.pdf', 'a MiSans file'],
    ['assets/app.js.map', 'a source map'],
  ])('refuses %s', async (name, reason) => {
    expect(refusalFor(name)).toBe(reason);
    const root = await createProject({ 'manifest.json': MANIFEST, [name]: 'x' });
    await expect(packageRelease({ root })).rejects.toThrow(reason);
  });

  it('allows ordinary names that only look close', () => {
    expect(refusalFor('assets/companion-card.js')).toBeNull();
    expect(refusalFor('assets/mapping.js')).toBeNull();
  });

  it('refuses when a licence file is missing', async () => {
    const root = await createProject({ 'manifest.json': MANIFEST });
    await rm(join(root, 'LICENSE'));
    await expect(packageRelease({ root })).rejects.toThrow('Missing licence file: LICENSE');
  });
});

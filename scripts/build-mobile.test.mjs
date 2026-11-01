// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import mobileConfig from '../vite.mobile.config.ts';
import {
  assertPrivateMobileOutput,
  assertPublicMobileOutput,
  mobileOutputDirectory,
  parseMobileBuildArgs,
} from './build-mobile.mjs';

const temporaryDirectories = [];

async function createOutput(files) {
  const directory = await mkdtemp(join(tmpdir(), 'valrecall-mobile-test-'));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, ...name.split('/'));
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('build-mobile arguments', () => {
  it('keeps the public default and accepts --outDir in both forms', () => {
    expect(parseMobileBuildArgs([])).toEqual({ outDir: 'build/mobile-web', privateArt: false });
    expect(parseMobileBuildArgs(['--outDir', 'build/x/mobile-web'])).toEqual({
      outDir: 'build/x/mobile-web',
      privateArt: false,
    });
    expect(parseMobileBuildArgs(['--outDir=build/y', '--private'])).toEqual({
      outDir: 'build/y',
      privateArt: true,
    });
    expect(parseMobileBuildArgs(['--private'])).toEqual({
      outDir: 'build/mobile-web-private',
      privateArt: true,
    });
  });

  it('rejects unknown or incomplete arguments', () => {
    expect(() => parseMobileBuildArgs(['--outDir'])).toThrow('--outDir needs a directory');
    expect(() => parseMobileBuildArgs(['--outDir', '--private'])).toThrow('needs a directory');
    expect(() => parseMobileBuildArgs(['--mode', 'private'])).toThrow('Unknown argument --mode');
  });

  it('only writes into a subfolder of build/', () => {
    expect(mobileOutputDirectory('build/wardrobe/w4/mobile', 'D:/repo')).toBe(
      resolve('D:/repo', 'build/wardrobe/w4/mobile'),
    );
    for (const value of ['build', 'dist', 'build/..', '../build/x', 'C:/elsewhere']) {
      expect(() => mobileOutputDirectory(value, 'D:/repo')).toThrow('subdirectory of build/');
    }
  });
});

describe('mobile Vite config', () => {
  it('turns the companion flag on only in the private mode', () => {
    const define = (mode) =>
      mobileConfig({ mode, command: 'build' }).define.__VALRECALL_PRIVATE_COMPANION_ASSETS__;
    expect(define('production')).toBe('false');
    expect(define('private')).toBe('true');
    expect(define('test')).toBe('false');
  });

  it('keeps the npm scripts pointed at build-mobile.mjs', async () => {
    const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
    expect(scripts['build:mobile']).toBe('node scripts/build-mobile.mjs');
  });
});

describe('phone web output checks', () => {
  const publicFiles = {
    'mobile.html': '<script src="./assets/mobile-abc.js"></script>',
    'assets/mobile-abc.js': 'const tasks = ["calm", "cheer", "outfit7"];',
    'fonts/OFL.txt': 'licence',
  };

  it('accepts a public build and rejects any private marker or art path', async () => {
    await expect(
      assertPublicMobileOutput(await createOutput(publicFiles)),
    ).resolves.toBeUndefined();
    for (const leak of [
      'assets/companion/chibi/outfit1/head-smile.svg',
      'head-joy.anim.svg',
      '服装 11',
      'valrecall.companionWardrobe',
    ]) {
      const output = await createOutput({ ...publicFiles, 'assets/mobile-abc.js': `"${leak}"` });
      await expect(assertPublicMobileOutput(output)).rejects.toThrow('found private marker');
    }
    await expect(
      assertPublicMobileOutput(
        await createOutput({ ...publicFiles, 'assets/chibi.svg': '<svg/>' }),
      ),
    ).rejects.toThrow('found private companion path');
    await expect(
      assertPublicMobileOutput(await createOutput({ 'assets/mobile-abc.js': 'x' })),
    ).rejects.toThrow('mobile.html is missing');
  });

  it('accepts a private build that references the art without carrying it', async () => {
    const privateFiles = {
      ...publicFiles,
      'assets/mobile-abc.js': 'const art = `assets/companion/chibi/${outfit}/${pose}.anim.svg`;',
    };
    await expect(
      assertPrivateMobileOutput(await createOutput(privateFiles)),
    ).resolves.toBeUndefined();

    await expect(assertPrivateMobileOutput(await createOutput(publicFiles))).rejects.toThrow(
      'no script references assets/companion/chibi/',
    );
    await expect(
      assertPrivateMobileOutput(
        await createOutput({
          ...privateFiles,
          'assets/companion/chibi/outfit1/calm.svg': '<svg/>',
        }),
      ),
    ).rejects.toThrow('found an assets/companion directory');
    await expect(
      assertPrivateMobileOutput(
        await createOutput({ ...privateFiles, 'chibi/calm.svg': '<svg/>' }),
      ),
    ).rejects.toThrow('found companion art file chibi/calm.svg');
    await expect(
      assertPrivateMobileOutput(
        await createOutput({ ...privateFiles, 'mobile.html': 'from private-assets/chibi' }),
      ),
    ).rejects.toThrow('found marker private-assets in mobile.html');
    await expect(
      assertPrivateMobileOutput(
        await createOutput({ ...privateFiles, 'mobile.html': 'src="companion/success.png"' }),
      ),
    ).rejects.toThrow('still references companion/success.png');
  });
});

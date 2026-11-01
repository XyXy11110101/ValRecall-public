// Builds the phone web app (mobile.html) that the Android shell packages.
//
//   node scripts/build-mobile.mjs [--outDir build/<dir>] [--private]
//
// The public build (mode "production") is the same as `vite build --config vite.mobile.config.ts`
// and is scanned for every private companion marker. `--private` (mode "private") only turns the
// companion art flag on: the art itself is never copied here. The art and the tool that makes
// the Android overlay are not in this repository, so this option adds no images.
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPrivateBuildHasNoRetiredImages,
  assertPublicBuildHasNoPrivateCompanionAssets,
  COMPANION_ALWAYS_FORBIDDEN_MARKERS,
  findCompanionMarker,
  LEGACY_COMPANION_ASSET_NAMES,
  listRelativeFiles,
} from './companion-build-scan.mjs';

export const MOBILE_CONFIG_FILE = 'vite.mobile.config.ts';
export const PRIVATE_ART_REFERENCE = 'assets/companion/chibi/';
const PRIVATE_MOBILE_MARKERS = Object.freeze([
  ...COMPANION_ALWAYS_FORBIDDEN_MARKERS,
  ...LEGACY_COMPANION_ASSET_NAMES,
]);

export function parseMobileBuildArgs(argv) {
  let outDir;
  let privateArt = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--private') {
      privateArt = true;
    } else if (argument === '--outDir') {
      outDir = argv[index + 1];
      index += 1;
      if (!outDir || outDir.startsWith('--')) throw new Error('--outDir needs a directory.');
    } else if (argument.startsWith('--outDir=')) {
      outDir = argument.slice('--outDir='.length);
      if (!outDir) throw new Error('--outDir needs a directory.');
    } else {
      throw new Error(
        `Unknown argument ${argument}. Usage: build-mobile.mjs [--outDir dir] [--private]`,
      );
    }
  }
  return {
    outDir: outDir ?? (privateArt ? 'build/mobile-web-private' : 'build/mobile-web'),
    privateArt,
  };
}

/** Phone web output always stays in a subfolder of the gitignored build/ folder. */
export function mobileOutputDirectory(value, repoRoot = process.cwd()) {
  const target = resolve(repoRoot, value);
  const withinBuild = relative(resolve(repoRoot, 'build'), target);
  if (
    !withinBuild ||
    withinBuild === '..' ||
    withinBuild.startsWith(`..${sep}`) ||
    isAbsolute(withinBuild)
  ) {
    throw new Error('The phone web output must be a subdirectory of build/.');
  }
  return target;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertPublicMobileOutput(directory) {
  if (!(await exists(join(directory, 'mobile.html')))) {
    throw new Error('Phone web build check failed: mobile.html is missing.');
  }
  await assertPublicBuildHasNoPrivateCompanionAssets({ distDirectory: directory });
}

/** The private phone web carries the flag and the art paths, never the art itself. */
export async function assertPrivateMobileOutput(directory) {
  if (!(await exists(join(directory, 'mobile.html')))) {
    throw new Error('Private phone web check failed: mobile.html is missing.');
  }
  if (await exists(join(directory, 'assets', 'companion'))) {
    throw new Error('Private phone web check failed: found an assets/companion directory.');
  }
  let referencesArt = false;
  for (const name of await listRelativeFiles(directory)) {
    if (/chibi/i.test(name)) {
      throw new Error(`Private phone web check failed: found companion art file ${name}.`);
    }
    const contents = await readFile(join(directory, ...name.split('/')));
    const marker = findCompanionMarker(contents, PRIVATE_MOBILE_MARKERS);
    if (marker !== null) {
      throw new Error(`Private phone web check failed: found marker ${marker} in ${name}.`);
    }
    if (name.endsWith('.js') && contents.includes(PRIVATE_ART_REFERENCE)) referencesArt = true;
  }
  if (!referencesArt) {
    throw new Error(
      `Private phone web check failed: no script references ${PRIVATE_ART_REFERENCE}, so the flag is off.`,
    );
  }
  await assertPrivateBuildHasNoRetiredImages({ distDirectory: directory });
}

export async function buildMobile({ outDir, privateArt }) {
  const target = mobileOutputDirectory(outDir);
  const { build } = await import('vite');
  await build({
    configFile: MOBILE_CONFIG_FILE,
    mode: privateArt ? 'private' : 'production',
    build: { outDir: target },
  });
  if (privateArt) await assertPrivateMobileOutput(target);
  else await assertPublicMobileOutput(target);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMobileBuildArgs(process.argv.slice(2));
    const target = await buildMobile(options);
    console.log(
      `[build:mobile] ${options.privateArt ? 'Private' : 'Public'} phone web built into ${relative(process.cwd(), target)} and scanned.`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[build:mobile] ${detail}`);
    process.exitCode = 1;
  }
}

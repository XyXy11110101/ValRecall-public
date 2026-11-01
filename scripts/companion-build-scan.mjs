import { readFileSync } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * The companion wardrobe (asset contract v2, 2026-10-28). The art is not in this repository, and
 * nothing built here may contain any. Every name below comes from
 * src/companion/wardrobe-manifest.json, the same data wardrobe.ts holds.
 */
function readWardrobeManifest() {
  // jsdom test runs give import.meta.url a non-file scheme; they run from the repository root.
  const url = new URL('../src/companion/wardrobe-manifest.json', import.meta.url);
  const path =
    url.protocol === 'file:' ? url : resolve('src', 'companion', 'wardrobe-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const label = 'wardrobe-manifest.json';
  const idList = (value, pattern, what) => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      new Set(value).size !== value.length ||
      !value.every((item) => typeof item === 'string' && pattern.test(item))
    ) {
      fail(label, `${what} must be a non-empty list of unique ids`);
    }
    return Object.freeze([...value]);
  };
  const subset = (value, of, what) => {
    const list = idList(value, /^[a-z][a-z-]*$/, what);
    if (!list.every((item) => of.includes(item))) fail(label, `${what} lists an unknown pose`);
    return list;
  };
  const outfits = idList(manifest?.rotation, /^[a-z][a-z0-9]*$/, 'rotation');
  const figurePoses = idList(manifest.figurePoses, /^[a-z][a-z-]*$/, 'figurePoses');
  const headPoses = idList(manifest.headPoses, /^head-[a-z-]+$/, 'headPoses');
  const poses = [...figurePoses, ...headPoses];
  if (new Set(poses).size !== poses.length) fail(label, 'a pose is both a figure and a head');
  const labels = {};
  for (const outfit of outfits) {
    const text = manifest.labels?.[outfit];
    if (typeof text !== 'string' || text.trim() === '') fail(label, `missing label for ${outfit}`);
    labels[outfit] = text;
  }
  const viewBoxes = {};
  for (const kind of ['figure', 'head']) {
    const viewBox = manifest.viewBoxes?.[kind];
    const match = typeof viewBox === 'string' ? /^-?\d+ -?\d+ (\d+) (\d+)$/.exec(viewBox) : null;
    if (!match) fail(label, `viewBoxes.${kind} must be four integers`);
    viewBoxes[kind] = Object.freeze({ viewBox, width: match[1], height: match[2] });
  }
  return Object.freeze({
    artRoot: 'assets/companion/chibi',
    outfits,
    labels: Object.freeze(labels),
    figurePoses,
    headPoses,
    staticOnlyPoses: subset(manifest.staticOnlyPoses, poses, 'staticOnlyPoses'),
    iconKinds: idList(manifest.iconKinds, /^[a-z]+$/, 'iconKinds'),
    viewBoxes: Object.freeze(viewBoxes),
    phonePoses: subset(manifest.phonePoses, poses, 'phonePoses'),
    widgetPoses: subset(manifest.widgetPoses, poses, 'widgetPoses'),
  });
}

export const COMPANION_WARDROBE = readWardrobeManifest();

/** The flat v1 set (2026-10-24). No build ships these names any more; they are only markers. */
export const LEGACY_COMPANION_ASSET_NAMES = Object.freeze([
  'idle-calm.svg',
  'due-point.svg',
  'reviewing-think.svg',
  'success-cheer.svg',
  'success-peace.svg',
  'idle-sleepy.svg',
  'idle-head.svg',
  'due-head.svg',
  'reviewing-head.svg',
  'success-head.svg',
  'idle-worried.svg',
  'due-worried.svg',
  'reviewing-worried.svg',
  'success-worried.svg',
  'icon-reminder-128.png',
  'icon-default-128.png',
]);

/** Four retired image names. No build may ship them again. */
export const RETIRED_IMAGE_NAMES = Object.freeze([
  'idle.png',
  'due.png',
  'reviewing.png',
  'success.png',
]);

/** Strings no build may contain at all: private source folders and file names. */
export const COMPANION_ALWAYS_FORBIDDEN_MARKERS = Object.freeze(['private-assets']);

/** A label as the bundler may escape it, so `\uXXXX` output cannot slip past the scan. */
function escapedForms(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return [];
  const escape = (upper) =>
    [...text]
      .map((character) => {
        const code = character.codePointAt(0);
        if (code < 0x80) return character;
        const hex = code.toString(16).padStart(4, '0');
        return `\\u${upper ? hex.toUpperCase() : hex}`;
      })
      .join('');
  return [...new Set([escape(false), escape(true)])];
}

/**
 * The public desktop build, the public phone web and the public APK contain none of these. Bare
 * outfit and pose ids are deliberately absent: words such as "calm" or "read" are common.
 */
export const COMPANION_PUBLIC_MARKERS = Object.freeze([
  ...new Set([
    ...RETIRED_IMAGE_NAMES,
    ...LEGACY_COMPANION_ASSET_NAMES,
    'companion/chibi',
    '.anim.svg',
    'valrecall.companionWardrobe',
    'wardrobe-manifest',
    ...Object.values(COMPANION_WARDROBE.labels).flatMap((text) => [text, ...escapedForms(text)]),
    // Rendered widget art lives only in the private Android release overlay.
    'widget_art_',
    ...COMPANION_ALWAYS_FORBIDDEN_MARKERS,
  ]),
]);

const markerBufferCache = new WeakMap();

/** The first marker found in `contents`, or null. Marker buffers are built once per list. */
export function findCompanionMarker(contents, markers = COMPANION_PUBLIC_MARKERS) {
  let buffers = markerBufferCache.get(markers);
  if (!buffers) {
    buffers = markers.map((marker) => [marker, Buffer.from(marker, 'utf8')]);
    markerBufferCache.set(markers, buffers);
  }
  for (const [marker, bytes] of buffers) if (contents.includes(bytes)) return marker;
  return null;
}

export function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(path)));
    else files.push(path);
  }
  return files;
}

/** Relative `/` paths of every file under `directory`, sorted. */
export async function listRelativeFiles(directory) {
  return (await listFilesRecursively(directory))
    .map((path) => relative(directory, path).split(sep).join('/'))
    .sort();
}

const RETIRED_IMAGE_REFERENCES = RETIRED_IMAGE_NAMES.map((image) => [
  image,
  Buffer.from(`companion/${image}`),
]);

/** The private build ships the illustrated set only: never the retired images. */
export async function assertPrivateBuildHasNoRetiredImages({ distDirectory = 'dist' } = {}) {
  for (const path of await listFilesRecursively(distDirectory)) {
    const name = basename(path);
    if (RETIRED_IMAGE_NAMES.includes(name)) {
      throw new Error(
        `Private build check failed: found retired image ${relative(distDirectory, path)}`,
      );
    }
    const contents = await readFile(path);
    for (const [image, reference] of RETIRED_IMAGE_REFERENCES) {
      if (contents.includes(reference)) {
        throw new Error(
          `Private build check failed: ${relative(distDirectory, path)} still references companion/${image}`,
        );
      }
    }
  }
}

export async function assertPublicBuildHasNoPrivateCompanionAssets({
  distDirectory = 'dist',
} = {}) {
  const companionDirectory = join(distDirectory, 'assets', 'companion');
  try {
    await access(companionDirectory);
    throw new Error(
      'Ordinary build privacy check failed: found private companion directory assets/companion',
    );
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  for (const path of await listFilesRecursively(distDirectory)) {
    const relativePath = relative(distDirectory, path);
    if (/chibi/i.test(relativePath)) {
      throw new Error(
        `Ordinary build privacy check failed: found private companion path ${relativePath}`,
      );
    }
    const marker = findCompanionMarker(await readFile(path));
    if (marker !== null) {
      throw new Error(
        `Ordinary build privacy check failed: found private marker ${marker} in ${relativePath}`,
      );
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIBRARY_IMAGE_INPUT_MAX_BYTES,
  LIBRARY_IMAGE_STORED_MAX_BYTES,
  containedImageDimensions,
  importedLibraryImageIssue,
  libraryImageFileIssue,
  prepareLibraryImage,
  preparedLibraryImageIssue,
} from './library-image';

const VALID_ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function validPngBlob(): Blob {
  const binary = atob(VALID_ONE_PIXEL_PNG);
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
    type: 'image/png',
  });
}

describe('Library image preparation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only bounded JPEG, PNG, and WebP inputs', () => {
    expect(libraryImageFileIssue(new Blob(['png'], { type: 'image/png' }))).toBeNull();
    expect(libraryImageFileIssue(new Blob(['svg'], { type: 'image/svg+xml' }))).toContain(
      'JPEG、PNG 或 WebP',
    );
    expect(libraryImageFileIssue(new Blob([], { type: 'image/png' }))).toContain('空的');
    expect(
      libraryImageFileIssue(
        new Blob([new Uint8Array(LIBRARY_IMAGE_INPUT_MAX_BYTES + 1)], { type: 'image/jpeg' }),
      ),
    ).toContain('12 MB');
  });

  it('calculates contained dimensions and rejects unsafe stored assets', () => {
    expect(containedImageDimensions(4096, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(
      preparedLibraryImageIssue({
        blob: new Blob(['image'], { type: 'image/webp' }),
        width: 2049,
        height: 100,
      }),
    ).toContain('2048');
    expect(
      preparedLibraryImageIssue({
        blob: new Blob([new Uint8Array(LIBRARY_IMAGE_STORED_MAX_BYTES + 1)], {
          type: 'image/webp',
        }),
        width: 100,
        height: 100,
      }),
    ).toContain('3 MB');
  });

  it('decodes a small image and keeps its bounded bytes', async () => {
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 640, height: 480, close }),
    );
    const blob = new Blob(['image'], { type: 'image/png' });

    await expect(prepareLibraryImage(blob)).resolves.toEqual({ blob, width: 640, height: 480 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects undecodable and extreme-dimension image content', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Decode failed.')));
    await expect(
      prepareLibraryImage(new Blob(['not-an-image'], { type: 'image/png' })),
    ).rejects.toThrow('Decode failed.');

    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 20_000, height: 100, close }),
    );
    await expect(
      prepareLibraryImage(new Blob(['extreme'], { type: 'image/jpeg' })),
    ).rejects.toThrow('dimensions are too large');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requires imported image bytes to have a matching signature and decoded dimensions', async () => {
    const close = vi.fn();
    const decode = vi.fn().mockResolvedValue({ width: 1, height: 1, close });
    vi.stubGlobal('createImageBitmap', decode);

    await expect(
      importedLibraryImageIssue({ blob: validPngBlob(), width: 1, height: 1 }),
    ).resolves.toBeNull();
    expect(close).toHaveBeenCalledTimes(1);

    await expect(
      importedLibraryImageIssue({
        blob: new Blob(['not a png'], { type: 'image/png' }),
        width: 1,
        height: 1,
      }),
    ).resolves.toContain('不匹配');
    expect(decode).toHaveBeenCalledTimes(1);

    decode.mockResolvedValueOnce({ width: 2, height: 1, close });
    await expect(
      importedLibraryImageIssue({ blob: validPngBlob(), width: 1, height: 1 }),
    ).resolves.toContain('尺寸');
  });

  it('rejects an imported image when the browser decoder cannot read it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Decode failed.')));

    await expect(
      importedLibraryImageIssue({ blob: validPngBlob(), width: 1, height: 1 }),
    ).resolves.toContain('无法解码');
  });

  it('normalises a large image through a bounded canvas', async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const normalized = new Blob(['webp'], { type: 'image/webp' });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 4096, height: 2048, close }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { drawImage };
        }
        async convertToBlob() {
          return normalized;
        }
      },
    );

    const result = await prepareLibraryImage(new Blob(['large'], { type: 'image/jpeg' }));
    expect(result).toEqual({ blob: normalized, width: 2048, height: 1024 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1024);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

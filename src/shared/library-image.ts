export const LIBRARY_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type LibraryImageMimeType = (typeof LIBRARY_IMAGE_MIME_TYPES)[number];

export const LIBRARY_IMAGE_INPUT_MAX_BYTES = 12 * 1024 * 1024;
export const LIBRARY_IMAGE_STORED_MAX_BYTES = 3 * 1024 * 1024;
export const LIBRARY_IMAGE_SOURCE_MAX_DIMENSION = 16_384;
export const LIBRARY_IMAGE_SOURCE_MAX_PIXELS = 64_000_000;
export const LIBRARY_IMAGE_STORED_MAX_DIMENSION = 2_048;

export interface PreparedLibraryImage {
  blob: Blob;
  width: number;
  height: number;
}

export function isLibraryImageMimeType(value: unknown): value is LibraryImageMimeType {
  return LIBRARY_IMAGE_MIME_TYPES.some((mimeType) => value === mimeType);
}

export function libraryImageFileIssue(blob: Blob): string | null {
  if (!isLibraryImageMimeType(blob.type)) {
    return '请选择 JPEG、PNG 或 WebP 图片。';
  }
  if (blob.size <= 0) return '所选图片是空的。';
  if (blob.size > LIBRARY_IMAGE_INPUT_MAX_BYTES) {
    return '所选图片超过 12 MB 输入上限。';
  }
  return null;
}

export function preparedLibraryImageIssue(image: PreparedLibraryImage): string | null {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    return '图片尺寸无效。';
  }
  if (image.width <= 0 || image.height <= 0) return '图片尺寸无效。';
  if (
    image.width > LIBRARY_IMAGE_STORED_MAX_DIMENSION ||
    image.height > LIBRARY_IMAGE_STORED_MAX_DIMENSION
  ) {
    return '处理后的图片超过 2048 像素存储上限。';
  }
  if (!isLibraryImageMimeType(image.blob.type)) return '处理后的图片类型不受支持。';
  if (image.blob.size <= 0 || image.blob.size > LIBRARY_IMAGE_STORED_MAX_BYTES) {
    return '处理后的图片超过 3 MB 存储上限。';
  }
  return null;
}

/**
 * Revalidates an untrusted backup asset before it crosses the IndexedDB boundary.
 * MIME labels and item metadata are not sufficient because both are user-editable
 * JSON; require a matching file signature and a successful browser decode.
 */
export async function importedLibraryImageIssue(
  image: PreparedLibraryImage,
): Promise<string | null> {
  const preparedIssue = preparedLibraryImageIssue(image);
  if (preparedIssue) return preparedIssue;
  if (!(await hasMatchingImageSignature(image.blob))) {
    return '导入图片的字节与声明的类型不匹配。';
  }
  if (typeof createImageBitmap !== 'function') {
    return '当前 Edge 版本无法安全解码导入的图片。';
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(image.blob);
    if (bitmap.width !== image.width || bitmap.height !== image.height) {
      return '导入图片的尺寸与解码内容不一致。';
    }
    return null;
  } catch {
    return '导入的图片无法解码。';
  } finally {
    bitmap?.close();
  }
}

async function hasMatchingImageSignature(blob: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await readBlobBytes(blob.slice(0, 12)));
  switch (blob.type) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      );
    case 'image/webp':
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('The image bytes could not be read.'));
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      'load',
      () =>
        reader.result instanceof ArrayBuffer
          ? resolve(reader.result)
          : reject(new Error('The image bytes could not be read.')),
      { once: true },
    );
    reader.addEventListener(
      'error',
      () => reject(reader.error ?? new Error('The image bytes could not be read.')),
      { once: true },
    );
    reader.readAsArrayBuffer(blob);
  });
}

export function containedImageDimensions(
  width: number,
  height: number,
  maxDimension = LIBRARY_IMAGE_STORED_MAX_DIMENSION,
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function prepareLibraryImage(blob: Blob): Promise<PreparedLibraryImage> {
  const initialIssue = libraryImageFileIssue(blob);
  if (initialIssue) throw new Error(initialIssue);
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This Edge version cannot safely decode the selected image.');
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    if (
      width <= 0 ||
      height <= 0 ||
      width > LIBRARY_IMAGE_SOURCE_MAX_DIMENSION ||
      height > LIBRARY_IMAGE_SOURCE_MAX_DIMENSION ||
      width * height > LIBRARY_IMAGE_SOURCE_MAX_PIXELS
    ) {
      throw new Error('The selected image dimensions are too large or invalid.');
    }

    if (
      width <= LIBRARY_IMAGE_STORED_MAX_DIMENSION &&
      height <= LIBRARY_IMAGE_STORED_MAX_DIMENSION &&
      blob.size <= LIBRARY_IMAGE_STORED_MAX_BYTES
    ) {
      return { blob, width, height };
    }

    const dimensions = containedImageDimensions(width, height);
    const normalized = await renderWebp(bitmap, dimensions.width, dimensions.height);
    const prepared = { blob: normalized, ...dimensions };
    const preparedIssue = preparedLibraryImageIssue(prepared);
    if (preparedIssue) throw new Error(preparedIssue);
    return prepared;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('The selected image could not be decoded.');
  } finally {
    bitmap?.close();
  }
}

async function renderWebp(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The selected image could not be prepared.');
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.84 });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The selected image could not be prepared.');
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error('The selected image could not be prepared.')),
      'image/webp',
      0.84,
    );
  });
}

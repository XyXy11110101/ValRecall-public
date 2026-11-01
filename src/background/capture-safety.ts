import type { CaptureDraft } from '../models/learning-item';
import { matchesSavedSource } from './source-url';

export interface CaptureTargetTab {
  id?: number | undefined;
  url?: string | undefined;
}

export interface SafeScreenshotDependencies {
  expectedTabId: number;
  draft: Pick<CaptureDraft, 'platform' | 'sourceUrl' | 'canonicalUrl'>;
  readActiveTab(): Promise<CaptureTargetTab | undefined>;
  validatePage(): Promise<boolean>;
  captureVisibleTab(): Promise<string>;
}

export async function captureScreenshotSafely(
  dependencies: SafeScreenshotDependencies,
): Promise<string> {
  const before = await dependencies.readActiveTab();
  if (!isSameCaptureTarget(dependencies.expectedTabId, dependencies.draft, before)) {
    throw new Error('视频已切换，请重新捕获。');
  }
  if (!(await dependencies.validatePage())) {
    throw new Error(captureChangedMessage(dependencies.draft.platform, 'before'));
  }

  const screenshot = await dependencies.captureVisibleTab();
  const after = await dependencies.readActiveTab();
  if (!isSameCaptureTarget(dependencies.expectedTabId, dependencies.draft, after)) {
    throw new Error('截图时视频已切换，请重新捕获。');
  }
  if (!(await dependencies.validatePage())) {
    throw new Error(captureChangedMessage(dependencies.draft.platform, 'during'));
  }
  if (!isUsableScreenshotDataUrl(screenshot)) {
    throw new Error('无法截取视频画面，请重试。');
  }
  if (!(await screenshotHasMeaningfulContent(screenshot))) {
    throw new Error('无法截取视频画面，请重试。');
  }
  return screenshot;
}

function captureChangedMessage(
  platform: CaptureDraft['platform'],
  phase: 'before' | 'during',
): string {
  if (platform === 'douyin') return '无法截取视频画面，请重试。';
  return phase === 'before' ? '视频已切换，请重新捕获。' : '截图时视频已切换，请重新捕获。';
}

/**
 * Confirms that captureVisibleTab still refers to the tab and exact saved work that
 * produced the semantic draft. This is deliberately platform-neutral.
 */
export function isSameCaptureTarget(
  expectedTabId: number,
  draft: Pick<CaptureDraft, 'platform' | 'sourceUrl' | 'canonicalUrl'>,
  activeTab: CaptureTargetTab | undefined,
): boolean {
  if (activeTab?.id !== expectedTabId || typeof activeTab.url !== 'string') return false;
  return matchesSavedSource(activeTab.url, draft.sourceUrl, draft.platform);
}

/** Rejects empty, malformed, or incorrectly labelled screenshot payloads. */
export function isUsableScreenshotDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (match === null) return false;
  const mime = match[1]?.toLowerCase();
  const payload = match[2] ?? '';
  if (payload.length === 0 || payload.length % 4 !== 0) return false;

  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(Math.min(binary.length, 12));
    for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
    if (mime === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mime === 'png') {
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      );
    }
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
  } catch {
    return false;
  }
}

export function hasMeaningfulScreenshotPixels(pixels: Uint8ClampedArray): boolean {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return false;
  const total = pixels.length / 4;
  let visibleNonBlack = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const alpha = pixels[index + 3] ?? 0;
    if (alpha >= 16 && red + green + blue > 24) visibleNonBlack += 1;
  }
  return visibleNonBlack >= Math.max(1, Math.ceil(total * 0.01));
}

async function screenshotHasMeaningfulContent(dataUrl: string): Promise<boolean> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return true;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
    if (bitmap.width <= 0 || bitmap.height <= 0) return false;
    const sampleSize = 32;
    const canvas = new OffscreenCanvas(sampleSize, sampleSize);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return false;
    context.drawImage(bitmap, 0, 0, sampleSize, sampleSize);
    return hasMeaningfulScreenshotPixels(context.getImageData(0, 0, sampleSize, sampleSize).data);
  } catch {
    return false;
  } finally {
    bitmap?.close();
  }
}

const DOUYIN_ORIGIN = 'https://www.douyin.com';

export const DOUYIN_VIDEO_ID_PATTERN = /^[0-9]+$/;

export interface DouyinVideoUrl {
  videoId: string;
  originalUrl: string;
  canonicalUrl: string;
  surface: 'direct' | 'modal';
}

export function parseDouyinVideoUrl(urlValue: string): DouyinVideoUrl | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.douyin.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }

  const directVideoId = /^\/video\/([0-9]+)$/.exec(url.pathname)?.[1];
  const surface = directVideoId === undefined ? 'modal' : 'direct';
  let videoId = directVideoId;
  if (videoId === undefined) {
    const modalIds = url.searchParams.getAll('modal_id');
    // Duplicate modal_id keys are rejected even when identical. This keeps the
    // identity boundary unambiguous and avoids silently choosing one occurrence.
    if (modalIds.length !== 1) return null;
    videoId = modalIds[0];
  }
  if (videoId === undefined || !DOUYIN_VIDEO_ID_PATTERN.test(videoId)) return null;

  return {
    videoId,
    originalUrl: url.href,
    canonicalUrl: `${DOUYIN_ORIGIN}/video/${videoId}`,
    surface,
  };
}

export function isSupportedDouyinVideoUrl(urlValue: string): boolean {
  return parseDouyinVideoUrl(urlValue) !== null;
}

export function extractDouyinVideoId(urlValue: string): string | null {
  return parseDouyinVideoUrl(urlValue)?.videoId ?? null;
}

export function canonicalizeDouyinVideoUrl(urlValue: string): string | null {
  return parseDouyinVideoUrl(urlValue)?.canonicalUrl ?? null;
}

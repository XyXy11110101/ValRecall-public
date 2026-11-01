const YOUTUBE_ORIGIN = 'https://www.youtube.com';

export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeWatchUrl {
  videoId: string;
  originalUrl: string;
  canonicalUrl: string;
}

export function parseYouTubeWatchUrl(urlValue: string): YouTubeWatchUrl | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.youtube.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/watch'
  ) {
    return null;
  }

  const videoIds = url.searchParams.getAll('v');
  if (videoIds.length !== 1 || !YOUTUBE_VIDEO_ID_PATTERN.test(videoIds[0]!)) {
    return null;
  }

  const videoId = videoIds[0]!;
  return {
    videoId,
    originalUrl: url.href,
    canonicalUrl: `${YOUTUBE_ORIGIN}/watch?v=${encodeURIComponent(videoId)}`,
  };
}

export function isSupportedYouTubeWatchUrl(urlValue: string): boolean {
  return parseYouTubeWatchUrl(urlValue) !== null;
}

export function extractYouTubeVideoId(urlValue: string): string | null {
  return parseYouTubeWatchUrl(urlValue)?.videoId ?? null;
}

export function canonicalizeYouTubeWatchUrl(urlValue: string): string | null {
  return parseYouTubeWatchUrl(urlValue)?.canonicalUrl ?? null;
}

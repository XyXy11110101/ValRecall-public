import type { VideoPlatform } from '../models/platform';
import { normalizeBilibiliVideoId, parseBilibiliVideoUrl } from './bilibili/url';
import { DOUYIN_VIDEO_ID_PATTERN, parseDouyinVideoUrl } from './douyin/url';
import { parseYouTubeWatchUrl, YOUTUBE_VIDEO_ID_PATTERN } from './youtube/url';

export interface SourceGroupingInput {
  platform: VideoPlatform;
  sourceUrl: string;
  canonicalUrl: string | null;
  videoId: string | null;
}

export interface SourceGroupingIdentity {
  key: string;
  platform: VideoPlatform;
  videoId: string;
  canonicalUrl: string;
}

export function getSourceGroupingIdentity(
  input: SourceGroupingInput,
): SourceGroupingIdentity | null {
  const source = parseForPlatform(input.platform, input.sourceUrl);
  if (source === null) return null;

  if (input.videoId !== null) {
    const storedVideoId = normalizeStoredVideoId(input.platform, input.videoId);
    if (storedVideoId === null || storedVideoId !== source.videoId) return null;
  }

  if (input.canonicalUrl !== null) {
    const canonical = parseForPlatform(input.platform, input.canonicalUrl);
    if (canonical === null || canonical.videoId !== source.videoId) return null;
  }

  return {
    key: `${input.platform}:${source.videoId}`,
    platform: input.platform,
    videoId: source.videoId,
    canonicalUrl: source.canonicalUrl,
  };
}

function parseForPlatform(
  platform: VideoPlatform,
  url: string,
): { videoId: string; canonicalUrl: string } | null {
  switch (platform) {
    case 'bilibili':
      return parseBilibiliVideoUrl(url);
    case 'youtube':
      return parseYouTubeWatchUrl(url);
    case 'douyin':
      return parseDouyinVideoUrl(url);
  }
}

function normalizeStoredVideoId(platform: VideoPlatform, videoId: string): string | null {
  switch (platform) {
    case 'bilibili':
      return normalizeBilibiliVideoId(videoId);
    case 'youtube':
      return YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
    case 'douyin':
      return DOUYIN_VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  }
}

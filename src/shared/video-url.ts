import type { VideoPlatform } from '../models/platform';
import { normalizeBilibiliVideoId, parseBilibiliVideoUrl } from '../adapters/bilibili/url';
import { parseDouyinVideoUrl } from '../adapters/douyin/url';
import { parseYouTubeWatchUrl } from '../adapters/youtube/url';

interface BilibiliIdentity {
  platform: 'bilibili';
  videoId: string;
  part: string;
  surface: 'video' | 'watch-later';
}

interface YouTubeIdentity {
  platform: 'youtube';
  videoId: string;
  playlistId: string | null;
}

interface DouyinIdentity {
  platform: 'douyin';
  videoId: string;
}

type SourceIdentity = BilibiliIdentity | YouTubeIdentity | DouyinIdentity;

export interface ParsedManualVideoSource {
  platform: VideoPlatform;
  sourceUrl: string;
  canonicalUrl: string;
  videoId: string;
}

export function parseManualVideoSource(urlValue: string): ParsedManualVideoSource | null {
  const trimmed = urlValue.trim();
  const youtube = parseYouTubeWatchUrl(trimmed);
  if (youtube) {
    return {
      platform: 'youtube',
      sourceUrl: youtube.originalUrl,
      canonicalUrl: youtube.canonicalUrl,
      videoId: youtube.videoId,
    };
  }
  const bilibili = parseBilibiliVideoUrl(trimmed);
  if (bilibili) {
    return {
      platform: 'bilibili',
      sourceUrl: bilibili.originalUrl,
      canonicalUrl: bilibili.canonicalUrl,
      videoId: bilibili.videoId,
    };
  }
  const douyin = parseDouyinVideoUrl(trimmed);
  if (douyin) {
    return {
      platform: 'douyin',
      sourceUrl: douyin.originalUrl,
      canonicalUrl: douyin.canonicalUrl,
      videoId: douyin.videoId,
    };
  }
  return null;
}

export function detectVideoPlatform(url: string): VideoPlatform | null {
  return (
    getBilibiliIdentity(url)?.platform ??
    getYouTubeIdentity(url)?.platform ??
    getDouyinIdentity(url)?.platform ??
    null
  );
}

export function isSupportedVideoUrl(url: string, platform?: VideoPlatform): boolean {
  const detected = detectVideoPlatform(url);
  return detected !== null && (platform === undefined || detected === platform);
}

export function hasConsistentVideoIdentity(
  platform: VideoPlatform,
  sourceUrl: string,
  canonicalUrl: string | null | undefined,
  videoId: string | null | undefined,
): boolean {
  const source = getSourceIdentity(sourceUrl);
  if (!source || source.platform !== platform) return false;

  if (canonicalUrl !== null && canonicalUrl !== undefined) {
    const canonical = getSourceIdentity(canonicalUrl);
    if (!canonical || canonical.platform !== platform || canonical.videoId !== source.videoId) {
      return false;
    }
  }

  if (videoId !== null && videoId !== undefined) {
    const normalizedVideoId = platform === 'bilibili' ? normalizeBilibiliVideoId(videoId) : videoId;
    if (normalizedVideoId !== source.videoId) return false;
  }

  return true;
}

export function matchesSavedSource(
  candidateUrl: string,
  savedSourceUrl: string,
  platform?: VideoPlatform,
): boolean {
  const candidate = getSourceIdentity(candidateUrl);
  const saved = getSourceIdentity(savedSourceUrl);
  if (!candidate || !saved || candidate.platform !== saved.platform) return false;
  if (platform !== undefined && saved.platform !== platform) return false;

  if (saved.platform === 'bilibili' && candidate.platform === 'bilibili') {
    return candidate.videoId === saved.videoId && candidate.part === saved.part;
  }
  if (saved.platform === 'youtube' && candidate.platform === 'youtube') {
    return (
      candidate.videoId === saved.videoId &&
      (saved.playlistId === null || candidate.playlistId === saved.playlistId)
    );
  }
  if (saved.platform === 'douyin' && candidate.platform === 'douyin') {
    return candidate.videoId === saved.videoId;
  }
  return false;
}

export function matchesSavedBilibiliSource(candidateUrl: string, savedSourceUrl: string): boolean {
  return matchesSavedSource(candidateUrl, savedSourceUrl, 'bilibili');
}

export function buildSourceOpenUrl(
  sourceUrl: string,
  platform: VideoPlatform,
  timestampSeconds: number | null,
): string {
  if (!isSupportedVideoUrl(sourceUrl, platform)) return sourceUrl;
  if (platform !== 'youtube' || timestampSeconds === null) return sourceUrl;

  const parsed = new URL(sourceUrl);
  parsed.searchParams.set('t', `${Math.max(0, Math.floor(timestampSeconds))}s`);
  return parsed.href;
}

/**
 * Chooses a validated URL for reopening without discarding meaningful Bilibili
 * part or YouTube playlist context from the saved source URL. A canonical URL
 * is preferred only when it describes the same source identity.
 */
export function selectSourceOpenUrl(
  sourceUrl: string,
  canonicalUrl: string | null | undefined,
  platform: VideoPlatform,
): string | null {
  if (!isSupportedVideoUrl(sourceUrl, platform)) return null;
  if (platform === 'bilibili' && getBilibiliIdentity(sourceUrl)?.surface === 'watch-later') {
    return sourceUrl;
  }
  if (
    canonicalUrl &&
    isSupportedVideoUrl(canonicalUrl, platform) &&
    hasConsistentVideoIdentity(platform, sourceUrl, canonicalUrl, null) &&
    matchesSavedSource(canonicalUrl, sourceUrl, platform)
  ) {
    return canonicalUrl;
  }
  return sourceUrl;
}

export function getSourceOpenCandidates(
  sourceUrl: string,
  canonicalUrl: string | null | undefined,
  platform: VideoPlatform,
): string[] {
  const primary = selectSourceOpenUrl(sourceUrl, canonicalUrl, platform);
  if (primary === null) return [];
  if (platform !== 'bilibili') return [primary];

  const source = getBilibiliIdentity(sourceUrl);
  const canonical = canonicalUrl ? getBilibiliIdentity(canonicalUrl) : null;
  if (
    source?.surface === 'watch-later' &&
    canonical?.surface === 'video' &&
    canonical.videoId === source.videoId
  ) {
    return [primary, canonicalUrl!];
  }
  return [primary];
}

export function matchesPreferredSourceContext(
  candidateUrl: string,
  targetUrl: string,
  platform: VideoPlatform,
): boolean {
  if (!matchesSavedSource(candidateUrl, targetUrl, platform)) return false;
  if (platform !== 'bilibili') return true;
  const candidate = getBilibiliIdentity(candidateUrl);
  const target = getBilibiliIdentity(targetUrl);
  return candidate !== null && target !== null && candidate.surface === target.surface;
}

export function getSourceTabPatterns(platform: VideoPlatform): string[] {
  switch (platform) {
    case 'youtube':
      return ['https://www.youtube.com/watch*'];
    case 'douyin':
      return ['https://www.douyin.com/video/*'];
    case 'bilibili':
      return [
        'https://www.bilibili.com/video/*',
        'https://bilibili.com/video/*',
        'https://www.bilibili.com/list/watchlater*',
      ];
  }
}

function getSourceIdentity(url: string): SourceIdentity | null {
  return getBilibiliIdentity(url) ?? getYouTubeIdentity(url) ?? getDouyinIdentity(url);
}

function getBilibiliIdentity(url: string): BilibiliIdentity | null {
  const parsed = parseBilibiliVideoUrl(url);
  return parsed === null
    ? null
    : {
        platform: 'bilibili',
        videoId: parsed.videoId,
        part: parsed.part,
        surface: parsed.surface,
      };
}

function getYouTubeIdentity(url: string): YouTubeIdentity | null {
  const watchUrl = parseYouTubeWatchUrl(url);
  if (watchUrl === null) return null;
  const parsed = new URL(watchUrl.originalUrl);
  return {
    platform: 'youtube',
    videoId: watchUrl.videoId,
    playlistId: parsed.searchParams.get('list'),
  };
}

function getDouyinIdentity(url: string): DouyinIdentity | null {
  const videoUrl = parseDouyinVideoUrl(url);
  return videoUrl === null
    ? null
    : {
        platform: 'douyin',
        videoId: videoUrl.videoId,
      };
}

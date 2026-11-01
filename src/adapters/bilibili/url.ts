// Bilibili sends some visitors to /zh-Hans/video/…, so a language segment may come first.
// Only these four: the manifest grants access to the same list and no other first segment.
const BILIBILI_VIDEO_PATH = /^\/(?:(?:zh-Hans|zh-Hant|en|ja)\/)?video\/(BV[A-Za-z0-9]+|av\d+)\/?$/i;
const BILIBILI_WATCH_LATER_PATH = /^\/(?:(?:zh-Hans|zh-Hant|en|ja)\/)?list\/watchlater\/?$/i;

export interface BilibiliVideoUrl {
  videoId: string;
  originalUrl: string;
  canonicalUrl: string;
  part: string;
  surface: 'video' | 'watch-later';
}

export function parseBilibiliVideoUrl(urlValue: string): BilibiliVideoUrl | null {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return null;
  }

  const directMatch = /^(?:www\.)?bilibili\.com$/i.test(url.hostname)
    ? BILIBILI_VIDEO_PATH.exec(url.pathname)
    : null;
  const watchLater =
    /^www\.bilibili\.com$/i.test(url.hostname) && BILIBILI_WATCH_LATER_PATH.test(url.pathname);
  const rawVideoId = directMatch?.[1] ?? (watchLater ? readWatchLaterVideoId(url) : null);
  const videoId = rawVideoId ? normalizeBilibiliVideoId(rawVideoId) : null;
  if (videoId === null) return null;

  return {
    videoId,
    originalUrl: url.href,
    canonicalUrl: `https://www.bilibili.com/video/${videoId}`,
    part: url.searchParams.get('p') ?? '1',
    surface: watchLater ? 'watch-later' : 'video',
  };
}

export function normalizeBilibiliVideoId(videoId: string): string | null {
  if (/^BV[A-Za-z0-9]+$/i.test(videoId)) return `BV${videoId.slice(2)}`;
  if (/^av\d+$/i.test(videoId)) return `av${videoId.slice(2)}`;
  return null;
}

export function extractBilibiliVideoId(urlValue: string): string | null {
  const supported = parseBilibiliVideoUrl(urlValue);
  if (supported !== null) return supported.videoId;

  try {
    const url = new URL(urlValue);
    const bangumiMatch = url.pathname.match(/\/(ep|ss)(\d+)(?:\/|$)/i);
    return bangumiMatch ? `${bangumiMatch[1]!.toLowerCase()}${bangumiMatch[2]!}` : null;
  } catch {
    return null;
  }
}

export function isBilibiliWatchLaterUrl(urlValue: string): boolean {
  return parseBilibiliVideoUrl(urlValue)?.surface === 'watch-later';
}

function readWatchLaterVideoId(url: URL): string | null {
  const bvidValues = url.searchParams.getAll('bvid');
  const aidValues = url.searchParams.getAll('aid');
  if (bvidValues.length > 1 || aidValues.length > 1) return null;

  const bvid = bvidValues[0];
  const aid = aidValues[0];
  if (bvid !== undefined && aid !== undefined) return null;
  if (bvid !== undefined) return /^BV[A-Za-z0-9]+$/i.test(bvid) ? bvid : null;
  if (aid === undefined) return null;
  if (/^\d+$/.test(aid)) return `av${aid}`;
  return /^av\d+$/i.test(aid) ? aid : null;
}

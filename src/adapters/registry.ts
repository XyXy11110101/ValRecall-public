import { BilibiliAdapter } from './bilibili';
import { parseBilibiliVideoUrl } from './bilibili/url';
import { DouyinAdapter, isSupportedDouyinVideoUrl } from './douyin';
import type { LocationLike, VideoPlatformAdapter } from './types';
import { isSupportedYouTubeWatchUrl, YouTubeAdapter } from './youtube';
import type { VideoPlatform } from '../models/platform';

export function getVideoPlatformFromUrl(urlValue: string): VideoPlatform | null {
  if (isSupportedYouTubeWatchUrl(urlValue)) {
    return 'youtube';
  }
  if (isSupportedDouyinVideoUrl(urlValue)) {
    return 'douyin';
  }
  if (parseBilibiliVideoUrl(urlValue) !== null) return 'bilibili';
  return null;
}

export function createVideoPlatformAdapter(
  documentRef: Document = document,
  locationRef?: LocationLike,
  pageSubtitleSnapshot: unknown = null,
): VideoPlatformAdapter | null {
  const adapterLocation = locationRef ?? documentRef.location;
  const platform = getVideoPlatformFromUrl(adapterLocation.href);
  if (platform === 'youtube') {
    const adapter = new YouTubeAdapter(documentRef, adapterLocation, pageSubtitleSnapshot);
    return adapter.detectPage().value.supported ? adapter : null;
  }
  if (platform === 'douyin') {
    const adapter = new DouyinAdapter(documentRef, adapterLocation, pageSubtitleSnapshot);
    return adapter.detectPage().value.supported ? adapter : null;
  }
  if (platform === 'bilibili') {
    return new BilibiliAdapter(documentRef, adapterLocation, pageSubtitleSnapshot);
  }
  return null;
}

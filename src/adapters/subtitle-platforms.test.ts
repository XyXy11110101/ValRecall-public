import { describe, expect, it } from 'vitest';

import type { PageSubtitleSnapshot } from '../models/page-subtitles';
import type { VideoPlatform } from '../models/platform';
import { BilibiliAdapter } from './bilibili/BilibiliAdapter';
import { DouyinAdapter } from './douyin/DouyinAdapter';
import type { AdapterLocation } from './types';
import { YouTubeAdapter } from './youtube/YouTubeAdapter';

describe('cross-platform player subtitle priority', () => {
  it.each([
    ['manual', false],
    ['automatic', true],
  ] as const)('captures YouTube %s captions from selected player state', (_kind, automatic) => {
    const location = locationFor('https://www.youtube.com/watch?v=subtitle_test', '/watch');
    const video = createVideo(10);
    const result = new YouTubeAdapter(
      document,
      location,
      snapshot('youtube', location.href, automatic ? 'Automatic caption' : 'Manual caption', {
        automatic,
      }),
    ).getSubtitleContext(video, 10, 60);

    expect(result.value.subtitleCurrent).toEqual([
      automatic ? 'Automatic caption' : 'Manual caption',
    ]);
    expect(result.value.extractionStrategy).toBe('text_track_timed_cues');
    expect(result.diagnostics[0]).toMatchObject({
      strategy: 'text_track_timed_cues',
      status: 'success',
    });
  });

  it.each([
    ['uploaded', false],
    ['AI-generated', true],
  ] as const)('captures Bilibili %s subtitles from player state', (_kind, automatic) => {
    const location = locationFor(
      'https://www.bilibili.com/video/BV1SubtitleTest',
      '/video/BV1SubtitleTest',
    );
    const video = createVideo(10);
    const result = new BilibiliAdapter(
      document,
      location,
      snapshot('bilibili', location.href, automatic ? 'AI subtitle' : 'Uploaded subtitle', {
        automatic,
      }),
    ).getSubtitleContext(video, 10);

    expect(result.value.subtitleCurrent).toEqual([automatic ? 'AI subtitle' : 'Uploaded subtitle']);
    expect(result.value.source).toBe('text-track');
  });

  it.each([
    ['direct', 'https://www.douyin.com/video/7420012345678901234', '/video/7420012345678901234'],
    ['modal', 'https://www.douyin.com/user/self?modal_id=7000000000000000002', '/user/self'],
  ] as const)('captures Douyin %s selected-work subtitles', (_surface, href, pathname) => {
    const location = locationFor(href, pathname);
    const video = createVideo(36);
    const result = new DouyinAdapter(
      document,
      location,
      snapshot('douyin', href, 'Douyin selected work', {
        structuredStateInspected: true,
        currentTime: 36,
      }),
    ).getSubtitleContext(video, 36, 120);

    expect(result.value.subtitleCurrent).toEqual(['Douyin selected work']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'douyin-current-work-structured-state',
        status: 'success',
      }),
    );
  });

  it('rejects a stale Douyin SPA snapshot before using current-page fallbacks', () => {
    document.body.innerHTML = '';
    const href = 'https://www.douyin.com/video/7420012345678901234';
    const location = locationFor(href, '/video/7420012345678901234');
    const video = createVideo(36);
    const stale = snapshot('douyin', 'https://www.douyin.com/video/7999999999999999999', 'Stale', {
      structuredStateInspected: true,
      currentTime: 36,
    });
    const result = new DouyinAdapter(document, location, stale).getSubtitleContext(video, 36, 120);

    expect(result.value.status).toBe('unavailable');
    expect(JSON.stringify(result.value)).not.toContain('Stale');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: 'main-world-subtitle-stale-response', status: 'failed' }),
    );
  });
});

function snapshot(
  platform: VideoPlatform,
  href: string,
  currentText: string,
  options: {
    automatic?: boolean;
    structuredStateInspected?: boolean;
    currentTime?: number;
  } = {},
): PageSubtitleSnapshot {
  const currentTime = options.currentTime ?? 10;
  return {
    version: 1,
    requestId: `request-${platform}`,
    platform,
    href,
    collectedAt: 1_786_000_000_000,
    selectedLanguage: 'en',
    structuredStateInspected: options.structuredStateInspected ?? false,
    video: { currentTime, duration: 120, currentSrc: null },
    tracks: [
      {
        id: `${platform}-selected`,
        kind: 'subtitles',
        language: 'en',
        label: 'Selected captions',
        mode: 'showing',
        active: true,
        selected: true,
        default: false,
        original: true,
        automatic: options.automatic ?? false,
        translated: false,
        cues: [{ startTime: currentTime - 1, endTime: currentTime + 1, text: currentText }],
      },
    ],
  };
}

function createVideo(currentTime: number): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperties(video, {
    currentTime: { configurable: true, value: currentTime },
    currentSrc: { configurable: true, value: '' },
    src: { configurable: true, value: '' },
    textTracks: { configurable: true, value: { length: 0 } },
  });
  return video;
}

function locationFor(href: string, pathname: string): AdapterLocation {
  return { href, hostname: new URL(href).hostname, pathname };
}

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { YouTubeAdapter } from './YouTubeAdapter';

const watchUrl = 'https://www.youtube.com/watch?v=AbC_dEf-123&list=PL_safe&index=4';
const youtubeLocation = {
  href: watchUrl,
  hostname: 'www.youtube.com',
  pathname: '/watch',
};

describe('YouTubeAdapter page and metadata extraction', () => {
  beforeEach(() => loadFixture());

  it('extracts required watch metadata while preserving the original playlist URL', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 1_280, height: 720 });

    const result = new YouTubeAdapter(document, youtubeLocation).extractMetadata();

    expect(result.value).toMatchObject({
      sourceUrl: watchUrl,
      canonicalUrl: 'https://www.youtube.com/watch?v=AbC_dEf-123',
      videoId: 'AbC_dEf-123',
      videoTitle: 'Reliable watch title',
      uploader: 'Test channel',
      timestampSeconds: 36,
      videoDurationSeconds: 120,
      chapterTitle: 'Demonstration',
    });
    expect(result.value.description).toContain('00:30 Demonstration');
    expect(result.value.videoBounds).toMatchObject({ width: 1_280, height: 720 });
  });

  it('uses metadata fallbacks and treats channel, description, and chapter as optional', () => {
    document.querySelector('h1')?.remove();
    document.querySelector('ytd-video-owner-renderer')?.remove();
    document.querySelector('#description-inline-expander')?.remove();
    document.querySelector('.ytp-chapter-title-content')?.remove();
    document.querySelector('meta[name="description"]')?.remove();
    prepareFixtureGeometry();

    const adapter = new YouTubeAdapter(document, youtubeLocation);

    expect(adapter.getVideoTitle().value).toBe('Metadata fallback title');
    expect(adapter.getUploader().value).toBeNull();
    expect(adapter.getDescription().value).toBeNull();
    expect(adapter.getChapter(null, 36, null).value).toBeNull();
  });

  it('rejects live watch pages even though their URL has a standard watch shape', () => {
    document.querySelector('ytd-watch-flexy')?.setAttribute('is-live-content', '');

    const result = new YouTubeAdapter(document, youtubeLocation).detectPage();

    expect(result.value).toEqual({ supported: false, platform: null, videoId: 'AbC_dEf-123' });
    expect(result.diagnostics[0]).toMatchObject({ status: 'failed', severity: 'error' });
  });

  it('rejects the selected main video while an advertisement is active', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 5, duration: 60, width: 1_280, height: 720 });
    document.querySelector('#movie_player')?.classList.add('ad-showing');

    const result = new YouTubeAdapter(document, youtubeLocation).findVideoElement();

    expect(result.value).toBeNull();
    expect(result.diagnostics[0]?.strategy).toBe('youtube-active-ad');
  });

  it('prefers a playing main-player video over a larger paused duplicate', () => {
    document.querySelector('#movie_player')!.innerHTML =
      '<video id="large" class="html5-main-video"></video><video id="playing" class="html5-main-video"></video>';
    const large = document.querySelector<HTMLVideoElement>('#large')!;
    const playing = document.querySelector<HTMLVideoElement>('#playing')!;
    mockVideo(large, { paused: true, currentTime: 0, duration: 120, width: 1_600, height: 900 });
    mockVideo(playing, { paused: false, currentTime: 5, duration: 120, width: 640, height: 360 });

    expect(new YouTubeAdapter(document, youtubeLocation).findVideoElement().value).toBe(playing);
  });
});

describe('YouTubeAdapter subtitle extraction', () => {
  beforeEach(() => loadFixture());

  it('prefers an exposed enabled text track without changing its mode', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 7, duration: 120, width: 1_280, height: 720 });
    const track = {
      kind: 'subtitles',
      mode: 'showing',
      cues: cueList([
        { startTime: 0, endTime: 5, text: 'Track before' },
        { startTime: 5, endTime: 10, text: 'Track current' },
        { startTime: 10, endTime: 15, text: 'Track after' },
      ]),
      activeCues: null,
    };
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      value: Object.assign([track], { length: 1 }),
    });

    const result = new YouTubeAdapter(document, youtubeLocation).getSubtitleContext(video, 7, 120);

    expect(result.value.source).toBe('text-track');
    expect(result.value.subtitleCurrent).toEqual(['Track current']);
    expect(result.value.subtitleBefore).toEqual(['Track before']);
    expect(result.value.subtitleAfter).toEqual(['Track after']);
    expect(track.mode).toBe('showing');
  });

  it('uses safely exposed active cues when the full cue list is unavailable', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 7, duration: 120, width: 1_280, height: 720 });
    const active = [{ startTime: 5, endTime: 10, text: 'Active track cue' }];
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      value: Object.assign(
        [
          {
            kind: 'captions',
            mode: 'showing',
            cues: null,
            activeCues: cueList(active),
          },
        ],
        { length: 1 },
      ),
    });

    const result = new YouTubeAdapter(document, youtubeLocation).getSubtitleContext(video, 7, 120);

    expect(result.value.source).toBe('text-track');
    expect(result.value.subtitleCurrent).toEqual(['Active track cue']);
  });

  it('uses only visible timestamped transcript rows and derives cue ends safely', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 7, duration: 14, width: 1_280, height: 720 });

    const result = new YouTubeAdapter(document, youtubeLocation).getSubtitleContext(video, 7, 14);

    expect(result.value.source).toBe('dom-transcript');
    expect(result.value.subtitleBefore).toEqual(['Before transcript line']);
    expect(result.value.subtitleCurrent).toEqual(['Current transcript line']);
    expect(result.value.subtitleAfter).toEqual(['After transcript line']);
    expect(result.value.timedCues.at(-1)).toMatchObject({ startTime: 10, endTime: 14 });
    expect(JSON.stringify(result.value)).not.toContain('Comment text');
    expect(JSON.stringify(result.value)).not.toContain('Recommended video');
    expect(JSON.stringify(result.value)).not.toContain('Captions settings');
  });

  it('falls back to a visible overlay bounded by the active video', () => {
    const video = prepareFixtureGeometry({ transcript: false });
    mockVideo(video, { paused: false, currentTime: 7, duration: 120, width: 1_280, height: 720 });

    const result = new YouTubeAdapter(document, youtubeLocation).getSubtitleContext(video, 7, 120);

    expect(result.value.status).toBe('current_only');
    expect(result.value.source).toBe('visible-overlay');
    expect(result.value.subtitleCurrent).toEqual(['Visible player caption']);
    expect(JSON.stringify(result.value)).not.toContain('Captions settings off color size');
  });

  it('returns unavailable when rows are hidden and overlays are outside the active video', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 7, duration: 120, width: 1_280, height: 720 });
    for (const row of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      row.setAttribute('aria-hidden', 'true');
    }
    const overlay = document.querySelector('.caption-window .ytp-caption-segment')!;
    mockRect(overlay, { left: 1_500, top: 50, width: 300, height: 40 });

    const result = new YouTubeAdapter(document, youtubeLocation).getSubtitleContext(video, 7, 120);

    expect(result.value.status).toBe('unavailable');
    expect(result.value.extractionStrategy).toBe('none');
    expect(result.value.rejectionReasons.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['hidden', 'outside_active_video', 'excluded_ui_ancestor']),
    );
  });
});

describe('YouTubeAdapter bounded seek', () => {
  beforeEach(() => loadFixture());

  it('retries until the main player appears and then seeks without an infinite loop', async () => {
    document.querySelector('video')?.remove();
    const wait = vi.fn(async () => {
      const video = document.createElement('video');
      video.className = 'html5-main-video';
      mockVideo(video, { paused: true, currentTime: 0, duration: 120, width: 640, height: 360 });
      document.querySelector('#movie_player')?.prepend(video);
    });

    const result = await new YouTubeAdapter(document, youtubeLocation).seekToTimestamp(42, {
      maxAttempts: 3,
      retryDelayMs: 0,
      pauseAfterSeek: false,
      wait,
    });

    expect(result).toMatchObject({ ok: true, attempts: 2, timestampSeconds: 42 });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLVideoElement>('video')?.currentTime).toBe(42);
  });

  it('stops exactly at the configured retry limit', async () => {
    document.querySelector('video')?.remove();
    const wait = vi.fn(async () => undefined);

    const result = await new YouTubeAdapter(document, youtubeLocation).seekToTimestamp(12, {
      maxAttempts: 3,
      retryDelayMs: 0,
      wait,
    });

    expect(result).toMatchObject({ ok: false, attempts: 3 });
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

function loadFixture(): void {
  const html = readFileSync('fixtures/youtube-watch-fixture.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

function prepareFixtureGeometry(options: { transcript?: boolean } = {}): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>('video')!;
  mockRectIfPresent('#watch-title', { left: 100, top: 20, width: 800, height: 48 });
  mockRectIfPresent('#channel-name a', { left: 100, top: 80, width: 180, height: 30 });
  mockRectIfPresent('#description-inline-expander', {
    left: 100,
    top: 800,
    width: 800,
    height: 180,
  });
  mockRectIfPresent('.ytp-chapter-title-content', {
    left: 100,
    top: 690,
    width: 200,
    height: 24,
  });
  const overlay = document.querySelector('.caption-window .ytp-caption-segment')!;
  mockRect(overlay, { left: 200, top: 620, width: 800, height: 44 });
  const settings = document.querySelector('.ytp-settings-menu .ytp-caption-segment')!;
  mockRect(settings, { left: 800, top: 100, width: 300, height: 40 });

  if (options.transcript === false) {
    document.querySelector('ytd-transcript-segment-list-renderer')?.remove();
  } else {
    for (const [index, row] of Array.from(
      document.querySelectorAll('ytd-transcript-segment-renderer'),
    ).entries()) {
      mockRect(row, { left: 1_300, top: 100 + index * 50, width: 320, height: 40 });
    }
  }
  return video;
}

function mockRectIfPresent(
  selector: string,
  options: { left: number; top: number; width: number; height: number },
): void {
  const element = document.querySelector(selector);
  if (element !== null) {
    mockRect(element, options);
  }
}

function mockVideo(
  video: HTMLVideoElement,
  options: {
    paused: boolean;
    currentTime: number;
    duration: number;
    width: number;
    height: number;
  },
): void {
  let currentTime = options.currentTime;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => options.paused },
    ended: { configurable: true, get: () => false },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    duration: { configurable: true, get: () => options.duration },
    pause: { configurable: true, value: vi.fn() },
  });
  mockRect(video, { left: 0, top: 0, width: options.width, height: options.height });
}

function mockRect(
  element: Element,
  options: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      x: options.left,
      y: options.top,
      top: options.top,
      left: options.left,
      right: options.left + options.width,
      bottom: options.top + options.height,
      width: options.width,
      height: options.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function cueList(
  cues: Array<{ startTime: number; endTime: number; text: string }>,
): TextTrackCueList {
  return Object.assign([...cues], { getCueById: () => null }) as unknown as TextTrackCueList;
}

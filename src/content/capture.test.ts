import { describe, expect, it, vi } from 'vitest';

import { BilibiliAdapter } from '../adapters/bilibili/BilibiliAdapter';
import { YouTubeAdapter } from '../adapters/youtube/YouTubeAdapter';
import { collectMainWorldSubtitleSnapshot } from '../background/page-subtitle-bridge';
import { captureCurrentPage } from './capture';

const location = {
  href: 'https://www.bilibili.com/video/BV1Fixture?p=3',
  hostname: 'www.bilibili.com',
  pathname: '/video/BV1Fixture',
};
const watchLaterLocation = {
  href: 'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd&vd_source=fixture',
  hostname: 'www.bilibili.com',
  pathname: '/list/watchlater',
};

describe('captureCurrentPage', () => {
  it('builds a useful draft even when optional metadata is unavailable', async () => {
    document.head.innerHTML = '<meta property="og:title" content="Fixture lesson">';
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 125.9 },
      duration: { configurable: true, value: 300 },
      paused: { configurable: true, value: true },
      ended: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
    });
    video.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        top: 20,
        left: 10,
        right: 650,
        bottom: 380,
        width: 640,
        height: 360,
        toJSON: () => ({}),
      }) as DOMRect;

    const result = await captureCurrentPage({
      adapter: new BilibiliAdapter(document, location),
      idGenerator: () => 'draft-fixed',
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({
      draftId: 'draft-fixed',
      videoTitle: 'Fixture lesson',
      uploader: null,
      timestampSeconds: 125.9,
      timestampDisplay: '02:05',
      videoDurationSeconds: 300,
      capturedAt: '2026-07-20T12:00:00.000Z',
      screenshotDataUrl: null,
    });
    expect(result.draft.extractionDiagnostics.some((entry) => entry.field === 'uploader')).toBe(
      true,
    );
  });

  it('returns a user-readable unsupported-page error', async () => {
    const adapter = new BilibiliAdapter(document, {
      href: 'https://example.com/',
      hostname: 'example.com',
      pathname: '/',
    });

    await expect(captureCurrentPage({ adapter })).resolves.toEqual({
      ok: false,
      error: {
        code: 'UNSUPPORTED_PAGE',
        message:
          'ValRecall can capture supported Bilibili direct videos or identified Watch Later items, standard YouTube watch pages, and direct or visible modal Douyin videos.',
      },
    });
  });

  it('returns a player-readiness error for valid Watch Later without a usable main player', async () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';

    await expect(
      captureCurrentPage({
        adapter: new ImmediateBilibiliAdapter(document, watchLaterLocation),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'VIDEO_NOT_FOUND',
        message:
          'Bilibili video player not ready. Wait for the main video to appear, then try again.',
      },
    });
  });

  it('keeps Watch Later item context while emitting the stable direct canonical URL', async () => {
    document.head.innerHTML = '<meta property="og:title" content="Watch Later lesson">';
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 42 },
      duration: { configurable: true, value: 300 },
      paused: { configurable: true, value: true },
      ended: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_METADATA },
      videoWidth: { configurable: true, value: 960 },
      videoHeight: { configurable: true, value: 540 },
    });
    video.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 960,
        bottom: 540,
        width: 960,
        height: 540,
        toJSON: () => ({}),
      }) as DOMRect;

    const result = await captureCurrentPage({
      adapter: new ImmediateBilibiliAdapter(document, watchLaterLocation),
      idGenerator: () => 'watch-later-draft',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({
      platform: 'bilibili',
      sourceUrl: watchLaterLocation.href,
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      videoId: 'BV1Ab411c7Cd',
      timestampSeconds: 42,
    });
  });

  it('captures a standard YouTube watch page without subtitles or a ready duration', async () => {
    document.head.innerHTML = '<meta property="og:title" content="YouTube fixture lesson">';
    document.body.innerHTML =
      '<div id="movie_player"><video class="html5-main-video"></video></div>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, writable: true, value: 42.4 },
      duration: { configurable: true, value: Number.NaN },
      paused: { configurable: true, value: true },
      ended: { configurable: true, value: false },
    });
    video.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_280,
        bottom: 720,
        width: 1_280,
        height: 720,
        toJSON: () => ({}),
      }) as DOMRect;
    const sourceUrl = 'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture&index=2';

    const result = await captureCurrentPage({
      adapter: new YouTubeAdapter(document, {
        href: sourceUrl,
        hostname: 'www.youtube.com',
        pathname: '/watch',
      }),
      idGenerator: () => 'youtube-draft',
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({
      draftId: 'youtube-draft',
      schemaVersion: 2,
      platform: 'youtube',
      sourceUrl,
      canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
      videoId: 'AbCdEf_123-',
      videoTitle: 'YouTube fixture lesson',
      timestampSeconds: 42.4,
      timestampDisplay: '00:42',
      videoDurationSeconds: null,
      subtitleStatus: 'unavailable',
      screenshotDataUrl: null,
    });
  });

  it('uses the real capturePage core path after resolving an active AI Chinese track from six Bilibili tracks', async () => {
    const href = 'https://www.bilibili.com/video/BV1CaptureSixTracks';
    const captureLocation = {
      href,
      hostname: 'www.bilibili.com',
      pathname: '/video/BV1CaptureSixTracks',
    };
    document.head.innerHTML = '<meta property="og:title" content="Six-track subtitle lesson">';
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video>
      <div class="bpx-player-ctrl-subtitle-language">
        <button class="bpx-state-active" data-track-id="ai-zh">AI Chinese</button>
      </div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 123 },
      duration: { configurable: true, value: 300 },
      paused: { configurable: true, value: false },
      ended: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { configurable: true, value: 1_280 },
      videoHeight: { configurable: true, value: 720 },
      currentSrc: { configurable: true, value: 'https://cdn.example/active-video.mp4' },
    });
    video.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_280,
        bottom: 720,
        width: 1_280,
        height: 720,
        toJSON: () => ({}),
      }) as DOMRect;
    const page = globalThis as unknown as Record<string, unknown>;
    const activeAiTrack: Record<string, unknown> = {
      id: 'ai-zh',
      lan: 'ai-zh',
      lan_doc: 'AI Chinese',
      ai_status: 1,
    };
    const subtitleUrlGetter = vi.fn(
      () => '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/capture-six.json',
    );
    Object.defineProperty(activeAiTrack, 'subtitle_url', {
      configurable: true,
      enumerable: true,
      get: subtitleUrlGetter,
    });
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1CaptureSixTracks',
        cid: 123456,
        pages: [{ page: 1, cid: 123456 }],
        subtitle: {
          list: [
            { id: 'uploaded-zh', lan: 'zh-CN', lan_doc: 'Chinese' },
            activeAiTrack,
            { id: 'en', lan: 'en', lan_doc: 'English' },
            { id: 'ja', lan: 'ja', lan_doc: 'Japanese' },
            { id: 'ko', lan: 'ko', lan_doc: 'Korean' },
            { id: 'de', lan: 'de', lan_doc: 'German' },
          ],
        },
      },
    };
    const resourceUrl = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/capture-six.json';
    vi.stubGlobal('location', { href });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            redirected: false,
            url: resourceUrl,
            headers: new Headers({ 'content-type': 'application/json' }),
            body: null,
            text: async () =>
              JSON.stringify({ body: [{ from: 122, to: 124, content: 'Active AI cue' }] }),
          }) as Response,
      ),
    );

    try {
      const subtitleSnapshot = await collectMainWorldSubtitleSnapshot({
        requestId: 'capture-six-track-request',
        platform: 'bilibili',
        expectedHref: href,
      });
      const result = await captureCurrentPage({
        adapter: new ImmediateBilibiliAdapter(document, captureLocation, subtitleSnapshot),
        idGenerator: () => 'six-track-capture-draft',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.draft.subtitleCurrent).toEqual(['Active AI cue']);
      expect(result.draft.subtitleStatus).toBe('timed_context');
      expect(subtitleUrlGetter).toHaveBeenCalledTimes(1);
      expect(result.draft.extractionDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            strategy: 'bilibili-active-player-subtitle',
            message: expect.stringContaining('trackId=ai-zh'),
          }),
          expect.objectContaining({
            strategy: 'bilibili-track-selection-reason',
            message: expect.stringContaining('explicit-track-id'),
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-url-descriptor',
            status: 'success',
            message: expect.stringContaining('accessor=yes'),
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-url-read',
            status: 'success',
            message: expect.stringContaining('protocol-relative-url'),
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-url-normalized',
            status: 'success',
            message: expect.stringContaining(
              'aisubtitle.hdslb.com/bfs/ai_subtitle/prod/capture-six.json',
            ),
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-resource-validation',
            status: 'success',
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-resource-load',
            status: 'success',
          }),
          expect.objectContaining({
            strategy: 'bilibili-subtitle-cue-match',
            status: 'success',
          }),
        ]),
      );
      expect(JSON.stringify(result.draft.extractionDiagnostics)).not.toContain('Active AI cue');
    } finally {
      delete page.__INITIAL_STATE__;
      vi.unstubAllGlobals();
    }
  });

  it('uses the real capturePage core overlay fallback after the resolved Bilibili resource fails', async () => {
    const href = 'https://www.bilibili.com/video/BV1CaptureOverlay';
    const captureLocation = {
      href,
      hostname: 'www.bilibili.com',
      pathname: '/video/BV1CaptureOverlay',
    };
    document.head.innerHTML = '<meta property="og:title" content="Overlay fallback lesson">';
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video>
      <div class="bpx-player-ctrl-subtitle-language">
        <button class="bpx-state-active" data-track-id="ai-zh">AI Chinese</button>
      </div>
      <div id="hidden-template" class="bili-subtitle-x-subtitle-panel-position" style="display:none">
        <span>Hidden template</span>
      </div>
      <div id="visible-wrapper" class="bili-subtitle-x-subtitle-panel-position">
        <span id="visible-cue">Visible overlay cue</span>
      </div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 123 },
      duration: { configurable: true, value: 300 },
      paused: { configurable: true, value: false },
      ended: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { configurable: true, value: 1_280 },
      videoHeight: { configurable: true, value: 720 },
      currentSrc: { configurable: true, value: 'https://cdn.example/overlay-video.mp4' },
    });
    const rectangle = (left: number, top: number, width: number, height: number) =>
      ({
        x: left,
        y: top,
        top,
        left,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
    video.getBoundingClientRect = () => rectangle(0, 0, 1_280, 720);
    for (const element of document.querySelectorAll<HTMLElement>(
      '#hidden-template, #hidden-template *',
    )) {
      element.getBoundingClientRect = () => rectangle(300, 620, 680, 42);
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      '#visible-wrapper, #visible-wrapper *',
    )) {
      element.getBoundingClientRect = () => rectangle(300, 620, 680, 42);
    }
    const page = globalThis as unknown as Record<string, unknown>;
    const activeAiTrack: Record<string, unknown> = {
      id: 'ai-zh',
      lan: 'ai-zh',
      lan_doc: 'AI Chinese',
      ai_status: 1,
    };
    const subtitleUrlGetter = vi.fn(() => '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fails.json');
    Object.defineProperty(activeAiTrack, 'subtitle_url', {
      configurable: true,
      enumerable: true,
      get: subtitleUrlGetter,
    });
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1CaptureOverlay',
        cid: 123456,
        pages: [{ page: 1, cid: 123456 }],
        subtitle: {
          list: [
            { id: 'uploaded-zh', lan: 'zh-CN', lan_doc: 'Chinese' },
            activeAiTrack,
            { id: 'en', lan: 'en', lan_doc: 'English' },
            { id: 'ja', lan: 'ja', lan_doc: 'Japanese' },
            { id: 'ko', lan: 'ko', lan_doc: 'Korean' },
            { id: 'de', lan: 'de', lan_doc: 'German' },
          ],
        },
      },
    };
    vi.stubGlobal('location', { href });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('fixture resource failure'))),
    );

    try {
      const subtitleSnapshot = await collectMainWorldSubtitleSnapshot({
        requestId: 'capture-overlay-request',
        platform: 'bilibili',
        expectedHref: href,
      });
      const result = await captureCurrentPage({
        adapter: new ImmediateBilibiliAdapter(document, captureLocation, subtitleSnapshot),
        idGenerator: () => 'overlay-capture-draft',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.draft.subtitleCurrent).toEqual(['Visible overlay cue']);
      expect(result.draft.subtitleStatus).toBe('current_only');
      expect(subtitleUrlGetter).toHaveBeenCalledTimes(1);
      const strategies = result.draft.extractionDiagnostics.map((entry) => entry.strategy);
      expect(strategies.indexOf('bilibili-selected-track-resource')).toBeLessThan(
        strategies.indexOf('visible_video_overlay'),
      );
      expect(strategies).toContain('bilibili-visible-overlay-instance');
      expect(JSON.stringify(result.draft.extractionDiagnostics)).not.toContain(
        'Visible overlay cue',
      );
    } finally {
      delete page.__INITIAL_STATE__;
      vi.unstubAllGlobals();
    }
  });

  it('keeps the real capturePage core successful when the validated Bilibili subtitle_url accessor throws', async () => {
    const href = 'https://www.bilibili.com/video/BV1CaptureAccessorFailure';
    const captureLocation = {
      href,
      hostname: 'www.bilibili.com',
      pathname: '/video/BV1CaptureAccessorFailure',
    };
    document.head.innerHTML = '<meta property="og:title" content="Accessor failure lesson">';
    document.body.innerHTML = '<main class="bpx-player-container"><video></video></main>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 123 },
      duration: { configurable: true, value: 300 },
      paused: { configurable: true, value: false },
      ended: { configurable: true, value: false },
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoWidth: { configurable: true, value: 1_280 },
      videoHeight: { configurable: true, value: 720 },
      currentSrc: { configurable: true, value: 'https://cdn.example/accessor-failure.mp4' },
    });
    video.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_280,
        bottom: 720,
        width: 1_280,
        height: 720,
        toJSON: () => ({}),
      }) as DOMRect;
    const selectedTrack: Record<string, unknown> = {
      id: 'ai-zh',
      lan: 'zh-CN',
      lan_doc: 'AI Chinese',
      ai_status: 1,
    };
    Object.defineProperty(selectedTrack, 'subtitle_url', {
      configurable: true,
      get() {
        throw new Error('Known accessor fixture failure.');
      },
    });
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1CaptureAccessorFailure',
        cid: 778899,
        pages: [{ page: 1, cid: 778899 }],
        subtitle: { list: [selectedTrack] },
      },
    };
    vi.stubGlobal('location', { href });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const subtitleSnapshot = await collectMainWorldSubtitleSnapshot({
        requestId: 'capture-accessor-failure-request',
        platform: 'bilibili',
        expectedHref: href,
      });
      const result = await captureCurrentPage({
        adapter: new ImmediateBilibiliAdapter(document, captureLocation, subtitleSnapshot),
        idGenerator: () => 'accessor-failure-capture-draft',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.draft.subtitleStatus).toBe('unavailable');
      expect(result.draft.extractionDiagnostics).toContainEqual(
        expect.objectContaining({
          strategy: 'bilibili-subtitle-url-read',
          status: 'failed',
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete page.__INITIAL_STATE__;
      vi.unstubAllGlobals();
    }
  });
});

class ImmediateBilibiliAdapter extends BilibiliAdapter {
  override prepareCapture() {
    return super.prepareCapture({ retryScheduleMs: [0], wait: async () => undefined });
  }
}

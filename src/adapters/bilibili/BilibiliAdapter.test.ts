import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { PageSubtitleSnapshot } from '../../models/page-subtitles';
import {
  BilibiliAdapter,
  chapterFromTimestampHeadings,
  extractBilibiliVideoId,
  selectSubtitleCues,
} from './BilibiliAdapter';

const bilibiliLocation = {
  href: 'https://www.bilibili.com/video/BV1Abc123?p=2#reply',
  hostname: 'www.bilibili.com',
  pathname: '/video/BV1Abc123',
};
const watchLaterUrl =
  'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd' +
  '&spm_id_from=333.1007.fixture.content.click&vd_source=fixture';
const watchLaterLocation = {
  href: watchLaterUrl,
  hostname: 'www.bilibili.com',
  pathname: '/list/watchlater',
};

describe('BilibiliAdapter metadata', () => {
  it('uses a reliable visible video heading before Open Graph metadata', () => {
    document.head.innerHTML = '<meta property="og:title" content="Fallback title">';
    document.body.innerHTML = '<h1 class="video-title">  Preferred   title </h1>';
    mockRect(document.querySelector('h1')!, { left: 30, top: 20, width: 600, height: 48 });
    const adapter = new BilibiliAdapter(document, bilibiliLocation);

    const result = adapter.getVideoTitle();

    expect(result.value).toBe('Preferred title');
    expect(result.diagnostics.map(({ strategy, status }) => ({ strategy, status }))).toEqual([
      { strategy: 'visible-video-heading', status: 'success' },
    ]);
  });

  it('uses reliable metadata before a known non-heading Bilibili title element', () => {
    document.head.innerHTML = '<meta property="og:title" content="Metadata title">';
    document.body.innerHTML = '<div class="video-title">Known element title</div>';
    mockRect(document.querySelector('.video-title')!, {
      left: 30,
      top: 20,
      width: 600,
      height: 48,
    });

    const result = new BilibiliAdapter(document, bilibiliLocation).getVideoTitle();

    expect(result.value).toBe('Metadata title');
    expect(result.diagnostics.at(-1)?.strategy).toBe('reliable-title-metadata');
  });

  it('ignores a hidden heading and falls back to reliable metadata', () => {
    document.head.innerHTML = '<meta property="og:title" content="Visible metadata">';
    document.body.innerHTML = '<h1 class="video-title" aria-hidden="true">Hidden duplicate</h1>';
    mockRect(document.querySelector('h1')!, { left: 30, top: 20, width: 600, height: 48 });

    expect(new BilibiliAdapter(document, bilibiliLocation).getVideoTitle().value).toBe(
      'Visible metadata',
    );
  });

  it('cleans the supplied Bilibili and category suffix without damaging the title prefix', () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title =
      '【示例前缀】这个标题用来测试后缀清理，前面的内容要保留_哔哩哔哩bilibili_VALORANT_第一视角';

    expect(new BilibiliAdapter(document, bilibiliLocation).getVideoTitle().value).toBe(
      '【示例前缀】这个标题用来测试后缀清理，前面的内容要保留',
    );
  });

  it('rejects an external canonical link and derives the stable direct URL', () => {
    document.head.innerHTML = '<link rel="canonical" href="https://example.com/stolen">';
    const result = new BilibiliAdapter(document, bilibiliLocation).getCanonicalUrl();

    expect(result.value).toBe('https://www.bilibili.com/video/BV1Abc123');
    expect(result.diagnostics[0]).toMatchObject({
      strategy: 'current-url-identity',
      status: 'success',
    });
  });

  it('detects supported IDs without accepting unrelated pages', () => {
    expect(extractBilibiliVideoId(bilibiliLocation.href)).toBe('BV1Abc123');
    expect(extractBilibiliVideoId('https://www.bilibili.com/bangumi/play/ep1234')).toBe('ep1234');
    expect(new BilibiliAdapter(document, bilibiliLocation).detectPage().value.supported).toBe(true);
    expect(
      new BilibiliAdapter(document, {
        href: 'https://example.com/video/BV1Abc123',
        hostname: 'example.com',
        pathname: '/video/BV1Abc123',
      }).detectPage().value.supported,
    ).toBe(false);
  });

  it('normalises a reliable page aid attribute into an av identifier', () => {
    document.body.innerHTML = '<div data-aid="123456"></div>';
    const adapter = new BilibiliAdapter(document, {
      href: 'https://www.bilibili.com/video/',
      hostname: 'www.bilibili.com',
      pathname: '/video/',
    });

    expect(adapter.getVideoId(null).value).toBe('av123456');
  });

  it('detects Watch Later, retains item context, and derives canonical identity metadata', () => {
    loadWatchLaterFixture();
    const main = document.querySelector<HTMLVideoElement>('#watch-later-main')!;
    const preview = document.querySelector<HTMLVideoElement>('#watch-later-preview')!;
    mockVideo(main, { paused: true, width: 960, height: 540, currentTime: 42 });
    mockVideo(preview, { paused: false, width: 160, height: 90, currentTime: 5 });
    const adapter = new BilibiliAdapter(document, watchLaterLocation);

    expect(adapter.detectPage().value).toEqual({
      supported: true,
      platform: 'bilibili',
      videoId: 'BV1Ab411c7Cd',
    });
    const metadata = adapter.extractMetadata().value;
    expect(metadata).toMatchObject({
      sourceUrl: watchLaterUrl,
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      videoId: 'BV1Ab411c7Cd',
      timestampSeconds: 42,
    });
  });
});

describe('BilibiliAdapter video selection', () => {
  it('uses rendered area as the strongest signal and accepts a dominant paused player', () => {
    document.body.innerHTML = '<video id="large"></video><video id="playing"></video>';
    const large = document.querySelector<HTMLVideoElement>('#large')!;
    const playing = document.querySelector<HTMLVideoElement>('#playing')!;
    mockVideo(large, { paused: true, width: 1_000, height: 600 });
    mockVideo(playing, { paused: false, width: 640, height: 360 });

    expect(new BilibiliAdapter(document, bilibiliLocation).findVideoElement().value).toBe(large);
  });

  it('chooses the largest visible video when all are paused', () => {
    document.body.innerHTML = '<video id="small"></video><video id="large"></video>';
    const small = document.querySelector<HTMLVideoElement>('#small')!;
    const large = document.querySelector<HTMLVideoElement>('#large')!;
    mockVideo(small, { paused: true, width: 320, height: 180 });
    mockVideo(large, { paused: true, width: 800, height: 450 });

    expect(new BilibiliAdapter(document, bilibiliLocation).findVideoElement().value).toBe(large);
  });

  it('rejects a tiny playing preview when no meaningful main player is available', () => {
    document.body.innerHTML = '<video class="recommend-preview"></video>';
    const preview = document.querySelector<HTMLVideoElement>('video')!;
    mockVideo(preview, { paused: false, width: 160, height: 90 });

    const result = new BilibiliAdapter(document, watchLaterLocation).findVideoElement();

    expect(result.value).toBeNull();
    expect(result.diagnostics.at(-1)).toMatchObject({
      strategy: 'dominant-visible-main-player',
      status: 'failed',
    });
  });

  it('selects the dominant main player among visible Watch Later candidates', () => {
    loadWatchLaterFixture();
    const main = document.querySelector<HTMLVideoElement>('#watch-later-main')!;
    const preview = document.querySelector<HTMLVideoElement>('#watch-later-preview')!;
    mockVideo(main, { paused: true, width: 960, height: 540 });
    mockVideo(preview, { paused: false, width: 160, height: 90 });

    expect(new BilibiliAdapter(document, watchLaterLocation).findVideoElement().value).toBe(main);
  });
});

describe('Bilibili capture preparation and consistency', () => {
  it('returns a player-readiness error instead of unsupported for an absent main player', async () => {
    document.body.innerHTML = '';
    const wait = vi.fn(async () => undefined);
    const adapter = new BilibiliAdapter(document, watchLaterLocation);

    await expect(adapter.prepareCapture({ retryScheduleMs: [0, 50, 100], wait })).resolves.toEqual({
      ok: false,
      reason: 'VIDEO_LOADING',
      message:
        'Bilibili video player not ready. Wait for the main video to appear, then try again.',
    });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('uses bounded readiness retries and accepts a later dominant paused player', async () => {
    document.body.innerHTML = '';
    const wait = vi.fn(async () => {
      if (document.querySelector('video') === null) {
        const video = document.createElement('video');
        mockVideo(video, { paused: true, width: 960, height: 540 });
        document.body.append(video);
      }
    });
    const adapter = new BilibiliAdapter(document, watchLaterLocation);

    await expect(adapter.prepareCapture({ retryScheduleMs: [0, 50, 100], wait })).resolves.toEqual({
      ok: true,
    });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('rejects a Watch Later identity change during bounded preparation', async () => {
    document.body.innerHTML = '';
    const location = { ...watchLaterLocation };
    const wait = vi.fn(async () => {
      location.href =
        'https://www.bilibili.com/list/watchlater?bvid=BV1Different&spm_id_from=changed';
    });

    await expect(
      new BilibiliAdapter(document, location).prepareCapture({
        retryScheduleMs: [0, 50],
        wait,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'UNSTABLE_VIDEO',
    });
  });

  it('invalidates screenshot consistency when the Watch Later URL identity changes', () => {
    loadWatchLaterFixture();
    const location = { ...watchLaterLocation };
    const main = document.querySelector<HTMLVideoElement>('#watch-later-main')!;
    const preview = document.querySelector<HTMLVideoElement>('#watch-later-preview')!;
    mockVideo(main, { paused: true, width: 960, height: 540, currentTime: 42 });
    mockVideo(preview, { paused: false, width: 160, height: 90 });
    const adapter = new BilibiliAdapter(document, location);
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();

    expect(validate?.()).toBe(true);
    location.href = 'https://www.bilibili.com/list/watchlater?bvid=BV1Different';
    expect(validate?.()).toBe(false);
  });

  it('invalidates screenshot consistency when the selected main player is replaced', () => {
    loadWatchLaterFixture();
    const main = document.querySelector<HTMLVideoElement>('#watch-later-main')!;
    const preview = document.querySelector<HTMLVideoElement>('#watch-later-preview')!;
    mockVideo(main, { paused: true, width: 960, height: 540, currentTime: 42 });
    mockVideo(preview, { paused: false, width: 160, height: 90 });
    const adapter = new BilibiliAdapter(document, watchLaterLocation);
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();

    expect(validate?.()).toBe(true);
    const replacement = document.createElement('video');
    mockVideo(replacement, { paused: true, width: 960, height: 540, currentTime: 42 });
    main.replaceWith(replacement);
    expect(validate?.()).toBe(false);
  });
});

describe('subtitle extraction', () => {
  it('selects two surrounding cues, current cues, and removes duplicate lines', () => {
    const context = selectSubtitleCues(
      [
        { startTime: 0, endTime: 5, text: 'First' },
        { startTime: 5, endTime: 10, text: 'Second' },
        { startTime: 10, endTime: 15, text: ' Current   cue ' },
        { startTime: 10, endTime: 15, text: 'Current cue' },
        { startTime: 15.1, endTime: 20, text: 'After one' },
        { startTime: 20, endTime: 25, text: 'After two' },
        { startTime: 25, endTime: 30, text: 'After three' },
      ],
      12,
    );

    expect(context.subtitleBefore).toEqual(['First', 'Second']);
    expect(context.subtitleCurrent).toEqual(['Current cue']);
    expect(context.subtitleAfter).toEqual(['After one', 'After two']);
    expect(context.status).toBe('timed_context');
    expect(context.extractionStrategy).toBe('text_track_timed_cues');
    expect(context.timedCues).toHaveLength(5);
    expect(context.availability).toBe('context');
  });

  it('treats cue end times as exclusive at an exact boundary', () => {
    const context = selectSubtitleCues(
      [
        { startTime: 0, endTime: 5, text: 'Old cue' },
        { startTime: 5, endTime: 10, text: 'New cue' },
      ],
      5,
    );

    expect(context.subtitleBefore).toEqual(['Old cue']);
    expect(context.subtitleCurrent).toEqual(['New cue']);
  });

  it('prefers timed HTML text tracks over a visible page overlay', () => {
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video><div class="bpx-player-subtitle-panel-text">Overlay fallback</div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const overlay = document.querySelector('.bpx-player-subtitle-panel-text')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(overlay, { left: 200, top: 620, width: 880, height: 50 });
    const cues = [
      { startTime: 0, endTime: 5, text: 'Before' },
      { startTime: 5, endTime: 10, text: 'Track current' },
      { startTime: 10.1, endTime: 15, text: 'After' },
    ];
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      value: {
        0: { kind: 'subtitles', cues: cueList(cues), activeCues: cueList([cues[1]!]) },
        length: 1,
      },
    });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 7);

    expect(result.value.source).toBe('text-track');
    expect(result.value.status).toBe('timed_context');
    expect(result.value.extractionStrategy).toBe('text_track_timed_cues');
    expect(result.value.subtitleCurrent).toEqual(['Track current']);
    expect(result.value.subtitleBefore).toEqual(['Before']);
    expect(result.value.subtitleAfter).toEqual(['After']);
    expect(result.diagnostics[0]?.strategy).toBe('text_track_timed_cues');
  });

  it('falls back to only the visible overlay without claiming surrounding context', () => {
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video><div class="bpx-player-subtitle-panel-text">  Hold   here. </div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const overlay = document.querySelector('.bpx-player-subtitle-panel-text')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(overlay, { left: 200, top: 620, width: 880, height: 50 });
    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 10);

    expect(result.value.subtitleCurrent).toEqual(['Hold here.']);
    expect(result.value.subtitleBefore).toEqual([]);
    expect(result.value.status).toBe('current_only');
    expect(result.value.extractionStrategy).toBe('visible_video_overlay');
    expect(result.value.confidence).toBe('medium');
    expect(result.value.timedCues).toEqual([]);
    expect(result.value.availability).toBe('current-only');
    expect(result.value.source).toBe('visible-overlay');
  });

  it('finds a tightly bounded subtitle child inside a large Bilibili overlay wrapper', () => {
    document.body.innerHTML = `
      <main class="bpx-player-container">
        <video></video>
        <div id="large-wrapper" class="bpx-player-subtitle-panel-text">
          <span id="tight-subtitle">Nested visible subtitle</span>
        </div>
      </main>
    `;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const wrapper = document.querySelector('#large-wrapper')!;
    const subtitle = document.querySelector('#tight-subtitle')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(wrapper, { left: -800, top: 580, width: 3_000, height: 120 });
    mockRect(subtitle, { left: 340, top: 620, width: 600, height: 42 });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 12);

    expect(result.value.subtitleCurrent).toEqual(['Nested visible subtitle']);
    expect(result.value.source).toBe('visible-overlay');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'bilibili-visible-overlay-candidates',
        status: 'success',
      }),
    );
  });

  it('continues to the overlay when a player blocks text-track access', () => {
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video><div class="bpx-player-subtitle-panel-text">Readable fallback</div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const overlay = document.querySelector('.bpx-player-subtitle-panel-text')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(overlay, { left: 200, top: 620, width: 880, height: 50 });
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      get: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 7);

    expect(result.value.subtitleCurrent).toEqual(['Readable fallback']);
    expect(result.value.source).toBe('visible-overlay');
    expect(result.diagnostics[0]).toMatchObject({
      strategy: 'text_track_timed_cues',
      status: 'failed',
    });
  });

  it('reads nested visible text once from the confirmed current-player subtitle wrapper', () => {
    document.body.innerHTML = `
      <main id="other-player" class="bpx-player-container">
        <video></video>
        <div id="other-wrapper" class="bili-subtitle-x-subtitle-panel-position">
          <span id="other-line">Wrong player subtitle</span>
        </div>
      </main>
      <main id="selected-player" class="bpx-player-container">
        <video></video>
        <div id="selected-wrapper" class="bili-subtitle-x-subtitle-panel-position">
          <span id="line-one">Hold the angle.</span>
          <span id="line-duplicate">Hold the angle.</span>
          <span id="hidden-line" style="display: none">Hidden subtitle</span>
          <div class="bpx-player-dm-wrap"><span id="danmaku-line">Danmaku text</span></div>
          <button type="button">Subtitle settings</button>
        </div>
      </main>
    `;
    const videos = document.querySelectorAll<HTMLVideoElement>('video');
    const otherVideo = videos[0]!;
    const selectedVideo = videos[1]!;
    mockVideo(selectedVideo, { paused: false, width: 1_280, height: 720 });
    mockVideo(otherVideo, { paused: false, width: 640, height: 360 });
    for (const selector of [
      '#selected-wrapper',
      '#line-one',
      '#line-duplicate',
      '#hidden-line',
      '#danmaku-line',
    ]) {
      for (const element of document.querySelectorAll(selector)) {
        mockRect(element, { left: 300, top: 620, width: 680, height: 42 });
      }
    }
    mockRect(document.querySelector('#other-wrapper')!, {
      left: 0,
      top: 650,
      width: 1_280,
      height: 60,
    });
    mockRect(document.querySelector('#other-line')!, {
      left: 0,
      top: 660,
      width: 1_280,
      height: 50,
    });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(
      selectedVideo,
      12,
    );

    expect(result.value.source).toBe('visible-overlay');
    expect(result.value.subtitleCurrent).toEqual(['Hold the angle.']);
    expect(result.value.subtitleCurrent).not.toContain('Hidden subtitle');
    expect(result.value.subtitleCurrent).not.toContain('Danmaku text');
    expect(result.value.subtitleCurrent).not.toContain('Wrong player subtitle');
    expect(result.value.rejectionReasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['hidden', 'excluded_ui_ancestor']),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'bilibili-visible-overlay-candidates',
        status: 'success',
      }),
    );
  });

  it('skips hidden and zero-sized wrapper instances and selects the visible current-player descendant', () => {
    document.body.innerHTML = `
      <main id="other-player" class="bpx-player-container">
        <video></video>
        <div id="other-instance" class="bili-subtitle-x-subtitle-panel-position">
          <span>Other player line</span>
        </div>
      </main>
      <main id="active-player" class="bpx-player-container">
        <video></video>
        <div id="hidden-template" class="bili-subtitle-x-subtitle-panel-position" style="display:none">
          <span>Hidden template line</span>
        </div>
        <div id="zero-instance" class="bili-subtitle-x-subtitle-panel-position">
          <span>Inactive zero-sized line</span>
        </div>
        <div id="visible-instance" class="bili-subtitle-x-subtitle-panel-position">
          <div><span id="visible-line">Visible current subtitle</span></div>
        </div>
      </main>
    `;
    const videos = document.querySelectorAll<HTMLVideoElement>('video');
    const otherVideo = videos[0]!;
    const activeVideo = videos[1]!;
    mockVideo(otherVideo, { paused: false, width: 640, height: 360 });
    mockVideo(activeVideo, { paused: false, width: 1_280, height: 720 });
    for (const element of document.querySelectorAll('#hidden-template, #hidden-template *')) {
      mockRect(element, { left: 300, top: 620, width: 680, height: 42 });
    }
    for (const element of document.querySelectorAll('#zero-instance, #zero-instance *')) {
      mockRect(element, { left: 300, top: 620, width: 0, height: 0 });
    }
    for (const element of document.querySelectorAll('#visible-instance, #visible-instance *')) {
      mockRect(element, { left: 300, top: 620, width: 680, height: 42 });
    }
    for (const element of document.querySelectorAll('#other-instance, #other-instance *')) {
      mockRect(element, { left: 300, top: 620, width: 680, height: 42 });
    }

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(
      activeVideo,
      123,
    );
    const summary = result.diagnostics.find(
      (entry) => entry.strategy === 'bilibili-visible-overlay-candidates',
    );
    const instances = result.diagnostics.filter(
      (entry) => entry.strategy === 'bilibili-visible-overlay-instance',
    );

    expect(result.value.source).toBe('visible-overlay');
    expect(result.value.subtitleCurrent).toEqual(['Visible current subtitle']);
    expect(result.value.subtitleCurrent).not.toEqual(
      expect.arrayContaining([
        'Hidden template line',
        'Inactive zero-sized line',
        'Other player line',
      ]),
    );
    expect(summary?.message).toContain('Selector matches=4');
    expect(summary?.message).toContain('active-player scoped=3');
    expect(summary?.message).toContain('accepted=1');
    expect(instances).toHaveLength(3);
    expect(instances.map((entry) => entry.message).join(' ')).toContain('zero_bounds');
    expect(instances.map((entry) => entry.message).join(' ')).toContain('hidden');
    expect(JSON.stringify(result.diagnostics)).not.toContain('Visible current subtitle');
  });

  it('accepts only an unowned confirmed wrapper portal that visibly intersects the selected video', () => {
    document.body.innerHTML = `
      <main class="bpx-player-container"><video></video></main>
      <div id="subtitle-portal" class="bili-subtitle-x-subtitle-panel-position">
        <span id="portal-line">Visible portal subtitle</span>
      </div>
    `;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const portal = document.querySelector('#subtitle-portal')!;
    const line = document.querySelector('#portal-line')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(portal, { left: 250, top: 610, width: 780, height: 64 });
    mockRect(line, { left: 300, top: 620, width: 680, height: 42 });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 123);

    expect(result.value.subtitleCurrent).toEqual(['Visible portal subtitle']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'bilibili-visible-overlay-candidates',
        message: expect.stringContaining('active-player scoped=1'),
      }),
    );
  });

  it('falls back to the confirmed current-player overlay after a selected resource failure', () => {
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video>
      <div class="bili-subtitle-x-subtitle-panel-position">
        <span id="resource-fallback-line">Visible fallback after resource failure</span>
      </div>
    </main>`;
    const video = document.querySelector<HTMLVideoElement>('video')!;
    const wrapper = document.querySelector('.bili-subtitle-x-subtitle-panel-position')!;
    const line = document.querySelector('#resource-fallback-line')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(wrapper, { left: 200, top: 600, width: 880, height: 72 });
    mockRect(line, { left: 300, top: 620, width: 680, height: 42 });
    const snapshot: PageSubtitleSnapshot = {
      version: 1,
      requestId: 'bilibili-resource-failure-overlay',
      platform: 'bilibili',
      href: bilibiliLocation.href,
      collectedAt: 1_786_000_000_000,
      selectedLanguage: null,
      structuredStateInspected: false,
      bilibiliIdentity: {
        bvid: 'BV1Abc123',
        aid: null,
        cid: '123456',
        part: 2,
        matched: true,
      },
      video: { currentTime: 123, duration: 180, currentSrc: null },
      tracks: [
        {
          id: 'sole-ai-zh',
          kind: 'subtitles',
          language: 'zh-CN',
          label: 'Chinese AI-generated',
          mode: 'disabled',
          active: false,
          selected: false,
          default: false,
          original: false,
          automatic: true,
          translated: false,
          cues: [],
          resource: {
            available: true,
            status: 'request-failed',
            host: 'aisubtitle.hdslb.com',
            parsedCueCount: 0,
          },
        },
      ],
    };

    const result = new BilibiliAdapter(document, bilibiliLocation, snapshot).getSubtitleContext(
      video,
      123,
    );
    const strategies = result.diagnostics.map((entry) => entry.strategy);

    expect(result.value.source).toBe('visible-overlay');
    expect(result.value.subtitleCurrent).toEqual(['Visible fallback after resource failure']);
    expect(strategies.indexOf('bilibili-selected-track-resource')).toBeLessThan(
      strategies.indexOf('visible_video_overlay'),
    );
    expect(strategies).toContain('subtitle-overlay-fallback');
  });

  it('uses timed accessible transcript rows before the visible overlay', () => {
    document.body.innerHTML = `
      <div class="bpx-player-subtitle-list">
        <div class="bpx-player-subtitle-item" data-start-time="0" data-end-time="5">Before row</div>
        <div class="bpx-player-subtitle-item" data-start-time="5" data-end-time="10">Current row</div>
        <div class="bpx-player-subtitle-item" data-start-time="10" data-end-time="15">After row</div>
      </div>
      <div class="bpx-player-subtitle-panel-text">Overlay fallback</div>
    `;

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(null, 7);

    expect(result.value.source).toBe('dom-transcript');
    expect(result.value.status).toBe('timed_context');
    expect(result.value.extractionStrategy).toBe('timestamped_transcript_rows');
    expect(result.value.subtitleBefore).toEqual(['Before row']);
    expect(result.value.subtitleCurrent).toEqual(['Current row']);
    expect(result.value.subtitleAfter).toEqual(['After row']);
  });

  it('selects the real overlay while rejecting the exact settings regression text and hidden duplicates', () => {
    loadSubtitleSettingsFixture();
    const video = document.querySelector<HTMLVideoElement>('#active-video')!;
    const realOverlay = document.querySelector('#real-subtitle')!;
    const settingsCandidate = document.querySelector('#settings-candidate')!;
    const hiddenDuplicate = document.querySelector('#hidden-duplicate')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(realOverlay, { left: 190, top: 620, width: 900, height: 52 });
    mockRect(settingsCandidate, { left: 120, top: 80, width: 1_000, height: 560 });
    mockRect(hiddenDuplicate, { left: 190, top: 620, width: 900, height: 52 });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 42);
    const extracted = [
      ...result.value.subtitleBefore,
      ...result.value.subtitleCurrent,
      ...result.value.subtitleAfter,
    ].join(' ');

    expect(result.value.status).toBe('current_only');
    expect(result.value.subtitleCurrent).toEqual(['Hold the angle until the utility lands.']);
    const serialisedResult = JSON.stringify(result.value);
    for (const forbidden of ['字幕大小', '字幕颜色', '恢复默认设置', 'B站自研的AI原声翻译功能']) {
      expect(extracted).not.toContain(forbidden);
      expect(serialisedResult).not.toContain(forbidden);
    }
    expect(result.value.rejectionReasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['excluded_ui_ancestor', 'settings_text', 'hidden']),
    );
  });

  it('returns unavailable instead of settings text when the real overlay is removed', () => {
    loadSubtitleSettingsFixture();
    document.querySelector('#real-subtitle')?.remove();
    const video = document.querySelector<HTMLVideoElement>('#active-video')!;
    const settingsCandidate = document.querySelector('#settings-candidate')!;
    const hiddenDuplicate = document.querySelector('#hidden-duplicate')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    mockRect(settingsCandidate, { left: 120, top: 80, width: 1_000, height: 560 });
    mockRect(hiddenDuplicate, { left: 190, top: 620, width: 900, height: 52 });

    const result = new BilibiliAdapter(document, bilibiliLocation).getSubtitleContext(video, 42);

    expect(result.value.status).toBe('unavailable');
    expect(result.value.extractionStrategy).toBe('none');
    expect(result.value.confidence).toBe('none');
    expect(result.value.subtitleCurrent).toEqual([]);
    expect(result.value.timedCues).toEqual([]);
  });

  it('emits only the available-but-unreadable final classification after finding a bridge track', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    mockVideo(video, { paused: false, width: 1_280, height: 720 });
    const snapshot: PageSubtitleSnapshot = {
      version: 1,
      requestId: 'bilibili-unreadable-track',
      platform: 'bilibili',
      href: bilibiliLocation.href,
      collectedAt: 1_786_000_000_000,
      selectedLanguage: null,
      structuredStateInspected: false,
      bilibiliIdentity: {
        bvid: 'BV1Abc123',
        aid: null,
        cid: '123456',
        part: 2,
        matched: true,
      },
      video: { currentTime: 12, duration: 60, currentSrc: null },
      tracks: [
        {
          id: 'sole-metadata-track',
          kind: 'subtitles',
          language: 'zh-CN',
          label: 'Chinese',
          mode: 'disabled',
          active: false,
          selected: false,
          default: false,
          original: false,
          automatic: true,
          translated: false,
          cues: [],
          resource: {
            available: true,
            status: 'request-failed',
            host: 'aisubtitle.hdslb.com',
            parsedCueCount: 0,
          },
        },
      ],
    };

    const result = new BilibiliAdapter(document, bilibiliLocation, snapshot).getSubtitleContext(
      video,
      12,
    );
    const strategies = result.diagnostics.map((entry) => entry.strategy);

    expect(strategies).toContain('subtitles-available-unreadable');
    expect(strategies).not.toContain('no-subtitles-available');
    expect(strategies).not.toContain('no-accessible-subtitles');
  });
});

describe('chapter extraction', () => {
  it('uses only timestamp headings at or before the captured moment', () => {
    const description = '00:00 Intro\n00:30 Holding the angle\n01:15 Safe reposition';

    expect(chapterFromTimestampHeadings(description, 74)).toBe('Holding the angle');
    expect(chapterFromTimestampHeadings(description, 75)).toBe('Safe reposition');
    expect(chapterFromTimestampHeadings('Some unstructured advice', 50)).toBeNull();
  });

  it('preserves description line breaks so the adapter can use reliable headings', () => {
    document.body.innerHTML = `<div class="basic-desc-info">
      00:00 Intro
      00:30 Holding the angle
      01:15 Safe reposition
    </div>`;
    const adapter = new BilibiliAdapter(document, bilibiliLocation);

    expect(adapter.getDescription().value).toContain('\n00:30 Holding the angle');
    expect(adapter.getChapter(null, 74).value).toBe('Holding the angle');
  });

  it('prefers an accessible chapter text track and handles exact boundaries', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector<HTMLVideoElement>('video')!;
    Object.defineProperty(video, 'textTracks', {
      configurable: true,
      value: {
        0: {
          kind: 'chapters',
          cues: cueList([
            { startTime: 0, endTime: 30, text: 'Introduction' },
            { startTime: 30, endTime: 60, text: 'Holding the angle' },
          ]),
          activeCues: null,
        },
        length: 1,
      },
    });

    const result = new BilibiliAdapter(document, bilibiliLocation).getChapter(video, 30);

    expect(result.value).toBe('Holding the angle');
    expect(result.diagnostics[0]?.strategy).toBe('chapter-text-track');
  });
});

describe('seek retry limits', () => {
  it('retries until a dynamically inserted video becomes available', async () => {
    document.body.innerHTML = '';
    const wait = vi.fn(async () => {
      const video = document.createElement('video');
      mockVideo(video, { paused: true, width: 640, height: 360 });
      document.body.append(video);
    });
    const adapter = new BilibiliAdapter(document, bilibiliLocation);

    const result = await adapter.seekToTimestamp(42, {
      maxAttempts: 3,
      retryDelayMs: 0,
      pauseAfterSeek: false,
      wait,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(document.querySelector('video')?.currentTime).toBe(42);
  });

  it('stops exactly at the configured retry limit', async () => {
    document.body.innerHTML = '';
    const wait = vi.fn(async () => undefined);

    const result = await new BilibiliAdapter(document, bilibiliLocation).seekToTimestamp(12, {
      maxAttempts: 3,
      retryDelayMs: 0,
      wait,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

function mockVideo(
  video: HTMLVideoElement,
  options: {
    paused: boolean;
    width: number;
    height: number;
    currentTime?: number;
    ready?: boolean;
  },
): void {
  Object.defineProperty(video, 'paused', { configurable: true, get: () => options.paused });
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    writable: true,
    value: options.currentTime ?? 12,
  });
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    get: () => (options.ready === false ? 0 : HTMLMediaElement.HAVE_METADATA),
  });
  Object.defineProperty(video, 'videoWidth', {
    configurable: true,
    get: () => (options.ready === false ? 0 : options.width),
  });
  Object.defineProperty(video, 'videoHeight', {
    configurable: true,
    get: () => (options.ready === false ? 0 : options.height),
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

function loadSubtitleSettingsFixture(): void {
  const html = readFileSync('fixtures/bilibili-subtitle-settings-regression.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

function loadWatchLaterFixture(): void {
  const html = readFileSync('fixtures/bilibili-watch-later-fixture.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
}

function cueList(
  cues: Array<{ startTime: number; endTime: number; text: string }>,
): TextTrackCueList {
  return Object.assign([...cues], { getCueById: () => null }) as unknown as TextTrackCueList;
}

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DouyinAdapter } from './DouyinAdapter';

const videoId = '7420012345678901234';
const sourceUrl = `https://www.douyin.com/video/${videoId}?previous_page=fixture`;
const douyinLocation = {
  href: sourceUrl,
  hostname: 'www.douyin.com',
  pathname: `/video/${videoId}`,
};
const modalVideoId = '7000000000000000002';
const complexModalUrl =
  `https://www.douyin.com/user/self?from_tab_name=main&modal_id=${modalVideoId}` +
  '&showSubTab=favorite_folder&showTab=favorite_collection';
const favouritesVideoId = '7000000000000000001';
const secondRealRetestUrl =
  `https://www.douyin.com/user/self?from_tab_name=main&modal_id=${favouritesVideoId}` +
  '&showTab=favorite_collection';

describe('DouyinAdapter page, player, and metadata extraction', () => {
  beforeEach(() => loadFixture());

  it('extracts direct-page metadata from the reliably associated active video', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 800, height: 450 });

    const result = new DouyinAdapter(document, douyinLocation).extractMetadata();

    expect(result.value).toMatchObject({
      sourceUrl,
      canonicalUrl: `https://www.douyin.com/video/${videoId}`,
      videoId,
      videoTitle: 'Visible associated fixture lesson',
      uploader: 'Fixture creator',
      description: 'Visible associated fixture lesson',
      timestampSeconds: 36,
      videoDurationSeconds: 120,
      chapterTitle: 'Fixture chapter',
    });
    expect(result.value.videoBounds).toMatchObject({ width: 800, height: 450 });
    expect(result.value.subtitleContext).toMatchObject({
      status: 'timed_context',
      source: 'dom-transcript',
      subtitleCurrent: ['Transcript current'],
    });
  });

  it('uses the strict title hierarchy and ignores a hashtag-only visible label', () => {
    prepareFixtureGeometry();
    const heading = document.querySelector('[data-e2e="video-desc"]')!;
    heading.textContent = '#fixture #onlytags';
    const adapter = new DouyinAdapter(document, douyinLocation);

    expect(adapter.getVideoTitle().value).toBe('Open Graph fixture title');

    document.querySelector('meta[property="og:title"]')?.remove();
    expect(adapter.getVideoTitle().value).toBe('Fixture document fallback');

    document.title = 'Douyin';
    expect(adapter.getVideoTitle().value).toBe(`Douyin video ${videoId}`);
  });

  it('rejects structured metadata for another video and falls back to associated Open Graph data', () => {
    prepareFixtureGeometry();
    document.querySelector('[data-e2e="video-desc"]')?.remove();
    document.querySelector('script[type="application/ld+json"]')!.textContent = JSON.stringify({
      '@type': 'VideoObject',
      url: 'https://www.douyin.com/video/9999999999999999999',
      name: 'Wrong recommendation title',
      author: { name: 'Wrong recommendation author' },
    });
    const adapter = new DouyinAdapter(document, douyinLocation);

    expect(adapter.getVideoTitle().value).toBe('Open Graph fixture title');
    document.querySelector('[data-e2e="video-author"]')?.remove();
    expect(adapter.getUploader().value).toBeNull();
  });

  it('falls back from a missing visible author to associated structured author metadata', () => {
    prepareFixtureGeometry();
    document.querySelector('[data-e2e="video-author"]')?.remove();

    expect(new DouyinAdapter(document, douyinLocation).getUploader().value).toBe(
      'Structured fixture creator',
    );
  });

  it('rejects hidden, off-screen, advertisement, preview, and background videos', () => {
    const active = prepareFixtureGeometry();
    mockVideo(active, { paused: true, currentTime: 10, duration: 120, width: 800, height: 450 });
    const scope = document.querySelector('[data-e2e="video-detail"]')!;

    const hiddenParent = document.createElement('div');
    hiddenParent.setAttribute('aria-hidden', 'true');
    const hidden = document.createElement('video');
    hiddenParent.append(hidden);
    scope.append(hiddenParent);
    mockVideo(hidden, { paused: false, currentTime: 10, duration: 120, width: 900, height: 500 });

    const offscreen = document.createElement('video');
    scope.append(offscreen);
    mockVideo(offscreen, {
      paused: false,
      currentTime: 10,
      duration: 120,
      width: 900,
      height: 500,
    });
    mockRect(offscreen, { left: 1_500, top: 0, width: 900, height: 500 });

    const zeroSize = document.createElement('video');
    scope.append(zeroSize);
    mockVideo(zeroSize, { paused: false, currentTime: 10, duration: 120, width: 0, height: 0 });

    const ad = document.createElement('video');
    ad.dataset.adVideo = 'true';
    scope.append(ad);
    mockVideo(ad, { paused: false, currentTime: 10, duration: 120, width: 900, height: 500 });

    const preview = document.createElement('video');
    preview.dataset.backgroundVideo = 'true';
    scope.append(preview);
    mockVideo(preview, { paused: false, currentTime: 10, duration: 120, width: 900, height: 500 });

    const result = new DouyinAdapter(document, douyinLocation).findVideoElement();

    expect(result.value).toBe(active);
    expect(result.diagnostics.map((entry) => entry.strategy)).toEqual(
      expect.arrayContaining([
        'douyin-reject-hidden',
        'douyin-reject-off-screen',
        'douyin-reject-zero-size',
        'douyin-reject-advertisement',
        'douyin-reject-preview-or-background',
      ]),
    );
  });

  it('selects the stronger visible candidate but rejects a true tie instead of taking the first', () => {
    const player = document.querySelector('[data-e2e="detail-video-player"]')!;
    player.querySelectorAll('video').forEach((video) => video.remove());
    const large = document.createElement('video');
    const small = document.createElement('video');
    player.prepend(small, large);
    mockVideo(large, { paused: true, currentTime: 0, duration: 120, width: 800, height: 450 });
    mockVideo(small, { paused: true, currentTime: 0, duration: 120, width: 400, height: 225 });

    const adapter = new DouyinAdapter(document, douyinLocation);
    expect(adapter.findVideoElement().value).toBe(large);

    mockVideo(small, { paused: true, currentTime: 0, duration: 120, width: 800, height: 450 });
    const ambiguous = adapter.findVideoElement();
    expect(ambiguous.value).toBeNull();
    expect(ambiguous.diagnostics.at(-1)).toMatchObject({
      strategy: 'douyin-ambiguous-active-video',
      severity: 'error',
    });
  });

  it('keeps a dominant paused player ahead of a smaller playing preview', () => {
    const player = document.querySelector('[data-e2e="detail-video-player"]')!;
    player.querySelectorAll('video').forEach((video) => video.remove());
    const playing = document.createElement('video');
    const paused = document.createElement('video');
    player.prepend(paused, playing);
    mockVideo(playing, { paused: false, currentTime: 5, duration: 120, width: 500, height: 280 });
    mockVideo(paused, { paused: true, currentTime: 5, duration: 120, width: 800, height: 450 });

    expect(new DouyinAdapter(document, douyinLocation).findVideoElement().value).toBe(paused);
  });

  it('keeps intrinsic-metadata evidence eligible while rejecting a detached candidate', () => {
    const active = prepareFixtureGeometry();
    mockVideo(active, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 800,
      height: 450,
    });
    const player = document.querySelector('[data-e2e="detail-video-player"]')!;
    const detached = document.createElement('video');
    player.prepend(detached);
    mockVideo(detached, { paused: false, currentTime: 5, duration: 120, width: 800, height: 450 });
    Object.defineProperty(detached, 'isConnected', { configurable: true, get: () => false });

    const result = new DouyinAdapter(document, douyinLocation).findVideoElement();

    expect(result.value).toBe(active);
    expect(result.diagnostics.map((entry) => entry.strategy)).toEqual(
      expect.arrayContaining(['douyin-reject-detached']),
    );
  });

  it('reports a visible candidate as loading when neither metadata nor intrinsic dimensions exist', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const active = prepareFixtureGeometry();
    mockVideo(active, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: Number(HTMLMediaElement.HAVE_NOTHING),
    });
    const adapter = new DouyinAdapter(document, douyinLocation);

    expect(adapter.findVideoElement().value).toBeNull();
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: false,
      reason: 'VIDEO_LOADING',
      message: 'The Douyin video is still loading. Wait briefly and try again.',
    });
    consoleSpy.mockRestore();
  });

  it('uses the finite default readiness schedule and then stops', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const active = prepareFixtureGeometry();
    mockVideo(active, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_NOTHING,
    });
    const wait = vi.fn(async (_milliseconds: number) => undefined);

    await expect(
      new DouyinAdapter(document, douyinLocation).prepareCapture({ wait }),
    ).resolves.toEqual({
      ok: false,
      reason: 'VIDEO_LOADING',
      message: 'The Douyin video is still loading. Wait briefly and try again.',
    });
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      150, 200, 350, 500, 800,
    ]);
    consoleSpy.mockRestore();
  });

  it('returns an explicit error when no reliable visible video remains', () => {
    const active = document.querySelector<HTMLVideoElement>('#active-video')!;
    mockVideo(active, { paused: false, currentTime: 1, duration: 10, width: 800, height: 450 });
    active.setAttribute('aria-hidden', 'true');

    const result = new DouyinAdapter(document, douyinLocation).findVideoElement();

    expect(result.value).toBeNull();
    expect(result.diagnostics.at(-1)).toMatchObject({
      strategy: 'douyin-reliable-active-video',
      severity: 'error',
    });
  });

  it('keeps optional duration, author, description, subtitles, and chapter non-blocking', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, {
      paused: true,
      currentTime: 18.4,
      duration: Number.NaN,
      width: 800,
      height: 450,
    });
    document.querySelector('[data-e2e="video-author"]')?.remove();
    document.querySelector('[data-e2e="video-desc"]')?.remove();
    document.querySelector('script[type="application/ld+json"]')?.remove();
    document.querySelector('meta[property="og:description"]')?.remove();
    document.querySelector('[data-e2e="video-transcript"]')?.remove();
    document.querySelectorAll('[data-e2e="video-subtitle"]').forEach((element) => element.remove());
    document.querySelector('[data-e2e="video-chapter"]')?.remove();
    setTextTracks(video, []);

    const result = new DouyinAdapter(document, douyinLocation).extractMetadata();

    expect(result.value).toMatchObject({
      videoTitle: 'Open Graph fixture title',
      uploader: null,
      description: null,
      timestampSeconds: 18.4,
      videoDurationSeconds: null,
      chapterTitle: null,
    });
    expect(result.value.subtitleContext.status).toBe('unavailable');
  });

  it('rejects non-direct Douyin surfaces during page detection', () => {
    const result = new DouyinAdapter(document, {
      href: 'https://www.douyin.com/search/fixture',
      hostname: 'www.douyin.com',
      pathname: '/search/fixture',
    }).detectPage();

    expect(result.value).toEqual({ supported: false, platform: null, videoId: null });
    expect(result.diagnostics[0]).toMatchObject({ status: 'failed', severity: 'error' });
  });

  it('rejects stale SPA state and refreshes every field after direct-video replacement', () => {
    const firstVideo = prepareFixtureGeometry();
    mockVideo(firstVideo, {
      paused: false,
      currentTime: 36,
      duration: 120,
      width: 800,
      height: 450,
    });
    const location = { ...douyinLocation };
    const adapter = new DouyinAdapter(document, location);
    expect(adapter.extractMetadata().value.videoId).toBe(videoId);

    const nextVideoId = '7430098765432109876';
    location.href = `https://www.douyin.com/video/${nextVideoId}?spa=1`;
    location.pathname = `/video/${nextVideoId}`;
    const stale = adapter.findVideoElement();
    expect(stale.value).toBeNull();
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'douyin-stale-page-identity', status: 'failed' }),
      ]),
    );

    document
      .querySelector('meta[property="og:url"]')
      ?.setAttribute('content', `https://www.douyin.com/video/${nextVideoId}`);
    document.querySelector('[data-e2e="video-detail"]')?.setAttribute('data-video-id', nextVideoId);
    const player = document.querySelector('[data-e2e="detail-video-player"]')!;
    player.setAttribute('data-video-id', nextVideoId);
    firstVideo.remove();
    const replacement = document.createElement('video');
    replacement.id = 'replacement-video';
    player.prepend(replacement);
    mockVideo(replacement, {
      paused: true,
      currentTime: 41,
      duration: 160,
      width: 800,
      height: 450,
    });
    document.querySelector('[data-e2e="video-desc"]')!.textContent = 'Replacement SPA lesson';
    document.querySelector('[data-e2e="video-author"]')!.textContent = 'Replacement creator';
    const currentTranscript = document.querySelectorAll('[data-e2e="transcript-text"]')[1];
    if (currentTranscript) currentTranscript.textContent = 'Replacement transcript current';

    const refreshed = adapter.extractMetadata();
    expect(refreshed.value).toMatchObject({
      sourceUrl: location.href,
      canonicalUrl: `https://www.douyin.com/video/${nextVideoId}`,
      videoId: nextVideoId,
      videoTitle: 'Replacement SPA lesson',
      uploader: 'Replacement creator',
      timestampSeconds: 41,
    });
    expect(refreshed.value.subtitleContext.subtitleCurrent).toEqual([
      'Replacement transcript current',
    ]);
    expect(JSON.stringify(refreshed.value)).not.toContain('Visible associated fixture lesson');
  });
});

describe('DouyinAdapter modal-video capture consistency', () => {
  beforeEach(() => {
    Reflect.deleteProperty(document, 'elementsFromPoint');
    loadFixture();
  });

  it('selects the dominant player from the no-recognised-surface fixture at a favourites URL', () => {
    loadModalWithoutSurfaceFixture();
    const panel = document.querySelector<HTMLElement>('#fixture-floating-panel')!;
    const player = document.querySelector<HTMLElement>('#fixture-generic-player')!;
    const video = document.querySelector<HTMLVideoElement>('#fixture-dominant-player')!;
    const preview = document.querySelector<HTMLVideoElement>('#fixture-profile-preview')!;
    mockRect(panel, { left: 40, top: 20, width: 900, height: 700 });
    mockRect(player, { left: 80, top: 40, width: 800, height: 450 });
    mockVideo(video, {
      paused: true,
      currentTime: 21,
      duration: Number.NaN,
      width: 800,
      height: 450,
      readyState: HTMLMediaElement.HAVE_METADATA,
      currentSrc: '',
    });
    mockVideo(preview, {
      paused: false,
      currentTime: 3,
      duration: 20,
      width: 180,
      height: 100,
    });
    mockRect(preview, { left: 20, top: 80, width: 180, height: 100 });
    const adapter = new DouyinAdapter(document, modalLocation(secondRealRetestUrl));

    expect(adapter.findVideoElement().value).toBe(video);
    expect(adapter.extractMetadata().value).toMatchObject({
      videoId: favouritesVideoId,
      videoTitle: `Douyin video ${favouritesVideoId}`,
      timestampSeconds: 21,
      videoDurationSeconds: null,
      sourceUrl: `https://www.douyin.com/video/${favouritesVideoId}`,
      canonicalUrl: `https://www.douyin.com/video/${favouritesVideoId}`,
    });
  });

  it('extracts the dominant portal player from the realistic profile-modal fixture', () => {
    loadModalPortalFixture();
    const panel = document.querySelector<HTMLElement>('#visible-video-panel')!;
    const portal = document.querySelector<HTMLElement>('#media-portal')!;
    const video = document.querySelector<HTMLVideoElement>('#portal-player')!;
    const preload = document.querySelector<HTMLVideoElement>('#profile-preload')!;
    mockRect(panel, { left: 20, top: 20, width: 900, height: 700 });
    mockRect(portal, { left: 80, top: 40, width: 800, height: 450 });
    mockRect(document.querySelector('[data-e2e="video-title"]')!, {
      left: 80,
      top: 520,
      width: 600,
      height: 36,
    });
    mockRect(document.querySelector('[data-e2e="video-author"]')!, {
      left: 80,
      top: 570,
      width: 220,
      height: 30,
    });
    mockVideo(video, {
      paused: true,
      currentTime: 18,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_METADATA,
    });
    mockVideo(preload, {
      paused: false,
      currentTime: 9,
      duration: 30,
      width: 220,
      height: 124,
    });

    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));
    expect(adapter.findVideoElement().value).toBe(video);
    expect(adapter.extractMetadata().value).toMatchObject({
      videoId: modalVideoId,
      videoTitle: 'Portal fixture learning moment',
      uploader: 'Fixture modal creator',
      timestampSeconds: 18,
      sourceUrl: `https://www.douyin.com/video/${modalVideoId}`,
    });
  });

  it('selects the visible modal video over a playing profile background and canonicalizes storage', () => {
    const { video, background } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 27, duration: 140, width: 760, height: 430 });
    mockVideo(background, {
      paused: false,
      currentTime: 88,
      duration: 200,
      width: 950,
      height: 540,
    });
    document.title = 'Profile owner favourites - Douyin';
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    expect(adapter.detectPage().value).toEqual({
      supported: true,
      platform: 'douyin',
      videoId: modalVideoId,
    });
    expect(adapter.findVideoElement().value).toBe(video);
    expect(adapter.extractMetadata().value).toMatchObject({
      sourceUrl: `https://www.douyin.com/video/${modalVideoId}`,
      canonicalUrl: `https://www.douyin.com/video/${modalVideoId}`,
      videoId: modalVideoId,
      videoTitle: 'Visible associated fixture lesson',
      uploader: 'Fixture creator',
      timestampSeconds: 27,
    });
  });

  it('captures a paused metadata-ready portal video outside the modal container with empty currentSrc', () => {
    const { video, background } = prepareModalFixture();
    const player = document.querySelector<HTMLElement>('[data-e2e="detail-video-player"]')!;
    const portal = document.createElement('div');
    portal.id = 'separate-media-portal';
    mockRect(portal, { left: 80, top: 40, width: 800, height: 450 });
    portal.append(player);
    document.body.append(portal);
    mockVideo(video, {
      paused: true,
      currentTime: 18,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_METADATA,
      currentSrc: '',
    });
    mockVideo(background, {
      paused: false,
      currentTime: 5,
      duration: 60,
      width: 220,
      height: 124,
    });

    expect(video.closest('[role="dialog"]')).toBeNull();
    const metadata = new DouyinAdapter(document, modalLocation(complexModalUrl)).extractMetadata()
      .value;
    expect(metadata).toMatchObject({
      videoId: modalVideoId,
      videoTitle: 'Visible associated fixture lesson',
      uploader: 'Fixture creator',
      timestampSeconds: 18,
      videoDurationSeconds: null,
      videoBounds: { x: 80, y: 40, width: 800, height: 450 },
    });
  });

  it('captures one dominant paused video when no recognised modal surface or Douyin wrapper exists', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    mockVideo(video, {
      paused: true,
      currentTime: 24,
      duration: Number.NaN,
      width: 800,
      height: 450,
      readyState: HTMLMediaElement.HAVE_METADATA,
      currentSrc: '',
    });
    mockVideo(background, {
      paused: false,
      currentTime: 3,
      duration: 30,
      width: 180,
      height: 100,
    });
    document.title = 'Profile owner favourites - Douyin';
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    const selected = adapter.findVideoElement();
    expect(selected.value).toBe(video);
    expect(selected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'douyin-modal-surface-evidence', status: 'skipped' }),
        expect.objectContaining({
          strategy: 'douyin-dominant-visible-video',
          status: 'success',
        }),
      ]),
    );
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: true,
    });
    expect(adapter.extractMetadata().value).toMatchObject({
      videoId: modalVideoId,
      videoTitle: `Douyin video ${modalVideoId}`,
      timestampSeconds: 24,
      videoDurationSeconds: null,
      sourceUrl: `https://www.douyin.com/video/${modalVideoId}`,
      canonicalUrl: `https://www.douyin.com/video/${modalVideoId}`,
    });
    consoleSpy.mockRestore();
  });

  it('selects one dominant generic video over multiple small generic previews', () => {
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    mockVideo(video, { paused: true, currentTime: 12, duration: 90, width: 760, height: 430 });
    mockVideo(background, {
      paused: false,
      currentTime: 3,
      duration: 30,
      width: 180,
      height: 100,
    });
    const secondPreview = document.createElement('video');
    document.body.append(secondPreview);
    mockVideo(secondPreview, {
      paused: false,
      currentTime: 5,
      duration: 30,
      width: 160,
      height: 90,
    });
    mockRect(secondPreview, { left: 820, top: 20, width: 160, height: 90 });

    expect(
      new DouyinAdapter(document, modalLocation(complexModalUrl)).findVideoElement().value,
    ).toBe(video);
  });

  it('uses best-effort top-layer samples as optional evidence for a central video', () => {
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    background.remove();
    mockVideo(video, { paused: true, currentTime: 7, duration: 90, width: 200, height: 200 });
    mockRect(video, { left: 412, top: 284, width: 200, height: 200 });
    const control = document.createElement('button');
    video.parentElement?.append(control);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [control, video]),
    });

    expect(
      new DouyinAdapter(document, modalLocation(complexModalUrl)).findVideoElement().value,
    ).toBe(video);
  });

  it('logs modal detection, dominance, area ratios, centre, and top-layer evidence locally', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    background.remove();
    mockVideo(video, { paused: true, currentTime: 9, duration: 90, width: 760, height: 430 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: true,
    });
    const diagnosticCall = consoleSpy.mock.calls.find(
      ([label]) => label === '[ValRecall][Douyin capture diagnostics]',
    );
    expect(diagnosticCall?.[1]).toMatchObject({
      modalSurfaceDetected: false,
      modalSurfaceUsedOnlyAsOptionalScore: true,
      finalDominanceConfidence: 'large-viewport',
      noCandidateAcceptedReason: null,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          viewportIntersectionArea: expect.any(Number),
          viewportAreaRatio: expect.any(Number),
          areaRatioToSecondLargest: null,
          viewportCentreDistanceRatio: expect.any(Number),
          topLayerScore: null,
          topLayerSamples: 0,
        }),
      ]),
    });
    consoleSpy.mockRestore();
  });

  it('rejects similarly sized modal-free videos as explicitly ambiguous', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    background.remove();
    const second = document.createElement('video');
    video.parentElement?.append(second);
    mockVideo(video, { paused: true, currentTime: 8, duration: 90, width: 700, height: 400 });
    mockVideo(second, { paused: true, currentTime: 8, duration: 90, width: 680, height: 400 });
    mockRect(second, { left: 100, top: 50, width: 680, height: 400 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    expect(adapter.findVideoElement().value).toBeNull();
    expect(adapter.findVideoElement().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'douyin-ambiguous-active-video' }),
      ]),
    );
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: false,
      reason: 'AMBIGUOUS_VIDEO',
      message:
        'ValRecall found multiple visible videos and could not identify the active one safely.',
    });
    consoleSpy.mockRestore();
  });

  it('keeps the same selected video valid when the optional modal heuristic disappears', () => {
    const { modal, article, video } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 31, duration: 140, width: 760, height: 430 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();

    removeRecognisedModalEvidence(modal, article, false);

    expect(validate?.()).toBe(true);
  });

  it('invalidates capture if a substantially stronger video appears after evidence is recorded', () => {
    const { modal, article, video, background } = prepareModalFixture();
    removeRecognisedModalEvidence(modal, article, true);
    background.remove();
    mockVideo(video, { paused: true, currentTime: 31, duration: 140, width: 700, height: 400 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();
    const replacement = document.createElement('video');
    document.body.append(replacement);
    mockVideo(replacement, {
      paused: false,
      currentTime: 4,
      duration: 140,
      width: 900,
      height: 650,
    });

    expect(validate?.()).toBe(false);
  });

  it('re-enumerates until a portal player becomes metadata-ready within the bounded schedule', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { video } = prepareModalFixture();
    const mediaState = {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: Number(HTMLMediaElement.HAVE_NOTHING),
    };
    mockVideo(video, mediaState);
    const wait = vi.fn(async (milliseconds: number) => {
      if (milliseconds === 150) mediaState.readyState = HTMLMediaElement.HAVE_METADATA;
    });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    await expect(adapter.prepareCapture({ retryScheduleMs: [0, 150, 350], wait })).resolves.toEqual(
      { ok: true },
    );
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(150);
    expect(adapter.findVideoElement().value).toBe(video);
    consoleSpy.mockRestore();
  });

  it('discards a loading element and selects its ready replacement during retry', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { video } = prepareModalFixture();
    const player = document.querySelector<HTMLElement>('[data-e2e="detail-video-player"]')!;
    mockVideo(video, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_NOTHING,
    });
    let replacement: HTMLVideoElement | null = null;
    const wait = vi.fn(async () => {
      replacement = document.createElement('video');
      replacement.id = 'replacement-portal-player';
      player.replaceChildren(replacement);
      mockVideo(replacement, {
        paused: true,
        currentTime: 22,
        duration: Number.NaN,
        width: 800,
        height: 450,
        readyState: HTMLMediaElement.HAVE_METADATA,
      });
    });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));

    await expect(adapter.prepareCapture({ retryScheduleMs: [0, 150], wait })).resolves.toEqual({
      ok: true,
    });
    expect(replacement).not.toBeNull();
    expect(adapter.findVideoElement().value).toBe(replacement);
    consoleSpy.mockRestore();
  });

  it('stops bounded discovery when modal_id changes between attempts', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { video } = prepareModalFixture();
    mockVideo(video, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_NOTHING,
    });
    const location = modalLocation(complexModalUrl);
    const wait = vi.fn(async () => {
      location.href = 'https://www.douyin.com/user/self?modal_id=7999999999999999999';
    });

    await expect(
      new DouyinAdapter(document, location).prepareCapture({
        retryScheduleMs: [0, 150, 350],
        wait,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'UNSTABLE_VIDEO',
      message: 'The Douyin video changed during capture. Try again.',
    });
    expect(wait).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('uses the panel-open error only when modal_id disappears before or during preparation', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { video } = prepareModalFixture();
    const location = modalLocation(complexModalUrl);
    const adapter = new DouyinAdapter(document, location);
    expect(adapter.detectPage().value.supported).toBe(true);
    location.href = 'https://www.douyin.com/user/self?showTab=favorite_collection';
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: false,
      reason: 'PANEL_NOT_OPEN',
      message: 'Open the video panel before capturing.',
    });

    location.href = complexModalUrl;
    const duringAdapter = new DouyinAdapter(document, location);
    mockVideo(video, {
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      width: 0,
      height: 0,
      readyState: HTMLMediaElement.HAVE_NOTHING,
    });
    const wait = vi.fn(async () => {
      location.href = 'https://www.douyin.com/user/self?showTab=favorite_collection';
    });
    await expect(
      duringAdapter.prepareCapture({ retryScheduleMs: [0, 150], wait }),
    ).resolves.toEqual({
      ok: false,
      reason: 'PANEL_NOT_OPEN',
      message: 'Open the video panel before capturing.',
    });
    consoleSpy.mockRestore();
  });

  it('does not reuse a profile-page title when modal-specific title evidence is absent', () => {
    const { video } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 27, duration: 140, width: 760, height: 430 });
    document.querySelector('[data-e2e="video-desc"]')?.remove();
    document.title = 'Profile owner favourites - Douyin';

    expect(
      new DouyinAdapter(document, modalLocation(complexModalUrl)).getVideoTitle(video).value,
    ).toBe(`Douyin video ${modalVideoId}`);
  });

  it('keeps the same capture valid across unrelated query reordering but rejects ID removal or change', () => {
    const { video } = prepareModalFixture();
    mockVideo(video, { paused: false, currentTime: 19, duration: 140, width: 760, height: 430 });
    const location = modalLocation(complexModalUrl);
    const adapter = new DouyinAdapter(document, location);
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();
    expect(validate).not.toBeNull();

    location.href = `https://www.douyin.com/user/self?encoded=a%2Fb&showTab=favourite&modal_id=${modalVideoId}&from=profile`;
    expect(validate?.()).toBe(true);

    location.href = 'https://www.douyin.com/user/self?showTab=favourite';
    expect(validate?.()).toBe(false);

    location.href = 'https://www.douyin.com/user/self?modal_id=7999999999999999999';
    expect(validate?.()).toBe(false);
  });

  it('rejects a stale modal URL after close and a same-ID replacement modal', () => {
    const { modal, video } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 31, duration: 140, width: 760, height: 430 });
    const location = modalLocation(complexModalUrl);
    const adapter = new DouyinAdapter(document, location);
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();

    const replacement = modal.cloneNode(true) as HTMLElement;
    mockRect(replacement, { left: 20, top: 20, width: 900, height: 700 });
    modal.replaceWith(replacement);
    expect(validate?.()).toBe(false);

    replacement.remove();
    expect(adapter.findVideoElement().value).toBeNull();
    expect(adapter.findVideoElement().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'douyin-modal-surface-evidence', status: 'skipped' }),
      ]),
    );
  });

  it('invalidates capture when only the selected portal player is replaced', () => {
    const { video } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 31, duration: 140, width: 760, height: 430 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();
    const replacement = document.createElement('video');
    video.replaceWith(replacement);
    mockVideo(replacement, {
      paused: true,
      currentTime: 31,
      duration: 140,
      width: 760,
      height: 430,
    });

    expect(validate?.()).toBe(false);
  });

  it('returns concise panel and visibility errors after bounded discovery', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { modal, video, background } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 2, duration: 30, width: 800, height: 450 });
    mockVideo(background, { paused: true, currentTime: 0, duration: 30, width: 0, height: 0 });
    const adapter = new DouyinAdapter(document, modalLocation(complexModalUrl));
    modal.remove();
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: false,
      reason: 'NO_VISIBLE_VIDEO',
      message: 'No visible video was found for the current Douyin item.',
    });

    document.body.append(modal);
    video.setAttribute('aria-hidden', 'true');
    await expect(adapter.prepareCapture({ retryScheduleMs: [0], wait: vi.fn() })).resolves.toEqual({
      ok: false,
      reason: 'NO_VISIBLE_VIDEO',
      message: 'No visible video was found for the current Douyin item.',
    });
    consoleSpy.mockRestore();
  });

  it('allows a same-ID modal-to-direct SPA transition after reselecting the direct player', () => {
    const { modal, article, video } = prepareModalFixture();
    mockVideo(video, { paused: false, currentTime: 44, duration: 140, width: 760, height: 430 });
    const location = modalLocation(complexModalUrl);
    const adapter = new DouyinAdapter(document, location);
    adapter.extractMetadata();
    const validate = adapter.createCaptureConsistencyCheck();

    document.querySelector('main')?.prepend(article);
    modal.remove();
    location.href = `https://www.douyin.com/video/${modalVideoId}?from=modal`;
    location.pathname = `/video/${modalVideoId}`;
    document
      .querySelector('meta[property="og:url"]')
      ?.setAttribute('content', `https://www.douyin.com/video/${modalVideoId}`);

    expect(validate?.()).toBe(true);
  });

  it('does not fail only because multiple recognised modal surfaces make the heuristic ambiguous', () => {
    const { modal, video } = prepareModalFixture();
    mockVideo(video, { paused: true, currentTime: 8, duration: 140, width: 760, height: 430 });
    const second = modal.cloneNode(true) as HTMLElement;
    mockRect(second, { left: 35, top: 30, width: 880, height: 680 });
    document.body.append(second);

    const result = new DouyinAdapter(document, modalLocation(complexModalUrl)).findVideoElement();
    expect(result.value).toBe(video);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'douyin-modal-surface-evidence', status: 'skipped' }),
      ]),
    );
  });
});

describe('DouyinAdapter strict subtitle extraction', () => {
  beforeEach(() => loadFixture());

  it('prefers an exposed enabled timed text track without changing its mode', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 800, height: 450 });
    const track = {
      kind: 'subtitles',
      mode: 'showing',
      cues: cueList([
        { startTime: 0, endTime: 30, text: 'Track before' },
        { startTime: 30, endTime: 60, text: 'Track current' },
        { startTime: 60, endTime: 90, text: 'Track after' },
      ]),
      activeCues: null,
    };
    setTextTracks(video, [track]);

    const result = new DouyinAdapter(document, douyinLocation).getSubtitleContext(video, 36, 120);

    expect(result.value.source).toBe('text-track');
    expect(result.value.subtitleCurrent).toEqual(['Track current']);
    expect(track.mode).toBe('showing');
  });

  it('uses only visible scoped timed rows and never reads page-wide text', () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 800, height: 450 });
    setTextTracks(video, []);
    Object.defineProperty(document.body, 'innerText', {
      configurable: true,
      get: () => {
        throw new Error('page-wide text must not be read');
      },
    });

    const result = new DouyinAdapter(document, douyinLocation).getSubtitleContext(video, 36, 120);

    expect(result.value.source).toBe('dom-transcript');
    expect(result.value.subtitleBefore).toEqual(['Transcript before']);
    expect(result.value.subtitleCurrent).toEqual(['Transcript current']);
    expect(result.value.subtitleAfter).toEqual(['Transcript after']);
    expect(JSON.stringify(result.value)).not.toContain('Comment text');
    expect(JSON.stringify(result.value)).not.toContain('Recommendation text');
    expect(JSON.stringify(result.value)).not.toContain('Captions settings');
  });

  it('falls back to a visible overlay bounded by the active video', () => {
    const video = prepareFixtureGeometry({ transcript: false });
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 800, height: 450 });
    setTextTracks(video, []);

    const result = new DouyinAdapter(document, douyinLocation).getSubtitleContext(video, 36, 120);

    expect(result.value.status).toBe('current_only');
    expect(result.value.source).toBe('visible-overlay');
    expect(result.value.subtitleCurrent).toEqual(['Visible fixture caption']);
    expect(JSON.stringify(result.value)).not.toContain('Captions settings fixture text');
    expect(JSON.stringify(result.value)).not.toContain('Comment text');
  });

  it('returns unavailable when overlays are outside the video or inside excluded UI', () => {
    const video = prepareFixtureGeometry({ transcript: false });
    mockVideo(video, { paused: false, currentTime: 36, duration: 120, width: 800, height: 450 });
    setTextTracks(video, []);
    const overlay = document.querySelector(
      '[data-e2e="detail-video-player"] [data-e2e="video-subtitle"]',
    )!;
    mockRect(overlay, { left: 1_500, top: 100, width: 500, height: 40 });

    const result = new DouyinAdapter(document, douyinLocation).getSubtitleContext(video, 36, 120);

    expect(result.value.status).toBe('unavailable');
    expect(result.value.extractionStrategy).toBe('none');
    expect(result.value.rejectionReasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['hidden', 'excluded_ui_ancestor']),
    );
  });
});

describe('DouyinAdapter finite seek', () => {
  beforeEach(() => loadFixture());

  it('waits for a reliable active video, seeks, and honors the pause preference', async () => {
    document.querySelectorAll('video').forEach((video) => video.remove());
    const wait = vi.fn(async () => {
      const video = document.createElement('video');
      video.id = 'late-video';
      document.querySelector('[data-e2e="detail-video-player"]')?.prepend(video);
      mockVideo(video, { paused: true, currentTime: 0, duration: 120, width: 800, height: 450 });
    });

    const result = await new DouyinAdapter(document, douyinLocation).seekToTimestamp(42, {
      maxAttempts: 3,
      retryDelayMs: 0,
      pauseAfterSeek: true,
      wait,
    });

    expect(result).toMatchObject({ ok: true, attempts: 2, timestampSeconds: 42 });
    expect(wait).toHaveBeenCalledTimes(1);
    const video = document.querySelector<HTMLVideoElement>('#late-video')!;
    expect(video.currentTime).toBe(42);
    expect(video.pause).toHaveBeenCalledOnce();
  });

  it('stops exactly at the configured retry limit', async () => {
    document.querySelectorAll('video').forEach((video) => video.remove());
    const wait = vi.fn(async () => undefined);

    const result = await new DouyinAdapter(document, douyinLocation).seekToTimestamp(12, {
      maxAttempts: 3,
      retryDelayMs: 0,
      wait,
    });

    expect(result).toMatchObject({ ok: false, attempts: 3 });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('retries when Douyin replaces the player during seek and verifies the replacement', async () => {
    const original = prepareFixtureGeometry();
    mockVideo(original, { paused: false, currentTime: 10, duration: 120, width: 800, height: 450 });
    const player = document.querySelector('[data-e2e="detail-video-player"]')!;
    Object.defineProperty(original, 'currentTime', {
      configurable: true,
      get: () => 10,
      set: () => {
        original.remove();
        const replacement = document.createElement('video');
        replacement.id = 'seek-replacement';
        player.prepend(replacement);
        mockVideo(replacement, {
          paused: true,
          currentTime: 0,
          duration: 120,
          width: 800,
          height: 450,
        });
      },
    });
    const wait = vi.fn(async () => undefined);

    const result = await new DouyinAdapter(document, douyinLocation).seekToTimestamp(42, {
      maxAttempts: 3,
      retryDelayMs: 0,
      wait,
    });

    expect(result).toMatchObject({ ok: true, attempts: 2, timestampSeconds: 42 });
    expect(document.querySelector<HTMLVideoElement>('#seek-replacement')?.currentTime).toBe(42);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('fails after bounded retries when the player ignores the requested position', async () => {
    const video = prepareFixtureGeometry();
    mockVideo(video, { paused: true, currentTime: 8, duration: 120, width: 800, height: 450 });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 8,
      set: () => undefined,
    });
    const wait = vi.fn(async () => undefined);

    const result = await new DouyinAdapter(document, douyinLocation).seekToTimestamp(42, {
      maxAttempts: 3,
      retryDelayMs: 0,
      wait,
    });

    expect(result).toMatchObject({ ok: false, attempts: 3, timestampSeconds: 42 });
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

function loadFixture(): void {
  const html = readFileSync('fixtures/douyin-video-fixture.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

function loadModalPortalFixture(): void {
  const html = readFileSync('fixtures/douyin-modal-portal-fixture.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

function loadModalWithoutSurfaceFixture(): void {
  const html = readFileSync('fixtures/douyin-modal-without-surface-fixture.html', 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  document.title = parsed.title;
}

function prepareFixtureGeometry(options: { transcript?: boolean } = {}): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>('#active-video')!;
  mockRect(document.querySelector('[data-e2e="video-detail"]')!, {
    left: 60,
    top: 20,
    width: 850,
    height: 700,
  });
  mockRect(document.querySelector('[data-e2e="detail-video-player"]')!, {
    left: 80,
    top: 40,
    width: 800,
    height: 450,
  });
  mockRect(document.querySelector('[data-e2e="video-desc"]')!, {
    left: 80,
    top: 510,
    width: 700,
    height: 42,
  });
  mockRect(document.querySelector('[data-e2e="video-author"]')!, {
    left: 80,
    top: 560,
    width: 180,
    height: 30,
  });
  mockRect(document.querySelector('[data-e2e="video-chapter"]')!, {
    left: 100,
    top: 440,
    width: 180,
    height: 24,
  });
  const overlays = document.querySelectorAll('[data-e2e="video-subtitle"]');
  if (overlays[0]) mockRect(overlays[0], { left: 180, top: 410, width: 600, height: 38 });
  if (overlays[1]) mockRect(overlays[1], { left: 600, top: 80, width: 220, height: 38 });
  if (overlays[2]) mockRect(overlays[2], { left: 100, top: 620, width: 500, height: 38 });

  if (options.transcript === false) {
    document.querySelector('[data-e2e="video-transcript"]')?.remove();
  } else {
    for (const [index, row] of Array.from(
      document.querySelectorAll('[data-e2e="video-transcript-item"]'),
    ).entries()) {
      mockRect(row, { left: 890, top: 80 + index * 50, width: 120, height: 40 });
    }
  }
  return video;
}

function prepareModalFixture(): {
  modal: HTMLElement;
  article: HTMLElement;
  video: HTMLVideoElement;
  background: HTMLVideoElement;
} {
  const video = prepareFixtureGeometry();
  const article = document.querySelector<HTMLElement>('[data-e2e="video-detail"]')!;
  const player = document.querySelector<HTMLElement>('[data-e2e="detail-video-player"]')!;
  article.setAttribute('data-video-id', modalVideoId);
  player.setAttribute('data-video-id', modalVideoId);

  const modal = document.createElement('section');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('data-e2e', 'video-modal');
  modal.setAttribute('data-video-id', modalVideoId);
  mockRect(modal, { left: 20, top: 20, width: 900, height: 700 });
  modal.append(article);
  document.body.append(modal);

  const background = document.createElement('video');
  background.id = 'profile-background-video';
  document.querySelector('main')?.append(background);
  return { modal, article, video, background };
}

function removeRecognisedModalEvidence(
  modal: HTMLElement,
  article: HTMLElement,
  removePlayerAssociation: boolean,
): void {
  modal.removeAttribute('role');
  modal.removeAttribute('aria-modal');
  modal.removeAttribute('data-e2e');
  modal.removeAttribute('data-video-id');
  if (!removePlayerAssociation) return;
  article.removeAttribute('data-e2e');
  article.removeAttribute('data-video-id');
  const player = article.querySelector<HTMLElement>('[data-e2e="detail-video-player"]');
  player?.removeAttribute('data-e2e');
  player?.removeAttribute('data-video-id');
}

function modalLocation(href: string): typeof douyinLocation {
  const parsed = new URL(href);
  return { href, hostname: parsed.hostname, pathname: parsed.pathname };
}

function mockVideo(
  video: HTMLVideoElement,
  options: {
    paused: boolean;
    currentTime: number;
    duration: number;
    width: number;
    height: number;
    readyState?: number;
    ended?: boolean;
    currentSrc?: string;
  },
): void {
  let currentTime = options.currentTime;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => options.paused },
    ended: { configurable: true, get: () => options.ended ?? false },
    readyState: {
      configurable: true,
      get: () => options.readyState ?? HTMLMediaElement.HAVE_METADATA,
    },
    currentSrc: { configurable: true, get: () => options.currentSrc ?? '' },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    duration: { configurable: true, get: () => options.duration },
    videoWidth: { configurable: true, get: () => options.width },
    videoHeight: { configurable: true, get: () => options.height },
    pause: { configurable: true, value: vi.fn() },
  });
  mockRect(video, { left: 80, top: 40, width: options.width, height: options.height });
}

function setTextTracks(
  video: HTMLVideoElement,
  tracks: Array<{
    kind: string;
    mode: string;
    cues: TextTrackCueList | null;
    activeCues: TextTrackCueList | null;
  }>,
): void {
  Object.defineProperty(video, 'textTracks', {
    configurable: true,
    value: Object.assign(tracks, { length: tracks.length }),
  });
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

import { describe, expect, it } from 'vitest';

import type { PageSubtitleSnapshot, PageSubtitleTrackSnapshot } from '../../models/page-subtitles';
import { extractSubtitleContextFromPageSnapshot } from './page-subtitles';

const href = 'https://www.youtube.com/watch?v=subtitle-fixture';

describe('validated page subtitle snapshots', () => {
  it('uses the active automatic caption track and reports each extraction stage', () => {
    const video = createVideo();
    const result = extractSubtitleContextFromPageSnapshot(
      snapshot({
        selectedLanguage: 'en-US',
        tracks: [
          track({
            id: 'automatic-en',
            language: 'en',
            active: true,
            selected: true,
            mode: 'showing',
            automatic: true,
            cues: cueWindow('Automatic'),
          }),
          track({
            id: 'translated-fr',
            language: 'fr',
            translated: true,
            default: true,
            cues: cueWindow('Wrong translation'),
          }),
        ],
      }),
      { platform: 'youtube', href, video, timestampSeconds: 10 },
    );

    expect(result.context?.subtitleCurrent).toEqual(['Automatic current']);
    expect(result.context?.subtitleBefore).toEqual(['Automatic before']);
    expect(result.context?.subtitleAfter).toEqual(['Automatic after']);
    expect(result.diagnostics.map(({ strategy, status }) => [strategy, status])).toEqual(
      expect.arrayContaining([
        ['main-world-bridge-track-count', 'success'],
        ['main-world-bridge-track-selection', 'success'],
        ['main-world-bridge-track-readability', 'success'],
        ['main-world-bridge-cue-match', 'success'],
      ]),
    );
  });

  it('follows a player language change and refuses an unrelated translated track', () => {
    const video = createVideo();
    const tracks = [
      track({
        id: 'english',
        language: 'en',
        cues: cueWindow('English'),
      }),
      track({
        id: 'original-zh',
        language: 'zh-CN',
        original: true,
        default: true,
        cues: cueWindow('Chinese'),
      }),
      track({
        id: 'translated-fr',
        language: 'fr',
        translated: true,
        default: true,
        cues: cueWindow('French'),
      }),
    ];

    const chinese = extractSubtitleContextFromPageSnapshot(
      snapshot({ selectedLanguage: 'zh', tracks }),
      { platform: 'youtube', href, video, timestampSeconds: 10 },
    );
    expect(chinese.context?.subtitleCurrent).toEqual(['Chinese current']);

    const unavailable = extractSubtitleContextFromPageSnapshot(
      snapshot({
        selectedLanguage: 'de',
        tracks: tracks.filter((candidate) => candidate.id !== 'original-zh'),
      }),
      { platform: 'youtube', href, video, timestampSeconds: 10 },
    );
    expect(unavailable.context).toBeNull();
    expect(unavailable.unreadable).toBe(true);
    expect(unavailable.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: 'main-world-bridge-track-selection', status: 'failed' }),
    );
  });

  it.each(['zh-Hans', 'zh-Hant', 'en', 'ja'])(
    'keeps the subtitles on a Bilibili page under /%s/',
    (language) => {
      const bilibiliHref = `https://www.bilibili.com/${language}/video/BV1PrefixFixture?p=1`;
      const result = extractSubtitleContextFromPageSnapshot(
        bilibiliSnapshot(bilibiliHref, {
          bilibiliIdentity: {
            bvid: 'BV1PrefixFixture',
            aid: null,
            cid: '123456',
            part: 1,
            matched: true,
          },
          video: { currentTime: 123, duration: 180, currentSrc: null },
          tracks: [
            track({
              id: 'sole-ai-zh',
              language: 'zh-CN',
              automatic: true,
              cues: cueWindowAt('Prefix track', 123),
            }),
          ],
        }),
        { platform: 'bilibili', href: bilibiliHref, video: createVideo(), timestampSeconds: 123 },
      );

      expect(result.context?.subtitleCurrent).toEqual(['Prefix track current']);
    },
  );

  it('refuses the subtitles when the prefixed page is a different video', () => {
    const bilibiliHref = 'https://www.bilibili.com/zh-Hans/video/BV1PrefixFixture?p=1';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        bilibiliIdentity: {
          bvid: 'BV1OtherFixture',
          aid: null,
          cid: '123456',
          part: 1,
          matched: true,
        },
        video: { currentTime: 123, duration: 180, currentSrc: null },
        tracks: [track({ id: 'sole-ai-zh', cues: cueWindowAt('Other video', 123) })],
      }),
      { platform: 'bilibili', href: bilibiliHref, video: createVideo(), timestampSeconds: 123 },
    );

    expect(result.context).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: 'bilibili-active-video-identity', status: 'failed' }),
    );
  });

  it('uses the sole valid Bilibili bridge track without cross-platform selection flags', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1SoleFixture?p=1';
    const video = createVideo();
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        video: { currentTime: 123, duration: 180, currentSrc: null },
        tracks: [
          track({
            id: 'sole-ai-zh',
            language: 'zh-CN',
            automatic: true,
            cues: cueWindowAt('Sole track', 123),
          }),
        ],
      }),
      { platform: 'bilibili', href: bilibiliHref, video, timestampSeconds: 123 },
    );

    expect(result.context?.subtitleCurrent).toEqual(['Sole track current']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'main-world-bridge-track-selection',
        status: 'success',
        message: expect.stringContaining('sole validated track'),
      }),
    );
  });

  it('does not treat a sole unrelated translated Bilibili track as a safe fallback', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1TranslatedFixture';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        tracks: [
          track({
            id: 'translated-fr',
            language: 'fr',
            translated: true,
            cues: cueWindow('Translated'),
          }),
        ],
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 10,
      },
    );

    expect(result).toMatchObject({ context: null, available: true, unreadable: true });
  });

  it('keeps an explicitly selected Bilibili track ahead of the sole/default fallbacks', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1SelectedFixture';
    const video = createVideo();
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        tracks: [
          track({ id: 'default-zh', language: 'zh', default: true, cues: cueWindow('Default') }),
          track({
            id: 'selected-ja',
            language: 'ja',
            selected: true,
            cues: cueWindow('Selected'),
          }),
        ],
      }),
      { platform: 'bilibili', href: bilibiliHref, video, timestampSeconds: 10 },
    );

    expect(result.context?.subtitleCurrent).toEqual(['Selected current']);
  });

  it('uses the Bilibili player-selected language when no explicit track flag is exposed', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1LanguageFixture';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        selectedLanguage: 'zh',
        tracks: [
          track({ id: 'ja', language: 'ja', cues: cueWindow('Japanese') }),
          track({ id: 'zh', language: 'zh-CN', cues: cueWindow('Chinese') }),
        ],
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 10,
      },
    );

    expect(result.context?.subtitleCurrent).toEqual(['Chinese current']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'main-world-bridge-track-selection',
        message: expect.stringContaining('selected language'),
      }),
    );
  });

  it('rejects multiple ambiguous Bilibili bridge tracks instead of guessing a language', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1AmbiguousFixture';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        tracks: [
          track({ id: 'zh', language: 'zh-CN', cues: cueWindow('Chinese') }),
          track({ id: 'ja', language: 'ja', cues: cueWindow('Japanese') }),
        ],
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 10,
      },
    );

    expect(result).toMatchObject({ context: null, available: true, unreadable: true });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        strategy: 'main-world-bridge-track-selection',
        status: 'failed',
        message: expect.stringContaining('ambiguous'),
      }),
    );
  });

  it.each([
    ['BVID/CID evidence', { matched: false, part: 1 }],
    ['part evidence', { matched: true, part: 2 }],
  ] as const)('rejects stale Bilibili %s before cue selection', (_label, identity) => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1IdentityFixture?p=1';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        bilibiliIdentity: {
          bvid: 'BV1IdentityFixture',
          aid: null,
          cid: '123456',
          ...identity,
        },
        tracks: [track({ cues: cueWindow('Private subtitle fixture') })],
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 10,
      },
    );

    expect(result.context).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: 'bilibili-active-video-identity', status: 'failed' }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain('Private subtitle fixture');
  });

  it('reports selected Bilibili resource metadata separately from bridge and DOM track counts', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1ResourceFixture';
    const video = createVideo();
    Object.defineProperty(video, 'textTracks', { configurable: true, value: { length: 0 } });
    const bridge = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        tracks: [
          track({
            id: 'metadata-only',
            language: 'zh-CN',
            resource: {
              available: true,
              status: 'request-failed',
              host: 'aisubtitle.hdslb.com',
              parsedCueCount: 0,
              urlResolution: {
                accessorFound: true,
                descriptorLocation: 'own',
                propertyReadSucceeded: true,
                resultType: 'protocol-relative-url',
                protocolRelative: true,
                validatedHost: 'aisubtitle.hdslb.com',
                validatedPath: '/bfs/ai_subtitle/fixture.json',
              },
            },
          }),
        ],
      }),
      { platform: 'bilibili', href: bilibiliHref, video, timestampSeconds: 10 },
    );

    expect(bridge).toMatchObject({ context: null, available: true, unreadable: true });
    expect(bridge.diagnostics.map((entry) => entry.strategy)).toEqual(
      expect.arrayContaining([
        'main-world-bridge-track-count',
        'main-world-bridge-track-selection',
        'bilibili-selected-track-resource',
        'bilibili-subtitle-url-descriptor',
        'bilibili-subtitle-url-read',
        'bilibili-subtitle-url-normalized',
        'bilibili-subtitle-resource-validation',
        'bilibili-subtitle-resource-load',
        'bilibili-subtitle-cue-match',
        'main-world-bridge-track-readability',
      ]),
    );
    expect(bridge.diagnostics.map((entry) => entry.strategy)).not.toContain(
      'dom-video-text-track-count',
    );
  });

  it('reports only approved Bilibili structural fields before an unreadable-track failure', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1StructureFixture';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        video: { currentTime: 123, duration: 180, currentSrc: null },
        tracks: [track({ id: 'sole-ai-zh', language: 'zh-CN', automatic: true })],
        bilibiliDiagnostics: {
          stateEntries: [
            {
              scope: 'selected-track',
              path: '__INITIAL_STATE__.videoData.subtitle.list[].payloadEndpoint',
              valueType: 'string',
              keys: [],
              arrayLength: null,
              httpsValuePresent: true,
              safeHttpsUrls: [
                { host: 'aisubtitle.hdslb.com', path: '/future/subtitle/payload.json' },
              ],
              cueLikeItemCount: 0,
            },
            {
              scope: 'current-player-state',
              path: 'selectedPlayer.__subtitleState.rows',
              valueType: 'array',
              keys: ['from', 'to', 'content'],
              arrayLength: 3,
              httpsValuePresent: false,
              safeHttpsUrls: [],
              cueLikeItemCount: 3,
            },
          ],
          stateEntryLimitReached: false,
          domElements: [
            {
              tag: 'div',
              classTokens: ['future-caption-layer'],
              dataAttributeNames: ['data-render-kind'],
              bounds: { x: 100, y: 300, width: 600, height: 40 },
              textLength: 27,
            },
          ],
          domElementLimitReached: false,
        },
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 123,
      },
    );

    expect(result).toMatchObject({ context: null, available: true, unreadable: true });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'bilibili-selected-track-structure-summary' }),
        expect.objectContaining({ strategy: 'bilibili-selected-track-structure' }),
        expect.objectContaining({ strategy: 'bilibili-current-player-subtitle-state' }),
        expect.objectContaining({ strategy: 'bilibili-lower-player-dom-element' }),
        expect.objectContaining({
          strategy: 'main-world-bridge-track-selection',
          message: expect.stringContaining('sole validated track'),
        }),
      ]),
    );
    const diagnosticsJson = JSON.stringify(result.diagnostics);
    expect(diagnosticsJson).toContain('aisubtitle.hdslb.com/future/subtitle/payload.json');
    expect(diagnosticsJson).toContain('textLength=27');
    expect(diagnosticsJson).not.toContain('PRIVATE_SUBTITLE');
    expect(diagnosticsJson).not.toContain('token=');
  });

  it('matches embedded Bilibili cues at exactly 123 seconds and keeps subtitle text out of diagnostics', () => {
    const bilibiliHref = 'https://www.bilibili.com/video/BV1CueFixture';
    const result = extractSubtitleContextFromPageSnapshot(
      bilibiliSnapshot(bilibiliHref, {
        video: { currentTime: 123, duration: 180, currentSrc: null },
        tracks: [
          track({
            cues: [
              { startTime: 121, endTime: 123, text: 'Ending private fixture' },
              { startTime: 123, endTime: 125, text: 'Current private fixture' },
            ],
            resource: {
              available: false,
              status: 'embedded-cues',
              host: null,
              parsedCueCount: 2,
            },
          }),
        ],
      }),
      {
        platform: 'bilibili',
        href: bilibiliHref,
        video: createVideo(),
        timestampSeconds: 123,
      },
    );

    expect(result.context?.subtitleBefore).toEqual(['Ending private fixture']);
    expect(result.context?.subtitleCurrent).toEqual(['Current private fixture']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ strategy: 'bilibili-subtitle-cue-match', status: 'success' }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain('private fixture');
  });

  it('uses exclusive cue ends at exact boundaries', () => {
    const video = createVideo();
    const result = extractSubtitleContextFromPageSnapshot(
      snapshot({
        tracks: [
          track({
            active: true,
            selected: true,
            mode: 'showing',
            cues: [
              { startTime: 8, endTime: 10, text: 'Ending cue' },
              { startTime: 10, endTime: 12, text: 'Starting cue' },
            ],
          }),
        ],
      }),
      { platform: 'youtube', href, video, timestampSeconds: 10 },
    );

    expect(result.context?.subtitleBefore).toEqual(['Ending cue']);
    expect(result.context?.subtitleCurrent).toEqual(['Starting cue']);
  });

  it('rejects stale navigation, player replacement, and playback responses', () => {
    const video = createVideo('https://cdn.example/current.mp4');
    const base = snapshot({
      video: {
        currentTime: 10,
        duration: 60,
        currentSrc: 'https://cdn.example/old.mp4',
      },
      tracks: [track({ active: true, selected: true, mode: 'showing', cues: cueWindow('Old') })],
    });

    for (const stale of [
      base,
      { ...base, href: 'https://www.youtube.com/watch?v=replaced' },
      {
        ...base,
        video: { ...base.video, currentSrc: 'https://cdn.example/current.mp4', currentTime: 20 },
      },
    ]) {
      const result = extractSubtitleContextFromPageSnapshot(stale, {
        platform: 'youtube',
        href,
        video,
        timestampSeconds: 10,
      });
      expect(result.context).toBeNull();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ strategy: 'main-world-subtitle-stale-response' }),
      );
    }
  });

  it('distinguishes discovered but unreadable tracks from no tracks', () => {
    const video = createVideo();
    const unreadable = extractSubtitleContextFromPageSnapshot(
      snapshot({ tracks: [track({ original: true, default: true })] }),
      { platform: 'youtube', href, video, timestampSeconds: 10 },
    );
    const absent = extractSubtitleContextFromPageSnapshot(snapshot(), {
      platform: 'youtube',
      href,
      video,
      timestampSeconds: 10,
    });

    expect(unreadable).toMatchObject({ available: true, unreadable: true, context: null });
    expect(absent).toMatchObject({ available: false, unreadable: false, context: null });
  });
});

function snapshot(overrides: Partial<PageSubtitleSnapshot> = {}): PageSubtitleSnapshot {
  return {
    version: 1,
    requestId: 'request-subtitle-fixture',
    platform: 'youtube',
    href,
    collectedAt: 1_786_000_000_000,
    selectedLanguage: null,
    structuredStateInspected: false,
    video: { currentTime: 10, duration: 60, currentSrc: null },
    tracks: [],
    ...overrides,
  };
}

function bilibiliSnapshot(
  bilibiliHref: string,
  overrides: Partial<PageSubtitleSnapshot> = {},
): PageSubtitleSnapshot {
  return snapshot({
    platform: 'bilibili',
    href: bilibiliHref,
    bilibiliIdentity: {
      bvid: new URL(bilibiliHref).pathname.split('/').filter(Boolean)[1] ?? null,
      aid: null,
      cid: '123456',
      part: Number(new URL(bilibiliHref).searchParams.get('p') ?? '1'),
      matched: true,
    },
    ...overrides,
  });
}

function track(overrides: Partial<PageSubtitleTrackSnapshot> = {}): PageSubtitleTrackSnapshot {
  return {
    id: 'manual-original',
    kind: 'subtitles',
    language: 'en',
    label: 'English',
    mode: 'disabled',
    active: false,
    selected: false,
    default: false,
    original: false,
    automatic: false,
    translated: false,
    cues: [],
    ...overrides,
  };
}

function cueWindow(prefix: string): PageSubtitleTrackSnapshot['cues'] {
  return [
    { startTime: 6, endTime: 8, text: `${prefix} before` },
    { startTime: 9, endTime: 11, text: `${prefix} current` },
    { startTime: 12, endTime: 14, text: `${prefix} after` },
  ];
}

function cueWindowAt(prefix: string, timestamp: number): PageSubtitleTrackSnapshot['cues'] {
  return [
    { startTime: timestamp - 4, endTime: timestamp - 2, text: `${prefix} before` },
    { startTime: timestamp - 1, endTime: timestamp + 1, text: `${prefix} current` },
    { startTime: timestamp + 2, endTime: timestamp + 4, text: `${prefix} after` },
  ];
}

function createVideo(currentSrc = ''): HTMLVideoElement {
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentSrc', { configurable: true, value: currentSrc });
  return video;
}

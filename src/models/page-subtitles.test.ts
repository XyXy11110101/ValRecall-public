import { describe, expect, it } from 'vitest';

import { isPageSubtitleSnapshot, type PageSubtitleSnapshot } from './page-subtitles';

describe('page subtitle snapshot guard', () => {
  it('accepts bounded Bilibili identity and resource metadata without a resource URL', () => {
    const value = snapshot();

    expect(isPageSubtitleSnapshot(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain('/bfs/ai_subtitle/');
  });

  it('rejects invalid Bilibili identity and resource count values', () => {
    expect(
      isPageSubtitleSnapshot({
        ...snapshot(),
        bilibiliIdentity: { ...snapshot().bilibiliIdentity, part: 0 },
      }),
    ).toBe(false);
    expect(
      isPageSubtitleSnapshot({
        ...snapshot(),
        tracks: [
          {
            ...snapshot().tracks[0],
            resource: { ...snapshot().tracks[0]?.resource, parsedCueCount: -1 },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects unknown resource states at the cross-context boundary', () => {
    expect(
      isPageSubtitleSnapshot({
        ...snapshot(),
        tracks: [
          {
            ...snapshot().tracks[0],
            resource: {
              ...snapshot().tracks[0]?.resource,
              status: 'downloaded-complete-transcript',
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts only bounded privacy-safe subtitle_url resolution metadata', () => {
    const resolution = {
      accessorFound: true,
      descriptorLocation: 'own',
      propertyReadSucceeded: true,
      resultType: 'protocol-relative-url',
      protocolRelative: true,
      validatedHost: 'aisubtitle.hdslb.com',
      validatedPath: '/bfs/ai_subtitle/bounded.json',
    } as const;
    const withResolution = {
      ...snapshot(),
      tracks: [
        {
          ...snapshot().tracks[0],
          resource: { ...snapshot().tracks[0]?.resource, urlResolution: resolution },
        },
      ],
    };

    expect(isPageSubtitleSnapshot(withResolution)).toBe(true);
    expect(
      isPageSubtitleSnapshot({
        ...withResolution,
        tracks: [
          {
            ...withResolution.tracks[0],
            resource: {
              ...withResolution.tracks[0]?.resource,
              urlResolution: {
                ...resolution,
                validatedPath: '/bfs/ai_subtitle/bounded.json?token=private',
              },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPageSubtitleSnapshot({
        ...withResolution,
        tracks: [
          {
            ...withResolution.tracks[0],
            resource: {
              ...withResolution.tracks[0]?.resource,
              urlResolution: { ...resolution, descriptorLocation: 'arbitrary-chain' },
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts bounded structural diagnostics and rejects unsafe or oversized variants', () => {
    const structuralSnapshot = {
      ...snapshot(),
      bilibiliDiagnostics: {
        stateEntries: [
          {
            scope: 'selected-track',
            path: '__INITIAL_STATE__.videoData.subtitle.list[].payload',
            valueType: 'array',
            keys: ['from', 'to', 'content'],
            arrayLength: 1,
            httpsValuePresent: true,
            safeHttpsUrls: [
              { host: 'aisubtitle.hdslb.com', path: '/bfs/ai_subtitle/bounded.json' },
            ],
            cueLikeItemCount: 1,
          },
        ],
        stateEntryLimitReached: false,
        domElements: [
          {
            tag: 'div',
            classTokens: ['future-caption-layer'],
            dataAttributeNames: ['data-render-kind'],
            bounds: { x: 100, y: 300, width: 600, height: 40 },
            textLength: 24,
          },
        ],
        domElementLimitReached: false,
      },
    };

    expect(isPageSubtitleSnapshot(structuralSnapshot)).toBe(true);
    expect(
      isPageSubtitleSnapshot({
        ...structuralSnapshot,
        bilibiliDiagnostics: {
          ...structuralSnapshot.bilibiliDiagnostics,
          stateEntries: Array.from(
            { length: 33 },
            () => structuralSnapshot.bilibiliDiagnostics.stateEntries[0],
          ),
        },
      }),
    ).toBe(false);
    expect(
      isPageSubtitleSnapshot({
        ...structuralSnapshot,
        bilibiliDiagnostics: {
          ...structuralSnapshot.bilibiliDiagnostics,
          stateEntries: [
            {
              ...structuralSnapshot.bilibiliDiagnostics.stateEntries[0],
              safeHttpsUrls: [
                {
                  host: 'aisubtitle.hdslb.com',
                  path: '/bfs/ai_subtitle/bounded.json?token=private',
                },
              ],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isPageSubtitleSnapshot({
        ...structuralSnapshot,
        bilibiliDiagnostics: {
          ...structuralSnapshot.bilibiliDiagnostics,
          domElements: [
            {
              ...structuralSnapshot.bilibiliDiagnostics.domElements[0],
              textLength: 20_001,
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('accepts only bounded privacy-safe Bilibili active-track diagnostics', () => {
    const selection = {
      tracks: [
        {
          id: 'ai-zh',
          language: 'ai-zh',
          selected: true,
          active: true,
          default: false,
          original: false,
        },
      ],
      activeTrackId: 'ai-zh',
      activeLanguage: 'ai-zh',
      source: 'active-subtitle-menu',
      finalReason: 'explicit-track-id',
    } as const;

    expect(isPageSubtitleSnapshot({ ...snapshot(), bilibiliSelection: selection })).toBe(true);
    expect(
      isPageSubtitleSnapshot({
        ...snapshot(),
        bilibiliSelection: { ...selection, finalReason: 'guessed-first-track' },
      }),
    ).toBe(false);
    expect(
      isPageSubtitleSnapshot({
        ...snapshot(),
        bilibiliSelection: {
          ...selection,
          tracks: Array.from({ length: 13 }, () => selection.tracks[0]),
        },
      }),
    ).toBe(false);
  });
});

function snapshot(): PageSubtitleSnapshot {
  return {
    version: 1,
    requestId: 'bilibili-resource-guard',
    platform: 'bilibili',
    href: 'https://www.bilibili.com/video/BV1GuardFixture',
    collectedAt: 1_786_000_000_000,
    selectedLanguage: null,
    structuredStateInspected: false,
    bilibiliIdentity: {
      bvid: 'BV1GuardFixture',
      aid: null,
      cid: '123456789',
      part: 1,
      matched: true,
    },
    video: { currentTime: 123, duration: 180, currentSrc: null },
    tracks: [
      {
        id: 'sole-ai-track',
        kind: 'subtitles',
        language: 'zh-CN',
        label: 'Chinese (AI-generated)',
        mode: 'disabled',
        active: false,
        selected: false,
        default: false,
        original: false,
        automatic: true,
        translated: false,
        cues: [{ startTime: 122, endTime: 124, text: 'Bounded fixture cue' }],
        resource: {
          available: true,
          status: 'loaded',
          host: 'aisubtitle.hdslb.com',
          parsedCueCount: 40,
        },
      },
    ],
  };
}

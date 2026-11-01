import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPageSubtitleSnapshot, type PageSubtitleSnapshot } from '../models/page-subtitles';
import { collectMainWorldSubtitleSnapshot } from './page-subtitle-bridge';

const bilibiliFixture = JSON.parse(
  readFileSync('fixtures/bilibili-subtitle-track-fixture.json', 'utf8'),
) as {
  href: string;
  initialState: Record<string, unknown>;
  resourcePayload: { body: Array<{ from: number; to: number; content: string }> };
};

describe('MAIN-world subtitle bridge', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    const page = globalThis as unknown as Record<string, unknown>;
    delete page.__INITIAL_STATE__;
    delete page.__playinfo__;
    delete page.cid;
    delete page.player;
    delete page.bilibiliPlayer;
    vi.unstubAllGlobals();
  });

  it('discovers the selected YouTube automatic-caption metadata and bounded active cues', async () => {
    document.body.innerHTML = '<div id="movie_player"><video></video></div>';
    const video = prepareVideo(document.querySelector('video')!, 10, 120);
    setTextTracks(video, [
      textTrack({
        id: 'dom-en',
        language: 'en',
        label: 'English (auto-generated)',
        mode: 'showing',
        cues: cueList([
          { startTime: 1, endTime: 2, text: 'Far before' },
          { startTime: 8, endTime: 9, text: 'Before' },
          { startTime: 9, endTime: 11, text: 'Current' },
          { startTime: 12, endTime: 13, text: 'After' },
          { startTime: 200, endTime: 201, text: 'Far after' },
        ]),
      }),
    ]);
    const player = document.getElementById('movie_player') as HTMLElement & {
      getOption?: (namespace: string, option: string) => unknown;
    };
    player.getOption = (_namespace, option) =>
      option === 'track'
        ? { languageCode: 'en', kind: 'asr', name: 'English (auto-generated)' }
        : [{ languageCode: 'en', kind: 'asr', name: 'English (auto-generated)' }];

    const result = await collect('youtube');

    expect(result.selectedLanguage).toBe('en');
    expect(result.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'en', automatic: true, language: 'en', selected: true }),
        expect.objectContaining({
          id: 'dom-en',
          selected: true,
          cues: expect.arrayContaining([expect.objectContaining({ text: 'Current' })]),
        }),
      ]),
    );
    expect(result.tracks.flatMap((track) => track.cues).map((cue) => cue.text)).not.toContain(
      'Far after',
    );
  });

  it('reads bounded Bilibili uploaded and AI subtitle cues from known player metadata', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 10, 120);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1EmbeddedCues',
        cid: 101,
        pages: [{ page: 1, cid: 101 }],
        subtitle: {
          list: [
            {
              id: 'uploaded-zh',
              lan: 'zh-CN',
              lan_doc: '中文（UP主上传）',
              is_default: true,
              body: [{ from: 9, to: 11, content: 'Uploaded current' }],
            },
            {
              id: 'ai-zh',
              lan: 'zh-CN',
              lan_doc: '中文 AI生成',
              ai_status: 1,
              body: [{ from: 9, to: 11, content: 'AI current' }],
            },
          ],
        },
      },
    };

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1EmbeddedCues');

    expect(result.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'uploaded-zh',
          default: true,
          cues: [expect.objectContaining({ text: 'Uploaded current' })],
        }),
        expect.objectContaining({
          id: 'ai-zh',
          automatic: true,
          cues: [expect.objectContaining({ text: 'AI current' })],
        }),
      ]),
    );
  });

  it('reads selected-work Douyin structured cues, converts milliseconds, and bounds context', async () => {
    document.body.innerHTML = '<main><article><video></video></article></main>';
    const video = prepareVideo(document.querySelector('video')!, 36, 120);
    const article = video.parentElement as HTMLElement & Record<string, unknown>;
    article.__reactProps$fixture = {
      props: {
        currentWork: {
          subtitleList: [
            { start_time: 1_000, end_time: 2_000, text: 'Far before' },
            { start_time: 34_000, end_time: 35_000, text: 'Before' },
            { start_time: 35_000, end_time: 38_000, text: 'Current' },
            { start_time: 39_000, end_time: 40_000, text: 'After' },
          ],
        },
      },
    };

    const result = await collect('douyin');
    const structured = result.tracks.find((track) => track.id === 'douyin-current-work-state');

    expect(result.structuredStateInspected).toBe(true);
    expect(structured?.selected).toBe(true);
    expect(structured?.cues).toEqual([
      { startTime: 1, endTime: 2, text: 'Far before' },
      { startTime: 34, endTime: 35, text: 'Before' },
      { startTime: 35, endTime: 38, text: 'Current' },
      { startTime: 39, endTime: 40, text: 'After' },
    ]);
  });

  it('follows active-video replacement rather than returning stale Douyin modal-player cues', async () => {
    document.body.innerHTML = '<div><video id="old"></video><video id="current"></video></div>';
    const oldVideo = prepareVideo(document.querySelector('#old')!, 10, 60, false, 320);
    const currentVideo = prepareVideo(document.querySelector('#current')!, 42, 90, true, 800);
    setTextTracks(oldVideo, [
      textTrack({ mode: 'showing', cues: cueList([{ startTime: 9, endTime: 11, text: 'Stale' }]) }),
    ]);
    setTextTracks(currentVideo, [
      textTrack({
        id: 'current-track',
        mode: 'showing',
        cues: cueList([{ startTime: 41, endTime: 43, text: 'Current player' }]),
      }),
    ]);

    const result = await collect('douyin');

    expect(result.video.currentTime).toBe(42);
    expect(result.tracks.flatMap((track) => track.cues).map((cue) => cue.text)).toEqual([
      'Current player',
    ]);
  });

  it('selects the sole identity-validated Bilibili metadata track and reads its bounded resource at 123 seconds', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    const resourceUrl =
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/valrecall-sanitised-fixture.json';
    const fetchMock = vi.fn(async () =>
      jsonResponse(resourceUrl, JSON.stringify(bilibiliFixture.resourcePayload)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      resourceUrl,
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }),
    );
    expect(result.bilibiliIdentity).toEqual({
      bvid: 'BV1FixtureTrack',
      aid: 'av123456789',
      cid: '987654321',
      part: 1,
      matched: true,
    });
    expect(result.tracks).toEqual([
      expect.objectContaining({
        id: 'sanitised-ai-zh',
        language: 'zh-CN',
        mode: 'disabled',
        active: false,
        selected: false,
        default: false,
        original: false,
        automatic: true,
        resource: expect.objectContaining({
          available: true,
          status: 'loaded',
          host: 'aisubtitle.hdslb.com',
          parsedCueCount: 4,
        }),
        cues: expect.arrayContaining([expect.objectContaining({ text: 'Sanitised cue at 02:03' })]),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('Distant cue excluded from the bridge response');
  });

  it('reads only the selected identity-matched AI track subtitle_url accessor and normalises its protocol-relative URL', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const selectedTrack: Record<string, unknown> = {
      id: 'selected-ai-zh-accessor',
      lan: 'zh-CN',
      lan_doc: 'Chinese AI-generated',
      ai_status: 1,
    };
    const subtitleUrlGetter = vi.fn(
      () =>
        '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/accessor-backed-selected-track.json?token=PRIVATE_ACCESSOR_QUERY',
    );
    const unrelatedGetter = vi.fn(() => {
      throw new Error('An unrelated getter must never be invoked.');
    });
    Object.defineProperties(selectedTrack, {
      subtitle_url: { configurable: true, enumerable: true, get: subtitleUrlGetter },
      unrelated_payload: { configurable: true, enumerable: true, get: unrelatedGetter },
    });
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1AccessorFixture',
        cid: 11223344,
        pages: [{ page: 1, cid: 11223344 }],
        subtitle: { list: [selectedTrack] },
      },
    };
    const resourceUrl =
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/accessor-backed-selected-track.json?token=PRIVATE_ACCESSOR_QUERY';
    const fetchMock = vi.fn(async () =>
      jsonResponse(resourceUrl, JSON.stringify(bilibiliFixture.resourcePayload)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1AccessorFixture');

    expect(subtitleUrlGetter).toHaveBeenCalledTimes(1);
    expect(unrelatedGetter).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      resourceUrl,
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }),
    );
    expect(result.tracks).toEqual([
      expect.objectContaining({
        id: 'selected-ai-zh-accessor',
        language: 'zh-CN',
        automatic: true,
        resource: expect.objectContaining({
          available: true,
          status: 'loaded',
          host: 'aisubtitle.hdslb.com',
          urlResolution: {
            accessorFound: true,
            descriptorLocation: 'own',
            propertyReadSucceeded: true,
            resultType: 'protocol-relative-url',
            protocolRelative: true,
            validatedHost: 'aisubtitle.hdslb.com',
            validatedPath: '/bfs/ai_subtitle/prod/accessor-backed-selected-track.json',
          },
        }),
        cues: expect.arrayContaining([expect.objectContaining({ text: 'Sanitised cue at 02:03' })]),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ACCESSOR_QUERY');
  });

  it('resolves a prototype accessor and a Proxy-backed exact subtitle_url read without broad property access', async () => {
    const cases = [
      {
        bvid: 'BV1PrototypeAccessor',
        resourcePath: '/bfs/ai_subtitle/prod/prototype-accessor.json',
        expectedLocation: 'prototype' as const,
        expectedAccessor: true,
        expectedResultType: 'absolute-https-url' as const,
        track: (() => {
          const prototype = {};
          Object.defineProperty(prototype, 'subtitle_url', {
            configurable: true,
            get: vi.fn(
              () => 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/prototype-accessor.json',
            ),
          });
          return Object.assign(Object.create(prototype) as Record<string, unknown>, {
            id: 'prototype-ai-zh',
            lan: 'zh-CN',
            lan_doc: 'Chinese AI-generated',
            ai_status: 1,
          });
        })(),
      },
      {
        bvid: 'BV1ProxyAccessor',
        resourcePath: '/bfs/ai_subtitle/prod/proxy-accessor.json',
        expectedLocation: 'none' as const,
        expectedAccessor: false,
        expectedResultType: 'protocol-relative-url' as const,
        track: (() => {
          const subtitleRead = vi.fn(
            () => '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/proxy-accessor.json',
          );
          return new Proxy<Record<string, unknown>>(
            {
              id: 'proxy-ai-zh',
              lan: 'zh-CN',
              lan_doc: 'Chinese AI-generated',
              ai_status: 1,
            },
            {
              get(target, property, receiver) {
                return property === 'subtitle_url'
                  ? subtitleRead()
                  : Reflect.get(target, property, receiver);
              },
            },
          );
        })(),
      },
      {
        bvid: 'BV1AccessorObjectShape',
        resourcePath: '/bfs/ai_subtitle/prod/accessor-object-shape.json',
        expectedLocation: 'own' as const,
        expectedAccessor: true,
        expectedResultType: 'protocol-relative-url' as const,
        track: (() => {
          const track: Record<string, unknown> = {
            id: 'object-shape-ai-zh',
            lan: 'zh-CN',
            lan_doc: 'Chinese AI-generated',
            ai_status: 1,
          };
          Object.defineProperty(track, 'subtitle_url', {
            configurable: true,
            get: vi.fn(() => ({
              url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/accessor-object-shape.json',
            })),
          });
          return track;
        })(),
      },
    ];

    for (const fixture of cases) {
      document.body.innerHTML = '<video></video>';
      prepareVideo(document.querySelector('video')!, 123, 1_000);
      const page = globalThis as unknown as Record<string, unknown>;
      page.__INITIAL_STATE__ = {
        videoData: {
          bvid: fixture.bvid,
          cid: 55667788,
          pages: [{ page: 1, cid: 55667788 }],
          subtitle: { list: [fixture.track] },
        },
      };
      const resourceUrl = `https://aisubtitle.hdslb.com${fixture.resourcePath}`;
      const fetchMock = vi.fn(async () =>
        jsonResponse(resourceUrl, JSON.stringify(bilibiliFixture.resourcePayload)),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await collect('bilibili', `https://www.bilibili.com/video/${fixture.bvid}`);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.tracks[0]).toMatchObject({
        automatic: true,
        resource: {
          status: 'loaded',
          urlResolution: {
            accessorFound: fixture.expectedAccessor,
            descriptorLocation: fixture.expectedLocation,
            propertyReadSucceeded: true,
            resultType: fixture.expectedResultType,
            validatedHost: 'aisubtitle.hdslb.com',
            validatedPath: fixture.resourcePath,
          },
        },
      });
    }
  });

  it.each([
    {
      label: 'undefined accessor value',
      value: undefined,
      throws: false,
      resultType: 'absent',
      propertyReadSucceeded: true,
      resourceStatus: 'none',
    },
    {
      label: 'throwing accessor',
      value: undefined,
      throws: true,
      resultType: 'invalid-type',
      propertyReadSucceeded: false,
      resourceStatus: 'none',
    },
    {
      label: 'unapproved HTTPS host',
      value: 'https://example.invalid/bfs/ai_subtitle/private.json',
      throws: false,
      resultType: 'absolute-https-url',
      propertyReadSucceeded: true,
      resourceStatus: 'rejected',
    },
    {
      label: 'malformed URL string',
      value: 'not a subtitle URL',
      throws: false,
      resultType: 'string',
      propertyReadSucceeded: true,
      resourceStatus: 'rejected',
    },
  ])(
    'contains a $label without requesting an unrelated resource or invalidating the snapshot',
    async ({ value, throws, resultType, propertyReadSucceeded, resourceStatus }) => {
      document.body.innerHTML = '<video></video>';
      prepareVideo(document.querySelector('video')!, 123, 1_000);
      const selectedTrack: Record<string, unknown> = {
        id: 'failure-contained-ai-zh',
        lan: 'zh-CN',
        ai_status: 1,
      };
      Object.defineProperty(selectedTrack, 'subtitle_url', {
        configurable: true,
        get() {
          if (throws) throw new Error('Known accessor fixture failure.');
          return value;
        },
      });
      const page = globalThis as unknown as Record<string, unknown>;
      page.__INITIAL_STATE__ = {
        videoData: {
          bvid: 'BV1ContainedAccessor',
          cid: 66778899,
          pages: [{ page: 1, cid: 66778899 }],
          subtitle: { list: [selectedTrack] },
        },
      };
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await collect(
        'bilibili',
        'https://www.bilibili.com/video/BV1ContainedAccessor',
      );

      expect(result.bilibiliIdentity?.matched).toBe(true);
      expect(result.tracks[0]).toMatchObject({
        id: 'failure-contained-ai-zh',
        cues: [],
        resource: {
          status: resourceStatus,
          urlResolution: {
            accessorFound: true,
            descriptorLocation: 'own',
            propertyReadSucceeded,
            resultType,
            validatedHost: null,
            validatedPath: null,
          },
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('resolves one active AI Chinese track by the selected player menu track id before loading its resource', async () => {
    document.body.innerHTML = `<main class="bpx-player-container">
      <video></video>
      <div class="bpx-player-ctrl-subtitle-language">
        <button class="bpx-state-active" data-track-id="ai-zh">AI Chinese</button>
      </div>
    </main>`;
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const tracks = [
      { id: 'uploaded-zh', lan: 'zh-CN', lan_doc: 'Chinese' },
      {
        id: 'ai-zh',
        lan: 'ai-zh',
        lan_doc: 'AI Chinese',
        ai_status: 1,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/active-ai-zh.json',
      },
      { id: 'en', lan: 'en', lan_doc: 'English' },
      { id: 'ja', lan: 'ja', lan_doc: 'Japanese' },
      { id: 'ko', lan: 'ko', lan_doc: 'Korean' },
      { id: 'de', lan: 'de', lan_doc: 'German' },
    ];
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1SixTrackId',
        cid: 123456,
        pages: [{ page: 1, cid: 123456 }],
        subtitle: { list: tracks },
      },
    };
    const resourceUrl = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/active-ai-zh.json';
    const fetchMock = vi.fn(async () =>
      jsonResponse(resourceUrl, JSON.stringify(bilibiliFixture.resourcePayload)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1SixTrackId');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.bilibiliSelection).toMatchObject({
      activeTrackId: 'ai-zh',
      activeLanguage: 'ai-zh',
      source: 'active-subtitle-menu',
      finalReason: 'explicit-track-id',
    });
    expect(result.tracks.find((track) => track.id === 'ai-zh')).toMatchObject({
      selected: true,
      active: true,
      resource: { status: 'loaded', host: 'aisubtitle.hdslb.com', available: true },
    });
    expect(result.tracks.filter((track) => track.selected)).toHaveLength(1);
  });

  it('uses a uniquely matching active player language and still rejects six tracks without active evidence', async () => {
    const makeTracks = () => [
      { id: 'uploaded-zh', lan: 'zh-CN', lan_doc: 'Chinese' },
      { id: 'ai-zh', lan: 'ai-zh', lan_doc: 'AI Chinese', ai_status: 1 },
      { id: 'en', lan: 'en', lan_doc: 'English' },
      { id: 'ja', lan: 'ja', lan_doc: 'Japanese' },
      { id: 'ko', lan: 'ko', lan_doc: 'Korean' },
      { id: 'de', lan: 'de', lan_doc: 'German' },
    ];
    document.body.innerHTML = '<main class="bpx-player-container"><video></video></main>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.player = { subtitle: { state: { currentLanguage: 'ai-zh' } } };
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1SixTrackLanguage',
        cid: 123456,
        pages: [{ page: 1, cid: 123456 }],
        subtitle: { list: makeTracks() },
      },
    };

    const selected = await collect(
      'bilibili',
      'https://www.bilibili.com/video/BV1SixTrackLanguage',
    );

    expect(selected.bilibiliSelection).toMatchObject({
      activeTrackId: 'ai-zh',
      activeLanguage: 'ai-zh',
      source: 'player-subtitle-state',
      finalReason: 'explicit-language',
    });
    expect(selected.tracks.find((track) => track.id === 'ai-zh')).toMatchObject({
      active: true,
      mode: 'showing',
    });

    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    delete page.player;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1SixTrackAmbiguous',
        cid: 123456,
        pages: [{ page: 1, cid: 123456 }],
        subtitle: { list: makeTracks() },
      },
    };
    const ambiguous = await collect(
      'bilibili',
      'https://www.bilibili.com/video/BV1SixTrackAmbiguous',
    );

    expect(ambiguous.bilibiliSelection).toMatchObject({
      activeTrackId: null,
      activeLanguage: null,
      source: 'none',
      finalReason: 'ambiguous',
    });
    expect(ambiguous.tracks.some((track) => track.selected || track.active)).toBe(false);
  });

  it('does not invoke a subtitle_url accessor when the selected Bilibili identity conflicts', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const selectedTrack: Record<string, unknown> = {
      id: 'stale-ai-zh-accessor',
      lan: 'zh-CN',
      ai_status: 1,
    };
    const subtitleUrlGetter = vi.fn(() => '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/stale.json');
    Object.defineProperty(selectedTrack, 'subtitle_url', {
      configurable: true,
      enumerable: true,
      get: subtitleUrlGetter,
    });
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1AccessorStale',
        cid: 11223344,
        pages: [{ page: 1, cid: 11223344 }],
        subtitle: { list: [selectedTrack] },
      },
    };
    page.__playinfo__ = {
      data: { bvid: 'BV1AccessorStale', cid: 99887766, subtitle: { subtitles: [] } },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1AccessorStale');

    expect(result.bilibiliIdentity?.matched).toBe(false);
    expect(subtitleUrlGetter).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records only bounded structural facts for the selected raw Bilibili track', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1StructuralFixture',
        cid: 24681012,
        pages: [{ page: 1, cid: 24681012 }],
        subtitle: {
          list: [
            {
              id: 'sole-ai-zh',
              lan: 'zh-CN',
              lan_doc: 'Chinese AI-generated',
              ai_status: 1,
              privateToken: 'SECRET_TOKEN_SHOULD_NOT_APPEAR',
              payloadRows: [
                {
                  from: 122,
                  to: 124,
                  content: 'PRIVATE_SUBTITLE_SHOULD_NOT_APPEAR',
                },
              ],
              payloadEndpoint:
                'https://aisubtitle.hdslb.com/new/subtitle/payload.json?token=SECRET_QUERY',
              unrelatedEndpoint: 'https://example.invalid/private?token=SECRET_QUERY',
            },
          ],
        },
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1StructuralFixture');
    const selectedEntries = result.bilibiliDiagnostics?.stateEntries.filter(
      (entry) => entry.scope === 'selected-track',
    );

    expect(result.bilibiliIdentity?.matched).toBe(true);
    expect(result.tracks).toEqual([
      expect.objectContaining({
        id: 'sole-ai-zh',
        cues: [],
        resource: expect.objectContaining({ status: 'none' }),
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(selectedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('payloadRows'),
          valueType: 'array',
          arrayLength: 1,
          cueLikeItemCount: 1,
        }),
        expect.objectContaining({
          path: expect.stringContaining('payloadEndpoint'),
          valueType: 'string',
          httpsValuePresent: true,
          safeHttpsUrls: [
            {
              host: 'aisubtitle.hdslb.com',
              path: '/new/subtitle/payload.json',
            },
          ],
        }),
        expect.objectContaining({
          path: expect.stringContaining('unrelatedEndpoint'),
          httpsValuePresent: true,
          safeHttpsUrls: [],
        }),
      ]),
    );
    const diagnosticJson = JSON.stringify(result.bilibiliDiagnostics);
    expect(diagnosticJson).not.toContain('SECRET_TOKEN_SHOULD_NOT_APPEAR');
    expect(diagnosticJson).not.toContain('PRIVATE_SUBTITLE_SHOULD_NOT_APPEAR');
    expect(diagnosticJson).not.toContain('SECRET_QUERY');
    expect(diagnosticJson).not.toContain('example.invalid');
  });

  it('records bounded lower-player DOM structure without recording visible text or data values', async () => {
    document.body.innerHTML = `
      <div class="bpx-player-container" style="opacity: 1">
        <video></video>
        <div
          class="future-caption-layer current-player-line"
          data-render-kind="SECRET_ATTRIBUTE_VALUE"
          style="opacity: 1"
        >PRIVATE_VISIBLE_SUBTITLE</div>
      </div>
    `;
    const video = prepareVideo(document.querySelector('video')!, 123, 1_000);
    const player = document.querySelector('.bpx-player-container') as HTMLElement;
    const overlay = document.querySelector('.future-caption-layer') as HTMLElement;
    player.getBoundingClientRect = () => domRect(0, 0, 800, 450);
    overlay.getBoundingClientRect = () => domRect(100, 330, 600, 42);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = {
      videoData: {
        bvid: 'BV1DomStructure',
        cid: 1357911,
        pages: [{ page: 1, cid: 1357911 }],
        subtitle: { list: [] },
      },
    };
    expect(video.getBoundingClientRect().bottom).toBe(450);

    const result = await collect('bilibili', 'https://www.bilibili.com/video/BV1DomStructure');
    const overlayEntry = result.bilibiliDiagnostics?.domElements.find((entry) =>
      entry.classTokens.includes('future-caption-layer'),
    );

    expect(overlayEntry).toEqual({
      tag: 'div',
      classTokens: ['future-caption-layer', 'current-player-line'],
      dataAttributeNames: ['data-render-kind'],
      bounds: { x: 100, y: 330, width: 600, height: 42 },
      textLength: 'PRIVATE_VISIBLE_SUBTITLE'.length,
    });
    const diagnosticJson = JSON.stringify(result.bilibiliDiagnostics);
    expect(diagnosticJson).not.toContain('PRIVATE_VISIBLE_SUBTITLE');
    expect(diagnosticJson).not.toContain('SECRET_ATTRIBUTE_VALUE');
  });

  it('does not fetch an explicit Bilibili resource when BVID, CID, or part evidence conflicts', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    page.__playinfo__ = {
      data: {
        bvid: 'BV1FixtureTrack',
        cid: 111111111,
        subtitle: { subtitles: [] },
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(result.bilibiliIdentity?.matched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tracks[0]?.resource?.status).toBe('none');
  });

  it('rejects a stale BVID before requesting a selected-track resource', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: bilibiliFixture.href });

    const value = await collectMainWorldSubtitleSnapshot({
      requestId: 'request-stale-bvid',
      platform: 'bilibili',
      expectedHref: 'https://www.bilibili.com/video/BV1DifferentFixture?p=1',
    });
    expect(isPageSubtitleSnapshot(value)).toBe(true);
    if (!isPageSubtitleSnapshot(value)) throw new Error('Expected a valid subtitle snapshot.');

    expect(value.bilibiliIdentity?.matched).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-allowlisted selected-track resource without requesting it', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    const state = structuredClone(bilibiliFixture.initialState);
    const videoData = state.videoData as Record<string, unknown>;
    const subtitle = videoData.subtitle as { list: Array<Record<string, unknown>> };
    subtitle.list[0]!.subtitle_url = 'https://example.invalid/bfs/subtitle/untrusted.json';
    page.__INITIAL_STATE__ = state;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.tracks[0]?.resource).toEqual(
      expect.objectContaining({ available: true, status: 'rejected', host: null }),
    );
  });

  it('classifies malformed selected-track resource JSON without exposing response text', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    const resourceUrl =
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/valrecall-sanitised-fixture.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(resourceUrl, 'private malformed text')),
    );

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(result.tracks[0]?.resource?.status).toBe('malformed');
    expect(JSON.stringify(result)).not.toContain('private malformed text');
  });

  it('rejects an oversized selected-track resource before reading its body', async () => {
    document.body.innerHTML = '<video></video>';
    prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    const resourceUrl =
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/valrecall-sanitised-fixture.json';
    const readBody = vi.fn(async () => JSON.stringify(bilibiliFixture.resourcePayload));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        responseFixture(resourceUrl, readBody, {
          'content-type': 'application/json',
          'content-length': '1000001',
        }),
      ),
    );

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(result.tracks[0]?.resource?.status).toBe('oversized');
    expect(readBody).not.toHaveBeenCalled();
  });

  it('invalidates resource evidence when the selected Bilibili player is replaced mid-request', async () => {
    document.body.innerHTML = '<video></video>';
    const video = prepareVideo(document.querySelector('video')!, 123, 1_000);
    const page = globalThis as unknown as Record<string, unknown>;
    page.__INITIAL_STATE__ = structuredClone(bilibiliFixture.initialState);
    const resourceUrl =
      'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/valrecall-sanitised-fixture.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        Object.defineProperty(video, 'currentSrc', {
          configurable: true,
          value: 'https://cdn.example/replaced-player.mp4',
        });
        return jsonResponse(resourceUrl, JSON.stringify(bilibiliFixture.resourcePayload));
      }),
    );

    const result = await collect('bilibili', bilibiliFixture.href);

    expect(result.bilibiliIdentity?.matched).toBe(false);
    expect(result.video.currentSrc).toBe('https://cdn.example/123.mp4');
  });
});

async function collect(
  platform: PageSubtitleSnapshot['platform'],
  href = platformHref(platform),
): Promise<PageSubtitleSnapshot> {
  vi.stubGlobal('location', { href });
  const value = await collectMainWorldSubtitleSnapshot({
    requestId: `request-${platform}`,
    platform,
    expectedHref: href,
  });
  expect(isPageSubtitleSnapshot(value)).toBe(true);
  if (!isPageSubtitleSnapshot(value)) throw new Error('Expected a valid subtitle snapshot.');
  return value;
}

function platformHref(platform: PageSubtitleSnapshot['platform']): string {
  switch (platform) {
    case 'youtube':
      return 'https://www.youtube.com/watch?v=subtitle-fixture';
    case 'bilibili':
      return 'https://www.bilibili.com/video/BV1BridgeFixture';
    case 'douyin':
      return 'https://www.douyin.com/video/7420012345678901234';
  }
}

function jsonResponse(url: string, body: string): Response {
  return responseFixture(url, async () => body, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(new TextEncoder().encode(body).byteLength),
  });
}

function responseFixture(
  url: string,
  readText: () => Promise<string>,
  headers: Record<string, string>,
): Response {
  return {
    ok: true,
    redirected: false,
    url,
    headers: new Headers(headers),
    body: null,
    text: readText,
  } as Response;
}

function prepareVideo(
  video: HTMLVideoElement,
  currentTime: number,
  duration: number,
  playing = true,
  width = 800,
): HTMLVideoElement {
  Object.defineProperties(video, {
    paused: { configurable: true, value: !playing },
    ended: { configurable: true, value: false },
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    currentTime: { configurable: true, value: currentTime },
    duration: { configurable: true, value: duration },
    currentSrc: { configurable: true, value: `https://cdn.example/${currentTime}.mp4` },
  });
  video.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: 450,
      width,
      height: 450,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return video;
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    x,
    y,
    toJSON: () => ({}),
  } as DOMRect;
}

function setTextTracks(video: HTMLVideoElement, tracks: TextTrack[]): void {
  Object.defineProperty(video, 'textTracks', {
    configurable: true,
    value: Object.assign([...tracks], { length: tracks.length }),
  });
}

function textTrack(
  overrides: Partial<TextTrack & { cues: TextTrackCueList; activeCues: TextTrackCueList }> = {},
): TextTrack {
  const cues = overrides.cues ?? cueList([]);
  return {
    id: 'track-fixture',
    kind: 'subtitles',
    language: 'zh-CN',
    label: 'Original',
    mode: 'disabled',
    cues,
    activeCues: cues,
    ...overrides,
  } as TextTrack;
}

function cueList(
  cues: Array<{ startTime: number; endTime: number; text: string }>,
): TextTrackCueList {
  return Object.assign([...cues], { length: cues.length }) as unknown as TextTrackCueList;
}

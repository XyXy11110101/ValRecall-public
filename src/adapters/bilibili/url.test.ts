import { describe, expect, it } from 'vitest';

import { extractBilibiliVideoId, isBilibiliWatchLaterUrl, parseBilibiliVideoUrl } from './url';

const exampleWatchLaterUrl =
  'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd' +
  '&spm_id_from=333.1007.fixture.content.click' +
  '&vd_source=00000000000000000000000000000000';

describe('Bilibili video URL parsing', () => {
  it('preserves standard BV and av video support including multipart context', () => {
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1Abc123?p=2#reply')).toEqual({
      videoId: 'BV1Abc123',
      originalUrl: 'https://www.bilibili.com/video/BV1Abc123?p=2#reply',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Abc123',
      part: '2',
      surface: 'video',
    });
    expect(parseBilibiliVideoUrl('https://bilibili.com/video/av12345')?.videoId).toBe('av12345');
  });

  it('derives the Watch Later BV identity and direct canonical URL', () => {
    expect(parseBilibiliVideoUrl(exampleWatchLaterUrl)).toEqual({
      videoId: 'BV1Ab411c7Cd',
      originalUrl: exampleWatchLaterUrl,
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      part: '1',
      surface: 'watch-later',
    });
    expect(extractBilibiliVideoId(exampleWatchLaterUrl)).toBe('BV1Ab411c7Cd');
    expect(isBilibiliWatchLaterUrl(exampleWatchLaterUrl)).toBe(true);
  });

  it('ignores tracking and oid for identity while preserving original item context', () => {
    const first =
      'https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1Ab411c7Cd&vd_source=first';
    const second =
      'https://www.bilibili.com/list/watchlater?spm_id_from=other&bvid=BV1Ab411c7Cd&oid=999';

    expect(parseBilibiliVideoUrl(first)?.videoId).toBe(parseBilibiliVideoUrl(second)?.videoId);
    expect(parseBilibiliVideoUrl(first)?.canonicalUrl).toBe(
      'https://www.bilibili.com/video/BV1Ab411c7Cd',
    );
    expect(parseBilibiliVideoUrl(first)?.originalUrl).toBe(first);
  });

  it('accepts the existing av identity family through one aid parameter', () => {
    expect(
      parseBilibiliVideoUrl('https://www.bilibili.com/list/watchlater?aid=100000000000001'),
    ).toMatchObject({
      videoId: 'av100000000000001',
      canonicalUrl: 'https://www.bilibili.com/video/av100000000000001',
      surface: 'watch-later',
    });
    expect(
      parseBilibiliVideoUrl('https://www.bilibili.com/list/watchlater?aid=av12345')?.videoId,
    ).toBe('av12345');
  });

  it.each([
    'https://www.bilibili.com/list/watchlater',
    'https://www.bilibili.com/list/watchlater?oid=100000000000001',
    'https://www.bilibili.com/list/watchlater?bvid=not-a-bvid',
    'https://www.bilibili.com/list/watchlater?bvid=BV1valid&bvid=BV1other',
    'https://www.bilibili.com/list/watchlater?bvid=BV1valid&aid=123',
    'https://bilibili.com/list/watchlater?bvid=BV1valid',
    'https://www.bilibili.com/list/watchlater/other?bvid=BV1valid',
    'https://www.bilibili.com/list/fav?bvid=BV1valid',
  ])('rejects unsupported or ambiguous Watch Later identity %s', (url) => {
    expect(parseBilibiliVideoUrl(url)).toBeNull();
  });
});

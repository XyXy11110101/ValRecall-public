import { describe, expect, it } from 'vitest';

import {
  buildSourceOpenUrl,
  detectVideoPlatform,
  getSourceOpenCandidates,
  getSourceTabPatterns,
  isSupportedVideoUrl,
  matchesSavedBilibiliSource,
  matchesPreferredSourceContext,
  matchesSavedSource,
  selectSourceOpenUrl,
} from './source-url';

describe('saved Bilibili source matching', () => {
  const base = 'https://www.bilibili.com/video/BV1abc123';
  const watchLater =
    'https://www.bilibili.com/list/watchlater?oid=111&bvid=BV1abc123&vd_source=first';

  it('matches the same exact source while ignoring only the fragment', () => {
    expect(matchesSavedBilibiliSource(`${base}?p=2#reply`, `${base}?p=2`)).toBe(true);
  });

  it('keeps multipart video pages distinct', () => {
    expect(matchesSavedBilibiliSource(`${base}?p=1`, `${base}?p=2`)).toBe(false);
    expect(matchesSavedBilibiliSource(base, `${base}?p=1`)).toBe(true);
  });

  it('rejects a different video or host', () => {
    expect(matchesSavedBilibiliSource(`${base}9?p=2`, `${base}?p=2`)).toBe(false);
    expect(
      matchesSavedBilibiliSource('https://www.bilibili.com/video/BV1AbC123?p=2', `${base}?p=2`),
    ).toBe(false);
    expect(
      matchesSavedBilibiliSource('https://example.com/video/BV1abc123?p=2', `${base}?p=2`),
    ).toBe(false);
  });

  it('matches Watch Later tracking variants and the standard route by stable identity', () => {
    const tracked =
      'https://www.bilibili.com/list/watchlater?spm_id_from=other&bvid=BV1abc123&oid=999';
    expect(detectVideoPlatform(watchLater)).toBe('bilibili');
    expect(isSupportedVideoUrl(watchLater, 'bilibili')).toBe(true);
    expect(matchesSavedSource(tracked, watchLater, 'bilibili')).toBe(true);
    expect(matchesSavedSource(base, watchLater, 'bilibili')).toBe(true);
    expect(
      matchesSavedSource(
        'https://www.bilibili.com/list/watchlater?bvid=BV1different',
        watchLater,
        'bilibili',
      ),
    ).toBe(false);
  });

  it('preserves item Watch Later context and orders a direct canonical fallback', () => {
    expect(selectSourceOpenUrl(watchLater, base, 'bilibili')).toBe(watchLater);
    expect(getSourceOpenCandidates(watchLater, base, 'bilibili')).toEqual([watchLater, base]);
    expect(matchesPreferredSourceContext(watchLater, watchLater, 'bilibili')).toBe(true);
    expect(matchesPreferredSourceContext(base, watchLater, 'bilibili')).toBe(false);
  });

  it('keeps standard multipart reopening behavior unchanged', () => {
    const partTwo = `${base}?p=2&spm_id_from=333`;
    expect(selectSourceOpenUrl(partTwo, base, 'bilibili')).toBe(partTwo);
    expect(getSourceOpenCandidates(partTwo, base, 'bilibili')).toEqual([partTwo]);
  });
});

describe('standard YouTube source URLs', () => {
  const video = 'AbCdEf_123-';
  const base = `https://www.youtube.com/watch?v=${video}`;

  it('accepts only an exact desktop watch URL with one valid 11-character ID', () => {
    expect(detectVideoPlatform(base)).toBe('youtube');
    expect(isSupportedVideoUrl(`${base}&list=PL123&index=4`, 'youtube')).toBe(true);

    for (const unsupported of [
      'https://youtube.com/watch?v=AbCdEf_123-',
      'https://m.youtube.com/watch?v=AbCdEf_123-',
      'https://music.youtube.com/watch?v=AbCdEf_123-',
      'https://youtu.be/AbCdEf_123-',
      'https://www.youtube.com/shorts/AbCdEf_123-',
      'https://www.youtube.com/embed/AbCdEf_123-',
      'https://www.youtube.com/live/AbCdEf_123-',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=AbCdEf_123-&v=ZyXwVu_987-',
    ]) {
      expect(isSupportedVideoUrl(unsupported)).toBe(false);
    }
  });

  it('matches by case-sensitive video identity and preserves a saved playlist constraint', () => {
    expect(matchesSavedSource(`${base}&t=42s`, base, 'youtube')).toBe(true);
    expect(matchesSavedSource(`${base}&list=PL123&index=9`, `${base}&list=PL123&index=4`)).toBe(
      true,
    );
    expect(matchesSavedSource(`${base}&list=OTHER`, `${base}&list=PL123`)).toBe(false);
    expect(matchesSavedSource('https://www.youtube.com/watch?v=abcdefghijk', base, 'youtube')).toBe(
      false,
    );
  });

  it('adds a timestamp without discarding playlist or index parameters', () => {
    const opened = new URL(buildSourceOpenUrl(`${base}&list=PL123&index=4&t=1s`, 'youtube', 42.9));

    expect(opened.searchParams.get('v')).toBe(video);
    expect(opened.searchParams.get('list')).toBe('PL123');
    expect(opened.searchParams.get('index')).toBe('4');
    expect(opened.searchParams.get('t')).toBe('42s');
  });

  it('leaves a validated source unchanged when no timestamp seek was requested', () => {
    const source = `${base}&list=PL123&index=4`;

    expect(buildSourceOpenUrl(source, 'youtube', null)).toBe(source);
    expect(new URL(buildSourceOpenUrl(source, 'youtube', 0)).searchParams.get('t')).toBe('0s');
    expect(
      buildSourceOpenUrl('https://www.bilibili.com/video/BV1abc123?p=2', 'bilibili', null),
    ).toBe('https://www.bilibili.com/video/BV1abc123?p=2');
    expect(
      buildSourceOpenUrl(
        'https://www.douyin.com/video/7391234567890123456?tracking=1',
        'douyin',
        null,
      ),
    ).toBe('https://www.douyin.com/video/7391234567890123456?tracking=1');
  });

  it('keeps platform tab queries narrowly scoped', () => {
    expect(getSourceTabPatterns('youtube')).toEqual(['https://www.youtube.com/watch*']);
    expect(getSourceTabPatterns('bilibili')).toEqual([
      'https://www.bilibili.com/video/*',
      'https://bilibili.com/video/*',
      'https://www.bilibili.com/list/watchlater*',
    ]);
    expect(getSourceTabPatterns('douyin')).toEqual(['https://www.douyin.com/video/*']);
  });
});

describe('direct Douyin source URLs', () => {
  const videoId = '7391234567890123456';
  const base = `https://www.douyin.com/video/${videoId}`;

  it('accepts only an exact HTTPS www.douyin.com numeric video path', () => {
    expect(detectVideoPlatform(`${base}?previous_page=app_code_link#detail`)).toBe('douyin');
    expect(isSupportedVideoUrl(base, 'douyin')).toBe(true);

    for (const unsupported of [
      'https://www.douyin.com/',
      'https://www.douyin.com/search/example',
      'https://www.douyin.com/user/example',
      'https://www.douyin.com/live/123',
      `https://www.douyin.com/video/${videoId}/`,
      'https://www.douyin.com/video/not-numeric',
      `https://douyin.com/video/${videoId}`,
      `http://www.douyin.com/video/${videoId}`,
      `https://v.douyin.com/${videoId}`,
    ]) {
      expect(isSupportedVideoUrl(unsupported)).toBe(false);
    }
  });

  it('matches saved tabs by exact numeric video identity', () => {
    expect(matchesSavedSource(`${base}?modeFrom=`, base, 'douyin')).toBe(true);
    expect(
      matchesSavedSource('https://www.douyin.com/video/7391234567890123457', base, 'douyin'),
    ).toBe(false);
  });

  it('matches modal and direct forms by resolved identity, not raw query order', () => {
    const modal =
      `https://www.douyin.com/user/self?from_tab_name=main&modal_id=${videoId}` +
      '&showSubTab=favorite_folder&showTab=favorite_collection';
    const reordered =
      `https://www.douyin.com/user/self?showTab=favorite_collection&tracking=1` +
      `&modal_id=${videoId}&from_tab_name=main`;

    expect(detectVideoPlatform(modal)).toBe('douyin');
    expect(matchesSavedSource(reordered, modal, 'douyin')).toBe(true);
    expect(matchesSavedSource(base, modal, 'douyin')).toBe(true);
    expect(selectSourceOpenUrl(modal, base, 'douyin')).toBe(base);
  });

  it('prefers a validated canonical URL and leaves invalid canonical data unused', () => {
    expect(selectSourceOpenUrl(`${base}?tracking=1`, base, 'douyin')).toBe(base);
    expect(
      selectSourceOpenUrl(
        `${base}?tracking=1`,
        'https://www.douyin.com/video/7391234567890123457',
        'douyin',
      ),
    ).toBe(`${base}?tracking=1`);
    expect(selectSourceOpenUrl(`${base}?tracking=1`, 'https://example.com/video/1', 'douyin')).toBe(
      `${base}?tracking=1`,
    );
  });

  it('does not discard meaningful multipart or playlist source context', () => {
    expect(
      selectSourceOpenUrl(
        'https://www.bilibili.com/video/BV1abc123?p=2',
        'https://www.bilibili.com/video/BV1abc123',
        'bilibili',
      ),
    ).toBe('https://www.bilibili.com/video/BV1abc123?p=2');
    expect(
      selectSourceOpenUrl(
        'https://www.youtube.com/watch?v=AbCdEf_123-&list=PL123',
        'https://www.youtube.com/watch?v=AbCdEf_123-',
        'youtube',
      ),
    ).toBe('https://www.youtube.com/watch?v=AbCdEf_123-&list=PL123');
  });
});

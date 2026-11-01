import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isBilibiliWatchLaterUrl, parseBilibiliVideoUrl } from './url';
import { getSourceTabPatterns, matchesSavedSource } from '../../shared/video-url';

const LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'ja'];

describe('Bilibili pages with a language prefix', () => {
  it.each(['zh-Hans', 'zh-Hant', 'en', 'ja'])('accepts /%s/video/', (language) => {
    expect(
      parseBilibiliVideoUrl(`https://www.bilibili.com/${language}/video/BV1Ab411c7Cd/?p=2`),
    ).toMatchObject({
      videoId: 'BV1Ab411c7Cd',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      part: '2',
      surface: 'video',
    });
  });

  it('treats the prefixed page as the same video as the saved one', () => {
    expect(
      matchesSavedSource(
        'https://www.bilibili.com/zh-Hans/video/BV1Ab411c7Cd/',
        'https://www.bilibili.com/video/BV1Ab411c7Cd',
        'bilibili',
      ),
    ).toBe(true);
  });

  it('accepts watch later with a prefix', () => {
    expect(
      isBilibiliWatchLaterUrl('https://www.bilibili.com/zh-Hans/list/watchlater?bvid=BV1Ab411c7Cd'),
    ).toBe(true);
  });

  it.each([
    'https://www.bilibili.com/not/a/language/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/toolongprefix/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/api/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/tv/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/zh-Hans-CN/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/zh-Hans/en/video/BV1Ab411c7Cd',
    'https://www.bilibili.com/zh-Hans/bangumi/play/ep1',
    'https://www.bilibili.com/zh-Hans/',
    'https://space.bilibili.com/zh-Hans/video/BV1Ab411c7Cd',
  ])('still refuses %s', (url) => {
    expect(parseBilibiliVideoUrl(url)).toBeNull();
  });

  it('still refuses watch later under any other first segment', () => {
    expect(
      isBilibiliWatchLaterUrl('https://www.bilibili.com/api/list/watchlater?bvid=BV1Ab411c7Cd'),
    ).toBe(false);
  });

  describe('browser access', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as {
      host_permissions: string[];
      content_scripts: { matches: string[] }[];
    };
    const lists = {
      host_permissions: manifest.host_permissions,
      content_scripts: manifest.content_scripts[0]!.matches,
      source_tabs: getSourceTabPatterns('bilibili'),
    };

    // "*" in a match pattern also crosses slashes, so "/*/video/*" would reach any depth.
    it.each(Object.entries(lists))('%s has no wildcard before the route', (_name, patterns) => {
      expect(patterns.filter((pattern) => pattern.includes('.com/*'))).toEqual([]);
    });

    it.each(Object.entries(lists))('%s names exactly the accepted segments', (_name, patterns) => {
      const segments = (route: string) =>
        patterns
          .map((pattern) => pattern.match(`^https://www\\.bilibili\\.com/([^/]+)/${route}`)?.[1])
          .filter((segment) => segment !== undefined);
      expect(segments('video/')).toEqual(LANGUAGES);
      expect(segments('list/watchlater')).toEqual(LANGUAGES);
    });
  });
});

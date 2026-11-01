import { describe, expect, it } from 'vitest';

import {
  canonicalizeDouyinVideoUrl,
  extractDouyinVideoId,
  isSupportedDouyinVideoUrl,
  parseDouyinVideoUrl,
} from './url';

describe('Douyin video URL identity', () => {
  it('accepts an exact desktop HTTPS video path and strips query state from its canonical URL', () => {
    const source =
      'https://www.douyin.com/video/7420012345678901234?previous_page=web_code_link#player';

    expect(parseDouyinVideoUrl(source)).toEqual({
      videoId: '7420012345678901234',
      originalUrl: source,
      canonicalUrl: 'https://www.douyin.com/video/7420012345678901234',
      surface: 'direct',
    });
    expect(extractDouyinVideoId(source)).toBe('7420012345678901234');
    expect(canonicalizeDouyinVideoUrl(source)).toBe(
      'https://www.douyin.com/video/7420012345678901234',
    );
  });

  it.each([
    'https://www.douyin.com/user/self?modal_id=7000000000000000002',
    'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7000000000000000002',
    'https://www.douyin.com/user/self?modal_id=7000000000000000002&showTab=favorite_collection',
    'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7000000000000000002&showSubTab=favorite_folder&showTab=favorite_collection',
    'https://www.douyin.com/user/creator?tracking=before&modal_id=7000000000000000002&collection=after',
    'https://www.douyin.com/collection/favourite?folder=name&modal_id=7000000000000000002',
    'https://www.douyin.com/search/lesson?query=encoded%20value%20%26%20state&modal_id=7000000000000000002&sort=recent',
  ])('resolves a structurally located modal_id on an approved desktop page: %s', (source) => {
    expect(parseDouyinVideoUrl(source)).toEqual({
      videoId: '7000000000000000002',
      originalUrl: source,
      canonicalUrl: 'https://www.douyin.com/video/7000000000000000002',
      surface: 'modal',
    });
  });

  it('parses a favourites URL without depending on other query state', () => {
    const source =
      'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7000000000000000001&showTab=favorite_collection';

    expect(parseDouyinVideoUrl(source)).toEqual({
      videoId: '7000000000000000001',
      originalUrl: source,
      canonicalUrl: 'https://www.douyin.com/video/7000000000000000001',
      surface: 'modal',
    });
  });

  it('ignores parameter order and unrelated state while preserving the resolved identity', () => {
    const first = 'https://www.douyin.com/user/self?alpha=1&modal_id=7000000000000000002&omega=2';
    const reordered =
      'https://www.douyin.com/user/self?omega=2&encoded=a%2Fb%3Fc&modal_id=7000000000000000002&alpha=1';

    expect(extractDouyinVideoId(first)).toBe('7000000000000000002');
    expect(extractDouyinVideoId(reordered)).toBe('7000000000000000002');
    expect(canonicalizeDouyinVideoUrl(reordered)).toBe(
      'https://www.douyin.com/video/7000000000000000002',
    );
  });

  it('gives a valid direct path priority over a different modal_id', () => {
    expect(
      parseDouyinVideoUrl(
        'https://www.douyin.com/video/7420012345678901234?modal_id=7000000000000000002',
      ),
    ).toMatchObject({ videoId: '7420012345678901234', surface: 'direct' });
  });

  it.each([
    'http://www.douyin.com/video/7420012345678901234',
    'https://douyin.com/video/7420012345678901234',
    'https://m.douyin.com/video/7420012345678901234',
    'https://v.douyin.com/fixture/',
    'https://www.douyin.com/',
    'https://www.douyin.com/search/fixture',
    'https://www.douyin.com/user/fixture',
    'https://www.douyin.com/live/7420012345678901234',
    'https://www.douyin.com/jingxuan',
    'https://www.douyin.com/video/',
    'https://www.douyin.com/video/not-numeric',
    'https://www.douyin.com/video/7420012345678901234/',
    'https://www.douyin.com/video/7420012345678901234/related',
    'https://user:secret@www.douyin.com/video/7420012345678901234',
    'https://www.douyin.com:8443/video/7420012345678901234',
    'not a URL',
  ])('rejects an unsupported or ambiguous surface: %s', (url) => {
    expect(isSupportedDouyinVideoUrl(url)).toBe(false);
    expect(parseDouyinVideoUrl(url)).toBeNull();
  });

  it.each([
    'https://www.douyin.com/user/self?modal_id=',
    'https://www.douyin.com/user/self?modal_id=not-numeric',
    'https://www.douyin.com/user/self?modal_id=12.5',
    'https://www.douyin.com/user/self?modal_id=-12',
    'https://www.douyin.com/user/self?modal_id=1&modal_id=2',
    'https://www.douyin.com/user/self?modal_id=7&modal_id=7',
    'https://m.douyin.com/user/self?modal_id=7000000000000000002',
    'https://example.com/user/self?modal_id=7000000000000000002',
  ])('rejects an invalid or ambiguous modal identity: %s', (source) => {
    expect(parseDouyinVideoUrl(source)).toBeNull();
  });
});

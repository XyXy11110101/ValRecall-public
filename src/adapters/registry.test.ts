import { describe, expect, it } from 'vitest';

import { BilibiliAdapter } from './bilibili';
import { DouyinAdapter } from './douyin';
import { createVideoPlatformAdapter, getVideoPlatformFromUrl } from './registry';
import { YouTubeAdapter } from './youtube';

describe('video platform registry', () => {
  it('creates a YouTube adapter only for an exact non-live standard watch page', () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const location = youtubeLocation('https://www.youtube.com/watch?v=AbC_dEf-123&list=PL1');

    expect(createVideoPlatformAdapter(document, location)).toBeInstanceOf(YouTubeAdapter);
    expect(getVideoPlatformFromUrl(location.href)).toBe('youtube');
  });

  it('does not register a live YouTube watch page', () => {
    document.body.innerHTML = '<ytd-watch-flexy is-live></ytd-watch-flexy>';

    expect(
      createVideoPlatformAdapter(
        document,
        youtubeLocation('https://www.youtube.com/watch?v=AbC_dEf-123'),
      ),
    ).toBeNull();
  });

  it('preserves current Bilibili page selection', () => {
    const location = {
      href: 'https://www.bilibili.com/video/BV1Abc123?p=2',
      hostname: 'www.bilibili.com',
      pathname: '/video/BV1Abc123',
    };

    expect(createVideoPlatformAdapter(document, location)).toBeInstanceOf(BilibiliAdapter);
    expect(getVideoPlatformFromUrl(location.href)).toBe('bilibili');
  });

  it('creates a Bilibili adapter for one validated Watch Later bvid', () => {
    const location = youtubeLocation(
      'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd&spm_id_from=tracking',
    );

    expect(createVideoPlatformAdapter(document, location)).toBeInstanceOf(BilibiliAdapter);
    expect(getVideoPlatformFromUrl(location.href)).toBe('bilibili');
  });

  it('rejects Watch Later without one valid URL identity', () => {
    for (const href of [
      'https://www.bilibili.com/list/watchlater',
      'https://www.bilibili.com/list/watchlater?oid=100000000000001',
      'https://www.bilibili.com/list/watchlater?bvid=invalid',
    ]) {
      const location = youtubeLocation(href);
      expect(createVideoPlatformAdapter(document, location)).toBeNull();
      expect(getVideoPlatformFromUrl(location.href)).toBeNull();
    }
  });

  it('creates a Douyin adapter for a direct numeric video page', () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const location = youtubeLocation(
      'https://www.douyin.com/video/7391234567890123456?previous_page=app_code_link',
    );

    expect(createVideoPlatformAdapter(document, location)).toBeInstanceOf(DouyinAdapter);
    expect(getVideoPlatformFromUrl(location.href)).toBe('douyin');
  });

  it('creates a Douyin adapter for a structurally identified modal video page', () => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const location = youtubeLocation(
      'https://www.douyin.com/user/self?from_tab_name=main&modal_id=7000000000000000002&showSubTab=favorite_folder&showTab=favorite_collection',
    );

    expect(createVideoPlatformAdapter(document, location)).toBeInstanceOf(DouyinAdapter);
    expect(getVideoPlatformFromUrl(location.href)).toBe('douyin');
  });

  it.each([
    'https://www.douyin.com/',
    'https://www.douyin.com/search/learning',
    'https://www.douyin.com/user/example',
    'https://www.douyin.com/live/123',
    'https://v.douyin.com/example/',
  ])('does not register unsupported Douyin surface %s', (href) => {
    const location = youtubeLocation(href);

    expect(createVideoPlatformAdapter(document, location)).toBeNull();
    expect(getVideoPlatformFromUrl(location.href)).toBeNull();
  });

  it('returns null for unsupported pages', () => {
    const location = youtubeLocation('https://www.youtube.com/shorts/AbC_dEf-123');

    expect(createVideoPlatformAdapter(document, location)).toBeNull();
    expect(getVideoPlatformFromUrl(location.href)).toBeNull();
  });
});

function youtubeLocation(href: string): { href: string; hostname: string; pathname: string } {
  const url = new URL(href);
  return { href, hostname: url.hostname, pathname: url.pathname };
}

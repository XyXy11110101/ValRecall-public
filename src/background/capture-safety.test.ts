import { describe, expect, it, vi } from 'vitest';

import type { CaptureDraft } from '../models/learning-item';
import {
  captureScreenshotSafely,
  hasMeaningfulScreenshotPixels,
  isSameCaptureTarget,
  isUsableScreenshotDataUrl,
} from './capture-safety';

describe('capture screenshot safety boundary', () => {
  it('requires the same active tab and exact Douyin video identity', () => {
    const draft = targetDraft(
      'douyin',
      'https://www.douyin.com/video/7420012345678901234?tracking=fixture',
      'https://www.douyin.com/video/7420012345678901234',
    );

    expect(
      isSameCaptureTarget(7, draft, {
        id: 7,
        url: 'https://www.douyin.com/video/7420012345678901234?fresh=1',
      }),
    ).toBe(true);
    expect(
      isSameCaptureTarget(7, draft, {
        id: 7,
        url: 'https://www.douyin.com/video/9999999999999999999',
      }),
    ).toBe(false);
    expect(isSameCaptureTarget(7, draft, { id: 8, url: draft.sourceUrl })).toBe(false);
  });

  it('retains existing Bilibili and YouTube identity matching', () => {
    expect(
      isSameCaptureTarget(
        2,
        targetDraft(
          'bilibili',
          'https://www.bilibili.com/video/BV1abc123?p=2',
          'https://www.bilibili.com/video/BV1abc123',
        ),
        { id: 2, url: 'https://www.bilibili.com/video/BV1abc123?p=2&spm_id_from=fixture' },
      ),
    ).toBe(true);
    expect(
      isSameCaptureTarget(
        3,
        targetDraft(
          'youtube',
          'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture',
          'https://www.youtube.com/watch?v=AbCdEf_123-',
        ),
        { id: 3, url: 'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture&index=4' },
      ),
    ).toBe(true);
  });

  it('matches Watch Later by bvid while rejecting an identity change', () => {
    const draft = targetDraft(
      'bilibili',
      'https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1Ab411c7Cd&vd_source=first',
      'https://www.bilibili.com/video/BV1Ab411c7Cd',
    );

    expect(
      isSameCaptureTarget(4, draft, {
        id: 4,
        url: 'https://www.bilibili.com/list/watchlater?spm_id_from=changed&bvid=BV1Ab411c7Cd&oid=2',
      }),
    ).toBe(true);
    expect(
      isSameCaptureTarget(4, draft, {
        id: 4,
        url: 'https://www.bilibili.com/list/watchlater?bvid=BV1Different',
      }),
    ).toBe(false);
  });

  it('accepts image payloads with matching magic bytes and rejects empty or false images', () => {
    expect(isUsableScreenshotDataUrl('data:image/jpeg;base64,/9j/AA==')).toBe(true);
    expect(isUsableScreenshotDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isUsableScreenshotDataUrl('data:image/jpeg;base64,')).toBe(false);
    expect(isUsableScreenshotDataUrl('data:image/jpeg;base64,AAAA')).toBe(false);
    expect(isUsableScreenshotDataUrl('data:text/plain;base64,/9j/AA==')).toBe(false);
    expect(isUsableScreenshotDataUrl(null)).toBe(false);
  });

  it('rejects an all-black decoded screenshot sample', () => {
    const black = new Uint8ClampedArray(100 * 4);
    for (let index = 3; index < black.length; index += 4) black[index] = 255;
    expect(hasMeaningfulScreenshotPixels(black)).toBe(false);

    const visible = new Uint8ClampedArray(black);
    visible[0] = 40;
    visible[1] = 40;
    visible[2] = 40;
    expect(hasMeaningfulScreenshotPixels(visible)).toBe(true);
  });

  it('rejects a near-black sample below the one-percent meaningful-pixel threshold', () => {
    const nearBlack = new Uint8ClampedArray(1_000 * 4);
    for (let pixel = 0; pixel < 1_000; pixel += 1) {
      nearBlack[pixel * 4 + 3] = 255;
    }
    for (let pixel = 0; pixel < 9; pixel += 1) {
      nearBlack[pixel * 4] = 32;
      nearBlack[pixel * 4 + 1] = 32;
      nearBlack[pixel * 4 + 2] = 32;
    }

    expect(hasMeaningfulScreenshotPixels(nearBlack)).toBe(false);
  });

  it('discards a screenshot when the modal changes during capture', async () => {
    const draft = targetDraft(
      'douyin',
      'https://www.douyin.com/video/7000000000000000002',
      'https://www.douyin.com/video/7000000000000000002',
    );
    const readActiveTab = vi.fn(async () => ({
      id: 7,
      url: 'https://www.douyin.com/user/self?state=changed&modal_id=7000000000000000002',
    }));
    const validatePage = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      captureScreenshotSafely({
        expectedTabId: 7,
        draft,
        readActiveTab,
        validatePage,
        captureVisibleTab: async () => 'data:image/jpeg;base64,/9j/AA==',
      }),
    ).rejects.toThrow('无法截取视频画面，请重试。');
    expect(readActiveTab).toHaveBeenCalledTimes(2);
    expect(validatePage).toHaveBeenCalledTimes(2);
  });

  it('allows reordered modal state and a same-ID direct transition', async () => {
    const draft = targetDraft(
      'douyin',
      'https://www.douyin.com/video/7000000000000000002',
      'https://www.douyin.com/video/7000000000000000002',
    );
    const tabs = [
      {
        id: 7,
        url: 'https://www.douyin.com/user/self?alpha=1&modal_id=7000000000000000002&omega=2',
      },
      { id: 7, url: 'https://www.douyin.com/video/7000000000000000002' },
    ];

    await expect(
      captureScreenshotSafely({
        expectedTabId: 7,
        draft,
        readActiveTab: async () => tabs.shift(),
        validatePage: async () => true,
        captureVisibleTab: async () => 'data:image/jpeg;base64,/9j/AA==',
      }),
    ).resolves.toBe('data:image/jpeg;base64,/9j/AA==');
  });
});

function targetDraft(
  platform: CaptureDraft['platform'],
  sourceUrl: string,
  canonicalUrl: string,
): Pick<CaptureDraft, 'platform' | 'sourceUrl' | 'canonicalUrl'> {
  return { platform, sourceUrl, canonicalUrl };
}

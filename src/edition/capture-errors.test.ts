import { describe, expect, it } from 'vitest';

import { captureErrorText } from './capture-errors';

const CODES = ['UNSUPPORTED_PAGE', 'VIDEO_NOT_FOUND', 'SCREENSHOT_FAILED', 'CAPTURE_FAILED'];

describe('captureErrorText', () => {
  it.each(CODES)('tells the user what to do next for %s', (code) => {
    const text = captureErrorText(code);
    expect(text).toMatch(/[一-鿿]/u);
    expect(text).toMatch(/再试一次|再按捕获快捷键|再重启|重启浏览器/u);
  });

  it('names what cannot be captured', () => {
    const text = captureErrorText('UNSUPPORTED_PAGE');
    for (const name of ['B 站', 'YouTube', '抖音', 'Shorts', '番剧']) {
      expect(text).toContain(name);
    }
  });

  it('says what to try for a black picture', () => {
    const text = captureErrorText('SCREENSHOT_FAILED');
    expect(text).toContain('黑');
    expect(text).toContain('换个视频');
    expect(text).toContain('快捷键');
  });

  it.each(['SOMETHING_NEW', '', 'constructor', '__proto__', 'Could not capture the tab.'])(
    'gives the plain general message for the unknown code %j',
    (code) => {
      expect(captureErrorText(code)).toBe(captureErrorText('CAPTURE_FAILED'));
    },
  );
});

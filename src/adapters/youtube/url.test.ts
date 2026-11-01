import { describe, expect, it } from 'vitest';

import {
  canonicalizeYouTubeWatchUrl,
  extractYouTubeVideoId,
  isSupportedYouTubeWatchUrl,
  parseYouTubeWatchUrl,
} from './url';

describe('YouTube watch URLs', () => {
  it('accepts only an exact desktop HTTPS watch URL and preserves its original query', () => {
    const url = 'https://www.youtube.com/watch?v=AbC_dEf-123&list=PL_safe&index=4#player';

    expect(parseYouTubeWatchUrl(url)).toEqual({
      videoId: 'AbC_dEf-123',
      originalUrl: url,
      canonicalUrl: 'https://www.youtube.com/watch?v=AbC_dEf-123',
    });
    expect(extractYouTubeVideoId(url)).toBe('AbC_dEf-123');
    expect(canonicalizeYouTubeWatchUrl(url)).toBe('https://www.youtube.com/watch?v=AbC_dEf-123');
  });

  it('keeps video IDs case-sensitive', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=AbC_dEf-123')).toBe(
      'AbC_dEf-123',
    );
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=abc_def-123')).toBe(
      'abc_def-123',
    );
  });

  it.each([
    'http://www.youtube.com/watch?v=AbC_dEf-123',
    'https://youtube.com/watch?v=AbC_dEf-123',
    'https://m.youtube.com/watch?v=AbC_dEf-123',
    'https://music.youtube.com/watch?v=AbC_dEf-123',
    'https://youtu.be/AbC_dEf-123',
    'https://www.youtube.com/shorts/AbC_dEf-123',
    'https://www.youtube.com/embed/AbC_dEf-123',
    'https://www.youtube.com/live/AbC_dEf-123',
    'https://www.youtube.com/watch/AbC_dEf-123',
    'https://www.youtube.com/watch?v=too-short',
    'https://www.youtube.com/watch?v=AbC_dEf-1234',
    'https://www.youtube.com/watch?v=AbC+dEf.123',
    'https://www.youtube.com/watch?v=AbC_dEf-123&v=abc_def-123',
    'https://www.youtube.com/watch',
    'not a URL',
  ])('rejects unsupported or ambiguous URL %s', (url) => {
    expect(isSupportedYouTubeWatchUrl(url)).toBe(false);
    expect(parseYouTubeWatchUrl(url)).toBeNull();
  });
});

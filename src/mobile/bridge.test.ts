import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeRequest } from './bridge';

afterEach(() => {
  delete window.ValRecallNative;
  vi.useRealTimers();
});

describe('Android origin-bound bridge client', () => {
  it('fails explicitly in an ordinary browser without sending data', async () => {
    await expect(nativeRequest('pair.status')).rejects.toThrow('Android App');
  });
  it('matches response IDs and preserves typed native failure guidance', async () => {
    window.ValRecallNative = {
      request: (text) => {
        const message = JSON.parse(text) as { id: string };
        for (const detail of ['bad json', JSON.stringify({ id: 'other', ok: true })]) {
          window.dispatchEvent(new CustomEvent('valrecall-native-result', { detail }));
        }
        window.dispatchEvent(
          new CustomEvent('valrecall-native-result', {
            detail: JSON.stringify({
              id: message.id,
              ok: false,
              error: { code: 'PAIRING_REVOKED', message: '请重新配对。' },
            }),
          }),
        );
      },
    };
    await expect(nativeRequest('sync', { version: 1, type: 'probe' })).rejects.toMatchObject({
      code: 'PAIRING_REVOKED',
      message: '请重新配对。',
    });
  });
  it('times out without treating an unconfirmed request as successful', async () => {
    vi.useFakeTimers();
    window.ValRecallNative = { request: vi.fn() };
    const response = nativeRequest('sync');
    const rejection = expect(response).rejects.toThrow('连接超时');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
  });
});

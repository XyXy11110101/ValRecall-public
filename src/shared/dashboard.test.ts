import { afterEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';
import { openValRecallDashboard } from './dashboard';

describe('side-panel study-dashboard service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the same versioned focus-or-create request as the toolbar route', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('chrome', { runtime: { id: 'valrecall', sendMessage } });

    await expect(openValRecallDashboard()).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.openDashboard,
      version: MESSAGE_PROTOCOL_VERSION,
    });
  });

  it('sends an optional saved-item destination without changing the legacy request', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('chrome', { runtime: { id: 'valrecall', sendMessage } });
    await expect(
      openValRecallDashboard({ view: 'library', itemId: 'saved-question' }),
    ).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.openDashboard,
      version: MESSAGE_PROTOCOL_VERSION,
      payload: { view: 'library', itemId: 'saved-question' },
    });
    sendMessage.mockClear();
    await expect(openValRecallDashboard({ view: 'library', itemId: '' })).resolves.toMatchObject({
      ok: false,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

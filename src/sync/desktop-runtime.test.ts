import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSyncDependencies } from './desktop-runtime';
import { subscribeSyncDataChanged, SYNC_DATA_CHANGED } from './data-events';
import type { DesktopSyncPort } from './service';

afterEach(() => vi.unstubAllGlobals());

describe('desktop sync wiring', () => {
  function fixture() {
    const port: DesktopSyncPort = {
      getEpoch: vi.fn(async () => 'epoch'),
      getSnapshot: vi.fn(),
      applyOperations: vi.fn(async () => []),
    };
    const notify = vi.fn();
    return { port, notify, api: desktopSyncDependencies(port, notify) };
  }
  it('routes the probe without touching the wallet', async () => {
    const { port, notify, api } = fixture();
    await api.onSync({ deviceId: 'phone', request: { version: 1, type: 'probe' } });
    expect(port.getEpoch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'refreshes dashboard even after lost or partial push (%s)',
    async (fail) => {
      const { port, notify, api } = fixture();
      if (fail) vi.mocked(port.applyOperations).mockRejectedValue(new Error('interrupted'));
      await api.onSync({
        deviceId: 'phone',
        request: { version: 2, type: 'push', epoch: 'epoch', operations: [] },
      });
      expect(notify).toHaveBeenCalledOnce();
    },
  );
  it('validates notifications and detaches the listener', () => {
    const onChange = vi.fn();
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension', onMessage: { addListener, removeListener } },
    });
    const dispose = subscribeSyncDataChanged(onChange);
    const receive = addListener.mock.calls[0]![0] as (
      value: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
    receive(SYNC_DATA_CHANGED, { id: 'other' });
    receive(SYNC_DATA_CHANGED, { id: 'extension', tab: {} as chrome.tabs.Tab });
    receive({ ...SYNC_DATA_CHANGED, version: 2 }, { id: 'extension' });
    expect(onChange).not.toHaveBeenCalled();
    receive(SYNC_DATA_CHANGED, { id: 'extension' });
    expect(onChange).toHaveBeenCalledOnce();
    dispose();
    expect(removeListener).toHaveBeenCalledWith(receive);
  });
});

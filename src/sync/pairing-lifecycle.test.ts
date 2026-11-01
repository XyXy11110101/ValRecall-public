// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import { deleteAllCopy } from '../edition/data-safety';
import { SYNC_ENABLED_STORAGE_KEY } from './settings';
import { NativeSyncController, type NativeSyncPort } from './native-bridge';
import { DesktopSyncService } from './service';

const connections: { close(): void }[] = [];
const controllers: NativeSyncController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const connection of connections.splice(0)) connection.close();
  vi.unstubAllGlobals();
});

/** The part of native/windows PairingState that a restore touches: a new epoch drops the phone. */
function fakeHelper() {
  const state = { epoch: '', paired: true, inits: 0 };
  const listeners = new Set<(message: unknown) => void>();
  const port: NativeSyncPort = {
    disconnect: () => undefined,
    onMessage: {
      addListener: (listener) => void listeners.add(listener),
      removeListener: (listener) => void listeners.delete(listener),
    },
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
    postMessage(raw) {
      const message = raw as { id: string; type: string; payload: { epoch?: string } };
      if (message.type === 'init') {
        state.inits += 1;
        if (state.epoch !== '' && state.epoch !== message.payload.epoch) state.paired = false;
        state.epoch = message.payload.epoch ?? '';
      }
      queueMicrotask(() => {
        for (const listener of listeners)
          listener({
            version: 1,
            id: message.id,
            type: 'result',
            ok: true,
            payload: {
              serverId: 'synthetic-server',
              paired: state.paired,
              addresses: ['192.168.1.2'],
              port: 19284,
            },
          });
      });
    },
  };
  return { state, port };
}

async function fixture() {
  const repository = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'pairing-lifecycle',
  });
  connections.push(repository);
  const domain = new SyncRepository(repository, { legacyLoader: async () => undefined });
  const service = new DesktopSyncService(domain);
  const helper = fakeHelper();
  const controller = new NativeSyncController({
    storage: {
      get: async () => ({ [SYNC_ENABLED_STORAGE_KEY]: true }),
      set: async () => undefined,
    },
    connect: () => helper.port,
    getEpoch: () => domain.getEpoch(),
    onSync: async () => undefined,
    timeoutMs: 1_000,
  });
  controllers.push(controller);
  await controller.start();
  const pairedEpoch = await domain.getEpoch();
  return {
    repository,
    domain,
    helper,
    controller,
    pairedEpoch,
    /** What a paired phone hears on its next sync, under the epoch it paired with. */
    phoneHears: () =>
      service.handle('synthetic-phone', { version: 2, type: 'capabilities', epoch: pairedEpoch }),
    /** What opening or refreshing the settings page does. */
    settingsSays: async () => (await controller.control('status')).state.status?.paired,
  };
}

describe.each([false, true])('pairing after restore and delete, public edition %s', (edition) => {
  function setEdition() {
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', edition);
  }

  it('keeps the pairing after a merge restore of a backup that carries the wallet', async () => {
    setEdition();
    const test = await fixture();
    const backup = await test.repository.exportData();
    expect(backup.schemaVersion).toBeGreaterThanOrEqual(9);
    await test.repository.importData(backup, 'merge');
    expect(await test.domain.getEpoch()).toBe(test.pairedEpoch);
    expect(await test.phoneHears()).toMatchObject({ type: 'capabilities' });
    expect(await test.settingsSays()).toBe(true);
    expect(test.helper.state.inits).toBe(1);
  });

  it('keeps the pairing after a merge of tasks only', async () => {
    setEdition();
    const test = await fixture();
    await test.repository.importTasks(await test.repository.exportTasks(), 'merge');
    expect(await test.domain.getEpoch()).toBe(test.pairedEpoch);
    expect(await test.settingsSays()).toBe(true);
  });

  it.each([
    ['without the wallet', false],
    ['with the wallet', true],
  ])('ends the pairing after a replace restore %s', async (_label, restoreWallet) => {
    setEdition();
    const test = await fixture();
    const backup = await test.repository.exportData();
    await test.repository.importData(backup, 'replace', { restoreWallet });
    expect(await test.domain.getEpoch()).not.toBe(test.pairedEpoch);
    // The phone is stopped at once, before the helper has heard anything.
    expect(await test.phoneHears()).toMatchObject({ type: 'error', code: 'EPOCH_CHANGED' });
    expect(test.helper.state.paired).toBe(true);
    // The next word from the settings page tells the helper, and the phone's token dies.
    expect(await test.settingsSays()).toBe(false);
    expect(test.helper.state.paired).toBe(false);
    expect(test.helper.state.epoch).toBe(await test.domain.getEpoch());
  });

  it('ends the pairing after deleting learning content', async () => {
    setEdition();
    const test = await fixture();
    await test.repository.clearAllData();
    expect(await test.domain.getEpoch()).not.toBe(test.pairedEpoch);
    expect(await test.phoneHears()).toMatchObject({ type: 'error', code: 'EPOCH_CHANGED' });
    expect(await test.settingsSays()).toBe(false);
    expect(test.helper.state.paired).toBe(false);
    expect(deleteAllCopy(true).panel).toContain('配对也会失效');
    expect(deleteAllCopy(false).confirm).toContain('配对也会失效');
  });

  it('keeps the pairing when a replace restore fails', async () => {
    setEdition();
    const test = await fixture();
    await expect(test.repository.importData({ nonsense: true }, 'replace')).rejects.toBeDefined();
    expect(await test.domain.getEpoch()).toBe(test.pairedEpoch);
    expect(await test.settingsSays()).toBe(true);
  });
});

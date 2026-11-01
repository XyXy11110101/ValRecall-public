import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftRepository } from '../database/drafts';
import { MobileRepository } from '../database/mobile-repository';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import { WalletRepository } from '../database/wallet';
import type { SyncRequest } from '../sync/contracts';
import { DesktopSyncService } from '../sync/service';
import { MobileApp } from './MobileApp';
import { SyncClient } from './sync-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-10-22T12:00:00Z');
const values = {
  title: '桌面任务',
  notes: null,
  kind: 'routine' as const,
  recurrence: 'daily' as const,
  scheduledDate: null,
  scheduledTime: null,
  selectedWeekdays: [],
  linkedLearningItemId: null,
  priority: 'normal' as const,
};

/**
 * The real phone stack against an in-memory computer: one sync pushes an operation, records
 * the computer's receipt and pulls a newer snapshot that removes the entry, all before the
 * app reloads. The confirmation must still be spoken, and only once.
 */
describe('phone confirmation after a real one-shot sync', () => {
  let container: HTMLDivElement;
  let root: Root;
  const closers: { close(): void }[] = [];

  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    for (const connection of closers.splice(0)) connection.close();
    vi.restoreAllMocks();
  });

  async function fixture() {
    const desktop = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'desktop',
      clock: () => now,
    });
    const sync = new SyncRepository(desktop, { clock: () => now });
    const mobile = new MobileRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'phone',
      clock: () => now,
    });
    closers.push(desktop, mobile);
    await desktop.createTask({ ...values, id: 'desk' });
    const epoch = await sync.getEpoch();
    const service = new DesktopSyncService(
      sync,
      () => now.getTime(),
      () => 'Europe/London',
    );
    const pushes: SyncRequest[] = [];
    const client = new SyncClient(mobile, {
      pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch }),
      request: (request: SyncRequest) => {
        if (request.type === 'push') pushes.push(request);
        return service.handle('phone', request);
      },
    });
    await client.sync();
    return { desktop, mobile, client, pushes, wallet: new WalletRepository(desktop) };
  }

  /** Every line the floating status ever showed, in order. */
  function recordAnnouncements() {
    const spoken: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof HTMLElement &&
            node.parentElement?.classList.contains('mobile-celebration-status')
          )
            spoken.push(node.textContent ?? '');
    });
    observer.observe(container, { childList: true, subtree: true });
    return { spoken, stop: () => observer.disconnect() };
  }

  async function settle(ms = 900) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Real IndexedDB and real timers: wait inside act until the condition holds. */
  async function until(condition: () => boolean, timeout = 4000) {
    for (let waited = 0; !condition(); waited += 50) {
      if (waited >= timeout) throw new Error('Timed out waiting for the phone');
      await settle(50);
    }
  }

  function button(text: string) {
    const value = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text || element.getAttribute('aria-label') === text,
    );
    if (!value) throw new Error(`Missing button ${text}`);
    return value;
  }

  it('announces a completion and a creation confirmed in one sync exactly once each', async () => {
    const f = await fixture();
    await act(async () =>
      root.render(
        <MobileApp
          services={{
            repository: f.mobile,
            client: f.client,
            draftRepository: new DraftRepository(f.mobile, () => now),
            native: vi.fn(async () => ({ paired: true })),
          }}
          clock={() => now}
          confirmAction={() => true}
        />,
      ),
    );
    await settle(200);
    const record = recordAnnouncements();

    await act(async () => button('桌面任务：标记完成').click());
    await until(() => record.spoken.includes('+5 元已到账'));
    expect(f.pushes).toHaveLength(1);
    // The acknowledged entry was removed inside the same sync, before any reload.
    expect((await f.mobile.load()).outbox).toEqual([]);
    await settle();
    expect(record.spoken).toEqual(['已完成 · 待入账 +5 元', '+5 元已到账']);

    await act(async () => button('添加任务').click());
    await settle(50);
    const title = container.querySelector<HTMLInputElement>('input[name="title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        title,
        '手机新增',
      );
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(50);
    await act(async () => button('保存任务').click());
    await until(() => record.spoken.filter((line) => line.endsWith('已到账')).length >= 2);
    expect(f.pushes).toHaveLength(2);
    const creationPush = f.pushes[1];
    expect(creationPush?.type === 'push' ? creationPush.taskCreationReward : null).toBe(5);
    await settle();
    record.stop();
    expect(record.spoken).toEqual([
      '已完成 · 待入账 +5 元',
      '+5 元已到账',
      '已添加 · 待入账 +5 元',
      '+5 元已到账',
    ]);
    // Money comes only from the computer: desktop create, phone completion, phone create.
    expect((await f.wallet.load()).balance).toBe(15);
    expect((await f.mobile.load()).snapshot?.wallet.balance).toBe(15);

    // Both syncs above were automatic, so the requested-sync line never spoke. A requested
    // sync with nothing new to confirm says once that it finished, and nothing else.
    const syncLine = () => container.querySelector('.mobile-sr-only[role="status"]');
    expect(syncLine()?.textContent).toBe('');
    const again = recordAnnouncements();
    await act(async () => button('同步').click());
    await until(() => syncLine()?.textContent === '同步完成。');
    await settle();
    again.stop();
    expect(again.spoken).toEqual([]);
  }, 15_000);
});

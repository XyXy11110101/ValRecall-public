// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import { MobileRepository } from '../database/mobile-repository';
import { SyncClient } from '../mobile/sync-client';
import { DesktopSyncService } from './service';
import type { SyncRequest } from './contracts';

const opened: { close(): void }[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
async function setup(legacy = false) {
  const desktop = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'desktop-probe',
  });
  const mobile = new MobileRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'mobile-probe',
  });
  opened.push(desktop, mobile);
  const domain = new SyncRepository(desktop, { legacyLoader: async () => undefined });
  const epoch = await domain.getEpoch();
  let zone = 'Europe/London';
  const service = new DesktopSyncService(
    legacy
      ? {
          getEpoch: () => domain.getEpoch(),
          getSnapshot: (z) => domain.getSnapshot(z),
          applyOperations: (...args) => domain.applyOperations(...args),
        }
      : domain,
    Date.now,
    () => zone,
  );
  const request = vi.fn((r: SyncRequest) => service.handle('phone', r));
  const client = new SyncClient(mobile, {
    request,
    pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch }),
  });
  await client.sync();
  request.mockClear();
  return {
    desktop,
    mobile,
    domain,
    service,
    client,
    request,
    setZone: (z: string) => {
      zone = z;
    },
  };
}
describe('local change checks through the real repositories and service', () => {
  it('sends pending edits directly rather than probing first', async () => {
    const f = await setup();
    await f.mobile.createTask({
      title: 'Pending edit',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-18',
    });
    await f.client.checkForChanges();
    expect(f.request.mock.calls.map(([request]) => request.type)).toEqual([
      'capabilities',
      'push',
      'pull',
    ]);
    expect((await f.mobile.load()).outbox).toEqual([]);
  });
  it('rejects a probe response after the phone accepts another epoch', async () => {
    const f = await setup();
    let finish!: () => void;
    f.request.mockImplementationOnce(async (request) => {
      const response = await f.service.handle('phone', request);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response;
    });
    const checking = f.client.checkForChanges();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.mobile.acceptNewEpoch('new-epoch');
    finish();
    await expect(checking).rejects.toMatchObject({ code: 'EPOCH_CHANGED' });
    expect((await f.mobile.load()).epoch).toBe('new-epoch');
    expect((await f.mobile.load()).snapshot).toBeNull();
  });
  it('avoids pulls and writes until desktop changes, including timezone', async () => {
    const f = await setup();
    const before = await f.mobile.load();
    const apply = vi.spyOn(f.mobile, 'applySnapshot');
    expect((await f.client.checkForChanges()).snapshotUpdated).toBe(false);
    expect(f.request.mock.calls.map(([r]) => r.type)).toEqual(['change-state']);
    expect(apply).not.toHaveBeenCalled();
    expect(await f.mobile.load()).toEqual(before);
    const task = await f.desktop.createTask({
      title: 'Desktop change',
      kind: 'routine',
      recurrence: 'daily',
    });
    expect((await f.client.checkForChanges()).state.snapshot?.tasks[0]?.task.id).toBe(task.id);
    f.request.mockClear();
    await f.client.checkForChanges();
    expect(f.request.mock.calls.map(([r]) => r.type)).toEqual(['change-state']);
    f.setZone('Asia/Shanghai');
    expect((await f.client.checkForChanges()).state.snapshot?.timeZone).toBe('Asia/Shanghai');
  });
  it('never polls full snapshots from a legacy peer', async () => {
    const f = await setup(true);
    for (let i = 0; i < 3; i++) expect((await f.client.checkForChanges()).changeProbe).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    await f.client.sync();
    expect(f.request.mock.calls.map(([r]) => r.type)).toEqual(['capabilities', 'pull']);
  });
  it('advances the baseline only after successful snapshot persistence', async () => {
    const f = await setup();
    const before = (await f.mobile.load()).snapshot!;
    await f.desktop.createTask({ title: 'New content', kind: 'routine', recurrence: 'daily' });
    const apply = vi.spyOn(f.mobile, 'applySnapshot').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.client.checkForChanges()).rejects.toMatchObject({ code: 'ACTION_REQUIRED' });
    expect((await f.mobile.load()).snapshot?.contentRevision).toBe(before.contentRevision);
    apply.mockRestore();
    expect((await f.client.checkForChanges()).snapshotUpdated).toBe(true);
  });
  it('retains a desktop change committed during snapshot transfer for the next check', async () => {
    const f = await setup();
    let changed = false;
    await f.desktop.createTask({ title: 'First', kind: 'routine', recurrence: 'daily' });
    f.request.mockImplementation(async (r) => {
      const response = await f.service.handle('phone', r);
      if (r.type === 'pull' && !changed) {
        changed = true;
        await f.desktop.createTask({ title: 'Later', kind: 'routine', recurrence: 'daily' });
      }
      return response;
    });
    const first = await f.client.checkForChanges();
    expect(first.state.snapshot?.tasks).toHaveLength(1);
    expect((await f.client.checkForChanges()).state.snapshot?.tasks).toHaveLength(2);
  });
  it('stops on invalid probe data and changed identity without writing or pulling', async () => {
    const f = await setup();
    const before = await f.mobile.load();
    f.request.mockResolvedValueOnce({
      version: 2,
      type: 'change-state',
      epoch: before.epoch!,
      contentRevision: 'bad token',
      timeZone: 'UTC',
    });
    await expect(f.client.checkForChanges()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    f.request.mockResolvedValueOnce({
      version: 2,
      type: 'error',
      code: 'EPOCH_CHANGED',
      message: 'restore',
    });
    await expect(f.client.checkForChanges()).rejects.toMatchObject({ code: 'EPOCH_CHANGED' });
    expect(await f.mobile.load()).toEqual(before);
    expect(f.request.mock.calls.every(([r]) => r.type === 'change-state')).toBe(true);
  });
  it('shares one in-flight request and submits queued work even when desktop revision matches', async () => {
    const f = await setup();
    await f.mobile.createTask({ title: 'Phone task', recurrence: 'daily' });
    const first = f.client.checkForChanges();
    expect(f.client.sync()).toBe(first);
    const result = await first;
    expect(result.pushed).toBe(1);
    expect(result.state.outbox).toHaveLength(0);
    expect((await f.domain.getSnapshot('Europe/London')).tasks).toHaveLength(1);
  });
});

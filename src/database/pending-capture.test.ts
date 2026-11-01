// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { CaptureDraft } from '../models/learning-item';
import { isValRecallMessage, MESSAGE_TYPES } from '../models/messages';
import { ValRecallRepository } from './repository';
import { DraftRepository } from './drafts';
import {
  dismissCaptureById,
  preservePendingCapture,
  consumeCaptureSource,
} from './pending-capture';
import { STORE_NAMES, runMigrations } from './migrations';
import { transactionComplete } from './idb';

function capture(id: string): CaptureDraft {
  return {
    draftId: id,
    schemaVersion: 1,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1abc123',
    canonicalUrl: null,
    videoId: 'BV1abc123',
    videoTitle: 'Synthetic',
    uploader: null,
    description: null,
    timestampSeconds: 12,
    timestampDisplay: '00:12',
    videoDurationSeconds: 120,
    chapterTitle: null,
    videoBounds: null,
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8=',
    subtitleBefore: [],
    subtitleCurrent: ['Synthetic source'],
    subtitleAfter: [],
    subtitleCueData: [],
    subtitleStatus: 'current_only',
    subtitleExtractionStrategy: 'visible_video_overlay',
    subtitleConfidence: 'medium',
    capturedAt: '2026-10-21T12:00:00Z',
    extractionDiagnostics: [],
  };
}
function fixture() {
  const repository = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'pending',
  });
  return { repository, drafts: new DraftRepository(repository) };
}
describe('capture sources and exact-ID cleanup', () => {
  it('migrates a valid v5 pending capture to a recoverable source without creating an item', async () => {
    const factory = new IDBFactory();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('v5-pending', 5);
      request.onupgradeneeded = () => runMigrations(request.result, request.transaction!, 0, 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = old.transaction(STORE_NAMES.meta, 'readwrite');
    tx.objectStore(STORE_NAMES.meta).put({
      key: 'runtime.pendingCapture',
      value: { ok: true, draft: capture('v5') },
      updatedAt: '2026-10-21T12:00:00Z',
    });
    await transactionComplete(tx);
    old.close();
    const repository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'v5-pending',
    });
    expect((await repository.open()).version).toBe(6);
    expect(await new DraftRepository(repository).list('capture')).toMatchObject([
      { id: 'capture-source:v5', payload: { capture: JSON.stringify(capture('v5')) } },
    ]);
    expect(await repository.listItems()).toEqual([]);
  });
  it('preserves multiple captures with a closed panel, including the v5 pending source', async () => {
    const { repository, drafts } = fixture();
    await repository.setMeta('runtime.pendingCapture', { ok: true, draft: capture('legacy') });
    await preservePendingCapture(repository, { ok: true, draft: capture('second') });
    await preservePendingCapture(repository, { ok: true, draft: capture('third') });
    expect((await drafts.list('capture')).map((row) => row.id).sort()).toEqual([
      'capture-source:legacy',
      'capture-source:second',
      'capture-source:third',
    ]);
    repository.close();
    expect(await repository.getMeta('runtime.pendingCapture')).toMatchObject({
      draft: { draftId: 'third' },
    });
    expect(await repository.listItems()).toEqual([]);
  });
  it('an old save/cancel callback cannot erase a newer capture', async () => {
    const { repository, drafts } = fixture();
    await preservePendingCapture(repository, { ok: true, draft: capture('old') });
    await preservePendingCapture(repository, { ok: true, draft: capture('new') });
    expect(await dismissCaptureById(repository, 'old')).toBe(false);
    expect(await repository.getMeta('runtime.pendingCapture')).toMatchObject({
      draft: { draftId: 'new' },
    });
    expect((await drafts.list('capture')).map((row) => row.id)).toEqual(['capture-source:new']);
    const tx = (await repository.open()).transaction(
      [STORE_NAMES.meta, STORE_NAMES.drafts],
      'readwrite',
    );
    const done = transactionComplete(tx);
    await consumeCaptureSource(tx, 'new');
    tx.abort();
    await expect(done).rejects.toThrow();
    expect(await repository.getMeta('runtime.pendingCapture')).toMatchObject({
      draft: { draftId: 'new' },
    });
    expect(await drafts.list('capture')).toHaveLength(1);
    expect(await dismissCaptureById(repository, 'new')).toBe(true);
    expect(await drafts.list('capture')).toEqual([]);
  });
  it('guards the optional identity field without breaking the version-one message boundary', () => {
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.dismissCapture,
        version: 1,
        payload: { draftId: 'specific' },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.dismissCapture,
        version: 1,
        payload: { draftId: '' },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.dismissCapture,
        version: 1,
        payload: { draftId: 2 },
      }),
    ).toBe(false);
  });
});

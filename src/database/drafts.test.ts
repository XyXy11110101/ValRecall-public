import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DatabaseConnection } from './connection';
import { DraftRepository, consumeDraft, readDraft } from './drafts';
import { transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';

function fixture() {
  const database = new DatabaseConnection(new IDBFactory(), 'draft-test');
  return {
    database,
    repository: new DraftRepository(database, () => new Date('2026-10-21T12:00:00Z')),
  };
}
const input = {
  id: 'draft1',
  scope: 'manual',
  summary: '中文 / English',
  payload: { answer: '未完成的答案', selected: ['a', 'b'] },
};
describe('durable drafts', () => {
  it('survives closing and reopening without creating learning items', async () => {
    const { database, repository } = fixture();
    const saved = await repository.save(input, 0);
    database.close();
    expect(await repository.list('manual')).toEqual([saved]);
    expect(await repository.list('intake')).toEqual([]);
  });
  it('rejects stale overwrites and stale discards and preserves the newer revision', async () => {
    const { repository } = fixture();
    const first = await repository.save(input, 0);
    const second = await repository.save({ ...input, payload: { answer: '新版' } }, first.revision);
    await expect(repository.save(input, first.revision)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(repository.discard(first)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.list('manual')).toEqual([second]);
  });
  it('rolls draft consumption back when the surrounding formal save aborts', async () => {
    const { database, repository } = fixture();
    const saved = await repository.save(input, 0);
    const tx = (await database.open()).transaction(
      [STORE_NAMES.items, STORE_NAMES.drafts],
      'readwrite',
    );
    const done = transactionComplete(tx);
    await consumeDraft(tx, saved);
    tx.abort();
    await expect(done).rejects.toThrow();
    expect(await repository.list('manual')).toEqual([saved]);
  });
  it('only removes the submitted revision after transaction success', async () => {
    const { repository } = fixture();
    const saved = await repository.save(input, 0);
    await repository.discard(saved);
    expect(await repository.list('manual')).toEqual([]);
  });
  it('rejects malformed persisted payloads instead of treating them as an empty draft', () => {
    expect(() =>
      readDraft({ ...input, schemaVersion: 1, revision: 1, updatedAt: 'bad' }),
    ).toThrow();
    expect(() =>
      readDraft({ ...input, schemaVersion: 2, revision: 1, updatedAt: '2026-10-21' }),
    ).toThrow();
    expect(() =>
      readDraft({
        ...input,
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-10-21',
        payload: { value: Infinity },
      }),
    ).toThrow();
  });
});

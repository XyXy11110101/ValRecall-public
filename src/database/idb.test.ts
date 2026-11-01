// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { requestResult, transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';
import { ValRecallRepository } from './repository';

describe('native transaction failure', () => {
  it('keeps an abort observable even when a request rejects before the caller awaits completion', async () => {
    const repository = new ValRecallRepository({ indexedDBFactory: new IDBFactory() });
    const database = await repository.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readwrite');
    const done = transactionComplete(transaction);
    const requested = requestResult(
      transaction.objectStore(STORE_NAMES.meta).put({ key: 'rollback', value: 1 }),
    );
    transaction.abort();
    await expect(requested).rejects.toMatchObject({ name: 'AbortError' });
    // Allow native abort dispatch to finish before observing the completion branch.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(done).rejects.toThrow();
    expect(await repository.getMeta('rollback')).toBeUndefined();
    repository.close();
  });
});

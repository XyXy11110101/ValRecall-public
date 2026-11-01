// @vitest-environment node

import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { STORE_NAMES, runMigrations } from './migrations';

describe('repository connection lifecycle', () => {
  it('closes a blocked attempt that succeeds after the caller has already received an error', async () => {
    const factory = new IDBFactory();
    const name = 'blocked-open-retry';
    const old = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (request.transaction) runMigrations(request.result, request.transaction, 0, 1);
      };
      request.onsuccess = () => resolve(request.result);
    });
    const completed: IDBDatabase[] = [];
    const originalOpen = factory.open.bind(factory);
    vi.spyOn(factory, 'open').mockImplementation((...args) => {
      const request = originalOpen(...args);
      request.addEventListener('success', () => completed.push(request.result));
      return request;
    });
    const repository = new ValRecallRepository({ indexedDBFactory: factory, databaseName: name });
    await expect(repository.open()).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    old.close();
    const live = await repository.open();
    expect(completed).toHaveLength(2);
    expect(completed[1]).toBe(live);
    expect(() => completed[0]?.transaction(STORE_NAMES.items)).toThrow();
    expect(await repository.open()).toBe(live);
    repository.close();
  });

  it('does not reuse an in-flight connection after close, and closes that old result', async () => {
    const repository = new ValRecallRepository({ indexedDBFactory: new IDBFactory() });
    const pending = repository.open();
    expect(repository.open()).toBe(pending);
    repository.close();
    const replacement = repository.open();
    const [closed, current] = await Promise.all([pending, replacement]);
    expect(closed).not.toBe(current);
    expect(() => closed.transaction(STORE_NAMES.items)).toThrow();
    expect(await repository.open()).toBe(current);
    repository.close();
  });

  it('reopens after the browser terminates a connection', async () => {
    const repository = new ValRecallRepository({ indexedDBFactory: new IDBFactory() });
    await repository.setMeta('keep', 'saved');
    const original = await repository.open();
    const closed = new Promise<void>((resolve) =>
      original.addEventListener('close', () => resolve()),
    );
    // fake-indexeddb 6 declares a constructor parameter, but its implementation
    // takes the live connection (closeConnection(db, true)). Keep this in tests.
    Reflect.apply(forceCloseDatabase, undefined, [original]);
    await closed;
    expect(await repository.open()).not.toBe(original);
    expect(await repository.getMeta('keep')).toBe('saved');
    repository.close();
  });
});

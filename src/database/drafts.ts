import { DatabaseConnection } from './connection';
import { DatabaseError } from './errors';
import { requestResult, transactionComplete } from './idb';
import { DATABASE_NAME, STORE_NAMES } from './migrations';

export type DraftValue =
  null | boolean | number | string | Blob | DraftValue[] | { [key: string]: DraftValue };
export interface LocalDraft {
  schemaVersion: 1;
  id: string;
  scope: string;
  revision: number;
  updatedAt: string;
  summary: string;
  payload: DraftValue;
}
export interface DraftToken {
  id: string;
  revision: number;
}
export interface DraftDatabase {
  open(): Promise<IDBDatabase>;
}

export function isDraftValue(value: unknown, depth = 0): value is DraftValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value instanceof Blob)
    return value.size <= 32 * 1024 * 1024 && /^image\/(png|jpeg|webp)$/.test(value.type);
  if (Array.isArray(value))
    return value.length <= 20000 && value.every((entry) => isDraftValue(entry, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      !['__proto__', 'constructor', 'prototype'].includes(key) && isDraftValue(entry, depth + 1),
  );
}

export function readDraft(value: unknown): LocalDraft {
  if (typeof value !== 'object' || value === null)
    throw new DatabaseError('INVALID_DATA', '草稿记录无效。');
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.scope !== 'string' ||
    !row.scope ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    typeof row.summary !== 'string' ||
    !isDraftValue(row.payload)
  )
    throw new DatabaseError('INVALID_DATA', '草稿无法读取。');
  return {
    schemaVersion: 1,
    id: row.id,
    scope: row.scope,
    revision: Number(row.revision),
    updatedAt: row.updatedAt,
    summary: row.summary,
    payload: row.payload,
  };
}

/** Call in the SAME transaction as the formal save. Never delete a newer revision. */
export async function consumeDraft(transaction: IDBTransaction, token?: DraftToken): Promise<void> {
  if (!token) return;
  const store = transaction.objectStore(STORE_NAMES.drafts);
  const value: unknown = await requestResult(store.get(token.id));
  if (value === undefined || readDraft(value).revision !== token.revision)
    throw new DatabaseError('CONFLICT', '草稿已在其他窗口修改，请刷新后重试。');
  store.delete(token.id);
}

export class DraftRepository {
  constructor(
    private readonly database: DraftDatabase = new DatabaseConnection(indexedDB, DATABASE_NAME),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(scope: string): Promise<LocalDraft[]> {
    const tx = (await this.database.open()).transaction(STORE_NAMES.drafts, 'readonly');
    const done = transactionComplete(tx);
    const values: unknown[] = await requestResult(
      tx.objectStore(STORE_NAMES.drafts).index('by-scope').getAll(scope),
    );
    await done;
    return values.map(readDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(
    input: Omit<LocalDraft, 'schemaVersion' | 'revision' | 'updatedAt'>,
    expectedRevision: number,
  ): Promise<LocalDraft> {
    const next = readDraft({
      ...input,
      schemaVersion: 1,
      revision: expectedRevision + 1,
      updatedAt: this.clock().toISOString(),
    });
    const tx = (await this.database.open()).transaction(STORE_NAMES.drafts, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const store = tx.objectStore(STORE_NAMES.drafts);
      const value: unknown = await requestResult(store.get(input.id));
      const current = value === undefined ? undefined : readDraft(value);
      if (
        (current?.revision ?? 0) !== expectedRevision ||
        (current && current.scope !== input.scope)
      )
        throw new DatabaseError('CONFLICT', '这份草稿已在其他窗口修改，请先看那个窗口。');
      store.put(next);
      await done;
      return next;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already completed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async discard(token: DraftToken): Promise<void> {
    const tx = (await this.database.open()).transaction(STORE_NAMES.drafts, 'readwrite');
    const done = transactionComplete(tx);
    try {
      await consumeDraft(tx, token);
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already completed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

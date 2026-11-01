import { isRecord, isSyncId, SyncDataError } from '../sync/protocol';
import { requestResult } from './idb';
import { STORE_NAMES } from './migrations';

export const SYNC_CONTENT_REVISION_KEY = 'contentRevision';

/** A token, not a counter: every committed task/wallet change shares its transaction. */
export function bumpContentRevision(tx: IDBTransaction): void {
  tx.objectStore(STORE_NAMES.wallet).put({
    key: SYNC_CONTENT_REVISION_KEY,
    value: crypto.randomUUID(),
  });
}

export async function contentRevision(tx: IDBTransaction): Promise<string> {
  const row: unknown = await requestResult(
    tx.objectStore(STORE_NAMES.wallet).get(SYNC_CONTENT_REVISION_KEY),
  );
  // Existing installations need no migration or write on a read-only check.
  if (row === undefined) return 'initial';
  if (!isRecord(row) || !isSyncId(row.value)) throw new SyncDataError('内容修订标记无效。');
  return row.value;
}

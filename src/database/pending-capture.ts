import { captureSourceDraft } from './capture-source-draft';
import { isCapturePageResponse, type CapturePageResponse } from '../models/messages';
import { requestResult, transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';
import type { DatabaseOpener } from './wallet';

export async function dismissCaptureById(
  database: DatabaseOpener,
  draftId: string,
): Promise<boolean> {
  const tx = (await database.open()).transaction(
    [STORE_NAMES.meta, STORE_NAMES.drafts],
    'readwrite',
  );
  const done = transactionComplete(tx);
  try {
    const store = tx.objectStore(STORE_NAMES.meta);
    const raw: unknown = await requestResult(store.get('runtime.pendingCapture'));
    const value = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : undefined;
    const matches = isCapturePageResponse(value) && value.ok && value.draft.draftId === draftId;
    transactionSourceCleanup(tx, draftId);
    if (matches)
      store.put({
        key: 'runtime.pendingCapture',
        value: null,
        updatedAt: new Date().toISOString(),
      });
    await done;
    return matches;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already closed. */
    }
    await done.catch(() => undefined);
    throw error;
  }
}

function transactionSourceCleanup(tx: IDBTransaction, draftId: string) {
  tx.objectStore(STORE_NAMES.drafts).delete('capture-source:' + draftId);
}
export async function consumeCaptureSource(tx: IDBTransaction, draftId: string) {
  transactionSourceCleanup(tx, draftId);
  const store = tx.objectStore(STORE_NAMES.meta);
  const raw: unknown = await requestResult(store.get('runtime.pendingCapture'));
  const value = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : undefined;
  if (isCapturePageResponse(value) && value.ok && value.draft.draftId === draftId)
    store.put({ key: 'runtime.pendingCapture', value: null, updatedAt: new Date().toISOString() });
}
/** Every explicit capture has its own source draft, even while the panel is closed. */
export async function preservePendingCapture(
  database: DatabaseOpener,
  response: CapturePageResponse,
) {
  const tx = (await database.open()).transaction(
    [STORE_NAMES.meta, STORE_NAMES.drafts],
    'readwrite',
  );
  const done = transactionComplete(tx);
  try {
    const previousRaw: unknown = await requestResult(
      tx.objectStore(STORE_NAMES.meta).get('runtime.pendingCapture'),
    );
    const previous =
      typeof previousRaw === 'object' && previousRaw !== null && 'value' in previousRaw
        ? previousRaw.value
        : undefined;
    const sources = [
      response,
      ...(isCapturePageResponse(previous) && previous.ok ? [previous] : []),
    ];
    for (const source of sources) {
      if (!source.ok) continue;
      const id = 'capture-source:' + source.draft.draftId;
      const store = tx.objectStore(STORE_NAMES.drafts);
      if ((await requestResult(store.getKey(id))) === undefined)
        store.add(captureSourceDraft(source.draft));
    }
    tx.objectStore(STORE_NAMES.meta).put({
      key: 'runtime.pendingCapture',
      value: response,
      updatedAt: new Date().toISOString(),
    });
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Closed. */
    }
    await done.catch(() => undefined);
    throw error;
  }
}

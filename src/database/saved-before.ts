import { requestResult, transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';
import { readOperationReceipt } from './reliability-backup';
import type { DatabaseOpener } from './wallet';

/**
 * Whether a learning item was ever saved here. Every save writes a receipt in the same transaction
 * as the item (capture, the Add page, image and video questions, received packages), and neither
 * deleting items nor delete-all removes it. A package that added no question proves nothing.
 *
 * An unreadable receipt throws: the caller then keeps the ordinary wording, not the new-user one.
 */
export async function hasSavedLearningItem(database: DatabaseOpener): Promise<boolean> {
  const transaction = (await database.open()).transaction(STORE_NAMES.learningReceipts, 'readonly');
  const done = transactionComplete(transaction);
  const rows: unknown[] = await requestResult(
    transaction.objectStore(STORE_NAMES.learningReceipts).getAll(),
  );
  await done;
  return rows.map(readOperationReceipt).some((receipt) => {
    return receipt.kind === 'intake' ? receipt.result.questions > 0 : true;
  });
}

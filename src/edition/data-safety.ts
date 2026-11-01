import { localDateKey } from '../models/daily-task';

// The browser may clear site data when the disk runs low, unless the data is marked persistent.
// Asked once: the answer is the browser's to give, and the app works the same either way.
const PERSIST_ASKED_KEY = 'valrecall.persistAsked';
export const LAST_BACKUP_KEY = 'valrecall.lastBackupAt';

function localStorageArea(): chrome.storage.LocalStorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
}

export async function requestPersistentStorageOnce(): Promise<void> {
  try {
    if (typeof navigator.storage?.persist !== 'function') return;
    const area = localStorageArea();
    const stored = await area?.get(PERSIST_ASKED_KEY);
    if (stored?.[PERSIST_ASKED_KEY] === true) return;
    await navigator.storage.persist().catch(() => false);
    await area?.set({ [PERSIST_ASKED_KEY]: true });
  } catch {
    // A refusal or a failed read changes nothing for the user. The next open may simply ask again.
  }
}

/** A failed write must not turn a finished export into an error. The old date simply stays. */
export async function recordLastBackup(now: Date = new Date()): Promise<void> {
  try {
    await localStorageArea()?.set({ [LAST_BACKUP_KEY]: now.toISOString() });
  } catch (error) {
    console.warn('[ValRecall] The backup date could not be saved.', error);
  }
}

/** Anything but a readable date counts as no backup. */
export function parseLastBackup(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function loadLastBackup(): Promise<Date | null> {
  const stored = await localStorageArea()?.get(LAST_BACKUP_KEY);
  return parseLastBackup(stored?.[LAST_BACKUP_KEY]);
}

/** Follows the date as it changes, in this page or another. */
export function onLastBackupChanged(listener: (date: Date | null) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => undefined;
  const handle = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const change = changes[LAST_BACKUP_KEY];
    if (area === 'local' && change) listener(parseLastBackup(change.newValue));
  };
  chrome.storage.onChanged.addListener(handle);
  return () => chrome.storage.onChanged.removeListener(handle);
}

export function lastBackupLine(date: Date | null): string {
  // The date of the request: the browser gives no word on whether the file was really saved.
  return date
    ? `上次导出：${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日。`
    : '还没有导出过。';
}

/** The date in the backup's file name. Local, so it matches the date this page shows. */
export function backupFileDate(now: Date = new Date()): string {
  return localDateKey(now);
}

/**
 * Delete-all does not empty the database: repository clearAll keeps the ledger, review sessions,
 * save receipts, sync receipts and task revisions, and settings live outside it. So nothing here
 * may say that everything is gone. Only uninstalling removes all of it. It also rotates the sync
 * epoch, and the helper drops the paired phone when it sees a new epoch.
 */
export function deleteAllCopy(rewardsOn: boolean) {
  const stays = `有些记录会留在这个浏览器里：${rewardsOn ? '零花钱和账本' : '奖励记录'}、部分复习记录、保存和同步记录等。`;
  const pairing = '如果配对了手机，配对也会失效，要重新配对。';
  return {
    title: '删除学习内容',
    panel: `会永久删除回忆题、截图、草稿、分类、待办和笔记。${stays}${pairing}要全部删除，只能卸载扩展。`,
    confirm: `删除回忆题、截图、草稿、分类、待办和笔记？${stays}${pairing}要全部删除，只能卸载扩展。没有备份就无法恢复。打开着的 ValRecall 页面会刷新，没保存的文字也会丢掉。`,
    done: '回忆题、截图、草稿、分类、待办和笔记已删除。有些记录还留在这个浏览器里。',
  };
}

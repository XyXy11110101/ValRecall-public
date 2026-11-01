import { useEffect, useState } from 'react';

import { hasSavedLearningItem } from '../database/saved-before';
import type { DatabaseOpener } from '../database/wallet';

// Zero items means two different things: nothing saved yet, or everything saved was later deleted.
// Only the first is a new user. Every real save leaves a receipt that survives deletion and
// delete-all, so the receipts tell them apart. This small flag saves reading them again.
const SAVED_ONCE_KEY = 'valrecall.savedItemOnce';

export interface RecentItemsReader extends DatabaseOpener {
  listRecentItems(limit: number): Promise<readonly unknown[]>;
}

export interface SavedOnceStore {
  load(): Promise<boolean>;
  save(): Promise<void>;
}

const chromeSavedOnceStore: SavedOnceStore = {
  async load() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return false;
    const stored = await chrome.storage.local.get(SAVED_ONCE_KEY);
    return stored[SAVED_ONCE_KEY] === true;
  },
  async save() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [SAVED_ONCE_KEY]: true });
  },
};

export async function isFreshInstall(
  items: RecentItemsReader,
  store: SavedOnceStore,
): Promise<boolean> {
  if (await store.load()) return false;
  const recent = await items.listRecentItems(1);
  if (recent.length === 0 && !(await hasSavedLearningItem(items))) return true;
  await store.save();
  return false;
}

/**
 * True: nothing has ever been saved. False: something has, or the read failed, so the ordinary
 * wording stays. Null: not known yet. Reads again on return, as a capture happens in another tab.
 */
export function useFreshInstall(
  revision: number,
  items: RecentItemsReader,
  store: SavedOnceStore = chromeSavedOnceStore,
): boolean | null {
  const [fresh, setFresh] = useState<boolean | null>(null);
  useEffect(() => {
    let latest = 0;
    const read = () => {
      const current = ++latest;
      void isFreshInstall(items, store)
        .catch(() => false)
        .then((value) => {
          if (current === latest) setFresh(value);
        });
    };
    const refresh = () => {
      if (document.visibilityState !== 'hidden') read();
    };
    read();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      latest = -1;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [items, revision, store]);
  return fresh;
}

/** A new user has no reviews, so "reviews are done" and "caught up" would both be untrue. */
export function freshCompanionMessage(taskCount: number): string {
  return taskCount > 0 ? `还有 ${taskCount} 项任务。` : '还没有内容。先存一条吧。';
}

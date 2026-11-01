export const SYNC_ENABLED_STORAGE_KEY = 'sync.enabled.v1';

export interface SyncPreferenceStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

/** Only the opt-in preference belongs in extension storage; no pairing credentials do. */
export async function loadSyncEnabled(storage: SyncPreferenceStorage): Promise<boolean> {
  const values = await storage.get(SYNC_ENABLED_STORAGE_KEY);
  return values[SYNC_ENABLED_STORAGE_KEY] === true;
}

export async function saveSyncEnabled(
  storage: SyncPreferenceStorage,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [SYNC_ENABLED_STORAGE_KEY]: enabled });
}

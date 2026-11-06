import {
  DEFAULT_WORKING_CARD,
  WORKING_CARD_STORAGE_KEY,
  forgetWorkingTask,
  normalizeWorkingCardState,
  type WorkingCardState,
} from '../models/working-card';

/** The small slice of `chrome.storage.local` the card reads and writes. */
export interface WorkingCardStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export function chromeWorkingCardStorage(): WorkingCardStorage | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/** Outside the extension (tests, local previews) nothing is stored. */
export async function loadWorkingCard(
  storage: WorkingCardStorage | null = chromeWorkingCardStorage(),
): Promise<WorkingCardState> {
  if (!storage) return { ...DEFAULT_WORKING_CARD, notes: [], plans: [] };
  const stored = await storage.get(WORKING_CARD_STORAGE_KEY);
  return normalizeWorkingCardState(stored?.[WORKING_CARD_STORAGE_KEY]);
}

export async function saveWorkingCard(
  state: WorkingCardState,
  storage: WorkingCardStorage | null = chromeWorkingCardStorage(),
): Promise<void> {
  await storage?.set({ [WORKING_CARD_STORAGE_KEY]: state });
}

/** Clear-all and replace-import: the next-step notes are the user's own words. */
export async function clearWorkingCard(
  storage: WorkingCardStorage | null = chromeWorkingCardStorage(),
): Promise<void> {
  await storage?.remove(WORKING_CARD_STORAGE_KEY);
}

/** A deleted task leaves no note behind. A failure here must not fail the delete. */
export async function forgetDeletedTask(
  taskId: string,
  storage: WorkingCardStorage | null = chromeWorkingCardStorage(),
): Promise<void> {
  try {
    await saveWorkingCard(forgetWorkingTask(await loadWorkingCard(storage), taskId), storage);
  } catch {
    /* The note stays until it ages out; it is never shown without its task. */
  }
}

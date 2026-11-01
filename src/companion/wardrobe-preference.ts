import { isCompanionOutfit, outfitForDate, type CompanionOutfit } from './wardrobe';

/**
 * The wardrobe choice: wear today's outfit from the rotation, or pin one. It has its own
 * storage key because any change to `valrecall.preferences` re-runs the reminders. The pin
 * applies to the desktop only (dashboard, side panel, notifications).
 */
export const COMPANION_WARDROBE_STORAGE_KEY = 'valrecall.companionWardrobe';

export type CompanionWardrobePreference =
  { version: 1; mode: 'daily' } | { version: 1; mode: 'pinned'; outfit: CompanionOutfit };

export const DAILY_COMPANION_WARDROBE: Readonly<CompanionWardrobePreference> = Object.freeze({
  version: 1,
  mode: 'daily',
});

/** The small slice of `chrome.storage.local` the wardrobe reads and writes. */
export interface CompanionWardrobeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Anything that is not exactly a known version-1 choice falls back to the daily rotation. */
export function normalizeCompanionWardrobePreference(value: unknown): CompanionWardrobePreference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { version: 1, mode: 'daily' };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return { version: 1, mode: 'daily' };
  if (record.mode === 'pinned' && isCompanionOutfit(record.outfit)) {
    return { version: 1, mode: 'pinned', outfit: record.outfit };
  }
  return { version: 1, mode: 'daily' };
}

export function resolveCompanionOutfit(
  preference: CompanionWardrobePreference,
  dateKey: string,
): CompanionOutfit {
  return preference.mode === 'pinned' ? preference.outfit : outfitForDate(dateKey);
}

export function chromeWardrobeStorage(): CompanionWardrobeStorage | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/** Outside the extension (tests, local previews) there is nothing stored: daily. */
export async function loadCompanionWardrobePreference(
  storage: CompanionWardrobeStorage | null = chromeWardrobeStorage(),
): Promise<CompanionWardrobePreference> {
  if (!storage) return { version: 1, mode: 'daily' };
  const stored = await storage.get(COMPANION_WARDROBE_STORAGE_KEY);
  return normalizeCompanionWardrobePreference(stored[COMPANION_WARDROBE_STORAGE_KEY]);
}

export async function saveCompanionWardrobePreference(
  preference: CompanionWardrobePreference,
  storage: CompanionWardrobeStorage | null = chromeWardrobeStorage(),
): Promise<void> {
  if (!storage) return;
  await storage.set({
    [COMPANION_WARDROBE_STORAGE_KEY]: normalizeCompanionWardrobePreference(preference),
  });
}

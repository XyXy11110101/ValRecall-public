import { companionIconPath, type CompanionIconKind } from '../companion/wardrobe';
import {
  COMPANION_WARDROBE_STORAGE_KEY,
  DAILY_COMPANION_WARDROBE,
  normalizeCompanionWardrobePreference,
  resolveCompanionOutfit,
} from '../companion/wardrobe-preference';
import { localDateKey } from '../models/daily-task';

/** The extension icon every build ships; ordinary builds always use it. */
export const APP_NOTIFICATION_ICON = 'icons/icon128.png';

/**
 * Private builds show the companion's head on notifications, in the pinned outfit or today's:
 * the reminder head for review reminders, the default head for the daily plan. Ordinary
 * builds return before reading anything, so the paths and the wardrobe key compile away.
 */
export async function companionNotificationIcon(
  kind: CompanionIconKind,
  readStorage: (key: string) => Promise<Record<string, unknown>>,
  now: Date,
): Promise<string> {
  if (!__VALRECALL_PRIVATE_COMPANION_ASSETS__) return APP_NOTIFICATION_ICON;
  let preference = DAILY_COMPANION_WARDROBE;
  try {
    const stored = await readStorage(COMPANION_WARDROBE_STORAGE_KEY);
    preference = normalizeCompanionWardrobePreference(stored[COMPANION_WARDROBE_STORAGE_KEY]);
  } catch {
    // An unreadable choice falls back to today's outfit; the reminder still goes out.
  }
  return companionIconPath(resolveCompanionOutfit(preference, localDateKey(now)), kind);
}

/**
 * A reminder must never be lost to artwork: if the companion icon cannot be loaded, the same
 * notification is created again with the extension icon.
 */
export async function createWithIconFallback(
  create: (iconPath: string) => Promise<unknown>,
  iconPath: string,
): Promise<void> {
  if (iconPath === APP_NOTIFICATION_ICON) {
    await create(iconPath);
    return;
  }
  try {
    await create(iconPath);
  } catch {
    await create(APP_NOTIFICATION_ICON);
  }
}

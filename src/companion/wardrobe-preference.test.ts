import { afterEach, describe, expect, it, vi } from 'vitest';

import { outfitForDate } from './wardrobe';
import {
  COMPANION_WARDROBE_STORAGE_KEY,
  loadCompanionWardrobePreference,
  normalizeCompanionWardrobePreference,
  resolveCompanionOutfit,
  saveCompanionWardrobePreference,
  type CompanionWardrobeStorage,
} from './wardrobe-preference';

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial };
  const storage: CompanionWardrobeStorage = {
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
  };
  return { storage, values };
}

describe('companion wardrobe preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has its own storage key, apart from the reminder preferences', () => {
    expect(COMPANION_WARDROBE_STORAGE_KEY).toBe('valrecall.companionWardrobe');
  });

  it('keeps a valid daily or pinned choice', () => {
    expect(normalizeCompanionWardrobePreference({ version: 1, mode: 'daily' })).toEqual({
      version: 1,
      mode: 'daily',
    });
    expect(
      normalizeCompanionWardrobePreference({ version: 1, mode: 'pinned', outfit: 'outfit10' }),
    ).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit10' });
  });

  it('drops extra fields from a pinned choice', () => {
    expect(
      normalizeCompanionWardrobePreference({
        version: 1,
        mode: 'pinned',
        outfit: 'outfit8',
        extra: '<script>',
      }),
    ).toEqual({ version: 1, mode: 'pinned', outfit: 'outfit8' });
  });

  it.each([
    undefined,
    null,
    'pinned',
    42,
    [],
    {},
    { version: 2, mode: 'pinned', outfit: 'outfit1' },
    { version: '1', mode: 'pinned', outfit: 'outfit1' },
    { version: 1, mode: 'pinned' },
    { version: 1, mode: 'pinned', outfit: 'red' },
    { version: 1, mode: 'pinned', outfit: 'OUTFIT1' },
    { version: 1, mode: 'shuffle' },
  ])('treats anything invalid as the daily rotation (%j)', (value) => {
    expect(normalizeCompanionWardrobePreference(value)).toEqual({ version: 1, mode: 'daily' });
  });

  it('wears the pinned outfit on every date, and the rotation otherwise', () => {
    const pinned = { version: 1, mode: 'pinned', outfit: 'outfit12' } as const;
    expect(resolveCompanionOutfit(pinned, '2026-10-28')).toBe('outfit12');
    expect(resolveCompanionOutfit(pinned, '2026-10-29')).toBe('outfit12');
    const daily = { version: 1, mode: 'daily' } as const;
    expect(resolveCompanionOutfit(daily, '2026-10-28')).toBe(outfitForDate('2026-10-28'));
    expect(resolveCompanionOutfit(daily, '2026-10-29')).toBe(outfitForDate('2026-10-29'));
    expect(resolveCompanionOutfit(daily, '2026-10-28')).not.toBe(
      resolveCompanionOutfit(daily, '2026-10-29'),
    );
  });

  it('loads and saves through the storage area, normalizing on both sides', async () => {
    const { storage, values } = memoryStorage({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit9' },
    });
    await expect(loadCompanionWardrobePreference(storage)).resolves.toEqual({
      version: 1,
      mode: 'pinned',
      outfit: 'outfit9',
    });
    expect(storage.get).toHaveBeenCalledWith(COMPANION_WARDROBE_STORAGE_KEY);

    await saveCompanionWardrobePreference({ version: 1, mode: 'daily' }, storage);
    expect(values[COMPANION_WARDROBE_STORAGE_KEY]).toEqual({ version: 1, mode: 'daily' });
    await expect(loadCompanionWardrobePreference(storage)).resolves.toEqual({
      version: 1,
      mode: 'daily',
    });
  });

  it('reads a corrupt stored value as daily', async () => {
    const { storage } = memoryStorage({ [COMPANION_WARDROBE_STORAGE_KEY]: 'outfit8' });
    await expect(loadCompanionWardrobePreference(storage)).resolves.toEqual({
      version: 1,
      mode: 'daily',
    });
  });

  it('is daily without chrome storage, and saving is a no-op', async () => {
    vi.stubGlobal('chrome', undefined);
    await expect(loadCompanionWardrobePreference()).resolves.toEqual({
      version: 1,
      mode: 'daily',
    });
    await expect(
      saveCompanionWardrobePreference({ version: 1, mode: 'pinned', outfit: 'outfit1' }),
    ).resolves.toBeUndefined();
  });

  it('uses chrome.storage.local when the extension provides it', async () => {
    const { storage, values } = memoryStorage();
    vi.stubGlobal('chrome', { storage: { local: storage } });
    await saveCompanionWardrobePreference({ version: 1, mode: 'pinned', outfit: 'outfit11' });
    expect(values[COMPANION_WARDROBE_STORAGE_KEY]).toEqual({
      version: 1,
      mode: 'pinned',
      outfit: 'outfit11',
    });
    await expect(loadCompanionWardrobePreference()).resolves.toEqual({
      version: 1,
      mode: 'pinned',
      outfit: 'outfit11',
    });
  });
});

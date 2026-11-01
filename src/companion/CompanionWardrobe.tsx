import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { outfitForDate, type CompanionOutfit } from './wardrobe';
import {
  COMPANION_WARDROBE_STORAGE_KEY,
  DAILY_COMPANION_WARDROBE,
  loadCompanionWardrobePreference,
  normalizeCompanionWardrobePreference,
  resolveCompanionOutfit,
  saveCompanionWardrobePreference,
  type CompanionWardrobePreference,
} from './wardrobe-preference';

export interface CompanionWardrobeValue {
  preference: CompanionWardrobePreference;
  /** False until the stored choice has been read; companions show their placeholder until then. */
  ready: boolean;
  outfitFor(dateKey: string): CompanionOutfit;
  /** Stores the choice; every open page follows through `chrome.storage.onChanged`. */
  save(preference: CompanionWardrobePreference): Promise<void>;
}

/**
 * Without a provider (tests, the Review showcase) the companion wears today's outfit at once
 * and saving does nothing. The default never touches storage, so ordinary builds drop it.
 */
const DAILY_WARDROBE_VALUE: CompanionWardrobeValue = {
  preference: DAILY_COMPANION_WARDROBE,
  ready: true,
  outfitFor: outfitForDate,
  save: () => Promise.resolve(),
};

const CompanionWardrobeContext = /* @__PURE__ */ createContext(DAILY_WARDROBE_VALUE);

export function useCompanionWardrobe(): CompanionWardrobeValue {
  return useContext(CompanionWardrobeContext);
}

/**
 * Mounted once at the dashboard root and in the side panel. Ordinary builds have no art, so
 * they render the children alone and never read the wardrobe key.
 */
export function CompanionWardrobeProvider({ children }: { children: ReactNode }) {
  if (!__VALRECALL_PRIVATE_COMPANION_ASSETS__) return <>{children}</>;
  return <StoredCompanionWardrobe>{children}</StoredCompanionWardrobe>;
}

function StoredCompanionWardrobe({ children }: { children: ReactNode }) {
  const [preference, setPreference] =
    useState<CompanionWardrobePreference>(DAILY_COMPANION_WARDROBE);
  const [ready, setReady] = useState(false);
  // A save or a change from another page is newer than the first read, which then loses.
  const settledRef = useRef(false);

  useEffect(() => {
    let active = true;
    void loadCompanionWardrobePreference()
      .catch(() => DAILY_COMPANION_WARDROBE)
      .then((loaded) => {
        if (!active) return;
        if (!settledRef.current) setPreference(loaded);
        settledRef.current = true;
        setReady(true);
      });

    const onChanged = chromeStorageChanged();
    const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'local' || !(COMPANION_WARDROBE_STORAGE_KEY in changes)) return;
      settledRef.current = true;
      setPreference(
        normalizeCompanionWardrobePreference(changes[COMPANION_WARDROBE_STORAGE_KEY]?.newValue),
      );
      setReady(true);
    };
    onChanged?.addListener(listener);
    return () => {
      active = false;
      onChanged?.removeListener(listener);
    };
  }, []);

  const save = useCallback(async (next: CompanionWardrobePreference) => {
    const normalized = normalizeCompanionWardrobePreference(next);
    await saveCompanionWardrobePreference(normalized);
    settledRef.current = true;
    setPreference(normalized);
    setReady(true);
  }, []);

  const value = useMemo<CompanionWardrobeValue>(
    () => ({
      preference,
      ready,
      outfitFor: (dateKey) => resolveCompanionOutfit(preference, dateKey),
      save,
    }),
    [preference, ready, save],
  );

  return (
    <CompanionWardrobeContext.Provider value={value}>{children}</CompanionWardrobeContext.Provider>
  );
}

type StorageChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

function chromeStorageChanged(): {
  addListener(listener: StorageChangeListener): void;
  removeListener(listener: StorageChangeListener): void;
} | null {
  if (typeof chrome === 'undefined') return null;
  const onChanged = chrome.storage?.onChanged;
  return onChanged && typeof onChanged.addListener === 'function' ? onChanged : null;
}

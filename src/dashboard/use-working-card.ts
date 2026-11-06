import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_WORKING_CARD,
  WORKING_CARD_STORAGE_KEY,
  normalizeWorkingCardState,
  type WorkingCardState,
} from '../models/working-card';
import {
  chromeWorkingCardStorage,
  loadWorkingCard,
  saveWorkingCard,
  type WorkingCardStorage,
} from '../shared/working-card-store';

export interface WorkingCardValue {
  /** False until the stored value has been read; until then no card and no 开始. */
  ready: boolean;
  state: WorkingCardState;
  /** Writes one at a time. Rejects and leaves the state unchanged when the write fails. */
  update(change: (state: WorkingCardState) => WorkingCardState): Promise<void>;
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

const NO_STORAGE = Symbol('default storage');

export function useWorkingCard(
  storageOption: WorkingCardStorage | null | typeof NO_STORAGE = NO_STORAGE,
): WorkingCardValue {
  const storageRef = useRef(
    storageOption === NO_STORAGE ? chromeWorkingCardStorage() : storageOption,
  );
  const [state, setState] = useState<WorkingCardState>(() => ({
    ...DEFAULT_WORKING_CARD,
    notes: [],
    plans: [],
  }));
  const [ready, setReady] = useState(false);
  const latest = useRef(state);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // A write or a change from another page is newer than the first read, which then loses.
  const settled = useRef(false);
  // After a failed read the defaults are only a stand-in: never write them over the real record.
  const readFailed = useRef(false);

  const accept = useCallback((next: WorkingCardState) => {
    settled.current = true;
    latest.current = next;
    setState(next);
    setReady(true);
  }, []);

  useEffect(() => {
    let active = true;
    void loadWorkingCard(storageRef.current)
      .catch(() => {
        readFailed.current = true;
        return { ...DEFAULT_WORKING_CARD, notes: [], plans: [] };
      })
      .then((loaded) => {
        if (!active) return;
        if (settled.current) setReady(true);
        else accept(loaded);
      });
    const onChanged = chromeStorageChanged();
    const listener: StorageChangeListener = (changes, areaName) => {
      if (areaName !== 'local' || !(WORKING_CARD_STORAGE_KEY in changes)) return;
      readFailed.current = false;
      accept(normalizeWorkingCardState(changes[WORKING_CARD_STORAGE_KEY]?.newValue));
    };
    onChanged?.addListener(listener);
    return () => {
      active = false;
      onChanged?.removeListener(listener);
    };
  }, [accept]);

  const update = useCallback(
    (change: (state: WorkingCardState) => WorkingCardState) => {
      const run = queue.current.then(async () => {
        if (readFailed.current) {
          latest.current = await loadWorkingCard(storageRef.current);
          readFailed.current = false;
        }
        const next = change(latest.current);
        if (next === latest.current) return;
        await saveWorkingCard(next, storageRef.current);
        accept(next);
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [accept],
  );

  return { ready, state, update };
}

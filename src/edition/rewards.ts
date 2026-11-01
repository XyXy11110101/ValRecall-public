import { useSyncExternalStore } from 'react';

// Rewards are off until someone turns them on. Off hides them, while the ledger keeps recording,
// so turning them on later shows the true total. This has its own key because any change to
// valrecall.preferences re-runs the reminders.
export const REWARDS_STORAGE_KEY = 'valrecall.rewards';

/** Unknown only until the stored choice has been read. It hides rewards, like off. */
export type RewardsState = 'unknown' | 'on' | 'off';

let current: RewardsState = 'unknown';
const listeners = new Set<() => void>();

function localStorageArea(): chrome.storage.LocalStorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;
}

function show(next: RewardsState): void {
  current = next;
  if (next === 'unknown') delete document.documentElement.dataset.rewards;
  else document.documentElement.dataset.rewards = next;
  for (const listener of listeners) listener();
}

function fromStored(value: unknown): RewardsState {
  return value === true ? 'on' : 'off';
}

/** For plain functions that build a sentence. The phone never starts this, so it stays false. */
export function rewardsVisible(): boolean {
  return current === 'on';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRewardsState(): RewardsState {
  return useSyncExternalStore(subscribe, () => current);
}

export function useRewardsVisible(): boolean {
  return useRewardsState() === 'on';
}

/** Reads the choice and follows it, in this page or another. Returns how to stop. */
export async function startRewards(): Promise<() => void> {
  const events = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
  const handle = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const change = changes[REWARDS_STORAGE_KEY];
    if (area === 'local' && change) show(fromStored(change.newValue));
  };
  events?.addListener(handle);
  try {
    const stored = await localStorageArea()?.get(REWARDS_STORAGE_KEY);
    show(fromStored(stored?.[REWARDS_STORAGE_KEY]));
  } catch {
    show('off');
  }
  return () => {
    events?.removeListener(handle);
    show('unknown');
  };
}

/** Throws if the choice could not be stored, so the switch can say so and stay as it was. */
export async function saveRewardsEnabled(enabled: boolean): Promise<void> {
  await localStorageArea()?.set({ [REWARDS_STORAGE_KEY]: enabled });
  show(enabled ? 'on' : 'off');
}

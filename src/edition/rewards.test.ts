import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REWARDS_STORAGE_KEY,
  rewardsVisible,
  saveRewardsEnabled,
  startRewards,
  type RewardsState,
} from './rewards';

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function stubStorage(stored: Record<string, unknown> = {}) {
  const listeners = new Set<ChangeListener>();
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(stored, values);
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async () => stored), set },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.add(listener),
        removeListener: (listener: ChangeListener) => listeners.delete(listener),
      },
    },
  });
  return { set, listeners };
}

const attribute = () => document.documentElement.dataset.rewards as RewardsState | undefined;

describe('rewards switch', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  });

  it('hides rewards before the choice is read', () => {
    expect(rewardsVisible()).toBe(false);
    expect(attribute()).toBeUndefined();
  });

  it('is off for someone who never chose', async () => {
    stubStorage();
    stop = await startRewards();
    expect(rewardsVisible()).toBe(false);
    expect(attribute()).toBe('off');
  });

  it.each(['true', 1, 'on', null, {}])('treats a stored %j as off', async (stored) => {
    stubStorage({ [REWARDS_STORAGE_KEY]: stored });
    stop = await startRewards();
    expect(rewardsVisible()).toBe(false);
  });

  it('is on only after it was turned on', async () => {
    stubStorage({ [REWARDS_STORAGE_KEY]: true });
    stop = await startRewards();
    expect(rewardsVisible()).toBe(true);
    expect(attribute()).toBe('on');
  });

  it('stays off when the choice cannot be read', async () => {
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn().mockRejectedValue(new Error('no')) } },
    });
    stop = await startRewards();
    expect(rewardsVisible()).toBe(false);
    expect(attribute()).toBe('off');
  });

  it('stores only its own key, so the reminders do not re-run', async () => {
    const { set } = stubStorage();
    stop = await startRewards();
    await saveRewardsEnabled(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ 'valrecall.rewards': true });
    expect(rewardsVisible()).toBe(true);
    await saveRewardsEnabled(false);
    expect(rewardsVisible()).toBe(false);
    expect(attribute()).toBe('off');
  });

  it('keeps the old state when the choice cannot be stored', async () => {
    const { set } = stubStorage();
    stop = await startRewards();
    set.mockRejectedValueOnce(new Error('full'));
    await expect(saveRewardsEnabled(true)).rejects.toThrow('full');
    expect(rewardsVisible()).toBe(false);
  });

  it('follows a change made in another page, and only that key in local storage', async () => {
    const { listeners } = stubStorage();
    stop = await startRewards();
    const change = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      for (const listener of listeners) listener(changes, area);
    };
    change({ other: { newValue: true } }, 'local');
    change({ [REWARDS_STORAGE_KEY]: { newValue: true } }, 'sync');
    expect(rewardsVisible()).toBe(false);
    change({ [REWARDS_STORAGE_KEY]: { newValue: true } }, 'local');
    expect(rewardsVisible()).toBe(true);
    change({ [REWARDS_STORAGE_KEY]: {} }, 'local');
    expect(rewardsVisible()).toBe(false);
  });
});

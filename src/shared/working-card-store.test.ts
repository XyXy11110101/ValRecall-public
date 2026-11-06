import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKING_CARD, WORKING_CARD_STORAGE_KEY } from '../models/working-card';
import {
  clearWorkingCard,
  forgetDeletedTask,
  loadWorkingCard,
  saveWorkingCard,
  type WorkingCardStorage,
} from './working-card-store';

function memory(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const storage: WorkingCardStorage = {
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(values, items)),
    remove: vi.fn(async (key: string) => void delete values[key]),
  };
  return { values, storage };
}

describe('working card storage', () => {
  it('reads the defaults with no storage, nothing stored, or a corrupt value', async () => {
    expect(await loadWorkingCard(null)).toEqual({ ...DEFAULT_WORKING_CARD, notes: [], plans: [] });
    expect(await loadWorkingCard(memory().storage)).toEqual({
      ...DEFAULT_WORKING_CARD,
      notes: [],
      plans: [],
    });
    expect(
      await loadWorkingCard(memory({ [WORKING_CARD_STORAGE_KEY]: 'corrupt' }).storage),
    ).toEqual({ ...DEFAULT_WORKING_CARD, notes: [], plans: [] });
  });

  it('round-trips a saved state under its own key', async () => {
    const { storage, values } = memory();
    const state = {
      ...DEFAULT_WORKING_CARD,
      notes: [],
      plans: [],
      current: { taskId: 'a', startedOn: '2026-10-30' },
    };
    await saveWorkingCard(state, storage);
    expect(Object.keys(values)).toEqual([WORKING_CARD_STORAGE_KEY]);
    expect(await loadWorkingCard(storage)).toEqual(state);
  });

  it('clears the key', async () => {
    const { storage, values } = memory({ [WORKING_CARD_STORAGE_KEY]: { version: 1 } });
    await clearWorkingCard(storage);
    expect(values).toEqual({});
  });

  it('forgets a deleted task, and a storage failure never fails the delete', async () => {
    const { storage, values } = memory({
      [WORKING_CARD_STORAGE_KEY]: {
        version: 1,
        current: { taskId: 'a', startedOn: '2026-10-30' },
        notes: [{ taskId: 'a', text: 'secret', date: '2026-10-30' }],
        plans: [
          {
            taskId: 'a',
            date: '2026-10-30',
            start: '14:00',
            end: '',
            deliverable: 'secret',
            criteria: '',
          },
        ],
      },
    });
    await forgetDeletedTask('a', storage);
    expect(values[WORKING_CARD_STORAGE_KEY]).toMatchObject({
      current: null,
      notes: [],
      plans: [],
    });
    const broken: WorkingCardStorage = {
      ...storage,
      get: vi.fn().mockRejectedValue(new Error('no storage')),
    };
    await expect(forgetDeletedTask('a', broken)).resolves.toBeUndefined();
  });
});

// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  ALLOWANCE_STORAGE_KEY,
  loadAllowance,
  recordSuccessfulCapture,
  recordSuccessfulIntake,
} from '../shared/allowance';
afterEach(() => vi.unstubAllGlobals());
it('three questions earn six and one daily check-in, with concurrent capture serialized', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  let value: unknown;
  const set = vi.fn(async (input: Record<string, unknown>) => {
    value = input[ALLOWANCE_STORAGE_KEY];
  });
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ [ALLOWANCE_STORAGE_KEY]: value }), set } },
  });
  const day = new Date(2026, 9, 1, 23, 59);
  const results = await Promise.all([
    recordSuccessfulIntake(0, 3, day),
    recordSuccessfulCapture(day),
  ]);
  expect(results[0]).toMatchObject({ amount: 11, checkInReward: 5 });
  expect((await loadAllowance()).balance).toBe(13);
  const state = await loadAllowance();
  expect(state.ledger.filter((row) => row.source === 'manual')).toEqual([]);
  expect(state.ledger.filter((row) => row.note === '接收笔记')).toEqual([]);
  expect(state.ledger.filter((row) => row.note === '保存回忆题')).toHaveLength(3);
  expect(await recordSuccessfulIntake(0, 0, new Date(2026, 9, 2))).toEqual({
    amount: 0,
    checkInReward: 0,
  });
  expect(set).not.toHaveBeenCalled();
  expect(value).toBeUndefined();
  expect(await recordSuccessfulIntake(0, 1, new Date(2026, 9, 2))).toEqual({
    amount: 7,
    checkInReward: 5,
  });
  expect((await loadAllowance()).balance).toBe(20);
  expect(set).not.toHaveBeenCalled();
});

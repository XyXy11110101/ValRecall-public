import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  applyCaptureReward,
  applyManualMomentReward,
  applyReviewItemReward,
  applyReviewSession,
  applyTaskCompletionReversal,
  applyTaskCompletionReward,
  CAPTURE_PRAISES,
  CAPTURE_REWARD,
  CHECK_IN_PRAISES,
  CHECK_IN_REWARD,
  MANUAL_MOMENT_REWARD,
  TASK_REWARD,
  DEFAULT_ALLOWANCE,
  addAllowance,
  formatAddConfirmation,
  formatSpendConfirmation,
  loadAllowance,
  MILESTONE_PRAISES,
  normalizeAllowance,
  recordSuccessfulCapture,
  REVIEW_MILESTONE_REWARDS,
  saveAllowance,
  spendAllowance,
  spendStoredAllowance,
  type AllowanceState,
} from './allowance';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(stored: unknown = undefined) {
  const get = vi.fn(async () => ({ 'valrecall.allowance': stored }));
  const set = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { get, set };
}

it('persists the unified wallet in native IndexedDB without extension storage', async () => {
  vi.stubGlobal('chrome', undefined);
  await expect(saveAllowance(DEFAULT_ALLOWANCE)).resolves.toBeUndefined();
  await expect(loadAllowance()).resolves.toEqual(DEFAULT_ALLOWANCE);
});

function withBalance(balance: number, extra: Partial<AllowanceState> = {}): AllowanceState {
  return {
    ...DEFAULT_ALLOWANCE,
    balance,
    totalEarned: extra.totalEarned ?? balance,
    ...extra,
  };
}

describe('allowance praise copy', () => {
  it('includes 你 in every capture, check-in, milestone, and spend line', () => {
    for (const line of CAPTURE_PRAISES) expect(line).toBeTruthy();
    for (const line of CHECK_IN_PRAISES) expect(line).toBeTruthy();
    for (const line of Object.values(MILESTONE_PRAISES)) expect(line).toBeTruthy();
    expect(formatSpendConfirmation(4)).toBeTruthy();
    expect(formatSpendConfirmation(4, 'coffee')).toBeTruthy();
    expect(formatAddConfirmation(3)).toBeTruthy();
    expect(formatAddConfirmation(3, 'gift')).toBeTruthy();
  });
});

describe('normalizeAllowance', () => {
  it('returns zeros for missing or malformed storage', () => {
    expect(normalizeAllowance(undefined)).toEqual(DEFAULT_ALLOWANCE);
    expect(normalizeAllowance(null)).toEqual(DEFAULT_ALLOWANCE);
    expect(
      normalizeAllowance({
        balance: -3,
        currentStreak: '2',
        lastCheckInDate: 'yesterday',
        reviewStreak: Number.NaN,
        lastReviewSessionDate: '2026-13-01',
        totalEarned: true,
        totalSpent: 1.8,
        lastCapturePraiseIndex: -1,
      }),
    ).toEqual({
      ...DEFAULT_ALLOWANCE,
      totalSpent: 1,
    });
  });
});

describe('applyCaptureReward', () => {
  it('starts from zero, awards +2 and first-day check-in +5, and rotates praise', () => {
    const first = applyCaptureReward(DEFAULT_ALLOWANCE, '2026-08-25');
    expect(first.captureReward).toBe(CAPTURE_REWARD);
    expect(first.checkIn).toBe(true);
    expect(first.checkInReward).toBe(CHECK_IN_REWARD);
    expect(first.praise).toBe(CAPTURE_PRAISES[0]);
    expect(first.checkInPraise).toBe(CHECK_IN_PRAISES[0]);
    expect(first.state).toMatchObject({
      balance: 7,
      currentStreak: 1,
      lastCheckInDate: '2026-08-25',
      totalEarned: 7,
      lastCapturePraiseIndex: 1,
    });

    const second = applyCaptureReward(first.state, '2026-08-25');
    expect(second.checkIn).toBe(false);
    expect(second.checkInReward).toBe(0);
    expect(second.checkInPraise).toBeNull();
    expect(second.praise).toBe(CAPTURE_PRAISES[1]);
    expect(second.state.balance).toBe(9);
    expect(second.state.currentStreak).toBe(1);
    expect(second.state.totalEarned).toBe(9);
  });

  it('continues a strict streak across consecutive local days and resets after a gap', () => {
    const dayOne = applyCaptureReward(DEFAULT_ALLOWANCE, '2026-08-25').state;
    const dayTwo = applyCaptureReward(dayOne, '2026-08-26');
    expect(dayTwo.checkIn).toBe(true);
    expect(dayTwo.checkInPraise).toBe(CHECK_IN_PRAISES[1]);
    expect(dayTwo.state.currentStreak).toBe(2);
    expect(dayTwo.state.balance).toBe(14);

    const afterGap = applyCaptureReward(dayTwo.state, '2026-08-28');
    expect(afterGap.state.currentStreak).toBe(1);
    expect(afterGap.state.lastCheckInDate).toBe('2026-08-28');
    expect(afterGap.state.balance).toBe(21);
  });

  it('does not award a second check-in when Review already checked in today', () => {
    const reviewed = applyReviewSession(DEFAULT_ALLOWANCE, '2026-08-25');
    expect(reviewed.state.balance).toBe(5);
    const captured = applyCaptureReward(reviewed.state, '2026-08-25');
    expect(captured.checkIn).toBe(false);
    expect(captured.state.balance).toBe(7);
    expect(captured.state.currentStreak).toBe(1);
  });

  it('records capture and check-in as newest-first ledger rows', () => {
    const captured = applyCaptureReward(DEFAULT_ALLOWANCE, '2026-08-25');
    expect(captured.state.ledger.map((row) => row.source)).toEqual(['check-in', 'capture']);
    expect(captured.state.ledger[0]).toMatchObject({
      kind: 'earn',
      amount: CHECK_IN_REWARD,
      note: '每日打卡',
      balanceAfter: 7,
    });
    expect(captured.state.ledger[1]).toMatchObject({
      kind: 'earn',
      amount: CAPTURE_REWARD,
      note: '保存 Moment',
      balanceAfter: 2,
    });
  });
});

describe('applyReviewSession', () => {
  it('checks in, tracks a separate review streak, and grants a milestone only when the streak lands exactly', () => {
    let state = DEFAULT_ALLOWANCE;
    const dates = ['2026-08-21', '2026-08-22', '2026-08-23'];
    const results = dates.map((today) => {
      const result = applyReviewSession(state, today);
      state = result.state;
      return result;
    });

    expect(results[0]?.checkIn).toBe(true);
    expect(results[0]?.milestone).toBeNull();
    expect(results[2]?.milestone).toBe(3);
    expect(results[2]?.milestoneReward).toBe(REVIEW_MILESTONE_REWARDS[3]);
    expect(results[2]?.milestonePraise).toBe(MILESTONE_PRAISES[3]);
    expect(state).toMatchObject({
      currentStreak: 3,
      reviewStreak: 3,
      lastReviewSessionDate: '2026-08-23',
      balance: 5 * 3 + 10,
      totalEarned: 25,
    });
  });

  it('does not repeat check-in, review-streak, or milestone on a second session the same day', () => {
    const first = applyReviewSession(DEFAULT_ALLOWANCE, '2026-08-25');
    const second = applyReviewSession(first.state, '2026-08-25');
    expect(second.checkIn).toBe(false);
    expect(second.milestone).toBeNull();
    expect(second.state).toEqual(first.state);
  });

  it('re-grants a milestone after a broken streak reaches the same day count again', () => {
    let state = DEFAULT_ALLOWANCE;
    for (const today of ['2026-08-21', '2026-08-22', '2026-08-23']) {
      state = applyReviewSession(state, today).state;
    }
    expect(state.balance).toBe(25);

    const broken = applyReviewSession(state, '2026-08-25');
    expect(broken.milestone).toBeNull();
    expect(broken.state.reviewStreak).toBe(1);
    state = broken.state;

    state = applyReviewSession(state, '2026-08-26').state;
    const again = applyReviewSession(state, '2026-08-27');
    expect(again.milestone).toBe(3);
    expect(again.milestoneReward).toBe(10);
    expect(again.state.reviewStreak).toBe(3);
    expect(again.state.balance).toBe(25 + 5 + 5 + 5 + 10);
  });

  it('keeps capture-only days out of the review milestone streak', () => {
    let state = DEFAULT_ALLOWANCE;
    state = applyCaptureReward(state, '2026-08-21').state;
    state = applyCaptureReward(state, '2026-08-22').state;
    state = applyCaptureReward(state, '2026-08-23').state;
    const reviewed = applyReviewSession(state, '2026-08-23');
    expect(reviewed.state.currentStreak).toBe(3);
    expect(reviewed.state.reviewStreak).toBe(1);
    expect(reviewed.milestone).toBeNull();
  });
});

describe('applyReviewItemReward', () => {
  it('adds one for a persisted rating while leaving daily and session streaks untouched', () => {
    const before = withBalance(-2, {
      totalEarned: 4,
      currentStreak: 2,
      reviewStreak: 1,
      lastCheckInDate: '2026-08-24',
      lastReviewSessionDate: '2026-08-24',
    });
    const first = applyReviewItemReward(before, '2026-08-25');
    expect(first.reward).toBe(1);
    expect(first.state).toMatchObject({
      balance: -1,
      totalEarned: 5,
      currentStreak: 2,
      reviewStreak: 1,
      lastCheckInDate: '2026-08-24',
      lastReviewSessionDate: '2026-08-24',
    });
    expect(first.state.ledger[0]).toMatchObject({
      kind: 'earn',
      source: 'milestone',
      amount: 1,
      note: '完成一道回忆题 +1',
      balanceAfter: -1,
    });
    expect(normalizeAllowance(first.state)).toEqual(first.state);
    expect(before.balance).toBe(-2);
  });
});

describe('applyManualMomentReward', () => {
  it('awards +3 for a manually authored Moment without touching check-in or review streaks', () => {
    const first = applyManualMomentReward(DEFAULT_ALLOWANCE, '2026-08-25');
    expect(first.reward).toBe(MANUAL_MOMENT_REWARD);
    expect(first.state).toMatchObject({
      balance: 3,
      totalEarned: 3,
      lastCheckInDate: null,
      reviewStreak: 0,
    });
    expect(first.state.ledger[0]).toMatchObject({
      kind: 'earn',
      source: 'manual',
      amount: 3,
      note: '手动添加 Moment',
      balanceAfter: 3,
    });
    expect(normalizeAllowance(first.state).ledger[0]?.source).toBe('manual');

    const captured = applyCaptureReward(first.state, '2026-08-25');
    expect(captured.captureReward).toBe(CAPTURE_REWARD);
    expect(captured.state.balance).toBe(10);
  });
});

describe('applyTaskCompletionReward', () => {
  it('awards +5 for each completed daily-plan item without touching check-in or review streaks', () => {
    const first = applyTaskCompletionReward(DEFAULT_ALLOWANCE, '2026-08-25');
    expect(first.reward).toBe(TASK_REWARD);
    expect(first.state).toMatchObject({
      balance: 5,
      totalEarned: 5,
      lastCheckInDate: null,
      reviewStreak: 0,
    });
    expect(first.state.ledger[0]).toMatchObject({
      kind: 'earn',
      source: 'task',
      amount: 5,
      note: '完成今日计划',
      balanceAfter: 5,
    });

    const second = applyTaskCompletionReward(first.state, '2026-08-25');
    expect(second.state.balance).toBe(10);
    expect(second.state.ledger).toHaveLength(2);
    expect(second.state.lastCheckInDate).toBeNull();
    expect(normalizeAllowance(second.state).ledger[0]?.source).toBe('task');
  });

  it('reverses the +5 when a completion is undone, without counting it as a spend total', () => {
    const awarded = applyTaskCompletionReward(DEFAULT_ALLOWANCE, '2026-08-25').state;
    const reversed = applyTaskCompletionReversal(awarded, '2026-08-25');
    expect(reversed.state.balance).toBe(0);
    expect(reversed.state.totalEarned).toBe(0);
    expect(reversed.state.totalSpent).toBe(0);
    expect(reversed.state.ledger[0]).toMatchObject({
      kind: 'spend',
      source: 'task',
      amount: 5,
      note: '撤销完成任务',
      balanceAfter: 0,
    });
  });

  it("reverses the supplied historical grant rather than today's task rate", () => {
    const state = { ...DEFAULT_ALLOWANCE, balance: 12, totalEarned: 12 };
    const reversed = applyTaskCompletionReversal(
      state,
      '2026-08-25',
      '2026-08-25T12:00:00.000Z',
      2,
    );
    expect(reversed.reward).toBe(2);
    expect(reversed.state.balance).toBe(10);
    expect(reversed.state.totalEarned).toBe(10);
    expect(reversed.state.ledger[0]?.amount).toBe(2);
    expect(state.balance).toBe(12);
  });
});

describe('addAllowance', () => {
  it('adds a whole number and records a manual-add ledger row', () => {
    const added = addAllowance(withBalance(4, { totalEarned: 4 }), 3, {
      note: '  gift  ',
      at: '2026-08-26T12:00:00.000Z',
      date: '2026-08-26',
    });
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.value.balance).toBe(7);
      expect(added.value.totalEarned).toBe(7);
      expect(added.value.totalSpent).toBe(0);
      expect(added.value.ledger[0]).toMatchObject({
        kind: 'earn',
        source: 'add',
        amount: 3,
        note: 'gift',
        balanceAfter: 7,
      });
    }
    expect(formatAddConfirmation(3, 'gift')).toBe('手动加入了 3 零花钱。gift');
  });
});

describe('spendAllowance', () => {
  it('rejects non-positive, non-integer, and oversized amounts without mutating state', () => {
    const state = withBalance(10);
    expect(spendAllowance(state, 0).ok).toBe(false);
    expect(spendAllowance(state, -2).ok).toBe(false);
    expect(spendAllowance(state, 1.5).ok).toBe(false);
    expect(spendAllowance(state, Number.NaN).ok).toBe(false);
    const overspend = spendAllowance(state, 11);
    expect(overspend.ok).toBe(false);
    if (!overspend.ok) {
      expect(overspend.error.code).toBe('INSUFFICIENT_BALANCE');
    }
    expect(state.balance).toBe(10);
  });

  it('subtracts a valid amount and records totalSpent', () => {
    const spent = spendAllowance(withBalance(10, { totalSpent: 3 }), 4);
    expect(spent.ok).toBe(true);
    if (spent.ok) {
      expect(spent.value.balance).toBe(6);
      expect(spent.value.totalSpent).toBe(7);
    }
    expect(formatSpendConfirmation(4, '  tea  ')).toBe('花掉了 4 零花钱。tea');
  });

  it('appends a spend ledger row when date and time are provided', () => {
    const spent = spendAllowance(withBalance(10), 4, {
      note: '  tea  ',
      at: '2026-08-26T12:00:00.000Z',
      date: '2026-08-26',
    });
    expect(spent.ok).toBe(true);
    if (spent.ok) {
      expect(spent.value.ledger).toHaveLength(1);
      expect(spent.value.ledger[0]).toMatchObject({
        kind: 'spend',
        source: 'spend',
        amount: 4,
        note: 'tea',
        date: '2026-08-26',
        balanceAfter: 6,
      });
    }
  });
});

describe('allowance storage', () => {
  it('loads defaults when chrome storage is absent', async () => {
    await expect(loadAllowance()).resolves.toEqual(DEFAULT_ALLOWANCE);
  });

  it('migrates a legacy record once and leaves chrome.storage.local read-only', async () => {
    const { set } = stubStorage({
      balance: 12,
      currentStreak: 2,
      lastCheckInDate: '2026-08-25',
      reviewStreak: 2,
      lastReviewSessionDate: '2026-08-25',
      totalEarned: 14,
      totalSpent: 2,
      lastCapturePraiseIndex: 3,
    });
    const loaded = await loadAllowance();
    expect(loaded.balance).toBe(12);
    await saveAllowance(loaded);
    expect(set).not.toHaveBeenCalled();
    await expect(loadAllowance()).resolves.toEqual(loaded);
  });

  it('records a capture through storage and spends from the stored balance', async () => {
    const stored: { value: unknown } = { value: undefined };
    const get = vi.fn(async () => ({ 'valrecall.allowance': stored.value }));
    const set = vi.fn(async (payload: Record<string, unknown>) => {
      stored.value = payload['valrecall.allowance'];
    });
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });

    const captured = await recordSuccessfulCapture(new Date(2026, 7, 25, 9));
    expect(captured.state.balance).toBe(7);
    const spent = await spendStoredAllowance(3);
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(spent.value.balance).toBe(4);
  });
});

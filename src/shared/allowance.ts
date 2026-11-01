import { addLocalCalendarDays, isLocalDateKey, localDateKey } from '../models/daily-task';
import { err, ok, type Result } from './result';

export const ALLOWANCE_STORAGE_KEY = 'valrecall.allowance';
export const ALLOWANCE_SCHEMA_VERSION = 2 as const;
export const ALLOWANCE_LEDGER_LIMIT = 200;

export const CAPTURE_REWARD = 2;
export const MANUAL_MOMENT_REWARD = 3;
export const TASK_REWARD = 5;
export const TASK_CREATION_REWARD = 5;
export const LEGACY_TASK_REWARD = 2;
export const CHECK_IN_REWARD = 5;
export const REVIEW_ITEM_REWARD = 1;
export const REVIEW_MILESTONE_REWARDS = {
  3: 10,
  7: 20,
  14: 35,
  30: 60,
} as const;

export type ReviewMilestoneDay = keyof typeof REVIEW_MILESTONE_REWARDS;

export const CAPTURE_PRAISES = [
  '又记下一个知识点。',
  '这一条记好了。',
  '这一条值得记住。',
  '又存下来了，继续保持。',
  '又进步了一点。',
  '记下来了。到时间会提醒你复习。',
] as const;

export const CHECK_IN_PRAISES = ['今天已打卡。', '连续学习的习惯越来越稳了。'] as const;

export const TASK_PRAISES = [
  '又完成一件。',
  '说到做到。',
  '又划掉一项。',
  '今天的行动不错。',
  '完成啦，离今天的目标更近了。',
] as const;

export const TASK_ALL_DONE_PRAISES = ['今天的待办全完成了，辛苦了。', '今天全部搞定了。'] as const;

export const TASK_LATE_PRAISES = ['补上了，没有落下它。'] as const;

export const MILESTONE_PRAISES: Readonly<Record<ReviewMilestoneDay, string>> = {
  3: '已经连续复习 3 天了。',
  7: '已经连续复习一整周了。',
  14: '十四天都没有落下复习。',
  30: '已经连续复习 30 天了。',
};

export type AllowanceLedgerKind = 'earn' | 'spend';
export type AllowanceLedgerSource =
  'capture' | 'manual' | 'add' | 'check-in' | 'milestone' | 'task' | 'spend';

export interface AllowanceLedgerEntry {
  id: string;
  at: string;
  date: string;
  kind: AllowanceLedgerKind;
  source: AllowanceLedgerSource;
  amount: number;
  note: string;
  balanceAfter: number;
}

export interface AllowanceState {
  schemaVersion: typeof ALLOWANCE_SCHEMA_VERSION;
  balance: number;
  currentStreak: number;
  lastCheckInDate: string | null;
  reviewStreak: number;
  lastReviewSessionDate: string | null;
  totalEarned: number;
  totalSpent: number;
  lastCapturePraiseIndex: number;
  ledgerSeq: number;
  ledger: AllowanceLedgerEntry[];
}

export const DEFAULT_ALLOWANCE: AllowanceState = {
  schemaVersion: ALLOWANCE_SCHEMA_VERSION,
  balance: 0,
  currentStreak: 0,
  lastCheckInDate: null,
  reviewStreak: 0,
  lastReviewSessionDate: null,
  totalEarned: 0,
  totalSpent: 0,
  lastCapturePraiseIndex: 0,
  ledgerSeq: 0,
  ledger: [],
};

export interface CaptureAllowanceResult {
  state: AllowanceState;
  captureReward: typeof CAPTURE_REWARD;
  checkIn: boolean;
  checkInReward: number;
  praise: string;
  checkInPraise: string | null;
}

export interface ReviewAllowanceResult {
  state: AllowanceState;
  checkIn: boolean;
  checkInReward: number;
  checkInPraise: string | null;
  reviewStreak: number;
  milestone: ReviewMilestoneDay | null;
  milestoneReward: number;
  milestonePraise: string | null;
}

export interface TaskAllowanceResult {
  state: AllowanceState;
  /** Actual grant/reversal amount; historical completions may have a different rate. */
  reward: number;
}

export interface ManualMomentAllowanceResult {
  state: AllowanceState;
  reward: typeof MANUAL_MOMENT_REWARD;
}

export function isReviewMilestoneDay(value: number): value is ReviewMilestoneDay {
  return value === 3 || value === 7 || value === 14 || value === 30;
}

export function normalizeAllowance(value: unknown): AllowanceState {
  const record = isRecord(value) ? value : {};
  const ledger = asLedger(record.ledger, record.schemaVersion === 2);
  return {
    schemaVersion: ALLOWANCE_SCHEMA_VERSION,
    balance:
      record.schemaVersion === 2
        ? asSignedInteger(record.balance, 0)
        : asNonNegativeInteger(record.balance, 0),
    currentStreak: asNonNegativeInteger(record.currentStreak, 0),
    lastCheckInDate: asLocalDate(record.lastCheckInDate),
    reviewStreak: asNonNegativeInteger(record.reviewStreak, 0),
    lastReviewSessionDate: asLocalDate(record.lastReviewSessionDate),
    totalEarned: asNonNegativeInteger(record.totalEarned, 0),
    totalSpent: asNonNegativeInteger(record.totalSpent, 0),
    lastCapturePraiseIndex: asNonNegativeInteger(record.lastCapturePraiseIndex, 0),
    ledgerSeq: Math.max(asNonNegativeInteger(record.ledgerSeq, 0), ledger.length),
    ledger,
  };
}

export function applyCaptureReward(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): CaptureAllowanceResult {
  requireLocalDate(today);
  const praiseIndex = state.lastCapturePraiseIndex % CAPTURE_PRAISES.length;
  const praise = CAPTURE_PRAISES[praiseIndex] ?? CAPTURE_PRAISES[0];
  const afterCapture = appendLedger(
    {
      ...state,
      balance: state.balance + CAPTURE_REWARD,
      totalEarned: state.totalEarned + CAPTURE_REWARD,
      lastCapturePraiseIndex: praiseIndex + 1,
    },
    {
      at,
      date: today,
      kind: 'earn',
      source: 'capture',
      amount: CAPTURE_REWARD,
      note: '保存 Moment',
      balanceAfter: state.balance + CAPTURE_REWARD,
    },
  );
  const checkIn = applyDailyCheckIn(afterCapture, today, at);
  return {
    state: checkIn.state,
    captureReward: CAPTURE_REWARD,
    checkIn: checkIn.applied,
    checkInReward: checkIn.reward,
    praise,
    checkInPraise: checkIn.praise,
  };
}

export function applyReviewSession(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): ReviewAllowanceResult {
  requireLocalDate(today);
  const checkIn = applyDailyCheckIn(state, today, at);
  let next = checkIn.state;
  let milestone: ReviewMilestoneDay | null = null;
  let milestoneReward = 0;
  let milestonePraise: string | null = null;

  if (next.lastReviewSessionDate !== today) {
    const consecutive =
      next.lastReviewSessionDate !== null &&
      next.lastReviewSessionDate === addLocalCalendarDays(today, -1);
    const reviewStreak = consecutive ? next.reviewStreak + 1 : 1;
    next = {
      ...next,
      reviewStreak,
      lastReviewSessionDate: today,
    };
    if (isReviewMilestoneDay(reviewStreak)) {
      milestone = reviewStreak;
      milestoneReward = REVIEW_MILESTONE_REWARDS[reviewStreak];
      milestonePraise = MILESTONE_PRAISES[reviewStreak];
      const balanceAfter = next.balance + milestoneReward;
      next = appendLedger(
        {
          ...next,
          balance: balanceAfter,
          totalEarned: next.totalEarned + milestoneReward,
        },
        {
          at,
          date: today,
          kind: 'earn',
          source: 'milestone',
          amount: milestoneReward,
          note: `连续复习 ${reviewStreak} 天`,
          balanceAfter,
        },
      );
    }
  }

  return {
    state: next,
    checkIn: checkIn.applied,
    checkInReward: checkIn.reward,
    checkInPraise: checkIn.praise,
    reviewStreak: next.reviewStreak,
    milestone,
    milestoneReward,
    milestonePraise,
  };
}

/** A successful rating earns once through its durable review-step receipt. */
export function applyReviewItemReward(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): { state: AllowanceState; reward: typeof REVIEW_ITEM_REWARD } {
  requireLocalDate(today);
  const balanceAfter = state.balance + REVIEW_ITEM_REWARD;
  return {
    state: appendLedger(
      {
        ...state,
        balance: balanceAfter,
        totalEarned: state.totalEarned + REVIEW_ITEM_REWARD,
      },
      {
        at,
        date: today,
        kind: 'earn',
        // Existing learning-achievement category keeps older phone wallets readable.
        source: 'milestone',
        amount: REVIEW_ITEM_REWARD,
        note: '完成一道回忆题 +1',
        balanceAfter,
      },
    ),
    reward: REVIEW_ITEM_REWARD,
  };
}

export function applyManualMomentReward(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): ManualMomentAllowanceResult {
  requireLocalDate(today);
  const balanceAfter = state.balance + MANUAL_MOMENT_REWARD;
  return {
    state: appendLedger(
      {
        ...state,
        balance: balanceAfter,
        totalEarned: state.totalEarned + MANUAL_MOMENT_REWARD,
      },
      {
        at,
        date: today,
        kind: 'earn',
        source: 'manual',
        amount: MANUAL_MOMENT_REWARD,
        note: '手动添加 Moment',
        balanceAfter,
      },
    ),
    reward: MANUAL_MOMENT_REWARD,
  };
}

export function applyTaskCreationReward(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): TaskAllowanceResult {
  return applyTaskReward(state, today, at, TASK_CREATION_REWARD, '创建待办');
}

export function applyTaskCompletionReward(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
): TaskAllowanceResult {
  return applyTaskReward(state, today, at, TASK_REWARD, '完成今日计划');
}

function applyTaskReward(
  state: AllowanceState,
  today: string,
  at: string,
  amount: number,
  note: string,
): TaskAllowanceResult {
  requireLocalDate(today);
  const balanceAfter = state.balance + amount;
  return {
    state: appendLedger(
      {
        ...state,
        balance: balanceAfter,
        totalEarned: state.totalEarned + amount,
      },
      {
        at,
        date: today,
        kind: 'earn',
        source: 'task',
        amount,
        note,
        balanceAfter,
      },
    ),
    reward: amount,
  };
}

export function applyTaskCompletionReversal(
  state: AllowanceState,
  today: string,
  at = `${today}T00:00:00.000Z`,
  rewardAmount: number = TASK_REWARD,
): TaskAllowanceResult {
  requireLocalDate(today);
  if (!Number.isSafeInteger(rewardAmount) || rewardAmount <= 0)
    throw new Error('任务奖励金额无效。');
  const deducted = rewardAmount;
  const earnedDeducted = Math.min(rewardAmount, state.totalEarned);
  const balanceAfter = state.balance - deducted;
  const next: AllowanceState = {
    ...state,
    balance: balanceAfter,
    totalEarned: state.totalEarned - earnedDeducted,
  };
  return {
    state: appendLedger(next, {
      at,
      date: today,
      kind: 'spend',
      source: 'task',
      amount: deducted,
      note: '撤销完成任务',
      balanceAfter,
    }),
    reward: rewardAmount,
  };
}

export function addAllowance(
  state: AllowanceState,
  amount: number,
  details: { note?: string; at?: string; date?: string } = {},
): Result<AllowanceState, { code: string; message: string }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    return err({
      code: 'INVALID_AMOUNT',
      message: '请输入大于 0 的整数。',
    });
  }
  const note = details.note?.trim() ?? '';
  const date = details.date && isLocalDateKey(details.date) ? details.date : null;
  const at = details.at?.trim() || (date ? `${date}T00:00:00.000Z` : '');
  const balanceAfter = state.balance + amount;
  const added: AllowanceState = {
    ...state,
    balance: balanceAfter,
    totalEarned: state.totalEarned + amount,
  };
  if (!date || at.length === 0) return ok(added);
  return ok(
    appendLedger(added, {
      at,
      date,
      kind: 'earn',
      source: 'add',
      amount,
      note: note.length > 0 ? note : '手动加入',
      balanceAfter,
    }),
  );
}

export function spendAllowance(
  state: AllowanceState,
  amount: number,
  details: { note?: string; at?: string; date?: string } = {},
): Result<AllowanceState, { code: string; message: string }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return err({
      code: 'INVALID_AMOUNT',
      message: '请输入大于 0 的整数。',
    });
  }
  if (amount > state.balance) {
    return err({
      code: 'INSUFFICIENT_BALANCE',
      message: '这个金额超过了当前零花钱。',
    });
  }
  const note = details.note?.trim() ?? '';
  const date = details.date && isLocalDateKey(details.date) ? details.date : null;
  const at = details.at?.trim() || (date ? `${date}T00:00:00.000Z` : '');
  const balanceAfter = state.balance - amount;
  const spent: AllowanceState = {
    ...state,
    balance: balanceAfter,
    totalSpent: state.totalSpent + amount,
  };
  if (!date || at.length === 0) return ok(spent);
  return ok(
    appendLedger(spent, {
      at,
      date,
      kind: 'spend',
      source: 'spend',
      amount,
      note,
      balanceAfter,
    }),
  );
}

export function formatSpendConfirmation(amount: number, note?: string): string {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0 ? `花掉了 ${amount} 零花钱。${trimmed}` : `花掉了 ${amount} 零花钱。`;
}

export function formatAddConfirmation(amount: number, note?: string): string {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0
    ? `手动加入了 ${amount} 零花钱。${trimmed}`
    : `手动加入了 ${amount} 零花钱。`;
}

export function reviewAllowanceLines(result: Omit<ReviewAllowanceResult, 'state'>): string[] {
  const lines: string[] = [];
  if (result.checkIn && result.checkInPraise) {
    lines.push(`${result.checkInPraise} +${result.checkInReward} 零花钱`);
  }
  if (result.milestone && result.milestonePraise) {
    lines.push(`${result.milestonePraise} +${result.milestoneReward} 零花钱`);
  }
  return lines;
}

export async function loadAllowance(): Promise<AllowanceState> {
  const { getDefaultWallet } = await import('../database/wallet');
  return getDefaultWallet().load();
}

export async function saveAllowance(state: AllowanceState): Promise<void> {
  const { getDefaultWallet } = await import('../database/wallet');
  await getDefaultWallet().update(() => ({ state, result: undefined }));
}

async function mutateAllowance<T>(
  operation: (state: AllowanceState) => { state: AllowanceState; result: T },
): Promise<T> {
  const { getDefaultWallet } = await import('../database/wallet');
  return getDefaultWallet().update(operation);
}

export function applyIntakeReward(
  current: AllowanceState,
  notes: number,
  questions: number,
  now: Date,
): { state: AllowanceState; result: { amount: number; checkInReward: number } } {
  if (
    ![notes, questions].every((count) => Number.isInteger(count) && count >= 0) ||
    notes + questions > 250
  )
    throw new Error('接收奖励数量无效。');
  let state = current;
  let checkInReward = 0;
  for (let index = 0; index < notes + questions; index++) {
    const reward = applyCaptureReward(state, localDateKey(now), now.toISOString());
    checkInReward += reward.checkInReward;
    // The existing capture reward is shared; ledger text identifies what was saved.
    state = {
      ...reward.state,
      ledger: reward.state.ledger.map((entry) =>
        entry.source === 'capture' &&
        entry.id === reward.state.ledger.find((row) => row.source === 'capture')?.id
          ? { ...entry, note: index < notes ? '接收笔记' : '保存回忆题' }
          : entry,
      ),
    };
  }
  return {
    state,
    result: { amount: (notes + questions) * CAPTURE_REWARD + checkInReward, checkInReward },
  };
}
export function recordSuccessfulIntake(
  notes: number,
  questions: number,
  now = new Date(),
): Promise<{ amount: number; checkInReward: number }> {
  return mutateAllowance((current) => applyIntakeReward(current, notes, questions, now));
}

export async function recordSuccessfulCapture(
  now: Date = new Date(),
): Promise<CaptureAllowanceResult> {
  return mutateAllowance((current) => {
    const today = localDateKey(now);
    const result = applyCaptureReward(current, today, now.toISOString());
    return { state: result.state, result };
  });
}

export async function recordSuccessfulReviewSession(
  now: Date = new Date(),
): Promise<ReviewAllowanceResult> {
  return mutateAllowance((current) => {
    const today = localDateKey(now);
    const result = applyReviewSession(current, today, now.toISOString());
    return { state: result.state, result };
  });
}

export async function recordSuccessfulManualMoment(
  now: Date = new Date(),
): Promise<ManualMomentAllowanceResult> {
  return mutateAllowance((current) => {
    const today = localDateKey(now);
    const result = applyManualMomentReward(current, today, now.toISOString());
    return { state: result.state, result };
  });
}

export async function recordSuccessfulTaskCompletion(
  now: Date = new Date(),
): Promise<TaskAllowanceResult> {
  return mutateAllowance((current) => {
    const today = localDateKey(now);
    const result = applyTaskCompletionReward(current, today, now.toISOString());
    return { state: result.state, result };
  });
}

export async function recordRevertedTaskCompletion(
  now: Date = new Date(),
): Promise<TaskAllowanceResult> {
  return mutateAllowance((current) => {
    const today = localDateKey(now);
    const result = applyTaskCompletionReversal(current, today, now.toISOString());
    return { state: result.state, result };
  });
}

export async function addStoredAllowance(
  amount: number,
  note = '',
  now: Date = new Date(),
): Promise<Result<AllowanceState, { code: string; message: string }>> {
  return mutateAllowance((current) => {
    const added = addAllowance(current, amount, {
      note,
      at: now.toISOString(),
      date: localDateKey(now),
    });
    return { state: added.ok ? added.value : current, result: added };
  });
}

export async function spendStoredAllowance(
  amount: number,
  note = '',
  now: Date = new Date(),
): Promise<Result<AllowanceState, { code: string; message: string }>> {
  return mutateAllowance((current) => {
    const spent = spendAllowance(current, amount, {
      note,
      at: now.toISOString(),
      date: localDateKey(now),
    });
    return { state: spent.ok ? spent.value : current, result: spent };
  });
}

export function allowanceLedgerLabel(entry: AllowanceLedgerEntry): string {
  if (entry.source === 'spend') return entry.note.length > 0 ? entry.note : '花掉';
  if (entry.source === 'add') return entry.note.length > 0 ? entry.note : '手动加入';
  if (entry.source === 'capture') return entry.note || '保存 Moment';
  if (entry.source === 'manual') return entry.note.length > 0 ? entry.note : '手动添加 Moment';
  if (entry.source === 'check-in') return '每日打卡';
  if (entry.source === 'task') {
    return entry.note.length > 0
      ? entry.note
      : entry.kind === 'spend'
        ? '撤销完成任务'
        : '完成今日计划';
  }
  return entry.note.length > 0 ? entry.note : '复习里程碑';
}

function applyDailyCheckIn(
  state: AllowanceState,
  today: string,
  at: string,
): {
  state: AllowanceState;
  applied: boolean;
  reward: number;
  praise: string | null;
} {
  if (state.lastCheckInDate === today) {
    return { state, applied: false, reward: 0, praise: null };
  }
  const consecutive =
    state.lastCheckInDate !== null && state.lastCheckInDate === addLocalCalendarDays(today, -1);
  const currentStreak = consecutive ? state.currentStreak + 1 : 1;
  const balanceAfter = state.balance + CHECK_IN_REWARD;
  return {
    state: appendLedger(
      {
        ...state,
        currentStreak,
        lastCheckInDate: today,
        balance: balanceAfter,
        totalEarned: state.totalEarned + CHECK_IN_REWARD,
      },
      {
        at,
        date: today,
        kind: 'earn',
        source: 'check-in',
        amount: CHECK_IN_REWARD,
        note: '每日打卡',
        balanceAfter,
      },
    ),
    applied: true,
    reward: CHECK_IN_REWARD,
    praise: currentStreak === 1 ? CHECK_IN_PRAISES[0] : CHECK_IN_PRAISES[1],
  };
}

function appendLedger(
  state: AllowanceState,
  entry: Omit<AllowanceLedgerEntry, 'id'>,
): AllowanceState {
  const ledgerSeq = state.ledgerSeq + 1;
  return {
    ...state,
    ledgerSeq,
    ledger: [{ ...entry, id: `al-${ledgerSeq}` }, ...state.ledger].slice(0, ALLOWANCE_LEDGER_LIMIT),
  };
}

function asLedger(value: unknown, signed: boolean): AllowanceLedgerEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AllowanceLedgerEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = item.kind === 'spend' ? 'spend' : item.kind === 'earn' ? 'earn' : null;
    const source =
      item.source === 'capture' ||
      item.source === 'manual' ||
      item.source === 'add' ||
      item.source === 'check-in' ||
      item.source === 'milestone' ||
      item.source === 'task' ||
      item.source === 'spend'
        ? item.source
        : null;
    const date = asLocalDate(item.date);
    const at = typeof item.at === 'string' ? item.at.trim() : '';
    const amount = asNonNegativeInteger(item.amount, 0);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (kind === null || source === null || date === null || at.length === 0 || amount <= 0) {
      continue;
    }
    if (
      (kind === 'earn' && source === 'spend') ||
      (kind === 'spend' && source !== 'spend' && source !== 'task')
    ) {
      continue;
    }
    entries.push({
      id: id.length > 0 ? id : `al-${entries.length + 1}`,
      at,
      date,
      kind,
      source,
      amount,
      note: typeof item.note === 'string' ? item.note.trim() : '',
      balanceAfter: signed
        ? asSignedInteger(item.balanceAfter, 0)
        : asNonNegativeInteger(item.balanceAfter, 0),
    });
    if (entries.length >= ALLOWANCE_LEDGER_LIMIT) break;
  }
  return entries;
}

function requireLocalDate(value: string): void {
  if (!isLocalDateKey(value)) {
    throw new Error('Allowance dates must use a real YYYY-MM-DD local date.');
  }
}

function asLocalDate(value: unknown): string | null {
  return isLocalDateKey(value) ? value : null;
}

function asNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function asSignedInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

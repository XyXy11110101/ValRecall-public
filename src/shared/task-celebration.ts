import { rewardsVisible } from '../edition/rewards';
import { TASK_ALL_DONE_PRAISES, TASK_LATE_PRAISES, TASK_PRAISES } from './allowance';

/** Presentation timings for one committed todo completion. None of them gates input. */
export const TASK_CELEBRATION_MS = {
  stamp: 440,
  coinDelay: 120,
  coinFlight: 680,
  walletBump: 360,
  rowHold: 1000,
  rowCollapse: 280,
  /** The whole visual moment, including the landing tag beside the wallet. */
  total: 1400,
  companionHold: 2400,
} as const;

/** 'created' is the +N creation grant: a coin only, never a stamp, departure or praise. */
export type TaskCelebrationKind = 'rewarded' | 'all-done' | 'late' | 'plain' | 'created';

export interface TaskCelebration {
  id: string;
  taskId: string;
  localDate: string;
  /** Confirmed whole-yuan grant; 0 means a stamp without a coin. */
  amount: number;
  kind: TaskCelebrationKind;
  praise: string;
}

/** The parts of an atomic task change that a celebration may read. */
export interface CommittedTaskChange {
  changed: boolean;
  reward: {
    state: { ledgerSeq: number; ledger: ReadonlyArray<{ id: string }> };
    reward: number;
  } | null;
  warning: string | null;
}

/**
 * Only a completion that this call actually committed celebrates. Undo also returns a
 * reward (the reversed amount), so the direction must come from the caller's intent.
 */
export function taskCelebrationFor(input: {
  completing: boolean;
  result: CommittedTaskChange;
  taskId: string;
  localDate: string;
  today: string;
  /** Unfinished today/overdue occurrences that remain after this one, when known. */
  remainingToday: number | null;
  fallbackId: string;
}): TaskCelebration | null {
  const { completing, result, taskId, localDate, today } = input;
  if (!completing || !result.changed) return null;
  const amount = result.reward && !result.warning ? result.reward.reward : 0;
  const kind: TaskCelebrationKind =
    input.remainingToday === 0 && localDate <= today
      ? 'all-done'
      : amount === 0 && localDate < today
        ? 'late'
        : amount > 0
          ? 'rewarded'
          : 'plain';
  const seed = result.reward?.state.ledgerSeq ?? stableSeed(`${taskId}:${localDate}`);
  return {
    id: result.reward?.state.ledger[0]?.id ?? input.fallbackId,
    taskId,
    localDate,
    amount,
    kind,
    praise: taskPraise(seed, kind),
  };
}

export function taskPraise(seed: number, kind: TaskCelebrationKind): string {
  const pool =
    kind === 'all-done'
      ? TASK_ALL_DONE_PRAISES
      : kind === 'late'
        ? TASK_LATE_PRAISES
        : TASK_PRAISES;
  return pool[Math.abs(Math.trunc(seed)) % pool.length]!;
}

/** The single status sentence; it keeps the existing "+N 元零花钱" receipt wording. */
export function taskCompletionMessage(kind: TaskCelebrationKind, amount: number): string {
  if (__VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible())
    return kind === 'all-done' ? '今天的待办都完成了。' : '已完成。';
  if (kind === 'all-done')
    return amount > 0 ? `今天的待办都完成了，+${amount} 元零花钱。` : '今天的待办都完成了。';
  return amount > 0 ? `已完成，+${amount} 元零花钱。` : '已完成。';
}

export function taskUndoMessage(reversed: number): string {
  if (__VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()) return '已撤销完成。';
  return reversed > 0 ? `已撤销完成，零花钱 −${reversed} 元。` : '已撤销完成。';
}

/** Nothing was committed: the occurrence already had the requested state. */
export const TASK_ALREADY_COMPLETED_MESSAGE = '这项待办已经完成了。';
export const TASK_ALREADY_OPEN_MESSAGE = '这项待办还没完成。';

/**
 * The one sentence for a completion or undo result; Home and the Tasks page share it. A
 * change that committed nothing (another device got there first) says so, and never claims
 * that a completion or an undo happened.
 */
export function taskChangeMessage(input: {
  completing: boolean;
  result: CommittedTaskChange;
  celebration: TaskCelebration | null;
}): string {
  const { completing, result, celebration } = input;
  if (!result.changed)
    return completing ? TASK_ALREADY_COMPLETED_MESSAGE : TASK_ALREADY_OPEN_MESSAGE;
  return completing
    ? taskCompletionMessage(
        celebration?.kind ?? 'plain',
        celebration?.amount ?? result.reward?.reward ?? 0,
      )
    : taskUndoMessage(result.reward?.reward ?? 0);
}

/** The committed creation grant, as the atomic create returned it. */
export interface CommittedTaskCreation {
  state: { ledger: ReadonlyArray<{ id: string }> };
  reward: number;
}

/**
 * Only a creation grant that this call committed shows a coin. A task that already existed,
 * or one recovered after a lost response, has no receipt here, so it never shows a coin twice
 * and never for an uncertain grant. The id is the committed ledger entry, so a re-render or
 * replay never restarts the flight.
 */
export function taskCreationCelebrationFor(input: {
  taskId: string;
  localDate: string;
  reward: CommittedTaskCreation | null;
  warning?: string | null;
}): TaskCelebration | null {
  const { reward } = input;
  if (!reward || !(reward.reward > 0) || input.warning) return null;
  const id = reward.state.ledger[0]?.id;
  if (!id) return null;
  return {
    id,
    taskId: input.taskId,
    localDate: input.localDate,
    amount: reward.reward,
    kind: 'created',
    praise: '',
  };
}

/** Matches the computer's own sync receipt wording for the same grant. */
export function taskCreationMessage(amount: number): string {
  if (__VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()) return '待办已创建。';
  return amount > 0 ? `待办已创建，+${amount} 元零花钱。` : '待办已创建。';
}

function stableSeed(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

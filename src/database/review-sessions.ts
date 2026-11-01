import type { Card } from 'ts-fsrs';
import {
  applyReviewItemReward,
  applyReviewSession,
  REVIEW_ITEM_REWARD,
  type ReviewAllowanceResult,
} from '../shared/allowance';
import { localDateKey } from '../models/daily-task';
import { contentFingerprint } from '../intake/package';
import { DatabaseError } from './errors';
import { requestResult, transactionComplete } from './idb';
import {
  cardFromPersisted,
  cardToPersisted,
  migratePersistedItem,
  reviewRecordFromPersisted,
  reviewRecordToPersisted,
} from './mappers';
import { STORE_NAMES } from './migrations';
import { reviewSchedulingStatesMatch, cardFromReviewSchedulingState } from './review-state';
import type {
  PersistedCard,
  PersistedReviewRecord,
  ReviewSchedulingState,
  SaveReviewInput,
} from './types';
import { WalletRepository, putWallet, walletInTransaction, type DatabaseOpener } from './wallet';

export type ReviewRewardSummary = Omit<ReviewAllowanceResult, 'state'>;
export interface ReviewSessionSeed {
  id: string;
  queue: string[];
  createdAt: string;
}
export interface ReviewSessionStep {
  itemId: string;
  fingerprint: string;
  kind: 'rated' | 'mastered' | 'unavailable';
  card: PersistedCard | null;
  review: PersistedReviewRecord | null;
  /** Missing on historical receipts; those ratings must never be backfilled. */
  rewardAmount?: typeof REVIEW_ITEM_REWARD;
}
export interface DurableReviewSession extends ReviewSessionSeed {
  schemaVersion: 1;
  status: 'active' | 'completed' | 'interrupted';
  revision: number;
  completedAt: string | null;
  steps: ReviewSessionStep[];
  reward: ReviewRewardSummary | null;
}
export type ReviewStepInput =
  | { kind: 'rated'; review: SaveReviewInput }
  | { kind: 'mastered' | 'unavailable'; itemId: string; expectedState: ReviewSchedulingState };

export function readReviewSession(value: unknown): DurableReviewSession {
  if (!value || typeof value !== 'object')
    throw new DatabaseError('INVALID_DATA', '复习会话记录无效。');
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Array.isArray(row.queue) ||
    row.queue.length === 0 ||
    !row.queue.every((id) => typeof id === 'string' && id) ||
    new Set(row.queue).size !== row.queue.length ||
    !['active', 'completed', 'interrupted'].includes(String(row.status)) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    !(
      row.completedAt === null ||
      (typeof row.completedAt === 'string' && Number.isFinite(Date.parse(row.completedAt)))
    ) ||
    !Array.isArray(row.steps)
  )
    throw new DatabaseError('INVALID_DATA', '复习会话格式无效。');
  const steps: ReviewSessionStep[] = row.steps.map((value: unknown) => {
    if (!value || typeof value !== 'object')
      throw new DatabaseError('INVALID_DATA', '复习进度无效。');
    const step = value as Record<string, unknown>;
    if (
      typeof step.itemId !== 'string' ||
      !(row.queue as string[]).includes(step.itemId) ||
      typeof step.fingerprint !== 'string' ||
      !step.fingerprint ||
      !['rated', 'mastered', 'unavailable'].includes(String(step.kind))
    )
      throw new DatabaseError('INVALID_DATA', '复习进度字段无效。');
    if (
      step.rewardAmount !== undefined &&
      (step.kind !== 'rated' || step.rewardAmount !== REVIEW_ITEM_REWARD)
    )
      throw new DatabaseError('INVALID_DATA', '逐题复习奖励凭据无效。');
    if (step.kind === 'rated') {
      const card = cardToPersisted(cardFromPersisted(step.card as PersistedCard));
      const review = reviewRecordToPersisted(
        reviewRecordFromPersisted(step.review as PersistedReviewRecord),
      );
      if (review.itemId !== step.itemId)
        throw new DatabaseError('INVALID_DATA', '评分记录身份不一致。');
      return {
        itemId: step.itemId,
        fingerprint: step.fingerprint,
        kind: 'rated',
        card,
        review,
        ...(step.rewardAmount === REVIEW_ITEM_REWARD ? { rewardAmount: REVIEW_ITEM_REWARD } : {}),
      };
    }
    if (step.card !== null || step.review !== null)
      throw new DatabaseError('INVALID_DATA', '非评分进度不能包含评分。');
    return {
      itemId: step.itemId,
      fingerprint: step.fingerprint,
      kind: step.kind as 'mastered' | 'unavailable',
      card: null,
      review: null,
    };
  });
  if (
    steps.some((step, index) => step.itemId !== (row.queue as string[])[index]) ||
    row.revision !== steps.length ||
    (row.status === 'completed'
      ? steps.length !== row.queue.length ||
        row.completedAt === null ||
        (steps.some((step) => step.kind === 'rated') && row.reward === null)
      : steps.length === row.queue.length || row.completedAt !== null)
  )
    throw new DatabaseError('INVALID_DATA', '复习进度计数无效。');
  if (row.reward !== null) {
    const reward = row.reward as Record<string, unknown>;
    if (
      !reward ||
      typeof reward !== 'object' ||
      typeof reward.checkIn !== 'boolean' ||
      !['checkInReward', 'reviewStreak', 'milestoneReward'].every(
        (key) => Number.isSafeInteger(reward[key]) && Number(reward[key]) >= 0,
      ) ||
      ![null, 3, 7, 14, 30].includes(reward.milestone as number | null) ||
      !['checkInPraise', 'milestonePraise'].every(
        (key) => reward[key] === null || typeof reward[key] === 'string',
      ) ||
      row.status !== 'completed' ||
      !steps.some((step) => step.kind === 'rated')
    )
      throw new DatabaseError('INVALID_DATA', '复习奖励凭据无效。');
  }
  return {
    schemaVersion: 1,
    id: row.id,
    createdAt: row.createdAt,
    queue: row.queue as string[],
    status: row.status as DurableReviewSession['status'],
    revision: Number(row.revision),
    completedAt: row.completedAt as string | null,
    steps,
    reward: row.reward as ReviewRewardSummary | null,
  };
}

export class ReviewSessionRepository {
  constructor(private readonly database: DatabaseOpener) {}
  async get(id: string): Promise<DurableReviewSession | undefined> {
    const tx = (await this.database.open()).transaction(STORE_NAMES.reviewSessions, 'readonly');
    const done = transactionComplete(tx);
    const value: unknown = await requestResult(tx.objectStore(STORE_NAMES.reviewSessions).get(id));
    await done;
    return value === undefined ? undefined : readReviewSession(value);
  }
  async commit(
    seed: ReviewSessionSeed,
    input: ReviewStepInput,
    at: Date,
  ): Promise<DurableReviewSession> {
    const itemId = input.kind === 'rated' ? input.review.itemId : input.itemId;
    const expected = input.kind === 'rated' ? input.review.expectedState : input.expectedState;
    const expectedCard = cardFromReviewSchedulingState(expected);
    const fingerprint = await contentFingerprint([
      input.kind,
      itemId,
      cardToPersisted(expectedCard),
      input.kind === 'rated' ? input.review.log.rating : null,
    ]);
    const initial = readReviewSession({
      ...seed,
      schemaVersion: 1,
      status: 'active',
      revision: 0,
      completedAt: null,
      steps: [],
      reward: null,
    });
    // Each new rating and final session reward share their commit with the wallet.
    // Read existing receipts first: a retry must not depend on the wallet still being readable.
    const committed = await this.get(seed.id);
    if (committed?.steps.some((step) => step.itemId === itemId)) {
      if (
        JSON.stringify(committed.queue) !== JSON.stringify(seed.queue) ||
        committed.createdAt !== seed.createdAt ||
        committed.steps.find((step) => step.itemId === itemId)?.fingerprint !== fingerprint
      )
        throw new DatabaseError('CONFLICT', '这道题已提交不同操作，请核对复习记录。');
      return committed;
    }
    if (input.kind === 'rated' || seed.queue.at(-1) === itemId)
      await new WalletRepository(this.database).ensureWallet();
    const tx = (await this.database.open()).transaction(
      [STORE_NAMES.items, STORE_NAMES.reviews, STORE_NAMES.reviewSessions, STORE_NAMES.wallet],
      'readwrite',
    );
    const done = transactionComplete(tx);
    try {
      const store = tx.objectStore(STORE_NAMES.reviewSessions);
      const value: unknown = await requestResult(store.get(seed.id));
      const session = value === undefined ? initial : readReviewSession(value);
      if (
        JSON.stringify(session.queue) !== JSON.stringify(seed.queue) ||
        session.createdAt !== seed.createdAt
      )
        throw new DatabaseError('CONFLICT', '会话身份不一致，请重新开始复习。');
      const previous = session.steps.find((step) => step.itemId === itemId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DatabaseError('CONFLICT', '这道题已提交不同操作，请核对复习记录。');
        await done;
        return session;
      }
      if (session.status !== 'active' || session.queue[session.steps.length] !== itemId)
        throw new DatabaseError('CONFLICT', '复习进度已改变，请重新核对。');
      const raw: unknown = await requestResult(tx.objectStore(STORE_NAMES.items).get(itemId));
      const item = raw === undefined ? undefined : migratePersistedItem(raw);
      const matches =
        item &&
        !item.suspended &&
        reviewSchedulingStatesMatch(cardFromPersisted(item.fsrsCard), expected);
      if (input.kind === 'unavailable' ? matches : !matches)
        throw new DatabaseError(
          'CONFLICT',
          input.kind === 'unavailable'
            ? '该题仍可复习，不能跳过。'
            : '题目已在其他窗口修改，请核对当前队列。',
        );
      let card: PersistedCard | null = null;
      let review: PersistedReviewRecord | null = null;
      if (input.kind === 'rated') {
        card = cardToPersisted(input.review.card);
        review = reviewRecordToPersisted({
          id: `${seed.id}:${itemId}`,
          itemId,
          reviewedAt: input.review.log.review,
          log: input.review.log,
        });
        tx.objectStore(STORE_NAMES.items).put({
          ...item!,
          fsrsCard: card,
          updatedAt: review.reviewedAt,
        });
        tx.objectStore(STORE_NAMES.reviews).add(review);
      } else if (input.kind === 'mastered') {
        tx.objectStore(STORE_NAMES.items).put({
          ...item!,
          suspended: true,
          updatedAt: at.toISOString(),
        });
      }
      const itemReward =
        input.kind === 'rated'
          ? applyReviewItemReward(await walletInTransaction(tx), localDateKey(at), at.toISOString())
          : null;
      session.steps.push({
        itemId,
        fingerprint,
        kind: input.kind,
        card,
        review,
        ...(itemReward ? { rewardAmount: itemReward.reward } : {}),
      });
      session.revision++;
      let walletState = itemReward?.state;
      if (session.steps.length === session.queue.length) {
        session.status = 'completed';
        session.completedAt = at.toISOString();
        if (session.steps.some((step) => step.kind === 'rated')) {
          const reward = applyReviewSession(
            walletState ?? (await walletInTransaction(tx)),
            localDateKey(at),
            at.toISOString(),
          );
          const { state, ...summary } = reward;
          walletState = state;
          session.reward = summary;
        }
      }
      if (walletState) putWallet(tx, walletState);
      store.put(session);
      await done;
      return session;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

export function persistedStepResult(
  session: DurableReviewSession,
  itemId: string,
): { card: Card; review: ReturnType<typeof reviewRecordFromPersisted>; rewardAmount: number } {
  const step = session.steps.find((entry) => entry.itemId === itemId);
  if (!step?.card || !step.review)
    throw new DatabaseError('INVALID_DATA', '找不到已提交的评分凭据。');
  return {
    card: cardFromPersisted(step.card),
    review: reviewRecordFromPersisted(step.review),
    rewardAmount: step.rewardAmount ?? 0,
  };
}

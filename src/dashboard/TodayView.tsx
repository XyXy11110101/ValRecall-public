import { ReviewSessionService } from '../fsrs/ReviewSessionService';
import type { ReviewSessionSeed, ReviewRewardSummary } from '../database/review-sessions';
import { platformLabel } from '../shared/source-labels';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useEditProtection } from '../shared/edit-protection';
import { useOperation } from '../shared/use-operation';

import {
  reviewSchedulingStateFromCard,
  isImageLearningItem,
  isVideoLearningItem,
  learningItemTitle,
  type CategorySummary,
  type LearningItem,
  type MomentCategory,
  type ReviewSchedulingState,
} from '../database';
import { CATEGORY_PICKER_VISIBLE_LIMIT } from '../models/category';
import { learningGoalLabel } from '../models/learning-item';
import { ReadingSourceDetails } from '../reading/ReadingSourceDetails';
import { NoteContentView } from '../intake/NoteContentView';
import {
  FSRS_RATING_OPTIONS,
  formatFsrsInterval,
  toFsrsRating,
  type FsrsPreview,
  type FsrsRatingInput,
  type PersistedFsrsReviewResult,
} from '../fsrs';
import { Notice, SourceContextDisclosure, SourceContextExcerpt } from '../shared/components';
import { displayError, openSourceAtTimestamp, refreshReviewReminders } from '../shared/extension';
import type { ValRecallPreferences } from '../shared/preferences';
import { MOTION_DURATION_MS, useReducedMotion } from '../ui/motion';
import './review.css';
import { ReviewStepFeedback, type ReviewStepReceipt } from './ReviewStepFeedback';
import {
  recordSuccessfulReviewSession,
  reviewAllowanceLines,
  type ReviewAllowanceResult,
} from '../shared/allowance';
import { rewardsVisible } from '../edition/rewards';
import { reviewArtSlot } from '../companion/companion-scenes';
import { useCompanionWardrobe } from '../companion/CompanionWardrobe';
import type { CompanionOutfit } from '../companion/wardrobe';
import { localDateKey } from '../models/daily-task';
import { COMPANION_ASSETS_ENABLED, Companion, reviewCompanionLayers } from './Companion';
import { ItemThumbnail } from './ItemThumbnail';
import { useMinuteClock } from './useMinuteClock';
import {
  createReviewCompanionState,
  reduceReviewCompanionState,
  type ReviewCompanionEvent,
  type ReviewCompanionState,
} from './review-companion';
import {
  cloneReviewSessionItem,
  createReviewSessionSnapshot,
  createReviewSessionSummary,
  recordMasteredMoment,
  recordSuccessfulReview,
  recordUnavailableMoment,
  reviewedTotal,
  reviewSessionProgress,
  type ReviewSessionSummary,
} from './review-session';
import { fsrsServiceForMode, repository } from './services';
import { requestAddQuestion } from '../edition/add-question-event';
import { useFreshInstall } from '../edition/fresh-install';

export type DueItemsLoader = (now: Date, categoryId?: string | null) => Promise<LearningItem[]>;
export type DueItemsCountLoader = (now: Date, categoryId?: string | null) => Promise<number>;
export type CategorySummariesLoader = (now: Date) => Promise<CategorySummary[]>;
export type ReviewItem = (
  itemId: string,
  rating: FsrsRatingInput,
  reviewedAt: Date,
  expectedState: ReviewSchedulingState,
) => Promise<PersistedFsrsReviewResult>;
export type PreviewItem = (item: LearningItem, reviewedAt: Date) => FsrsPreview;
export type ReviewAllowanceRecorder = (now: Date) => Promise<ReviewAllowanceResult | null>;
export type SuspendItem = (itemId: string) => Promise<unknown>;

type ReviewSessionPhase = 'entry' | 'active' | 'complete';
type ReviewScope = 'all' | 'uncategorized' | string;

const loadRepositoryDueItems: DueItemsLoader = (now, categoryId) =>
  repository.listDueItems(now, categoryId);
const countRepositoryDueItems: DueItemsCountLoader = (now, categoryId) =>
  repository.countDueReviewItems(now, categoryId);
const loadRepositoryCategorySummaries: CategorySummariesLoader = (now) =>
  repository.listCategorySummaries(now);
const durableReviewService = new ReviewSessionService(repository);
const systemClock = () => new Date();
const systemInteractionClock = () => performance.now();
const REVIEW_REVEAL_HERO_DURATION_MS = MOTION_DURATION_MS.standard;
const REVIEW_TIMED_DIALOGUE_DURATION_MS = 2400;
const REVIEW_RAPID_INTERACTION_MS = 500;

export interface ReviewStartRequest {
  key: number;
  preferredItemId: string | null;
}
const ignoreStartRequest = () => undefined;

/** What the companion art keys on: the outfit and the date, hour and card that pick poses. */
interface ReviewCompanionArt {
  /** Fixed for a session; absent at entry, where the current outfit (pin or today's) shows. */
  outfit: CompanionOutfit | undefined;
  dateKey: string;
  hour: number;
  cardIndex: number;
}

/** Captured once when a session starts; a pin or a new day mid-session does not change it. */
interface ReviewSessionArt {
  dateKey: string;
  hour: number;
  /** Null only while the wardrobe is still being read; filled once it is. */
  outfit: CompanionOutfit | null;
}

export function TodayView({
  revision,
  preferences,
  onChanged,
  onGoHome,
  onGoLibrary,
  onViewUpcoming = () => undefined,
  preferredItemId = null,
  startRequest = null,
  onStartRequestConsumed = ignoreStartRequest,
  loadDueItems = loadRepositoryDueItems,
  countDueItems = countRepositoryDueItems,
  loadCategorySummaries = loadRepositoryCategorySummaries,
  reviewItem,
  previewItem,
  recordReviewAllowance = (now: Date) => recordSuccessfulReviewSession(now),
  suspendItem = (itemId: string) => repository.updateItem(itemId, { suspended: true }),
  clock = systemClock,
  interactionClock = systemInteractionClock,
}: {
  revision: number;
  preferences: ValRecallPreferences;
  onChanged: () => void;
  onGoHome: () => void;
  onGoLibrary: () => void;
  onViewUpcoming?: () => void;
  preferredItemId?: string | null;
  startRequest?: ReviewStartRequest | null;
  onStartRequestConsumed?: () => void;
  loadDueItems?: DueItemsLoader;
  countDueItems?: DueItemsCountLoader;
  loadCategorySummaries?: CategorySummariesLoader;
  reviewItem?: ReviewItem;
  previewItem?: PreviewItem;
  recordReviewAllowance?: ReviewAllowanceRecorder;
  suspendItem?: SuspendItem;
  clock?: () => Date;
  interactionClock?: () => number;
}) {
  const durableSession = reviewItem === undefined && loadDueItems === loadRepositoryDueItems;
  const sessionSeed = useRef<ReviewSessionSeed | null>(null);
  const committedReward = useRef<ReviewRewardSummary | null>(null);
  const reducedMotion = useReducedMotion();
  // The entry companion follows the date and hour (outfit, idle pose) while the tab stays open.
  const entryNow = useMinuteClock(clock);
  const consumedStartRef = useRef<number | null>(null);
  const [failedStart, setFailedStart] = useState<ReviewStartRequest | null>(null);
  const [phase, setPhase] = useState<ReviewSessionPhase>('entry');
  const [entryItems, setEntryItems] = useState<LearningItem[]>([]);
  const [reviewScope, setReviewScope] = useState<ReviewScope>('all');
  const [categorySummaries, setCategorySummaries] = useState<CategorySummary[]>([]);
  const [sessionCategoryId, setSessionCategoryId] = useState<string | null | undefined>(undefined);
  const [sessionScopeLabel, setSessionScopeLabel] = useState('全部到期');
  const [sessionItems, setSessionItems] = useState<LearningItem[]>([]);
  const [summary, setSummary] = useState<ReviewSessionSummary>(() => createReviewSessionSummary(0));
  const [loading, setLoading] = useState(true);
  const [entryLoadFailed, setEntryLoadFailed] = useState(false);
  const [entryRetry, setEntryRetry] = useState(0);
  const [completionCountLoading, setCompletionCountLoading] = useState(false);
  const [additionalDueCount, setAdditionalDueCount] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [reviewedAt, setReviewedAt] = useState<Date | null>(null);
  const [preview, setPreview] = useState<FsrsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceOperation = useOperation();
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [selectedRating, setSelectedRating] = useState<FsrsRatingInput | null>(null);
  const [stepReceipt, setStepReceipt] = useState<ReviewStepReceipt | null>(null);
  const [reviewRewardTotal, setReviewRewardTotal] = useState(0);
  const [companionState, setCompanionState] = useState<ReviewCompanionState>(() =>
    createReviewCompanionState(),
  );
  const wardrobe = useCompanionWardrobe();
  const [sessionArt, setSessionArt] = useState<ReviewSessionArt | null>(null);
  const [allowanceReceipt, setAllowanceReceipt] = useState<ReviewRewardSummary | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'success' | 'warning' | 'error';
  } | null>(null);
  const phaseRef = useRef<ReviewSessionPhase>('entry');
  const submittingRef = useRef(false);
  useEditProtection({ dirty: false, busy: () => submittingRef.current });
  const dueRequestRef = useRef(0);
  const completionCountRequestRef = useRef(0);
  const cardTransitionTimerRef = useRef<number | null>(null);
  const companionStageTimerRef = useRef<number | null>(null);
  const companionDialogueTimerRef = useRef<number | null>(null);
  const companionStateRef = useRef(companionState);
  const lastInteractionAtRef = useRef<number | null>(null);
  const allowanceRecordedRef = useRef(false);
  const allowanceRequestRef = useRef(0);
  const focusAnswerAfterRevealRef = useRef(false);
  const focusAfterAdvanceRef = useRef(false);
  const reviewRegionRef = useRef<HTMLElement | null>(null);
  const activeCardRef = useRef<HTMLElement | null>(null);
  const recoveryButtonRef = useRef<HTMLButtonElement | null>(null);
  const promptHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const revealButtonRef = useRef<HTMLButtonElement | null>(null);
  const answerRegionRef = useRef<HTMLDivElement | null>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const revealedRef = useRef(false);
  const rateRef = useRef<(rating: FsrsRatingInput) => Promise<void>>(async () => undefined);
  const revealAnswerRef = useRef<() => void>(() => undefined);

  function transitionTo(next: ReviewSessionPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function sessionOutfitFor(dateKey: string): CompanionOutfit | null {
    // Ordinary builds have no art, so they never resolve an outfit.
    if (!COMPANION_ASSETS_ENABLED || !wardrobe.ready) return null;
    return wardrobe.outfitFor(dateKey);
  }

  // A session that started before the wardrobe was read takes the outfit once, then keeps it.
  useEffect(() => {
    if (!COMPANION_ASSETS_ENABLED || !wardrobe.ready) return;
    setSessionArt((current) =>
      current && current.outfit === null
        ? { ...current, outfit: wardrobe.outfitFor(current.dateKey) }
        : current,
    );
  }, [wardrobe]);

  function moveCompanion(event: ReviewCompanionEvent): ReviewCompanionState | null {
    const previous = companionStateRef.current;
    const next = reduceReviewCompanionState(previous, event);
    if (next === previous) return null;
    const previousTimedSequence =
      previous.dialogue?.lifetime === 'timed' ? previous.dialogue.sequence : null;
    const nextTimedSequence = next.dialogue?.lifetime === 'timed' ? next.dialogue.sequence : null;
    const timedDialogueChanged = previousTimedSequence !== nextTimedSequence;
    if (timedDialogueChanged && companionDialogueTimerRef.current !== null) {
      window.clearTimeout(companionDialogueTimerRef.current);
      companionDialogueTimerRef.current = null;
    }
    companionStateRef.current = next;
    setCompanionState(next);
    if (timedDialogueChanged && next.dialogue?.lifetime === 'timed') {
      const dialogueSequence = next.dialogue.sequence;
      companionDialogueTimerRef.current = window.setTimeout(() => {
        companionDialogueTimerRef.current = null;
        moveCompanion({
          type: 'DISMISS_DIALOGUE',
          expectedDialogueSequence: dialogueSequence,
        });
      }, REVIEW_TIMED_DIALOGUE_DURATION_MS);
    }
    return next;
  }

  useEffect(() => {
    if (phaseRef.current !== 'entry') return;
    const request = ++dueRequestRef.current;
    setLoading(true);
    setEntryLoadFailed(false);
    setEntryItems([]);
    setNotice(null);
    const now = clock();
    const categoryId = categoryIdForReviewScope(reviewScope);
    void Promise.all([loadDueItems(now, categoryId), loadCategorySummaries(now).catch(() => null)])
      .then(([dueItems, summaries]) => {
        if (request !== dueRequestRef.current || phaseRef.current !== 'entry') return;
        if (summaries === null) {
          setCategorySummaries([]);
          if (reviewScope !== 'all') setReviewScope('all');
          setNotice({
            text: '分类没加载出来，先复习全部。',
            tone: 'warning',
          });
          const snapshot = createReviewSessionSnapshot(dueItems, preferredItemId);
          setEntryItems(snapshot);
          moveCompanion({ type: 'ENTRY', hasDue: snapshot.length > 0 });
          return;
        }
        if (
          reviewScope !== 'all' &&
          reviewScope !== 'uncategorized' &&
          !summaries.some((summary) => summary.category?.id === reviewScope)
        ) {
          setReviewScope('all');
          setNotice({
            text: '分类已变更，已切回全部。',
            tone: 'warning',
          });
          return;
        }
        setCategorySummaries(summaries);
        const snapshot = createReviewSessionSnapshot(dueItems, preferredItemId);
        setEntryItems(snapshot);
        moveCompanion({ type: 'ENTRY', hasDue: snapshot.length > 0 });
      })
      .catch((error) => {
        if (request !== dueRequestRef.current || phaseRef.current !== 'entry') return;
        setEntryLoadFailed(true);
        setNotice({
          text: displayError(error, '到期 Moment 无法加载。'),
          tone: 'error',
        });
      })
      .finally(() => {
        if (request === dueRequestRef.current && phaseRef.current === 'entry') {
          setLoading(false);
        }
      });
  }, [
    clock,
    loadCategorySummaries,
    loadDueItems,
    preferredItemId,
    reviewScope,
    revision,
    entryRetry,
  ]);

  useEffect(() => {
    if (
      !startRequest ||
      loading ||
      phaseRef.current !== 'entry' ||
      consumedStartRef.current === startRequest.key
    )
      return;
    consumedStartRef.current = startRequest.key;
    onStartRequestConsumed();
    if (notice?.tone === 'error') {
      setFailedStart(startRequest);
      return;
    }
    beginRequestedSession(entryItems, startRequest);
  }, [startRequest, loading, entryItems, onStartRequestConsumed]);

  function beginRequestedSession(items: LearningItem[], request: ReviewStartRequest) {
    setFailedStart(null);
    if (
      request.preferredItemId &&
      !items.some((candidate) => candidate.id === request.preferredItemId)
    ) {
      setNotice({
        tone: 'warning',
        text: '这条 Moment 现在不用复习。',
      });
      return;
    }
    startSession(items, request.preferredItemId, 'all');
  }

  async function retryRequestedSession() {
    if (!failedStart || loading) return;
    const target = failedStart;
    const request = ++dueRequestRef.current;
    setLoading(true);
    try {
      const items = await loadDueItems(clock(), undefined);
      if (request !== dueRequestRef.current || phaseRef.current !== 'entry') return;
      setEntryItems(items);
      setEntryLoadFailed(false);
      setNotice(null);
      beginRequestedSession(items, target);
    } catch (error) {
      if (request === dueRequestRef.current) {
        setEntryLoadFailed(true);
        setNotice({ tone: 'error', text: displayError(error, '到期 Moment 无法加载。') });
      }
    } finally {
      if (request === dueRequestRef.current) setLoading(false);
    }
  }

  const item = sessionItems[0];
  const videoItem = item && isVideoLearningItem(item) ? item : null;
  const activeVideoId = useRef<string | null>(null);
  activeVideoId.current = videoItem?.id ?? null;
  const readingSource = item?.sourceType === 'text' ? item.readingSource : undefined;
  const noteSource = item?.sourceType === 'text' ? item.noteSource : undefined;
  const capturedVideoItem = videoItem?.videoOrigin === 'library' ? null : videoItem;
  const imageItem = item && isImageLearningItem(item) ? item : null;
  const keyTakeaway = item?.coreLesson.trim() ?? '';

  useEffect(() => {
    setRevealed(false);
    revealedRef.current = false;
    setReviewedAt(null);
    setPreview(null);
    setSelectedRating(null);
  }, [item?.id]);

  useEffect(() => {
    if (!focusAfterAdvanceRef.current) return;
    let target = phase === 'active' ? revealButtonRef.current : completionHeadingRef.current;
    if (target) {
      if (phase === 'active') {
        const card = activeCardRef.current;
        const top = card?.getBoundingClientRect().top;
        if (top !== undefined && (top < 0 || top > window.innerHeight / 3)) {
          card?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
        }
        const revealBounds = target.getBoundingClientRect();
        if (revealBounds.top < 0 || revealBounds.bottom > window.innerHeight) {
          // A long question owns focus while its reveal control is below the viewport.
          target = promptHeadingRef.current;
          const promptTop = target?.getBoundingClientRect().top;
          if (promptTop !== undefined && (promptTop < 0 || promptTop > window.innerHeight / 2)) {
            target?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
          }
        }
      }
      target?.focus({ preventScroll: phase === 'active' });
      focusAfterAdvanceRef.current = false;
    }
  }, [item?.id, phase, refreshRequired]);

  useEffect(() => {
    if (phase === 'active' && refreshRequired && !loading) {
      recoveryButtonRef.current?.focus();
    }
  }, [phase, refreshRequired, loading]);

  useEffect(() => {
    if (!revealed || !focusAnswerAfterRevealRef.current) return;
    focusAnswerAfterRevealRef.current = false;
    answerRegionRef.current?.focus();
  }, [item?.id, revealed]);

  useEffect(
    () => () => {
      activeVideoId.current = null;
      dueRequestRef.current += 1;
      completionCountRequestRef.current += 1;
      allowanceRequestRef.current += 1;
      if (cardTransitionTimerRef.current !== null) {
        window.clearTimeout(cardTransitionTimerRef.current);
      }
      if (companionStageTimerRef.current !== null) {
        window.clearTimeout(companionStageTimerRef.current);
      }
      if (companionDialogueTimerRef.current !== null) {
        window.clearTimeout(companionDialogueTimerRef.current);
      }
      companionStateRef.current = {
        ...companionStateRef.current,
        sequence: companionStateRef.current.sequence + 1,
      };
    },
    [],
  );

  useEffect(() => {
    function handleReviewShortcut(event: KeyboardEvent) {
      if (
        phaseRef.current !== 'active' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (
        target &&
        target !== document.body &&
        target !== document.documentElement &&
        !reviewRegionRef.current?.contains(target)
      ) {
        return;
      }
      const scene = companionStateRef.current.scene;
      if (event.repeat) return;
      if (scene === 'PROMPT' && (event.key === 'Enter' || event.key === ' ')) {
        // Focused controls keep their native activation instead of revealing another action.
        if (target?.closest('button, a[href], summary, [role="button"], [role="link"]')) return;
        event.preventDefault();
        revealAnswerRef.current();
        return;
      }
      if (
        !revealedRef.current ||
        (scene !== 'REVEALED' && scene !== 'REVEAL_TRANSITION' && scene !== 'RATING')
      ) {
        return;
      }
      const index = Number(event.key) - 1;
      const option = FSRS_RATING_OPTIONS[index];
      if (!option) return;
      event.preventDefault();
      void rateRef.current(option.value);
    }

    window.addEventListener('keydown', handleReviewShortcut);
    return () => window.removeEventListener('keydown', handleReviewShortcut);
  }, []);

  function startSession(
    snapshotSource: readonly LearningItem[],
    preferredId: string | null,
    scope: ReviewScope = reviewScope,
    summaries: readonly CategorySummary[] = categorySummaries,
  ) {
    setStepReceipt(null);
    const snapshot = createReviewSessionSnapshot(snapshotSource, preferredId);
    setReviewRewardTotal(0);
    if (snapshot.length === 0) {
      setEntryItems([]);
      return;
    }
    completionCountRequestRef.current += 1;
    const startedAt = clock();
    // A refresh inside a running session keeps its outfit; a new session takes the current one.
    const continuing = phaseRef.current === 'active';
    setSessionArt((current) => {
      if (continuing && current) return current;
      const dateKey = localDateKey(startedAt);
      return { dateKey, hour: startedAt.getHours(), outfit: sessionOutfitFor(dateKey) };
    });
    sessionSeed.current = {
      id: crypto.randomUUID(),
      queue: snapshot.map((entry) => entry.id),
      createdAt: startedAt.toISOString(),
    };
    committedReward.current = null;
    setSessionItems(snapshot);
    setSessionCategoryId(categoryIdForReviewScope(scope));
    setSessionScopeLabel(reviewScopeLabel(scope, summaries));
    setSummary(createReviewSessionSummary(snapshot.length));
    setAdditionalDueCount(null);
    setCompletionCountLoading(false);
    setRefreshRequired(false);
    setNotice(null);
    lastInteractionAtRef.current = null;
    allowanceRecordedRef.current = false;
    allowanceRequestRef.current += 1;
    setAllowanceReceipt(null);
    moveCompanion({ type: 'START_PROMPT' });
    focusAfterAdvanceRef.current = true;
    transitionTo('active');
  }

  async function startSelectedSession() {
    if (reviewScope === 'all') {
      startSession(entryItems, preferredItemId);
      return;
    }
    const request = ++dueRequestRef.current;
    const categoryId = categoryIdForReviewScope(reviewScope);
    setLoading(true);
    try {
      const at = clock();
      const [dueItems, summaries] = await Promise.all([
        loadDueItems(at, categoryId),
        loadCategorySummaries(at),
      ]);
      if (request !== dueRequestRef.current || phaseRef.current !== 'entry') return;
      if (
        reviewScope !== 'uncategorized' &&
        !summaries.some((summary) => summary.category?.id === reviewScope)
      ) {
        setReviewScope('all');
        setNotice({
          text: '分类已变更，已切回全部。',
          tone: 'warning',
        });
        return;
      }
      setCategorySummaries(summaries);
      setEntryItems(createReviewSessionSnapshot(dueItems, null));
      if (dueItems.length === 0) {
        setNotice({
          text: '这个分类已经没有要复习的了。',
          tone: 'warning',
        });
        return;
      }
      setLoading(false);
      startSession(dueItems, null);
    } catch (error) {
      if (request !== dueRequestRef.current || phaseRef.current !== 'entry') return;
      setNotice({
        text: displayError(error, '无法开始这个分类的复习。'),
        tone: 'error',
      });
    } finally {
      if (request === dueRequestRef.current && phaseRef.current === 'entry') setLoading(false);
    }
  }

  async function refreshCompletionDueCount() {
    const request = ++completionCountRequestRef.current;
    setCompletionCountLoading(true);
    setAdditionalDueCount(null);
    try {
      const count = await countDueItems(clock(), sessionCategoryId);
      if (request !== completionCountRequestRef.current || phaseRef.current !== 'complete') return;
      setAdditionalDueCount(count);
    } catch {
      // The extra-due count is optional; leave it hidden when it cannot be read.
    } finally {
      if (request === completionCountRequestRef.current && phaseRef.current === 'complete') {
        setCompletionCountLoading(false);
      }
    }
  }

  function finishSession(nextSummary: ReviewSessionSummary) {
    setSessionItems([]);
    setSelectedRating(null);
    setBusy(false);
    submittingRef.current = false;
    setRevealed(false);
    revealedRef.current = false;
    focusAfterAdvanceRef.current = true;
    transitionTo('complete');
    void refreshCompletionDueCount();
    if (durableSession) {
      setAllowanceReceipt(committedReward.current);
      return;
    }
    if (reviewedTotal(nextSummary) > 0 && !allowanceRecordedRef.current) {
      allowanceRecordedRef.current = true;
      const request = ++allowanceRequestRef.current;
      void recordReviewAllowance(clock())
        .then((receipt) => {
          if (phaseRef.current !== 'complete' || request !== allowanceRequestRef.current) return;
          setAllowanceReceipt(receipt);
        })
        .catch(() => {
          if (phaseRef.current !== 'complete' || request !== allowanceRequestRef.current) return;
          if (__VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()) return;
          setNotice({
            tone: 'warning',
            text: '复习已保存，零花钱没更新，请到零花钱页核对。',
          });
        });
    }
  }

  function advanceToNextCard(remaining: LearningItem[]) {
    setSessionItems(remaining);
    focusAfterAdvanceRef.current = true;
    setSelectedRating(null);
    setBusy(false);
    submittingRef.current = false;
    setRevealed(false);
    revealedRef.current = false;
    setReviewedAt(null);
    setPreview(null);
  }

  async function rate(rating: FsrsRatingInput) {
    if (!item || !revealed || !reviewedAt || busy || refreshRequired || submittingRef.current) {
      return;
    }
    const ratedItem = item;
    const remaining = sessionItems.slice(1);
    const hasNextCard = remaining.length > 0;
    const interactionAt = interactionClock();
    const previousInteractionAt = lastInteractionAtRef.current;
    lastInteractionAtRef.current = interactionAt;
    const ratingCompanionState = moveCompanion({
      type: 'RATE',
      rating,
      rapidInteraction:
        previousInteractionAt !== null &&
        interactionAt >= previousInteractionAt &&
        interactionAt - previousInteractionAt <= REVIEW_RAPID_INTERACTION_MS,
    });
    if (!ratingCompanionState) return;
    submittingRef.current = true;
    setBusy(true);
    setSelectedRating(rating);
    setStepReceipt(null);
    try {
      let rewardAmount = 0;
      let committedReviewReward = reviewRewardTotal;
      const service = fsrsServiceForMode(preferences.shortTermReviewMode);
      const result = durableSession
        ? await (async () => {
            if (!sessionSeed.current) throw new Error('复习会话未初始化。');
            const committed = await durableReviewService.rate(
              sessionSeed.current,
              ratedItem,
              rating,
              reviewedAt,
              service,
              clock(),
            );
            committedReward.current = committed.session.reward;
            rewardAmount = committed.rewardAmount;
            committedReviewReward = committed.session.steps.reduce(
              (sum, step) => sum + (step.rewardAmount ?? 0),
              0,
            );
            return committed.result;
          })()
        : await (reviewItem ?? service.reviewItem.bind(service))(
            ratedItem.id,
            rating,
            reviewedAt,
            reviewSchedulingStateFromCard(ratedItem.fsrsCard),
          );
      void refreshReviewReminders().then((refreshResult) => {
        if (!refreshResult.ok) {
          console.warn('[ValRecall] Review reminder refresh failed.', refreshResult.error);
        }
      });
      const persistedCompanionState = moveCompanion({
        type: 'PERSISTED',
        hasNextCard,
        expectedSequence: ratingCompanionState.sequence,
      });
      if (!persistedCompanionState) return;
      const nextSummary = recordSuccessfulReview(summary, ratedItem.id, result);
      setSummary(nextSummary);
      setReviewRewardTotal(committedReviewReward);
      if (!document.hidden) {
        setStepReceipt({ id: result.reviewRecord.id, rewardAmount });
      }
      // The stamp confirms the save. An older skip or source notice must not linger on the next card.
      setNotice(null);
      onChanged();
      finishOrAdvance(remaining, nextSummary);
    } catch (error) {
      try {
        const authoritativeDue = await loadDueItems(clock(), sessionCategoryId);
        const authoritativeItem = authoritativeDue.find(
          (candidate) => candidate.id === ratedItem.id,
        );
        if (
          !authoritativeItem ||
          authoritativeItem.fsrsCard.due.getTime() !== ratedItem.fsrsCard.due.getTime()
        ) {
          if (durableSession) {
            if (!sessionSeed.current) throw new Error('复习会话未初始化。');
            const committed = await durableReviewService.finishItem(
              sessionSeed.current,
              ratedItem,
              'unavailable',
              clock(),
            );
            committedReward.current = committed.reward;
          }
          const nextSummary = recordUnavailableMoment(summary, ratedItem.id);
          setSummary(nextSummary);
          setNotice({
            text: '这条 Moment 已在别处改动，已跳过。',
            tone: 'warning',
          });
          const skippedCompanionState = moveCompanion({
            type: 'SKIPPED',
            hasNextCard,
            expectedSequence: ratingCompanionState.sequence,
          });
          if (!skippedCompanionState) return;
          setRefreshRequired(false);
          finishOrAdvance(remaining, nextSummary);
          return;
        }
      } catch {
        // Keep the original persistence error and the current snapshot Moment available.
      }
      setNotice({
        text: displayError(error, '这次复习无法保存。'),
        tone: 'error',
      });
      moveCompanion({
        type: 'RATING_FAILED',
        expectedSequence: ratingCompanionState.sequence,
      });
      setRefreshRequired(true);
      setBusy(false);
      setSelectedRating(null);
      submittingRef.current = false;
    }
  }

  rateRef.current = rate;

  function finishOrAdvance(remaining: LearningItem[], nextSummary: ReviewSessionSummary) {
    if (remaining.length === 0) finishSession(nextSummary);
    else advanceToNextCard(remaining);
  }

  async function markMastered() {
    if (!item || busy || refreshRequired || submittingRef.current) return;
    setStepReceipt(null);
    const masteredItem = item;
    const remaining = sessionItems.slice(1);
    const hasNextCard = remaining.length > 0;
    submittingRef.current = true;
    setBusy(true);
    try {
      if (durableSession) {
        if (!sessionSeed.current) throw new Error('复习会话未初始化。');
        const committed = await durableReviewService.finishItem(
          sessionSeed.current,
          masteredItem,
          'mastered',
          clock(),
        );
        committedReward.current = committed.reward;
      } else await suspendItem(masteredItem.id);
      void refreshReviewReminders().then((refreshResult) => {
        if (!refreshResult.ok) {
          console.warn('[ValRecall] Review reminder refresh failed.', refreshResult.error);
        }
      });
      const nextSummary = recordMasteredMoment(summary, masteredItem.id);
      setSummary(nextSummary);
      // On the last card the completion summary says it instead.
      setNotice(hasNextCard ? { text: '已学成。', tone: 'success' } : null);
      onChanged();
      moveCompanion({
        type: 'MASTERED',
        hasNextCard,
      });
      finishOrAdvance(remaining, nextSummary);
    } catch (error) {
      setNotice({
        text: displayError(error, '无法标记为学成。'),
        tone: 'error',
      });
      setBusy(false);
      submittingRef.current = false;
    }
  }

  function revealAnswer() {
    if (!item) return;
    const timestamp = clock();
    try {
      const service = fsrsServiceForMode(preferences.shortTermReviewMode);
      const nextPreview = (previewItem ?? ((current, at) => service.preview(current.fsrsCard, at)))(
        cloneReviewSessionItem(item),
        timestamp,
      );
      const revealCompanionState = moveCompanion({ type: 'REVEAL' });
      if (!revealCompanionState) return;
      lastInteractionAtRef.current = interactionClock();
      setReviewedAt(timestamp);
      setPreview(nextPreview);
      focusAnswerAfterRevealRef.current = true;
      setRevealed(true);
      revealedRef.current = true;
      if (companionStageTimerRef.current !== null) {
        window.clearTimeout(companionStageTimerRef.current);
      }
      companionStageTimerRef.current = window.setTimeout(
        () => {
          companionStageTimerRef.current = null;
          moveCompanion({
            type: 'SETTLE_REVEAL',
            expectedSequence: revealCompanionState.sequence,
          });
        },
        reducedMotion ? 0 : REVIEW_REVEAL_HERO_DURATION_MS,
      );
    } catch (error) {
      setNotice({
        text: displayError(error, '无法预览下次间隔。'),
        tone: 'error',
      });
    }
  }

  revealAnswerRef.current = revealAnswer;

  async function openSource() {
    if (!videoItem || !sourceOperation.begin()) return;
    try {
      const result = await openSourceAtTimestamp({
        platform: videoItem.platform,
        sourceUrl: videoItem.sourceUrl,
        canonicalUrl: videoItem.canonicalUrl,
        timestampSeconds: videoItem.timestampSeconds,
        pauseAfterSeek: preferences.pauseAfterReopen,
      });
      if (activeVideoId.current !== videoItem.id) return;
      setNotice({
        text: result.ok
          ? videoItem.timestampDisplay
            ? `已打开来源，定位到 ${videoItem.timestampDisplay}。`
            : '已打开来源。'
          : videoItem.timestampDisplay
            ? `没能跳到 ${videoItem.timestampDisplay}，请重试或手动拖动。`
            : `来源无法打开。${result.error ?? ''}`,
        tone: result.ok ? 'success' : 'warning',
      });
    } catch (error) {
      if (activeVideoId.current === videoItem.id)
        setNotice({ text: displayError(error, '原视频打不开，请重试。'), tone: 'warning' });
    } finally {
      sourceOperation.finish();
    }
  }

  async function refreshReviewSession() {
    if (phaseRef.current !== 'active' || loading) return;
    setStepReceipt(null);
    const request = ++dueRequestRef.current;
    setLoading(true);
    setBusy(false);
    submittingRef.current = false;
    try {
      const at = clock();
      const summaries = await loadCategorySummaries(at).catch(() => null);
      if (request !== dueRequestRef.current || phaseRef.current !== 'active') return;

      let targetScope: ReviewScope =
        sessionCategoryId === undefined
          ? 'all'
          : sessionCategoryId === null
            ? 'uncategorized'
            : sessionCategoryId;
      let scopeChanged = false;
      if (
        summaries === null ||
        (typeof targetScope === 'string' &&
          targetScope !== 'all' &&
          targetScope !== 'uncategorized' &&
          !summaries.some((summary) => summary.category?.id === targetScope))
      ) {
        targetScope = 'all';
        scopeChanged = true;
      }
      const categoryId = categoryIdForReviewScope(targetScope);
      const dueItems = await loadDueItems(at, categoryId);
      if (request !== dueRequestRef.current || phaseRef.current !== 'active') return;

      setReviewScope(targetScope);
      setCategorySummaries(summaries ?? []);
      setEntryItems(createReviewSessionSnapshot(dueItems, null));
      setSessionItems([]);
      setSummary(createReviewSessionSummary(0));
      setRevealed(false);
      revealedRef.current = false;
      setReviewedAt(null);
      setPreview(null);
      setSelectedRating(null);
      setRefreshRequired(false);
      if (dueItems.length === 0) {
        moveCompanion({ type: 'ENTRY', hasDue: false });
        setSessionArt(null);
        transitionTo('entry');
        setNotice({
          text: '已刷新，没有要复习的了。',
          tone: 'success',
        });
        return;
      }

      startSession(dueItems, null, targetScope, summaries ?? []);
      setNotice({
        text: scopeChanged ? '分类已变更，已切回全部。' : '已刷新。',
        tone: 'success',
      });
    } catch (error) {
      if (request !== dueRequestRef.current || phaseRef.current !== 'active') return;
      setRefreshRequired(true);
      setNotice({
        text: displayError(error, '复习会话无法刷新。'),
        tone: 'error',
      });
    } finally {
      if (request === dueRequestRef.current) setLoading(false);
    }
  }

  async function continueReviewing() {
    if ((additionalDueCount ?? 0) <= 0 || completionCountLoading) return;
    const request = ++dueRequestRef.current;
    setCompletionCountLoading(true);
    try {
      const dueItems = await loadDueItems(clock(), sessionCategoryId);
      if (request !== dueRequestRef.current || phaseRef.current !== 'complete') return;
      if (dueItems.length === 0) {
        setAdditionalDueCount(0);
        setNotice({ text: '现在没有要复习的了。', tone: 'warning' });
        return;
      }
      startSession(dueItems, null);
    } catch (error) {
      if (request !== dueRequestRef.current || phaseRef.current !== 'complete') return;
      setNotice({
        text: displayError(error, '无法加载下一场到期会话。'),
        tone: 'error',
      });
    } finally {
      if (request === dueRequestRef.current && phaseRef.current === 'complete') {
        setCompletionCountLoading(false);
      }
    }
  }

  const initialLoading = loading && phase === 'entry';
  const hasError = notice?.tone === 'error';
  const progress = reviewSessionProgress(summary, sessionItems.length);
  let companionArt: ReviewCompanionArt;
  if (phase !== 'entry' && sessionArt) {
    companionArt = {
      outfit: sessionArt.outfit ?? undefined,
      dateKey: sessionArt.dateKey,
      hour: sessionArt.hour,
      // The card being answered: the reveal pose alternates per card within the session.
      cardIndex: progress.processed,
    };
  } else {
    companionArt = {
      outfit: undefined,
      dateKey: localDateKey(entryNow),
      hour: entryNow.getHours(),
      cardIndex: 0,
    };
  }

  return (
    <section
      ref={reviewRegionRef}
      className="stack review-view"
      data-review-session-phase={phase}
      data-reduced-motion={reducedMotion}
      aria-busy={initialLoading || completionCountLoading || (loading && phase === 'active')}
    >
      <ReviewStepFeedback receipt={stepReceipt} />
      {phase === 'entry' && (
        <h2 className="dashboard-page-heading sr-only" tabIndex={-1}>
          到期主动回忆
        </h2>
      )}

      {failedStart && phase === 'entry' && !entryLoadFailed && (
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => void retryRequestedSession()}
        >
          重试开始复习
        </button>
      )}
      {notice && !(refreshRequired && phase === 'active') && (
        <div className="motion-state-change" key={notice.text}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}

      {initialLoading ? (
        <div className="review-status-panel" role="status">
          <span className="review-state-mark" aria-hidden="true">
            …
          </span>
          <span>正在加载到期 Moment…</span>
        </div>
      ) : phase === 'entry' && entryLoadFailed ? (
        <div className="review-status-panel">
          <span className="review-state-mark" aria-hidden="true">
            !
          </span>
          <div className="stack-tight">
            <h3>复习内容没加载出来</h3>
            <button
              className="button"
              onClick={() => {
                if (failedStart) void retryRequestedSession();
                else setEntryRetry((value) => value + 1);
              }}
            >
              {failedStart ? '重试开始复习' : '重新加载'}
            </button>
          </div>
        </div>
      ) : phase === 'entry' ? (
        <ReviewEntry
          dueCount={entryItems.length}
          hasError={hasError}
          companionState={companionState}
          companionArt={companionArt}
          reducedMotion={reducedMotion}
          scopeSummaries={categorySummaries}
          scopeValue={reviewScope}
          nextReviewAt={reviewScopeSummary(reviewScope, categorySummaries)?.nextReviewAt ?? null}
          onScopeChange={setReviewScope}
          onStart={() => void startSelectedSession()}
          onGoHome={onGoHome}
          onViewUpcoming={onViewUpcoming}
        />
      ) : phase === 'complete' ? (
        <ReviewCompletion
          summary={summary}
          additionalDueCount={additionalDueCount}
          additionalDueLoading={completionCountLoading}
          hasError={hasError}
          companionState={companionState}
          companionArt={companionArt}
          reducedMotion={reducedMotion}
          headingRef={completionHeadingRef}
          allowanceLines={allowanceReceipt ? reviewAllowanceLines(allowanceReceipt) : []}
          reviewRewardTotal={reviewRewardTotal}
          onGoHome={onGoHome}
          onViewUpcoming={onViewUpcoming}
          onGoLibrary={onGoLibrary}
          onContinue={() => void continueReviewing()}
        />
      ) : item ? (
        <div
          className="review-stage"
          data-review-composition="immersive-reading"
          data-review-phase={revealed ? 'revealed' : 'prompt'}
          data-review-stage-owner={companionState.owner}
          data-review-stage-spatial={companionState.spatial}
        >
          <article
            ref={activeCardRef}
            className="review-card stack"
            key={item.id}
            data-review-card-state="active"
            data-review-stage-region="learning"
          >
            <div
              className="review-session-progress"
              aria-label={`Moment ${progress.current} / ${progress.total}`}
            >
              <div className="split">
                <h2
                  className={`dashboard-page-heading review-active-scope${
                    sessionCategoryId === undefined ? ' sr-only' : ''
                  }`}
                  tabIndex={-1}
                >
                  <span className="sr-only">范围：</span>
                  {sessionScopeLabel}
                </h2>
                <div className="review-session-tally">
                  {reviewRewardTotal > 0 && (
                    <span className="review-session-earned" key={reviewRewardTotal}>
                      本轮 +{reviewRewardTotal} 元
                    </span>
                  )}
                  <span className="review-session-count">
                    第 <strong>{progress.current}</strong> / {progress.total} 条
                  </span>
                </div>
              </div>
              <progress max={progress.total} value={progress.processed}>
                已完成 {progress.processed} / {progress.total}
              </progress>
            </div>
            <div className="split review-item-meta">
              <div className="cluster">
                <span className={`pill ${item.itemType}`}>{learningGoalLabel(item.itemType)}</span>
                {videoItem && (
                  <button
                    type="button"
                    className="button secondary small-button review-source-action"
                    disabled={busy || sourceOperation.busy}
                    onClick={() => void openSource()}
                  >
                    查看原视频
                  </button>
                )}
              </div>
              <button
                className="button text-button small-button review-mastered-action"
                type="button"
                disabled={busy || refreshRequired}
                aria-label="学成，以后不再复习这条 Moment"
                onClick={() => void markMastered()}
              >
                学成
              </button>
            </div>
            <ReviewCueRow
              companionState={companionState}
              companionArt={companionArt}
              statusLabel={
                busy
                  ? selectedRating
                    ? `正在保存 ${ratingLabel(selectedRating)}`
                    : '正在保存学成状态'
                  : refreshRequired
                    ? '保存未确认'
                    : ''
              }
              reducedMotion={reducedMotion}
              hasMediaCue={Boolean(imageItem || videoItem?.screenshotId)}
              media={
                imageItem ? (
                  <ItemThumbnail
                    screenshotId={imageItem.imageAssetId}
                    alt={`${imageItem.title} 的图片线索`}
                    className="screenshot image-moment-cue"
                    missingLabel="图片不可用"
                    showMissingLabel
                  />
                ) : videoItem?.screenshotId ? (
                  <figure
                    className="review-captured-frame review-recall-cue stack-tight"
                    data-review-cue-kind="captured-video"
                  >
                    <div className="review-video-cue-viewport" data-review-media-kind="video">
                      <ItemThumbnail
                        screenshotId={videoItem.screenshotId}
                        alt="这一刻的截取画面"
                        className="screenshot review-video-cue-image"
                        missingLabel="截图不可用"
                        showMissingLabel
                      />
                    </div>
                    <figcaption className="muted small">
                      {platformLabel(videoItem.platform)}
                      {videoItem.timestampDisplay ? ` · ${videoItem.timestampDisplay}` : ''}
                    </figcaption>
                  </figure>
                ) : null
              }
              prompt={
                <div className="review-prompt-block">
                  {!readingSource && !noteSource && (item.sourceType === 'text' || imageItem) && (
                    <p className="muted small">{learningItemTitle(item)}</p>
                  )}
                  <h3
                    className={`recall-prompt${readingSource ? ' reading-question' : ''}`}
                    ref={promptHeadingRef}
                    tabIndex={-1}
                  >
                    {item.recallPrompt}
                  </h3>
                </div>
              }
              answer={
                revealed && (
                  <div
                    className="stack review-answer-reveal motion-reveal"
                    id={`review-answer-${item.id}`}
                    ref={answerRegionRef}
                    role="region"
                    aria-label="关键收获"
                    tabIndex={-1}
                  >
                    <div className="answer-box">
                      <strong
                        className={`review-key-takeaway${readingSource ? ' reading-answer' : ''}`}
                      >
                        {keyTakeaway}
                      </strong>
                    </div>
                    {readingSource && <ReadingSourceDetails source={readingSource} />}
                    {noteSource && (
                      <details className="reading-source-details">
                        <summary>来源材料</summary>
                        <NoteContentView content={noteSource} />
                      </details>
                    )}
                    {capturedVideoItem && (
                      <SourceContextExcerpt
                        before={capturedVideoItem.subtitleBefore}
                        current={capturedVideoItem.subtitleCurrent}
                        after={capturedVideoItem.subtitleAfter}
                        className="review-subtitle-context"
                      />
                    )}
                    {videoItem && (
                      <SourceContextDisclosure
                        summary="来源详情"
                        summaryAriaLabel={`${platformLabel(videoItem.platform)} 的来源详情${videoItem.timestampDisplay ? `，时间 ${videoItem.timestampDisplay}` : ''}`}
                      >
                        <dl className="metadata">
                          <dt>平台</dt>
                          <dd>{platformLabel(videoItem.platform)}</dd>
                          <dt>标题</dt>
                          <dd>{videoItem.videoTitle}</dd>
                          {videoItem.uploader && (
                            <>
                              <dt>创作者</dt>
                              <dd>{videoItem.uploader}</dd>
                            </>
                          )}
                          {videoItem.timestampDisplay && (
                            <>
                              <dt>时间戳</dt>
                              <dd>{videoItem.timestampDisplay}</dd>
                            </>
                          )}
                        </dl>
                      </SourceContextDisclosure>
                    )}
                  </div>
                )
              }
              controls={
                <div
                  className={`review-control-deck${revealed ? ' review-rating-panel' : ' review-reveal-panel'}`}
                  data-review-stage-region="controls"
                >
                  {!revealed ? (
                    <button
                      className="button primary-action review-reveal-action"
                      ref={revealButtonRef}
                      aria-expanded={false}
                      aria-controls={`review-answer-${item.id}`}
                      onClick={revealAnswer}
                    >
                      揭晓答案
                    </button>
                  ) : (
                    <div className="stack-tight" role="group" aria-label="回忆得怎么样？">
                      <div className="rating-grid">
                        {FSRS_RATING_OPTIONS.map((option, index) => (
                          <button
                            className={`button motion-press${
                              selectedRating === option.value ? ' is-selected' : ''
                            }`}
                            data-rating={option.label.toLocaleLowerCase()}
                            aria-busy={busy && selectedRating === option.value}
                            aria-pressed={selectedRating === option.value}
                            aria-keyshortcuts={String(index + 1)}
                            disabled={!revealed || busy || refreshRequired}
                            key={option.label}
                            onClick={() => void rate(option.value)}
                            aria-label={`${option.label}，下次间隔 ${
                              reviewedAt && preview
                                ? formatFsrsInterval(reviewedAt, preview[option.value].nextDue)
                                : '暂不可用'
                            }，快捷键 ${index + 1}`}
                          >
                            <span>{option.label}</span>
                            <span className="rating-description">
                              {['没想起来', '费力想起', '正常想起', '轻松想起'][index]}
                            </span>
                            {reviewedAt && preview && (
                              <span className="rating-interval" aria-hidden="true">
                                {formatFsrsInterval(reviewedAt, preview[option.value].nextDue)}
                              </span>
                            )}
                            <kbd className="rating-shortcut" aria-hidden="true">
                              {index + 1}
                            </kbd>
                          </button>
                        ))}
                      </div>
                      {refreshRequired && (
                        <div className="stack-tight review-session-recovery">
                          <p className="review-save-status small">没保存成功，请刷新后重试。</p>
                          <div id="review-recovery-message">
                            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
                          </div>
                          <button
                            ref={recoveryButtonRef}
                            className="button secondary"
                            aria-describedby="review-recovery-message"
                            disabled={loading}
                            onClick={() => void refreshReviewSession()}
                          >
                            {loading ? '正在刷新复习会话…' : '刷新复习会话'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              }
            />
          </article>
        </div>
      ) : null}
    </section>
  );
}

function ReviewCueRow({
  companionState,
  companionArt,
  statusLabel,
  reducedMotion,
  hasMediaCue,
  media,
  prompt,
  answer,
  controls,
}: {
  companionState: ReviewCompanionState;
  companionArt: ReviewCompanionArt;
  statusLabel: string;
  reducedMotion: boolean;
  hasMediaCue: boolean;
  media: ReactNode;
  prompt: ReactNode;
  answer: ReactNode;
  controls: ReactNode;
}) {
  return (
    <div className="review-cue-row" data-review-cue={hasMediaCue ? 'media' : 'text'}>
      <aside
        className="review-cue-companion"
        data-review-cue-companion="true"
        aria-label={__VALRECALL_PUBLIC_RELEASE__ ? '复习提示' : '复习伙伴'}
      >
        <p className="sr-only" role="status">
          {statusLabel}
        </p>
        {companionState.dialogue ? (
          <ReviewSpeech dialogue={companionState.dialogue} variant="cue" />
        ) : (
          <p className="review-speech review-speech-placeholder" aria-hidden="true" />
        )}
        <ReviewCompanionPresentation
          state={companionState}
          art={companionArt}
          reducedMotion={reducedMotion}
          placement="cue"
        />
      </aside>
      <div className="review-reading-column">
        {hasMediaCue && media}
        {prompt}
        {answer}
        {controls}
      </div>
    </div>
  );
}

function ReviewSpeech({
  dialogue,
  variant,
}: {
  dialogue: NonNullable<ReviewCompanionState['dialogue']>;
  variant: 'entry' | 'cue' | 'completion';
}) {
  const cueBubbleClasses =
    variant === 'cue' ? ' review-companion-dialogue review-cue-dialogue' : '';
  return (
    <p
      className={`review-speech review-speech-${variant}${cueBubbleClasses}`}
      data-review-speech={variant}
      data-review-dialogue-intent={dialogue.intent}
      data-review-dialogue-level={dialogue.level}
      data-review-dialogue-origin={dialogue.origin}
      data-review-dialogue-lifetime={dialogue.lifetime}
      data-review-dialogue-sequence={dialogue.sequence}
    >
      {dialogue.text}
    </p>
  );
}

function ReviewCompanionPresentation({
  state,
  art,
  reducedMotion,
  placement = 'stage',
  stageRegion = true,
}: {
  state: ReviewCompanionState;
  art: ReviewCompanionArt;
  reducedMotion: boolean;
  placement?: 'stage' | 'cue';
  stageRegion?: boolean;
}) {
  const { hour, dateKey, cardIndex } = art;
  // The art keys on the scene, not the macro: ENTRY with reviews due and PROMPT share 'due'.
  const layers = useMemo(
    () =>
      COMPANION_ASSETS_ENABLED ? reviewCompanionLayers({ hour, dateKey, cardIndex }) : undefined,
    [hour, dateKey, cardIndex],
  );
  const activeLayer = COMPANION_ASSETS_ENABLED
    ? reviewArtSlot(state.scene, state.macro)
    : undefined;
  return (
    <div
      className={`review-companion-viewport review-companion-scene-${state.scene.toLocaleLowerCase()} review-companion-reaction-${state.reaction} review-companion-intensity-${state.intensity} review-companion-spatial-${state.spatial}${placement === 'cue' ? ' review-companion-cue' : ''}`}
      data-review-companion-scene={state.scene}
      data-review-companion-reaction={state.reaction}
      data-review-companion-priority={state.priority}
      data-review-companion-spatial={state.spatial}
      data-review-stage-owner={state.owner}
      data-review-companion-sequence={state.sequence}
      data-review-companion-reduced-motion={reducedMotion}
      data-review-stage-region={stageRegion ? 'companion' : undefined}
      aria-hidden="true"
    >
      <Companion
        state={state.macro}
        compact={state.spatial !== 'hero'}
        placement="review"
        message={null}
        outfit={art.outfit}
        dateKey={dateKey}
        layers={layers}
        activeLayer={activeLayer}
      />
    </div>
  );
}

function ReviewScopePicker({
  summaries,
  value,
  onChange,
}: {
  summaries: CategorySummary[];
  value: ReviewScope;
  onChange: (scope: ReviewScope) => void;
}) {
  const [query, setQuery] = useState('');
  const categories = summaries
    .map((summary) => summary.category)
    .filter((category): category is MomentCategory => category !== null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matching = categories.filter(
    (category) => !normalizedQuery || category.name.toLocaleLowerCase().includes(normalizedQuery),
  );
  const visible = matching.slice(0, CATEGORY_PICKER_VISIBLE_LIMIT);
  const selected = categories.find((category) => category.id === value);
  if (selected && !visible.some((category) => category.id === selected.id)) {
    visible.unshift(selected);
  }
  const summaryFor = (categoryId: string | null) =>
    summaries.find((summary) => summary.category?.id === categoryId) ??
    (categoryId === null ? summaries.find((summary) => summary.category === null) : undefined);

  return (
    <section className="review-scope-picker" aria-label="按分类复习">
      <label className="field">
        <span>分类</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="all">全部</option>
          <option value="uncategorized">未分类（{summaryFor(null)?.dueCount ?? 0} 条到期）</option>
          {visible.map((category) => (
            <option value={category.id} key={category.id}>
              {category.name}（{summaryFor(category.id)?.dueCount ?? 0} 条到期）
            </option>
          ))}
        </select>
      </label>
      {(categories.length > CATEGORY_PICKER_VISIBLE_LIMIT || query.length > 0) && (
        <label className="field">
          <span className="sr-only">搜索要复习的分类</span>
          <input
            type="search"
            value={query}
            placeholder="搜索分类"
            onChange={(event) => setQuery(event.target.value)}
          />
          <small className="field-help">
            显示 {Math.min(matching.length, CATEGORY_PICKER_VISIBLE_LIMIT)} / {matching.length}
          </small>
        </label>
      )}
    </section>
  );
}

function categoryIdForReviewScope(scope: ReviewScope): string | null | undefined {
  if (scope === 'all') return undefined;
  if (scope === 'uncategorized') return null;
  return scope;
}

function reviewScopeSummary(
  scope: ReviewScope,
  summaries: readonly CategorySummary[],
): CategorySummary | undefined {
  if (scope === 'all') return undefined;
  if (scope === 'uncategorized') return summaries.find((summary) => summary.category === null);
  return summaries.find((summary) => summary.category?.id === scope);
}

function reviewScopeLabel(scope: ReviewScope, summaries: readonly CategorySummary[]): string {
  if (scope === 'all') return '全部到期';
  if (scope === 'uncategorized') return '未分类';
  return summaries.find((summary) => summary.category?.id === scope)?.category?.name ?? '分类';
}

function ReviewEntry({
  dueCount,
  hasError,
  companionState,
  companionArt,
  reducedMotion,
  scopeSummaries,
  scopeValue,
  nextReviewAt,
  onScopeChange,
  onStart,
  onGoHome,
  onViewUpcoming,
}: {
  dueCount: number;
  hasError: boolean;
  companionState: ReviewCompanionState;
  companionArt: ReviewCompanionArt;
  reducedMotion: boolean;
  scopeSummaries: CategorySummary[];
  scopeValue: ReviewScope;
  nextReviewAt: Date | null;
  onScopeChange: (scope: ReviewScope) => void;
  onStart: () => void;
  onGoHome: () => void;
  onViewUpcoming: () => void;
}) {
  const freshInstall = __VALRECALL_PUBLIC_RELEASE__ ? useFreshInstall(0, repository) : false;
  return (
    <div
      className="review-entry-layout motion-state-change"
      data-review-composition="immersive-reading"
      data-review-phase="entry"
    >
      {!hasError && (
        <div className="review-entry-companion" data-review-stage-region="companion">
          {companionState.dialogue && (
            <ReviewSpeech dialogue={companionState.dialogue} variant="entry" />
          )}
          <ReviewCompanionPresentation
            state={companionState}
            art={companionArt}
            reducedMotion={reducedMotion}
            stageRegion={false}
          />
        </div>
      )}
      <div className="card review-entry-card stack-tight" data-review-stage-region="learning">
        <div className="review-entry-summary stack-tight">
          {dueCount > 0 ? (
            <h3>{dueCount} 条到期 Moment</h3>
          ) : (
            <>
              <h3>
                {__VALRECALL_PUBLIC_RELEASE__ && freshInstall !== false
                  ? freshInstall
                    ? '还没有内容'
                    : '这里没有到期内容'
                  : scopeValue === 'all'
                    ? '都跟上了'
                    : '这里没有到期内容'}
              </h3>
              {__VALRECALL_PUBLIC_RELEASE__ && freshInstall === true ? (
                <p className="muted">先存一条内容。到时间，这里会提醒你复习。</p>
              ) : (
                nextReviewAt &&
                nextReviewAt.getTime() > Date.now() && (
                  <p className="muted">下次复习：{formatDateTime(nextReviewAt)}</p>
                )
              )}
            </>
          )}
        </div>
        <ReviewScopePicker summaries={scopeSummaries} value={scopeValue} onChange={onScopeChange} />
      </div>
      <div
        className="review-control-deck review-entry-controls"
        data-review-stage-region="controls"
      >
        {dueCount > 0 ? (
          <button className="button primary-action" onClick={onStart}>
            开始复习
          </button>
        ) : __VALRECALL_PUBLIC_RELEASE__ && freshInstall === true ? (
          <div className="cluster">
            <button className="button motion-press" onClick={requestAddQuestion}>
              添加回忆题
            </button>
            <button className="button secondary motion-press" onClick={onGoHome}>
              返回首页
            </button>
          </div>
        ) : (
          <div className="cluster">
            <button className="button motion-press" onClick={onViewUpcoming}>
              查看即将到期
            </button>
            <button className="button secondary motion-press" onClick={onGoHome}>
              返回首页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewCompletion({
  summary,
  additionalDueCount,
  additionalDueLoading,
  hasError,
  companionState,
  companionArt,
  reducedMotion,
  headingRef,
  allowanceLines = [],
  reviewRewardTotal,
  onGoHome,
  onViewUpcoming,
  onGoLibrary,
  onContinue,
}: {
  summary: ReviewSessionSummary;
  additionalDueCount: number | null;
  additionalDueLoading: boolean;
  hasError: boolean;
  companionState: ReviewCompanionState;
  companionArt: ReviewCompanionArt;
  reducedMotion: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  allowanceLines?: readonly string[];
  reviewRewardTotal: number;
  onGoHome: () => void;
  onViewUpcoming: () => void;
  onGoLibrary: () => void;
  onContinue: () => void;
}) {
  const total = reviewedTotal(summary);
  const masteredCount = summary.masteredItemIds.length;
  const skippedCount = summary.unavailableItemIds.length;
  return (
    <div
      className="review-complete-layout"
      data-review-composition="immersive-reading"
      data-review-phase="complete"
    >
      {!hasError && (
        <div className="review-complete-companion" data-review-stage-region="companion">
          {companionState.dialogue && (
            <ReviewSpeech dialogue={companionState.dialogue} variant="completion" />
          )}
          <ReviewCompanionPresentation
            state={companionState}
            art={companionArt}
            reducedMotion={reducedMotion}
            stageRegion={false}
          />
        </div>
      )}
      <div
        className="card review-complete-copy stack motion-enter"
        data-review-stage-region="learning"
      >
        <div>
          <h2 ref={headingRef} tabIndex={-1}>
            本轮结束
          </h2>
          {allowanceLines.length > 0 && (
            <div className="review-allowance-copy stack-tight" data-review-allowance="true">
              {allowanceLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
          {reviewRewardTotal > 0 && (
            <p className="review-earned-total">本轮 +{reviewRewardTotal} 元</p>
          )}
        </div>
        <dl className="review-session-results">
          <div>
            <dt>已复习总数</dt>
            <dd>{total}</dd>
          </div>
          <div>
            <dt>Again</dt>
            <dd>{summary.ratingCounts.again}</dd>
          </div>
          <div>
            <dt>Hard</dt>
            <dd>{summary.ratingCounts.hard}</dd>
          </div>
          <div>
            <dt>Good</dt>
            <dd>{summary.ratingCounts.good}</dd>
          </div>
          <div>
            <dt>Easy</dt>
            <dd>{summary.ratingCounts.easy}</dd>
          </div>
        </dl>
        {(summary.earliestNextDue || masteredCount > 0 || skippedCount > 0) && (
          <div className="review-session-next stack-tight">
            {summary.earliestNextDue && (
              <>
                <span className="muted small">最早下次复习</span>
                <time dateTime={summary.earliestNextDue.toISOString()}>
                  {formatDateTime(summary.earliestNextDue)}
                </time>
              </>
            )}
            {masteredCount > 0 && <span className="muted small">{masteredCount} 条已学成</span>}
            {skippedCount > 0 && <span className="muted small">{skippedCount} 条已跳过</span>}
          </div>
        )}
        <p className="review-additional-due" role="status">
          {!additionalDueLoading && additionalDueCount !== null && additionalDueCount > 0
            ? `又有 ${additionalDueCount} 条到期了。`
            : ''}
        </p>
      </div>
      <div
        className="review-control-deck review-complete-actions"
        data-review-stage-region="controls"
      >
        <div className="cluster">
          <button className="button motion-press" onClick={onGoHome}>
            返回首页
          </button>
          <button className="button secondary motion-press" onClick={onViewUpcoming}>
            查看即将到期
          </button>
          {additionalDueCount !== null && additionalDueCount > 0 && (
            <button
              className="button amber motion-press"
              disabled={additionalDueLoading}
              onClick={onContinue}
            >
              继续复习
            </button>
          )}
          <button className="button secondary motion-press" onClick={onGoLibrary}>
            打开资料库
          </button>
        </div>
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function ratingLabel(rating: FsrsRatingInput): string {
  return (
    FSRS_RATING_OPTIONS.find((option) => option.value === toFsrsRating(rating))?.label ?? 'Review'
  );
}

export function prioritizeDueItem(
  items: readonly LearningItem[],
  preferredItemId: string | null,
): LearningItem[] {
  return createReviewSessionSnapshot(items, preferredItemId);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { Rating, createEmptyCard, fsrs } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ValRecallRepository,
  reviewSchedulingStateFromCard,
  type CategorySummary,
  type ImageLearningItem,
  type LearningItem,
  type TextLearningItem,
  type VideoLearningItem,
} from '../database';
import {
  FsrsService,
  toFsrsRating,
  type FsrsPreview,
  type Grade,
  type PersistedFsrsReviewResult,
} from '../fsrs';
import { CHECK_IN_PRAISES, DEFAULT_ALLOWANCE } from '../shared/allowance';
import { requestEditorLeave } from '../shared/edit-protection';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { ReviewSessionService } from '../fsrs/ReviewSessionService';
import { WalletRepository } from '../database/wallet';
import { STORE_NAMES } from '../database/migrations';
import { repository as dashboardRepository } from './services';
import { COMPLETE_POOL, ENTRY_POOL, PROMPT_POOL, REVEAL_POOL } from './review-companion-copy';
import { CompanionWardrobeProvider } from '../companion/CompanionWardrobe';
import {
  idlePoseForHour,
  invitePose,
  revealPose,
  reviewCompletePose,
} from '../companion/companion-scenes';
import { companionArtPath, outfitForDate, type CompanionOutfit } from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import {
  TodayView,
  type DueItemsLoader,
  type ReviewItem,
  type ReviewStartRequest,
  type ReviewAllowanceRecorder,
  type SuspendItem,
} from './TodayView';

const extensionMocks = vi.hoisted(() => ({
  openSourceAtTimestamp: vi.fn(),
  refreshReviewReminders: vi.fn(),
}));

vi.mock('../shared/extension', () => ({
  displayError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  openSourceAtTimestamp: extensionMocks.openSourceAtTimestamp,
  refreshReviewReminders: extensionMocks.refreshReviewReminders,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-07-21T12:00:00.000Z');
const nextDue = new Date('2026-07-24T12:00:00.000Z');

function item(id: string): VideoLearningItem {
  return {
    id,
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: `https://www.bilibili.com/video/${id}`,
    canonicalUrl: null,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: '',
    situation: 'A test situation',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: 'Take the action',
    reason: 'It is useful',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function textItem(id: string): TextLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'text',
    title: `Text lesson ${id}`,
    categoryId: null,
    itemType: 'Understand',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: ['text'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function imageItem(id: string): ImageLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'image',
    title: `Image lesson ${id}`,
    imageAssetId: `image-${id}`,
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: ['image'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function reviewResultFor(
  learningItem: LearningItem,
  rating: Grade = Rating.Good,
  due: Date = nextDue,
): PersistedFsrsReviewResult {
  const scheduled = fsrs().next(learningItem.fsrsCard, now, rating);
  const card = { ...scheduled.card, due };
  return {
    rating,
    card,
    log: scheduled.log,
    nextDue: due,
    itemId: learningItem.id,
    reviewRecord: {
      id: `review-${learningItem.id}`,
      itemId: learningItem.id,
      reviewedAt: now,
      log: scheduled.log,
    },
  };
}

function reviewResult(learningItem: LearningItem): PersistedFsrsReviewResult {
  return reviewResultFor(learningItem);
}

describe('TodayView', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreVisibility: () => void;

  beforeEach(() => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    restoreVisibility = () => {
      visibility.mockRestore();
      hidden.mockRestore();
    };
    extensionMocks.openSourceAtTimestamp.mockReset().mockResolvedValue({
      ok: true,
      attempts: 1,
      timestampSeconds: 42,
      error: null,
      diagnostics: [],
    });
    extensionMocks.refreshReviewReminders.mockReset().mockResolvedValue({ ok: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    restoreVisibility();
  });

  it('consumes an explicit start once, prioritizes the target and keeps the full queue without rewards', async () => {
    const recordReviewAllowance = vi.fn(async () => null);
    const consumed = vi.fn();
    const reviewItem = vi.fn();
    await renderView({
      items: [item('a'), item('b')],
      reviewItem,
      autoStart: false,
      startRequest: { key: 1, preferredItemId: 'b' },
      onStartRequestConsumed: consumed,
      recordReviewAllowance,
    });
    expect(container.textContent).toContain('Recall b');
    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).toContain('范围：全部到期');
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(recordReviewAllowance).not.toHaveBeenCalled();
    expect(reviewItem).not.toHaveBeenCalled();
    expect(button('揭晓答案')).toBeDefined();
    expect(
      container
        .querySelector('[data-review-session-phase]')
        ?.getAttribute('data-review-session-phase'),
    ).toBe('active');
  });

  it('does not substitute another card when the requested Moment is no longer due', async () => {
    const recordReviewAllowance = vi.fn(async () => null);
    await renderView({
      items: [item('other')],
      reviewItem: vi.fn(),
      autoStart: false,
      startRequest: { key: 2, preferredItemId: 'missing' },
      recordReviewAllowance,
    });
    expect(container.textContent).toContain('这条 Moment 现在不用复习。');
    expect(button('揭晓答案')).toBeUndefined();
    expect(recordReviewAllowance).not.toHaveBeenCalled();
  });

  it('conceals note original/user/AI evidence and title until Reveal', async () => {
    const first = {
      ...textItem('note-source'),
      title: '标题中的答案',
      noteSource: {
        schemaVersion: 1 as const,
        noteId: 'n1',
        title: '笔记标题',
        excerpt: '原文秘密',
        thought: '感想秘密',
        summary: '摘要秘密',
        aiAdditions: '补充秘密',
        bookTitle: '书名秘密',
        location: '42',
      },
    };
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));
    await renderView({ items: [first], reviewItem });
    for (const hidden of [
      first.title,
      first.noteSource.excerpt,
      first.noteSource.thought,
      first.noteSource.summary,
      first.noteSource.aiAdditions,
      first.coreLesson,
    ])
      expect(container.textContent).not.toContain(hidden);
    expect(button('Good')?.disabled ?? true).toBe(true);
    act(() => button('揭晓答案')?.click());
    expect(container.textContent).toContain(first.noteSource.excerpt);
    expect(container.textContent).toContain(first.noteSource.aiAdditions);
    expect(container.querySelector('.reading-source-details')?.hasAttribute('open')).toBe(false);
    expect(reviewItem).not.toHaveBeenCalled();
  });

  it('conceals reading evidence and title until Reveal, then advances directly to the next prompt', async () => {
    const first = {
      ...textItem('reading-first'),
      title: '标题中含有答案',
      readingSource: {
        schemaVersion: 1 as const,
        excerpt: '这是原文证据',
        bookTitle: '测试书名',
        location: '42',
      },
    };
    const second = {
      ...textItem('reading-second'),
      readingSource: { ...first.readingSource, excerpt: '第二条的原文' },
    };
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));
    await renderView({ items: [first, second], reviewItem });
    const promptSpeech = container.querySelector('[data-review-speech="cue"]')?.textContent;
    expect(container.textContent).toContain(first.recallPrompt);
    for (const hidden of [
      first.title,
      first.coreLesson,
      first.referenceAnswer,
      first.readingSource.excerpt,
      first.readingSource.bookTitle,
    ])
      expect(container.textContent).not.toContain(hidden);
    expect(button('Good')?.disabled ?? true).toBe(true);
    expect(reviewItem).not.toHaveBeenCalled();
    act(() => button('揭晓答案')?.click());
    expect(container.querySelector('.review-key-takeaway')?.textContent).toBe(first.coreLesson);
    expect(container.querySelector('.reading-source-details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.reading-excerpt')?.textContent).toBe(
      first.readingSource.excerpt,
    );
    await act(async () => button('Good')?.click());
    expect(reviewItem).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(second.recallPrompt);
    expect(container.querySelector('.reading-source-details')).toBeNull();
    expect(button('揭晓答案')).toBeDefined();
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.querySelector('[data-review-speech="cue"]')?.textContent).not.toBe(
      promptSpeech,
    );
  });

  it('allows explicit retry after loading fails without starting or awarding an empty session', async () => {
    const loadDueItems = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValue([item('retry')]);
    const recordReviewAllowance = vi.fn(async () => null);
    await renderView({
      items: [],
      loadDueItems,
      reviewItem: vi.fn(),
      autoStart: false,
      startRequest: { key: 3, preferredItemId: null },
      recordReviewAllowance,
    });
    expect(container.textContent).toContain('Temporary failure');
    await act(async () => button('重试开始复习')?.click());
    expect(container.textContent).toContain('Recall retry');
    expect(recordReviewAllowance).not.toHaveBeenCalled();
  });

  it('keeps an empty explicit start at the entry without recording a completion', async () => {
    const recordReviewAllowance = vi.fn(async () => null);
    await renderView({
      items: [],
      reviewItem: vi.fn(),
      autoStart: false,
      startRequest: { key: 4, preferredItemId: null },
      recordReviewAllowance,
    });
    expect(button('揭晓答案')).toBeUndefined();
    expect(container.textContent).toContain('都跟上了');
    expect(recordReviewAllowance).not.toHaveBeenCalled();
  });

  it('shows the due count before starting and moves focus into a fixed session', async () => {
    const first = item('entry-first');
    const second = item('entry-second');

    await renderView({
      items: [first, second],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(first)),
      autoStart: false,
    });

    expect(container.textContent).toContain('2 条到期 Moment');
    expect(container.textContent).not.toContain('Recall entry-first');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('ENTRY');
    expect(
      container
        .querySelector('[data-review-companion-spatial]')
        ?.getAttribute('data-review-companion-spatial'),
    ).toBe('hero');
    expect(
      container.querySelector('[data-review-stage-owner]')?.getAttribute('data-review-stage-owner'),
    ).toBe('companion');
    const entryLayout = container.querySelector('.review-entry-layout');
    const entryCompanion = entryLayout?.querySelector('[data-review-stage-region="companion"]');
    const entryStage = entryCompanion?.querySelector('.review-companion-viewport');
    const entryLearningCanvas = entryLayout?.querySelector('[data-review-stage-region="learning"]');
    const entryControls = entryLayout?.querySelector('[data-review-stage-region="controls"]');
    expect(entryLayout?.getAttribute('data-review-composition')).toBe('immersive-reading');
    expect(entryLayout?.getAttribute('data-review-phase')).toBe('entry');
    expect(entryLayout?.firstElementChild).toBe(entryCompanion);
    expect(entryCompanion?.nextElementSibling).toBe(entryLearningCanvas);
    expect(entryLearningCanvas?.nextElementSibling).toBe(entryControls);
    expect(entryCompanion?.getAttribute('data-review-stage-region')).toBe('companion');
    expect(
      entryCompanion?.querySelector('[data-review-dialogue-intent="invitation"]'),
    ).not.toBeNull();
    expect(
      entryStage?.contains(
        entryCompanion?.querySelector('[data-review-dialogue-intent="invitation"]') ?? null,
      ),
    ).toBe(false);
    expect(entryLearningCanvas?.querySelector('.review-scope-picker')).not.toBeNull();
    expect(container.querySelector('.review-scope-picker')?.parentElement).toBe(
      entryLearningCanvas,
    );
    expect(button('开始复习')?.closest('[data-review-stage-region="controls"]')).toBe(
      entryControls,
    );
    expect(container.querySelector('[data-review-speech="entry"]')?.textContent).toBe(
      ENTRY_POOL[0],
    );
    expect(container.querySelector('[data-review-speech="entry"]')?.textContent).toBeTruthy();
    expect(
      container
        .querySelector('[data-review-speech="entry"]')
        ?.closest('.review-companion-viewport'),
    ).toBeNull();
    expect(container.querySelector('[data-review-dialogue-intent="invitation"]')?.textContent).toBe(
      ENTRY_POOL[0],
    );
    expect(
      container.querySelector('[data-review-dialogue-intent="invitation"]')?.textContent,
    ).toBeTruthy();
    const entryInvitation = entryCompanion?.querySelector(
      '[data-review-dialogue-intent="invitation"]',
    );
    expect(entryInvitation).not.toBeNull();
    expect(entryStage).not.toBeNull();
    if (entryInvitation && entryStage) {
      expect(
        entryInvitation.compareDocumentPosition(entryStage) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }

    act(() => button('开始复习')?.click());

    expect(container.textContent).toContain('Recall entry-first');
    expect(container.textContent).toContain('1 / 2');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.querySelector('.review-companion-spatial-compact')).not.toBeNull();
    expect(
      container
        .querySelector('[data-review-companion-spatial]')
        ?.getAttribute('data-review-companion-spatial'),
    ).toBe('compact');
    expect(container.querySelector('.review-stage')?.getAttribute('data-review-stage-owner')).toBe(
      'recall-content',
    );
    const activeStage = container.querySelector('.review-stage');
    const activeLearningCanvas = activeStage?.querySelector(
      '[data-review-stage-region="learning"]',
    );
    const activeControls = activeStage?.querySelector('[data-review-stage-region="controls"]');
    expect(activeStage?.getAttribute('data-review-phase')).toBe('prompt');
    expect(container.querySelector('.review-view')?.getAttribute('data-review-session-phase')).toBe(
      'active',
    );
    expectCueSpriteLayout(container);
    expect(activeLearningCanvas?.classList.contains('review-card')).toBe(true);
    expect(
      activeLearningCanvas?.querySelector('.review-cue-row')?.getAttribute('data-review-cue'),
    ).toBe('text');
    expect(button('揭晓答案')?.closest('[data-review-stage-region="controls"]')).toBe(
      activeControls,
    );
    expect(container.querySelector('[data-review-dialogue-intent="invitation"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[0],
    );
    expect(container.querySelector('[data-review-speech="cue"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('揭晓答案');

    act(() => button('揭晓答案')?.click());
    expect(container.querySelector('[data-review-dialogue-intent="invitation"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="reveal"]')?.textContent).toBe(
      REVEAL_POOL[0],
    );
    expect(container.querySelector('[data-review-dialogue-intent="discovery"]')).not.toBeNull();
  });

  it('replaces the Entry invitation with a card-specific PROMPT line', async () => {
    const learningItem = item('invitation-lifetime');
    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
      autoStart: false,
    });

    expect(container.querySelector('[data-review-dialogue-intent="invitation"]')).not.toBeNull();
    act(() => button('开始复习')?.click());
    expect(container.querySelector('[data-review-dialogue-intent="invitation"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[0],
    );
    expect(container.querySelector('.review-companion-spatial-compact')).not.toBeNull();
    expect(container.textContent).toContain('Recall invitation-lifetime');
  });

  it('distinguishes entry load failure from an empty queue and retries without starting or awarding', async () => {
    const loadDueItems = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce([item('retry-entry')]);
    const reviewItem = vi.fn<ReviewItem>();
    const recordReviewAllowance = vi.fn(async () => null);
    await renderView({
      items: [],
      reviewItem,
      loadDueItems,
      recordReviewAllowance,
      autoStart: false,
    });
    expect(container.textContent).toContain('复习内容没加载出来');
    expect(container.textContent).not.toContain('都跟上了');
    expect(container.textContent).not.toContain('0 条已选');
    expect(container.querySelector('.companion-success')).toBeNull();
    expect(button('开始复习')).toBeUndefined();
    await act(async () => {
      button('重新加载')?.click();
    });
    expect(loadDueItems).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('1 条到期 Moment');
    expect(container.querySelector('.review-card')).toBeNull();
    expect(reviewItem).not.toHaveBeenCalled();
    expect(recordReviewAllowance).not.toHaveBeenCalled();
  });

  it('shows a useful empty state and opens Upcoming without starting a session', async () => {
    const onViewUpcoming = vi.fn();
    await renderView({
      items: [],
      reviewItem: vi.fn<ReviewItem>(),
      onViewUpcoming,
      autoStart: false,
    });

    expect(container.textContent).toContain('都跟上了');
    expect(button('开始复习')).toBeUndefined();
    expect(container.querySelector('.review-card')).toBeNull();

    act(() => button('查看即将到期')?.click());
    expect(onViewUpcoming).toHaveBeenCalledOnce();
  });

  it('preserves reveal gating and passes the selected rating unchanged to reviewItem', async () => {
    const learningItem = item('review-me');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    const onChanged = vi.fn();
    const onGoHome = vi.fn();
    const onGoLibrary = vi.fn();
    const onViewUpcoming = vi.fn();

    await renderView({
      items: [learningItem],
      reviewItem,
      onChanged,
      onGoHome,
      onGoLibrary,
      onViewUpcoming,
    });

    expect(button('Good')).toBeUndefined();
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    act(() => button('揭晓答案')?.click());
    expect(button('Good')).toBeDefined();
    expect(button('Good')?.closest('[data-review-stage-region="controls"]')).not.toBeNull();
    expect(button('Good')?.closest('.review-reading-column')).not.toBeNull();
    expect(button('Good')?.closest('[data-review-stage-region="companion"]')).toBeNull();
    expect(container.querySelector('.review-stage')?.getAttribute('data-review-phase')).toBe(
      'revealed',
    );
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
      'reviewing',
    );

    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(reviewItem).toHaveBeenCalledWith(
      'review-me',
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
    expect(extensionMocks.refreshReviewReminders).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('本轮结束');
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.textContent).not.toContain('已保存 Good');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
      'success',
    );

    act(() => button('返回首页')?.click());
    act(() => button('查看即将到期')?.click());
    act(() => button('打开资料库')?.click());
    expect(onGoHome).toHaveBeenCalledOnce();
    expect(onViewUpcoming).toHaveBeenCalledOnce();
    expect(onGoLibrary).toHaveBeenCalledOnce();
  });

  it('never flashes success after a normal rating and establishes the next prompt as due', async () => {
    vi.useFakeTimers();
    const first = item('first');
    const second = item('second');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));

    await renderView({
      items: [first, second],
      reviewItem,
    });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Recall second');
    expect(container.textContent).not.toContain('Recall first');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    // The second card's question is the still recall slot, never the success art.
    expect(container.querySelector('.companion')?.getAttribute('data-companion-slot')).toBe(
      'recall',
    );
    expect(container.querySelector('.companion')?.getAttribute('data-companion-motion')).toBe(
      'static',
    );
    expect(container.querySelector('.companion-success')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(button('下一题 →')).toBeUndefined();
    expect(button('揭晓答案')).toBeDefined();

    expect(container.textContent).toContain('Recall second');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[1],
    );
    expect(container.querySelector('.companion-success')).toBeNull();

    act(() => vi.advanceTimersByTime(280));
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');

    act(() => button('揭晓答案')?.click());
    const currentSequence = container
      .querySelector('[data-review-companion-sequence]')
      ?.getAttribute('data-review-companion-sequence');
    act(() => vi.advanceTimersByTime(420));
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
      'reviewing',
    );
    // The second card reveals with the other pose.
    expect(container.querySelector('.companion')?.getAttribute('data-companion-slot')).toBe(
      'reveal',
    );
    expect(container.querySelector('.companion')?.getAttribute('data-companion-pose')).toBe('note');
    expect(
      container
        .querySelector('[data-review-companion-sequence]')
        ?.getAttribute('data-review-companion-sequence'),
    ).toBe(String(Number(currentSequence) + 1));
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('REVEALED');
    expect(container.querySelector('.review-companion-spatial-yield')).not.toBeNull();
  });

  it('reveals the answer immediately while the reviewing companion briefly owns HERO and then yields', async () => {
    vi.useFakeTimers();
    const learningItem = item('stage-reveal');
    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });

    const revealButton = button('揭晓答案');
    expect(document.activeElement).toBe(revealButton);
    act(() => revealButton?.click());

    expect(container.querySelector('.review-key-takeaway')?.textContent).toBe('Core stage-reveal');
    expect(document.activeElement).toBe(container.querySelector('.review-answer-reveal'));
    expect(document.activeElement?.getAttribute('role')).toBe('region');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关键收获');
    expect(button('Good')).toBeDefined();
    const revealedStage = container.querySelector('.review-stage');
    const revealedLearning = revealedStage?.querySelector('[data-review-stage-region="learning"]');
    const revealedControls = revealedStage?.querySelector('[data-review-stage-region="controls"]');
    expect(revealedStage?.getAttribute('data-review-phase')).toBe('revealed');
    expectCueSpriteLayout(container);
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="reveal"]')?.textContent).toBe(
      REVEAL_POOL[0],
    );
    expect(revealedLearning?.querySelector('.answer-box .review-key-takeaway')).not.toBeNull();
    expect(revealedControls?.querySelector('.rating-grid')).not.toBeNull();
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('REVEAL_TRANSITION');
    expect(container.querySelector('.review-stage')?.getAttribute('data-review-stage-owner')).toBe(
      'companion',
    );
    expect(container.querySelector('.review-companion-spatial-hero')).not.toBeNull();

    act(() => vi.advanceTimersByTime(219));
    expect(container.querySelector('.review-key-takeaway')?.textContent).toBe('Core stage-reveal');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('REVEAL_TRANSITION');

    act(() => vi.advanceTimersByTime(1));
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('REVEALED');
    expect(container.querySelector('.review-stage')?.getAttribute('data-review-stage-owner')).toBe(
      'key-takeaway',
    );
    expect(container.querySelector('.review-companion-spatial-yield')).not.toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="reveal"]')?.textContent).toBe(
      REVEAL_POOL[0],
    );
  });

  it('writes the rating on commit and immediately opens the next prompt without a second write', async () => {
    const first = item('commit-once');
    const second = item('after-commit');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));
    await renderView({ items: [first, second], reviewItem });

    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(reviewItem).toHaveBeenCalledWith(
      first.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(first.fsrsCard),
    );
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(container.textContent).toContain('Recall after-commit');
    expect(container.textContent).not.toContain('Recall commit-once');
    expect(button('下一题 →')).toBeUndefined();
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[1],
    );
    expectCueSpriteLayout(container);
  });

  it('shows fresh PROMPT, Reveal, next-PROMPT, and COMPLETED speech', async () => {
    const first = item('speech-first');
    const second = item('speech-last');
    const reviewItem = vi
      .fn<ReviewItem>()
      .mockImplementationOnce(async () => reviewResult(first))
      .mockImplementationOnce(async () => reviewResult(second));
    await renderView({
      items: [first, second],
      reviewItem,
      autoStart: false,
    });

    const entrySpeech = container.querySelector('[data-review-speech="entry"]');
    expect(entrySpeech?.textContent).toBeTruthy();
    expect(entrySpeech?.closest('.review-companion-viewport')).toBeNull();

    act(() => button('开始复习')?.click());
    const firstPromptSpeech = container.querySelector('[data-review-dialogue-origin="prompt"]');
    expect(firstPromptSpeech?.textContent).toBe(PROMPT_POOL[0]);
    expect(firstPromptSpeech?.getAttribute('data-review-speech')).toBe('cue');
    expect(firstPromptSpeech?.closest('.review-companion-viewport')).toBeNull();
    expectCueSpriteLayout(container);

    act(() => button('揭晓答案')?.click());
    const firstRevealSpeech = container.querySelector('[data-review-dialogue-origin="reveal"]');
    expect(firstRevealSpeech?.textContent).toBe(REVEAL_POOL[0]);
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')).toBeNull();
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-review-speech="reaction"]')).toBeNull();
    expect(button('下一题 →')).toBeUndefined();
    const secondPromptSpeech = container.querySelector('[data-review-dialogue-origin="prompt"]');
    expect(secondPromptSpeech?.textContent).toBe(PROMPT_POOL[1]);
    expect(secondPromptSpeech?.textContent).not.toBe(firstPromptSpeech?.textContent);
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="reveal"]')).toBeNull();
    act(() => button('揭晓答案')?.click());
    const secondRevealSpeech = container.querySelector('[data-review-dialogue-origin="reveal"]');
    expect(secondRevealSpeech?.textContent).toBe(REVEAL_POOL[1]);
    expect(secondRevealSpeech?.textContent).not.toBe(firstRevealSpeech?.textContent);
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')).toBeNull();
    await act(async () => {
      button('Easy')?.click();
      await Promise.resolve();
    });
    const completionSpeech = container.querySelector('[data-review-speech="completion"]');
    expect(completionSpeech?.textContent).toBeTruthy();
    expect(completionSpeech?.textContent).toBe(COMPLETE_POOL[0]);
    expect(completionSpeech?.closest('.review-companion-viewport')).toBeNull();
  });

  it('opens the next prompt immediately after a rating shortcut', async () => {
    const first = item('held-key');
    const second = item('after-held-key');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));
    await renderView({ items: [first, second], reviewItem });
    act(() => button('揭晓答案')?.click());

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '3', code: 'Digit3', bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Recall after-held-key');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(button('下一题 →')).toBeUndefined();
    expectCueSpriteLayout(container);
  });

  it('reveals from PROMPT with Enter or Space and ignores Enter on COMPLETED', async () => {
    const learningItem = item('keyboard-reveal');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      );
    });
    expect(button('Good')).toBeDefined();
    expect(container.querySelector('.review-key-takeaway')).not.toBeNull();

    await act(async () => {
      button('Easy')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('本轮结束');
    expect(button('下一题 →')).toBeUndefined();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
      );
    });
    expect(container.textContent).toContain('本轮结束');
    expect(reviewItem).toHaveBeenCalledOnce();
  });

  it('stays on the current card when rating persistence fails', async () => {
    const learningItem = item('persist-fail');
    const loadDueItems = vi.fn(async () => [learningItem]);
    const reviewItem = vi
      .fn<ReviewItem>()
      .mockRejectedValueOnce(new Error('Review state conflict. Refresh review session.'));
    await renderView({ items: [learningItem], loadDueItems, reviewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(button('刷新复习会话')).toBeDefined();
    expect(button('下一题 →')).toBeUndefined();
    expect(container.querySelector('.review-reaction-layout')).toBeNull();
    expect(container.querySelector('.rating-grid')).not.toBeNull();
    expect(container.textContent).toContain('Recall persist-fail');
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });

  it.each([
    [Rating.Again, 'Again'],
    [Rating.Hard, 'Hard'],
    [Rating.Good, 'Good'],
    [Rating.Easy, 'Easy'],
  ] as const)('opens the next prompt immediately after %s', async (rating, label) => {
    const first = item(`rating-${label.toLocaleLowerCase()}`);
    const second = item(`after-${label.toLocaleLowerCase()}`);
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResultFor(first, rating));

    await renderView({
      items: [first, second],
      reviewItem,
    });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button(label)?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(`Recall ${second.id}`);
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expect(button('下一题 →')).toBeUndefined();
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[1],
    );
    const feedback = container.querySelector('.review-step-feedback[data-receipt-id]');
    expect(feedback?.querySelector('.review-step-seal')).not.toBeNull();
    expect(feedback?.textContent).not.toContain('完成一题');
    expect(feedback?.textContent).not.toContain('本轮已复习');
    expect(container.querySelectorAll('.review-step-feedback')).toHaveLength(1);
    expectCueSpriteLayout(container);
  });

  it('acknowledges a rating only after persistence and still advances without waiting', async () => {
    const first = item('feedback-pending');
    const second = item('feedback-after-pending');
    let resolve!: (result: PersistedFsrsReviewResult) => void;
    const reviewItem = vi.fn<ReviewItem>(() => new Promise((done) => (resolve = done)));
    await renderView({ items: [first, second], reviewItem });
    act(() => button('揭晓答案')?.click());
    act(() => {
      button('Good')?.click();
      button('Good')?.click();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(container.textContent).toContain('Recall feedback-pending');
    // Only the chosen grade shows the waiting state; all four stay the same kind of control.
    expect(
      [...container.querySelectorAll('.rating-grid button')].map((rating) => [
        rating.getAttribute('data-rating'),
        rating.getAttribute('aria-busy'),
      ]),
    ).toEqual([
      ['again', 'false'],
      ['hard', 'false'],
      ['good', 'true'],
      ['easy', 'false'],
    ]);
    await act(async () => resolve(reviewResult(first)));

    expect(container.querySelectorAll('.review-step-feedback[data-receipt-id]')).toHaveLength(1);
    expect(container.textContent).toContain('Recall feedback-after-pending');
    expect(document.activeElement?.textContent).toBe('揭晓答案');
    expect(reviewItem).toHaveBeenCalledOnce();
  });

  it('does not replay a success animation when a rating finishes in a hidden document', async () => {
    const first = item('feedback-hidden');
    const second = item('feedback-after-hidden');
    let resolve!: (result: PersistedFsrsReviewResult) => void;
    const reviewItem = vi.fn<ReviewItem>(() => new Promise((done) => (resolve = done)));
    await renderView({ items: [first, second], reviewItem });
    act(() => button('揭晓答案')?.click());
    act(() => button('Good')?.click());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await act(async () => resolve(reviewResult(first)));
    expect(container.textContent).toContain('Recall feedback-after-hidden');
    expect(container.querySelector('.review-step-feedback')).toBeNull();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(reviewItem).toHaveBeenCalledOnce();
  });

  it('ignores a successful rating result after the review view unmounts', async () => {
    const learningItem = item('feedback-unmounted');
    let resolve!: (result: PersistedFsrsReviewResult) => void;
    const reviewItem = vi.fn<ReviewItem>(() => new Promise((done) => (resolve = done)));
    const onChanged = vi.fn();
    const recordReviewAllowance = vi.fn<ReviewAllowanceRecorder>(async () => null);
    await renderView({ items: [learningItem], reviewItem, onChanged, recordReviewAllowance });
    act(() => button('揭晓答案')?.click());
    act(() => button('Good')?.click());
    act(() => root.unmount());
    root = createRoot(container);

    await act(async () => resolve(reviewResult(learningItem)));

    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(container.textContent).toBe('');
    expect(onChanged).not.toHaveBeenCalled();
    expect(recordReviewAllowance).not.toHaveBeenCalled();
    expect(reviewItem).toHaveBeenCalledOnce();
  });

  it('preserves due and reviewing scene feedback and advances immediately with Reduced Motion', async () => {
    vi.useFakeTimers();
    const restoreMatchMedia = installReducedMotion(true);
    try {
      const first = item('reduced-first');
      const second = item('reduced-second');
      const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));

      await renderView({
        items: [first, second],
        reviewItem,
      });

      expect(
        container
          .querySelector('[data-review-companion-reduced-motion]')
          ?.getAttribute('data-review-companion-reduced-motion'),
      ).toBe('true');
      expect(container.querySelector('.review-stage .review-companion-viewport')).not.toBeNull();
      expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
        'due',
      );

      act(() => button('揭晓答案')?.click());
      expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
        'reviewing',
      );

      await act(async () => {
        button('Good')?.click();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Recall reduced-second');
      expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
      expect(container.querySelector('.review-step-feedback .review-step-seal')).not.toBeNull();
      expect(
        container
          .querySelector('[data-review-companion-scene]')
          ?.getAttribute('data-review-companion-scene'),
      ).toBe('PROMPT');
      expect(button('下一题 →')).toBeUndefined();
      expect(container.textContent).toContain('Recall reduced-second');
      expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
        'due',
      );
      expect(container.querySelector('.companion-success')).toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });

  it('keeps HERO ownership and Major dialogue visible under Reduced Motion', async () => {
    const restoreMatchMedia = installReducedMotion(true);
    try {
      const learningItem = item('reduced-dialogue');
      await renderView({
        items: [learningItem],
        reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
        autoStart: false,
      });

      expect(container.querySelector('.review-companion-spatial-hero')).not.toBeNull();
      expect(container.querySelector('[data-review-dialogue-intent="invitation"]')).not.toBeNull();
      expect(
        container
          .querySelector('[data-review-companion-reduced-motion]')
          ?.getAttribute('data-review-companion-reduced-motion'),
      ).toBe('true');
      expect(container.querySelector('.review-companion-viewport')).not.toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });

  it('reveals a long answer and rating controls below a stable question', async () => {
    const learningItem = {
      ...item('long-answer'),
      recallPrompt: '  Which angle should I hold?\nKeep my spacing.  ',
      coreLesson: 'A long takeaway '.repeat(80),
      referenceAnswer: 'A distinct legacy answer that Review must not expose.',
    };
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));

    await renderView({ items: [learningItem], reviewItem });
    const question = container.querySelector('.recall-prompt');
    expect(question?.textContent).toBe('  Which angle should I hold?\nKeep my spacing.  ');
    expect(container.textContent).not.toContain(learningItem.coreLesson);
    expect(container.textContent).not.toContain(learningItem.referenceAnswer);
    expect(button('Good')).toBeUndefined();

    act(() => button('揭晓答案')?.click());

    expect(container.querySelector('.recall-prompt')).toBe(question);
    expect(container.querySelector('.review-key-takeaway')?.textContent).toBe(
      learningItem.coreLesson.trim(),
    );
    expect(container.textContent).not.toContain(learningItem.referenceAnswer);
    expect(container.querySelector('.review-answer-reveal.motion-reveal')).not.toBeNull();
    expect(button('Good')).toBeDefined();
    expect(button('揭晓答案')).toBeUndefined();
  });

  it('reveals the Key takeaway once and never presents a legacy personal note', async () => {
    const learningItem = {
      ...item('canonical-takeaway'),
      coreLesson: 'Hold the angle before using utility.',
      referenceAnswer: '  Hold   the angle before using utility.  ',
      personalNote: 'Private wording from an earlier ValRecall format.',
    };

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });
    act(() => button('揭晓答案')?.click());

    expect(container.querySelector('.review-answer-reveal')?.getAttribute('aria-label')).toBe(
      '关键收获',
    );
    expect(container.textContent).not.toContain('关键收获');
    expect(container.textContent?.match(/Hold the angle before using utility\./g)).toHaveLength(1);
    expect(container.textContent).not.toContain('Reference answer:');
    expect(container.textContent).not.toContain('Personal note');
    expect(container.textContent).not.toContain(
      'Private wording from an earlier ValRecall format.',
    );
  });

  it('never presents a distinct legacy Reference answer as a second Review answer', async () => {
    const learningItem = {
      ...item('distinct-legacy-answer'),
      coreLesson: 'Use the saved Key takeaway as the only revealed answer.',
      referenceAnswer: 'Preserved legacy wording that belongs in Library only.',
    };

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });

    expect(container.textContent).not.toContain(learningItem.coreLesson);
    expect(container.textContent).not.toContain(learningItem.referenceAnswer);
    act(() => button('揭晓答案')?.click());

    expect(container.textContent).toContain(learningItem.coreLesson);
    expect(container.textContent).not.toContain(learningItem.referenceAnswer);
    expect(container.textContent).not.toContain('Reference answer');
  });

  it('keeps captured video source context out of recall until Reveal and removes legacy fields', async () => {
    const learningItem: VideoLearningItem = {
      ...item('source-context'),
      videoTitle: 'Hidden source title',
      uploader: 'Hidden source creator',
      screenshotId: 'hidden-source-screenshot',
      subtitleBefore: [],
      subtitleCurrent: ['Current-only source evidence'],
      subtitleAfter: [],
      situation: 'Legacy situation detail',
      mistakeToAvoid: 'Legacy avoid detail',
      recommendedAction: 'Legacy action detail',
      reason: 'Distinct user-authored legacy reason',
    };

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });

    expect(container.textContent).toContain('Recall source-context');
    expect(container.textContent).not.toContain('Source context');
    expect(container.textContent).not.toContain('Source excerpt');
    expect(container.textContent).not.toContain('来源详情');
    expect(container.textContent).not.toContain('Subtitle context');
    expect(container.textContent).not.toContain('Hidden source title');
    expect(container.textContent).not.toContain('Hidden source creator');
    expect(container.textContent).not.toContain('Current-only source evidence');
    expect(container.querySelector('figcaption')?.textContent).toBe('Bilibili · 00:42');
    const capturedFrameBeforeReveal =
      container.querySelector<HTMLElement>('.review-captured-frame');
    const videoCueViewportBeforeReveal = container.querySelector<HTMLElement>(
      '[data-review-media-kind="video"]',
    );
    const questionBeforeReveal = container.querySelector<HTMLElement>('.recall-prompt');
    const readingColumnBeforeReveal =
      container.querySelector<HTMLElement>('.review-reading-column');
    expect(container.querySelectorAll('.recall-prompt')).toHaveLength(1);
    expect(questionBeforeReveal?.textContent).toBe(learningItem.recallPrompt);
    expect(container.querySelectorAll('.review-reading-column')).toHaveLength(1);
    expect(questionBeforeReveal?.closest('.review-reading-column')).toBe(readingColumnBeforeReveal);
    expect(capturedFrameBeforeReveal?.closest('.review-reading-column')).toBe(
      readingColumnBeforeReveal,
    );
    expect(capturedFrameBeforeReveal).not.toBeNull();
    expect(capturedFrameBeforeReveal?.getAttribute('data-review-cue-kind')).toBe('captured-video');
    expect(videoCueViewportBeforeReveal).not.toBeNull();
    expect(videoCueViewportBeforeReveal?.querySelector('.review-video-cue-image')).not.toBeNull();
    expect(capturedFrameBeforeReveal?.textContent).not.toContain('截取画面');
    expect(
      capturedFrameBeforeReveal?.querySelector('[role="img"][aria-label*="这一刻的截取画面"]'),
    ).not.toBeNull();
    expect(button('查看原视频')).toBeDefined();

    act(() => button('揭晓答案')?.click());

    expect(container.textContent).toContain('Core source-context');
    expect(container.textContent).not.toContain('Answer source-context');
    for (const legacyValue of [
      'Legacy situation detail',
      'Legacy avoid detail',
      'Legacy action detail',
      'Distinct user-authored legacy reason',
    ]) {
      expect(container.textContent).not.toContain(legacyValue);
    }
    const disclosure = container.querySelector<HTMLDetailsElement>('.source-context-disclosure');
    const subtitleContext = container.querySelector<HTMLElement>('.review-subtitle-context');
    const revealExperience = container.querySelector<HTMLElement>('.review-answer-reveal');
    const answerBox = revealExperience?.querySelector<HTMLElement>('.answer-box');
    const reviewStage = container.querySelector<HTMLElement>('.review-stage');
    const controlsRegion = reviewStage?.querySelector<HTMLElement>(
      '[data-review-stage-region="controls"]',
    );
    const ratingGrid = controlsRegion?.querySelector<HTMLElement>('.rating-grid');
    expect(revealExperience).not.toBeNull();
    expect(answerBox).not.toBeNull();
    expect(ratingGrid).not.toBeNull();
    expect(reviewStage?.getAttribute('data-review-phase')).toBe('revealed');
    expectCueSpriteLayout(container);
    expect(answerBox?.querySelector('.review-key-takeaway')?.textContent).toBe(
      'Core source-context',
    );
    expect(ratingGrid?.closest('[data-review-stage-region="controls"]')).toBe(controlsRegion);
    expect(subtitleContext).not.toBeNull();
    expect(subtitleContext?.closest('details')).toBeNull();
    expect(subtitleContext?.getAttribute('aria-label')).toBe('来源摘录');
    expect(subtitleContext?.querySelector('.eyebrow')?.textContent).toBe('来源摘录');
    expect(subtitleContext?.textContent).toContain('Current-only source evidence');
    expect(subtitleContext?.textContent?.match(/Current-only source evidence/g)).toHaveLength(1);
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toBe('来源详情');
    expect(disclosure?.querySelector('summary')?.getAttribute('aria-label')).toBe(
      'Bilibili 的来源详情，时间 00:42',
    );
    expect(disclosure?.textContent).toContain('Hidden source title');
    expect(disclosure?.textContent).toContain('Hidden source creator');
    expect(disclosure?.textContent).not.toContain('Current-only source evidence');
    expect(disclosure?.textContent).toContain('00:42');
    expect(disclosure?.querySelector('[aria-label="Nearby caption excerpt"]')).toBeNull();
    const revealSections = [...(revealExperience?.children ?? [])];
    expect(revealSections.indexOf(answerBox as HTMLElement)).toBeLessThan(
      revealSections.indexOf(subtitleContext as HTMLElement),
    );
    expect(revealSections.indexOf(subtitleContext as HTMLElement)).toBeLessThan(
      revealSections.indexOf(disclosure as HTMLDetailsElement),
    );
    const capturedFrame = container.querySelector<HTMLElement>('.review-captured-frame');
    expect(capturedFrame).toBe(capturedFrameBeforeReveal);
    expect(container.querySelectorAll('.recall-prompt')).toHaveLength(1);
    expect(container.querySelector('.recall-prompt')).toBe(questionBeforeReveal);
    expect(container.querySelectorAll('.review-reading-column')).toHaveLength(1);
    expect(container.querySelector('.review-reading-column')).toBe(readingColumnBeforeReveal);
    expect(questionBeforeReveal?.closest('.review-reading-column')).toBe(readingColumnBeforeReveal);
    expect(capturedFrame?.closest('.review-reading-column')).toBe(readingColumnBeforeReveal);
    expect(container.querySelector('[data-review-media-kind="video"]')).toBe(
      videoCueViewportBeforeReveal,
    );
    expect(capturedFrame?.textContent).not.toContain('截取画面');
    expect(
      capturedFrame?.querySelector('[role="img"][aria-label*="这一刻的截取画面"]'),
    ).not.toBeNull();
    expect(disclosure?.querySelector('.screenshot')).toBeNull();
    expect(container.querySelectorAll('.review-captured-frame')).toHaveLength(1);
    expect(button('查看原视频')).toBeDefined();
  });

  it.each([
    [
      'previous and current cues',
      ['Previous cue'],
      ['Current cue'],
      [],
      ['Previous cue', 'Current cue'],
    ],
    ['current and next cues', [], ['Current cue'], ['Next cue'], ['Current cue', 'Next cue']],
    [
      'a full deduplicated cue window',
      ['Duplicate cue'],
      ['Duplicate cue'],
      ['Next cue'],
      ['Duplicate cue', 'Next cue'],
    ],
  ] as const)(
    'renders %s directly after Reveal and not inside Source details',
    async (_case, subtitleBefore, subtitleCurrent, subtitleAfter, expected) => {
      const learningItem = {
        ...item(`partial-${expected.length}`),
        subtitleBefore: [...subtitleBefore],
        subtitleCurrent: [...subtitleCurrent],
        subtitleAfter: [...subtitleAfter],
      };
      await renderView({
        items: [learningItem],
        reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
      });

      expect(container.querySelector('.review-subtitle-context')).toBeNull();
      act(() => button('揭晓答案')?.click());

      const subtitleContext = container.querySelector('.review-subtitle-context');
      const lines = [...(subtitleContext?.querySelectorAll('.source-context-lines p') ?? [])].map(
        (line) => line.textContent,
      );
      expect(lines).toEqual(expected);
      expect(
        container
          .querySelector('.source-context-disclosure')
          ?.querySelector('.source-context-lines'),
      ).toBeNull();
    },
  );

  it('does not render an empty Source excerpt section after Reveal', async () => {
    const learningItem = item('no-subtitle-context');
    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });

    act(() => button('揭晓答案')?.click());

    expect(container.querySelector('.review-subtitle-context')).toBeNull();
    expect(container.textContent).not.toContain('Subtitle context');
    expect(container.textContent).not.toContain('Source excerpt');
    expect(container.querySelector('.source-context-disclosure')).not.toBeNull();
  });

  it('shows all four real scheduler previews from one fixed review timestamp', async () => {
    const learningItem = item('preview-card');
    const previewItem = vi.fn((current: LearningItem, reviewedAt: Date) =>
      new FsrsService().preview(current.fsrsCard, reviewedAt),
    );

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
      previewItem,
    });
    act(() => button('揭晓答案')?.click());

    expect(previewItem).toHaveBeenCalledWith(learningItem, now);
    expect(button('Again')?.textContent).toContain('没想起来1m');
    expect(button('Hard')?.textContent).toContain('费力想起6m');
    expect(button('Good')?.textContent).toContain('正常想起10m');
    expect(button('Easy')?.textContent).toContain('轻松想起8d');
  });

  it('isolates the active expected due from preview and reveal mutations', async () => {
    const learningItem = item('preview-isolation');
    const originalDue = learningItem.fsrsCard.due.getTime();
    const previewItem = vi.fn((current: LearningItem, reviewedAt: Date) => {
      current.fsrsCard.due.setTime(current.fsrsCard.due.getTime() + 60_000);
      current.fsrsCard.reps += 10;
      return new FsrsService().preview(learningItem.fsrsCard, reviewedAt);
    });
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));

    await renderView({ items: [learningItem], reviewItem, previewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(learningItem.fsrsCard.due.getTime()).toBe(originalDue);
    expect(reviewItem).toHaveBeenCalledWith(
      learningItem.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
  });

  it('submits the same timestamp used by preview and confirms the saved result', async () => {
    const learningItem = item('preview-agreement');
    const service = new FsrsService();
    const previews: FsrsPreview[] = [];
    const previewItem = vi.fn((current: LearningItem, reviewedAt: Date) => {
      const preview = service.preview(current.fsrsCard, reviewedAt);
      previews.push(preview);
      return preview;
    });
    const reviewItem = vi.fn<ReviewItem>(async (itemId, rating, reviewedAt) => {
      const scheduled = service.schedule(learningItem.fsrsCard, rating, reviewedAt);
      return {
        ...scheduled,
        itemId,
        reviewRecord: {
          id: 'review-agreement',
          itemId,
          reviewedAt,
          log: scheduled.log,
        },
      };
    });

    await renderView({ items: [learningItem], reviewItem, previewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledWith(
      learningItem.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
    expect(previews[0]?.[Rating.Good].nextDue.toISOString()).toBe('2026-07-21T12:10:00.000Z');
    expect(container.querySelector('.review-session-next time')?.getAttribute('datetime')).toBe(
      '2026-07-21T12:10:00.000Z',
    );
  });

  it('confirms one rating, then focuses the next reveal immediately', async () => {
    const first = item('transition-first');
    const second = item('transition-second');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));

    await renderView({
      items: [first, second],
      reviewItem,
    });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Recall transition-second');
    expect(container.textContent).not.toContain('Recall transition-first');
    expect(button('下一题 →')).toBeUndefined();
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe('due');
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('PROMPT');
    expectCueSpriteLayout(container);
    expect(container.querySelector('[data-review-dialogue-origin="rating"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="reveal"]')).toBeNull();
    expect(container.querySelector('[data-review-dialogue-origin="prompt"]')?.textContent).toBe(
      PROMPT_POOL[1],
    );
    expect(document.activeElement?.textContent).toBe('揭晓答案');
    expect(container.querySelectorAll('.review-step-feedback[data-receipt-id]')).toHaveLength(1);
  });

  it('blocks a keyboard and click collision from writing the same Moment twice', async () => {
    const learningItem = item('collision');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });
    act(() => button('揭晓答案')?.click());

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(reviewItem).toHaveBeenCalledWith(
      learningItem.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
    expect(container.textContent).toContain('本轮结束');
  });

  it('keeps the initial queue stable when a parent revision introduces a newly due Moment', async () => {
    const initial = item('snapshot-initial');
    const newlyDue = item('snapshot-new');
    let dueItems = [initial];
    const loadDueItems = vi.fn(async () => dueItems);
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(initial));
    const commonProps = {
      preferences: DEFAULT_PREFERENCES,
      onChanged: () => undefined,
      onGoHome: () => undefined,
      onGoLibrary: () => undefined,
      loadDueItems,
      reviewItem,
      clock: () => now,
      countDueItems: async () => 1,
      loadCategorySummaries: async () => [],
    };

    await act(async () => {
      root.render(<TodayView revision={0} {...commonProps} />);
      await Promise.resolve();
    });
    act(() => button('开始复习')?.click());
    dueItems = [initial, newlyDue];
    await act(async () => {
      root.render(<TodayView revision={1} {...commonProps} />);
      await Promise.resolve();
    });

    expect(loadDueItems).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('1 / 1');
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('本轮结束');
    expect(container.textContent).not.toContain('Recall snapshot-new');
    expect(container.textContent).toContain('又有 1 条到期了。');
  });

  it('goes to COMPLETED after the last rating without a Next Reaction', async () => {
    const learningItem = item('final-transition');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));

    await renderView({
      items: [learningItem],
      reviewItem,
    });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Hard')?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.review-card')).toBeNull();
    expect(button('下一题 →')).toBeUndefined();
    expect(container.textContent).toContain('本轮结束');
    const completionSpeech = container.querySelector('[data-review-speech="completion"]');
    expect(container.querySelector('.review-step-feedback[data-receipt-id]')).not.toBeNull();
    expect(completionSpeech?.textContent).toBeTruthy();
    expect(completionSpeech?.textContent).toBe(COMPLETE_POOL[0]);
    expect(completionSpeech?.closest('.review-companion-viewport')).toBeNull();
    expect(container.querySelector('.companion')?.getAttribute('data-companion-state')).toBe(
      'success',
    );
    expect(
      container
        .querySelector('[data-review-companion-scene]')
        ?.getAttribute('data-review-companion-scene'),
    ).toBe('COMPLETED');
    expect(
      container.querySelector('[data-review-stage-owner]')?.getAttribute('data-review-stage-owner'),
    ).toBe('companion-and-summary');
    expect(container.querySelector('[data-review-dialogue-intent="completion"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-review-dialogue-intent="completion"]')
        ?.getAttribute('data-review-dialogue-lifetime'),
    ).toBe('scene');
    expect(container.textContent).toContain(COMPLETE_POOL[0]);
    const completionLayout = container.querySelector('.review-complete-layout');
    const completionCompanion = completionLayout?.querySelector(
      '[data-review-stage-region="companion"]',
    );
    const completionStage = completionCompanion?.querySelector('.review-companion-viewport');
    const completionLearningCanvas = completionLayout?.querySelector(
      '[data-review-stage-region="learning"]',
    );
    const completionControls = completionLayout?.querySelector(
      '[data-review-stage-region="controls"]',
    );
    expect(completionLayout?.getAttribute('data-review-composition')).toBe('immersive-reading');
    expect(completionLayout?.getAttribute('data-review-phase')).toBe('complete');
    expect(completionLayout?.firstElementChild).toBe(completionCompanion);
    expect(completionStage).not.toBeNull();
    expect(completionCompanion?.contains(completionStage ?? null)).toBe(true);
    expect(completionCompanion?.nextElementSibling).toBe(completionLearningCanvas);
    expect(completionLearningCanvas?.nextElementSibling).toBe(completionControls);
    expect(completionLearningCanvas?.classList.contains('review-complete-copy')).toBe(true);
    expect(button('返回首页')?.closest('[data-review-stage-region="controls"]')).toBe(
      completionControls,
    );
    expect(document.activeElement?.textContent).toBe('本轮结束');

    act(() => root.render(<></>));
  });

  it('does not replay or hide an already revealed answer when the same item is restored', async () => {
    const learningItem = item('restored');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });
    act(() => button('揭晓答案')?.click());
    const answer = container.querySelector('.review-answer-reveal');

    await act(async () => {
      root.render(
        <TodayView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={() => undefined}
          onGoHome={() => undefined}
          onGoLibrary={() => undefined}
          loadDueItems={async () => [learningItem]}
          loadCategorySummaries={async () => []}
          reviewItem={reviewItem}
          clock={() => now}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.review-answer-reveal')).toBe(answer);
    expect(container.textContent).toContain('Core restored');
    expect(container.textContent).not.toContain('Answer restored');
  });

  it('does not register rating shortcuts while an editor input owns keyboard focus', async () => {
    const learningItem = item('keyboard-safe');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });
    act(() => button('揭晓答案')?.click());
    const input = document.createElement('input');
    container.prepend(input);
    input.focus();

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));

    expect(document.activeElement).toBe(input);
    expect(reviewItem).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Recall keyboard-safe');
  });

  it.each(['Enter', ' '])(
    'preserves native %j activation on the focused mastered button',
    async (key) => {
      const learningItem = item('native-button');
      const reviewItem = vi.fn<ReviewItem>();
      await renderView({ items: [learningItem], reviewItem });
      const mastered = button('学成')!;
      mastered.focus();
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => mastered.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(false);
      expect(container.querySelector('.review-answer-reveal')).toBeNull();
      expect(document.activeElement).toBe(mastered);
      expect(reviewItem).not.toHaveBeenCalled();
    },
  );

  it('keeps shortcuts inside the Review context and ignores composing keys', async () => {
    const learningItem = item('shortcut-context');
    const reviewItem = vi.fn<ReviewItem>();
    await renderView({ items: [learningItem], reviewItem });
    const navigation = document.createElement('button');
    navigation.textContent = '首页';
    container.prepend(navigation);
    navigation.focus();
    act(() =>
      navigation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(button('Good')).toBeUndefined();

    act(() => button('揭晓答案')?.click());
    act(() => navigation.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true })));
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '3', bubbles: true, isComposing: true }),
      ),
    );
    expect(reviewItem).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Core shortcut-context');
  });

  it('focuses the question when the reveal control would scroll past its beginning', async () => {
    const scrollDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: -600,
      bottom: 1200,
      left: 0,
      right: 500,
      x: 0,
      y: -600,
      width: 500,
      height: 1800,
      toJSON: () => ({}),
    });
    try {
      await renderView({ items: [item('long-question')], reviewItem: vi.fn<ReviewItem>() });
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(container.querySelector('.recall-prompt'));
      expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'start' });
      expect(scroll.mock.contexts[0]).toBe(container.querySelector('.review-card'));
    } finally {
      focus.mockRestore();
      bounds.mockRestore();
      if (scrollDescriptor)
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('keeps failed-save recovery beside ratings, focused and safe to retry after another read failure', async () => {
    const learningItem = item('recover-near-action');
    let rejectReload!: (error: Error) => void;
    const loadDueItems = vi
      .fn<DueItemsLoader>()
      .mockResolvedValueOnce([learningItem])
      .mockResolvedValueOnce([learningItem])
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectReload = reject;
          }),
      );
    const reviewItem = vi.fn<ReviewItem>().mockRejectedValue(new Error('保存未确认'));
    await renderView({ items: [learningItem], reviewItem, loadDueItems });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
    });

    const recovery = button('刷新复习会话')!;
    expect(container.querySelector('.review-control-deck')?.contains(recovery)).toBe(true);
    expect(document.activeElement).toBe(recovery);
    expect(container.textContent).toContain('没保存成功，请刷新后重试。');
    expect(button('Good')?.disabled).toBe(true);
    await act(async () => {
      recovery.click();
    });
    expect(recovery.disabled).toBe(true);
    await act(async () => {
      rejectReload(new Error('读取失败，可再次核对'));
    });
    expect(document.activeElement).toBe(recovery);
    expect(recovery.disabled).toBe(false);
    expect(container.textContent).toContain('Core recover-near-action');
    expect(reviewItem).toHaveBeenCalledOnce();
  });

  it('reports all rating totals and the earliest successful next review', async () => {
    const moments = [item('again'), item('hard'), item('good'), item('easy')];
    const dueByRating = {
      [Rating.Again]: new Date('2026-07-21T12:01:00.000Z'),
      [Rating.Hard]: new Date('2026-07-21T12:06:00.000Z'),
      [Rating.Good]: new Date('2026-07-24T12:00:00.000Z'),
      [Rating.Easy]: new Date('2026-07-29T12:00:00.000Z'),
    };
    const reviewItem = vi.fn<ReviewItem>(async (itemId, rating) => {
      const learningItem = moments.find((candidate) => candidate.id === itemId)!;
      const grade = toFsrsRating(rating);
      return reviewResultFor(learningItem, grade, dueByRating[grade]);
    });

    await renderView({ items: moments, reviewItem });
    for (const label of ['Again', 'Hard', 'Good', 'Easy']) {
      act(() => button('揭晓答案')?.click());
      await act(async () => {
        button(label)?.click();
        await Promise.resolve();
      });
    }

    expect(resultValue('已复习总数')).toBe('4');
    expect(resultValue('Again')).toBe('1');
    expect(resultValue('Hard')).toBe('1');
    expect(resultValue('Good')).toBe('1');
    expect(resultValue('Easy')).toBe('1');
    expect(container.querySelector('time')?.dateTime).toBe('2026-07-21T12:01:00.000Z');
    expect(reviewItem).toHaveBeenCalledTimes(4);
  });

  it('requires an explicit Continue action before newly due Moments form another session', async () => {
    const first = item('first-session');
    const later = item('next-session');
    const loadDueItems = vi
      .fn<(at: Date) => Promise<VideoLearningItem[]>>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([later]);
    const countDueItems = vi.fn(async () => 1);
    const reviewItem = vi.fn<ReviewItem>(async (itemId) =>
      reviewResult(itemId === first.id ? first : later),
    );

    await renderView({ items: [first], loadDueItems, countDueItems, reviewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(loadDueItems).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('又有 1 条到期了。');
    expect(container.textContent).not.toContain('Recall next-session');

    await act(async () => {
      button('继续复习')?.click();
      await Promise.resolve();
    });

    expect(loadDueItems).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Recall next-session');
    expect(container.textContent).toContain('1 / 1');
  });

  it('marks the current Moment as mastered without using the four ratings', async () => {
    const first = item('master-first');
    const second = item('master-second');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(first));
    const suspendItem = vi.fn<SuspendItem>(async () => ({ ...first, suspended: true }));
    const onChanged = vi.fn();
    await renderView({ items: [first, second], reviewItem, suspendItem, onChanged });

    const mastered = button('学成');
    expect(mastered).toBeDefined();
    expect(mastered?.closest('.rating-grid')).toBeNull();
    expect(mastered?.closest('[data-review-stage-region="controls"]')).toBeNull();
    expect(mastered?.closest('[data-review-stage-region="learning"]')).not.toBeNull();

    await act(async () => {
      mastered?.click();
      await Promise.resolve();
    });

    expect(suspendItem).toHaveBeenCalledWith('master-first');
    expect(reviewItem).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(container.querySelector('.notice')?.textContent).toBe('已学成。');
    expect(container.textContent).not.toContain('以后不再复习');
    expect(container.textContent).toContain('Recall master-second');
    expect(button('Again')).toBeUndefined();
    expect(button('学成')?.closest('.rating-grid')).toBeNull();
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });

  it('finishes the session when the last Moment is mastered', async () => {
    const learningItem = item('last-mastered');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    const suspendItem = vi.fn<SuspendItem>(async () => ({ ...learningItem, suspended: true }));
    await renderView({ items: [learningItem], reviewItem, suspendItem });

    await act(async () => {
      button('学成')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).not.toHaveBeenCalled();
    expect(container.textContent).toContain('本轮结束');
    expect(container.querySelector('.review-session-next')?.textContent).toBe('1 条已学成');
    // The summary says it; a notice above it would only repeat it.
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.textContent).not.toContain('以后不再复习');
    expect(container.textContent).not.toContain('最早下次复习');
    expect(container.textContent).not.toContain('暂不可用');
    expect(resultValue('已复习总数')).toBe('0');
    expect(container.querySelector('.rating-grid')).toBeNull();
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });

  it('advances without a rating when the current Moment was removed or suspended elsewhere', async () => {
    const learningItem = item('gone-elsewhere');
    const loadDueItems = vi
      .fn<(at: Date) => Promise<VideoLearningItem[]>>()
      .mockResolvedValueOnce([learningItem])
      .mockResolvedValueOnce([]);
    const reviewItem = vi.fn<ReviewItem>(async () => {
      throw new Error('Review state changed');
    });
    const onChanged = vi.fn();

    await renderView({ items: [learningItem], loadDueItems, reviewItem, onChanged });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已在别处改动，已跳过。');
    expect(resultValue('已复习总数')).toBe('0');
    expect(container.querySelector('.review-session-next')?.textContent).toBe('1 条已跳过');
    expect(container.textContent).not.toContain('暂不可用');
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });

  it('does not retry a stale snapshot card that was rated elsewhere but remains due', async () => {
    const snapshotItem = item('rated-elsewhere');
    const changedItem = {
      ...snapshotItem,
      fsrsCard: {
        ...snapshotItem.fsrsCard,
        due: new Date('2026-07-21T11:59:00.000Z'),
      },
    };
    const loadDueItems = vi
      .fn<(at: Date) => Promise<VideoLearningItem[]>>()
      .mockResolvedValueOnce([snapshotItem])
      .mockResolvedValueOnce([changedItem]);
    const reviewItem = vi.fn<ReviewItem>(async () => {
      throw new Error('Review state changed');
    });

    await renderView({ items: [snapshotItem], loadDueItems, reviewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(reviewItem).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('已在别处改动，已跳过');
    expect(container.textContent).toContain('本轮结束');
    expect(resultValue('已复习总数')).toBe('0');
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });

  it('offers an explicit Refresh review session action after an unchanged save failure', async () => {
    const learningItem = item('refresh-after-conflict');
    const loadDueItems = vi.fn(async () => [learningItem]);
    const reviewItem = vi
      .fn<ReviewItem>()
      .mockRejectedValueOnce(new Error('Review state conflict. Refresh review session.'))
      .mockResolvedValueOnce(reviewResult(learningItem));

    await renderView({ items: [learningItem], loadDueItems, reviewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(button('刷新复习会话')).toBeDefined();
    expect(reviewItem).toHaveBeenCalledOnce();
    await act(async () => {
      button('刷新复习会话')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('已刷新。');
    expect(container.textContent).toContain('1 / 1');
    expect(button('揭晓答案')).toBeDefined();
    expect(document.activeElement).toBe(button('揭晓答案'));
    expect(reviewItem).toHaveBeenCalledOnce();
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(reviewItem).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('本轮结束');
  });

  it('rates a serialized current-schema follow-up Moment through the real IndexedDB path', async () => {
    const factory = new IDBFactory();
    const databaseName = 'today-review-save-integration';
    let sequence = 0;
    const seedRepository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName,
      clock: () => new Date(now),
      idGenerator: () => `integration-${(sequence += 1)}`,
    });
    const firstReviewAt = new Date('2026-07-21T11:50:00.000Z');
    const created = await seedRepository.createItem(
      {
        ...item('serialized-follow-up'),
        sourceUrl: 'https://www.bilibili.com/video/BV1test',
        videoId: 'BV1test',
        fsrsCard: createEmptyCard(firstReviewAt),
      },
      new Blob(['serialized']),
    );
    const seedService = new FsrsService(seedRepository);
    const first = await seedService.reviewItem(created.id, Rating.Good, firstReviewAt);
    expect(first.nextDue.getTime()).toBe(now.getTime());

    const reloadedRepository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName,
      clock: () => new Date(now),
    });
    const service = new FsrsService(reloadedRepository);
    const dueItems = await reloadedRepository.listDueItems(now);
    const historyBefore = await reloadedRepository.listReviews(created.id);
    expect(dueItems).toHaveLength(1);

    await renderView({
      items: dueItems,
      loadDueItems: (at, categoryId) => reloadedRepository.listDueItems(at, categoryId),
      countDueItems: (at, categoryId) => reloadedRepository.countDueReviewItems(at, categoryId),
      loadCategorySummaries: (at) => reloadedRepository.listCategorySummaries(at),
      reviewItem: (itemId, rating, reviewedAt, expectedState) =>
        service.reviewItem(itemId, rating, reviewedAt, expectedState),
      autoStart: false,
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(button('开始复习')).toBeDefined();
    act(() => button('开始复习')?.click());
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    const historyAfter = await reloadedRepository.listReviews(created.id);
    expect(container.textContent).toContain('本轮结束');
    expect(historyAfter).toHaveLength(historyBefore.length + 1);
    expect(historyAfter.at(-1)?.log.rating).toBe(Rating.Good);
  });

  it('discards an interrupted visual session and reloads authoritative due data on remount', async () => {
    const interrupted = item('interrupted');
    const authoritative = item('authoritative');
    let dueItems = [interrupted];
    const loadDueItems = vi.fn(async () => dueItems);
    const props = {
      revision: 0,
      preferences: DEFAULT_PREFERENCES,
      onChanged: () => undefined,
      onGoHome: () => undefined,
      onGoLibrary: () => undefined,
      loadDueItems,
      countDueItems: async () => 1,
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(interrupted)),
      clock: () => now,
      loadCategorySummaries: async () => [],
    };

    await act(async () => {
      root.render(<TodayView {...props} />);
      await Promise.resolve();
    });
    act(() => button('开始复习')?.click());
    act(() => button('揭晓答案')?.click());
    expect(container.textContent).toContain('Core interrupted');
    expect(container.textContent).not.toContain('Answer interrupted');

    act(() => root.unmount());
    root = createRoot(container);
    dueItems = [authoritative];
    await act(async () => {
      root.render(<TodayView {...props} />);
      await Promise.resolve();
    });

    expect(loadDueItems).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('1 条到期 Moment');
    expect(container.textContent).not.toContain('Answer interrupted');
    expect(container.textContent).not.toContain('Recall authoritative');
  });

  it('keeps editing controls out of active review and completion', async () => {
    const learningItem = item('library-only');
    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });
    const forbidden = [
      'Edit Moment',
      'Rewrite prompt',
      'Split Moment',
      'Change answer',
      'Change due',
    ];
    for (const label of forbidden) expect(button(label)).toBeUndefined();

    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    for (const label of forbidden) expect(button(label)).toBeUndefined();
    expect(button('打开资料库')).toBeDefined();
  });

  it('reviews a complete Text Moment without video source controls or metadata', async () => {
    const learningItem = textItem('text-review');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });

    expect(container.textContent).toContain('Text lesson text-review');
    expect(container.textContent).toContain('Recall text-review');
    expect(container.textContent).not.toContain('Core text-review');
    expect(button('查看原视频')).toBeUndefined();
    expect(container.textContent).not.toContain('00:42');
    expect(container.querySelector('.screenshot')).toBeNull();
    expect(container.querySelector('[data-review-media-kind="video"]')).toBeNull();

    act(() => button('揭晓答案')?.click());
    expect(container.textContent).toContain('Core text-review');
    expect(container.textContent).not.toContain('Answer text-review');
    expect(container.textContent).not.toContain('Subtitle');
    expect(container.textContent).not.toContain('Creator unavailable');
    expect(container.querySelector('.source-context-disclosure')).toBeNull();

    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(reviewItem).toHaveBeenCalledWith(
      learningItem.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
    expect(container.textContent).toContain('本轮结束');
  });

  it('uses an Image Moment as the recall cue and never renders video source controls', async () => {
    const learningItem = imageItem('image-review');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    await renderView({ items: [learningItem], reviewItem });

    expect(container.textContent).toContain('Image lesson image-review');
    expect(container.textContent).toContain('Recall image-review');
    expect(container.textContent).not.toContain('Core image-review');
    expect(button('查看原视频')).toBeUndefined();
    expect(container.textContent).not.toContain('Subtitle');
    expect(
      container.querySelector('[role="img"][aria-label*="Image lesson image-review 的图片线索"]'),
    ).not.toBeNull();
    expect(container.querySelector('.image-moment-cue')).not.toBeNull();
    expect(container.querySelector('[data-review-media-kind="video"]')).toBeNull();

    act(() => button('揭晓答案')?.click());
    expect(container.textContent).toContain('Core image-review');
    expect(container.textContent).not.toContain('Answer image-review');
    expect(container.querySelector('.source-context-disclosure')).toBeNull();
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(reviewItem).toHaveBeenCalledWith(
      learningItem.id,
      Rating.Good,
      now,
      reviewSchedulingStateFromCard(learningItem.fsrsCard),
    );
  });

  it('starts with an individually selected due Library item without changing the queue', async () => {
    const first = item('first');
    const selected = item('selected');
    const third = item('third');

    await renderView({
      items: [first, selected, third],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(selected)),
      preferredItemId: selected.id,
    });

    expect(container.textContent).toContain('Recall selected');
    expect(container.textContent).not.toContain('Recall first');
    expect(container.textContent).toContain('1 / 3');
  });

  it('keeps the revealed portrait and recovery state without celebrating a failed save', async () => {
    const learningItem = item('failed-review');
    const reviewItem = vi.fn<ReviewItem>(async () => {
      throw new Error('FSRS persistence failed');
    });

    await renderView({ items: [learningItem], reviewItem });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('FSRS persistence failed');
    expect(container.querySelector('.companion-reviewing')).not.toBeNull();
    expect(container.querySelector('.companion-success')).toBeNull();
    expect(container.textContent).toContain('保存未确认');
    expect(container.textContent).toContain('Core failed-review');
  });

  it.each([
    ['bilibili', 'https://www.bilibili.com/video/BV1test'],
    ['youtube', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['douyin', 'https://www.douyin.com/video/7391234567890123456'],
  ] as const)(
    'opens the saved %s video before reveal without grading or revealing the answer',
    async (platform, sourceUrl) => {
      const learningItem: VideoLearningItem = { ...item('open-early'), platform, sourceUrl };
      const reviewItem = vi.fn<ReviewItem>();
      const reward = vi.fn<ReviewAllowanceRecorder>();
      await renderView({ items: [learningItem], reviewItem, recordReviewAllowance: reward });
      expect(button('查看原视频')?.closest('details')).toBeNull();
      expect(container.querySelector('.review-answer-reveal')).toBeNull();
      expect(button('Good')).toBeUndefined();
      await act(async () => {
        button('查看原视频')?.click();
      });
      expect(extensionMocks.openSourceAtTimestamp).toHaveBeenCalledExactlyOnceWith({
        platform,
        sourceUrl,
        canonicalUrl: null,
        timestampSeconds: 42,
        pauseAfterSeek: DEFAULT_PREFERENCES.pauseAfterReopen,
      });
      expect(reviewItem).not.toHaveBeenCalled();
      expect(reward).not.toHaveBeenCalled();
      expect(container.querySelector('.review-answer-reveal')).toBeNull();
      act(() => button('揭晓答案')?.click());
      expect(button('查看原视频')?.closest('details')).toBeNull();
      expect(container.querySelectorAll('.review-source-action')).toHaveLength(1);
    },
  );

  it('keeps the timestamp and retry action when video seeking fails', async () => {
    extensionMocks.openSourceAtTimestamp.mockResolvedValueOnce({
      ok: false,
      attempts: 3,
      timestampSeconds: 42,
      error: 'Player unavailable',
      diagnostics: [],
    });
    const learningItem = item('seek-failure');
    await renderView({ items: [learningItem], reviewItem: vi.fn<ReviewItem>() });
    await act(async () => button('查看原视频')?.click());
    expect(container.textContent).toContain('没能跳到 00:42');
    expect(container.textContent).not.toContain('来源已打开');
    expect(button('查看原视频')?.disabled).toBe(false);
    expect(container.querySelector('.review-answer-reveal')).toBeNull();
  });

  it('deduplicates source opening and ignores a reply after advancing to another question', async () => {
    let resolve!: (result: {
      ok: boolean;
      attempts: number;
      timestampSeconds: number;
      error: null;
      diagnostics: never[];
    }) => void;
    extensionMocks.openSourceAtTimestamp.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = item('first-source');
    const second = item('next-source');
    await renderView({
      items: [first, second],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(first)),
    });
    await act(async () => {
      button('查看原视频')?.click();
      button('查看原视频')?.click();
    });
    expect(extensionMocks.openSourceAtTimestamp).toHaveBeenCalledOnce();
    act(() => button('揭晓答案')?.click());
    await act(async () => button('Good')?.click());
    expect(container.textContent).toContain('Recall next-source');
    await act(async () =>
      resolve({ ok: true, attempts: 1, timestampSeconds: 42, error: null, diagnostics: [] }),
    );
    expect(container.textContent).not.toContain('已打开来源');
    expect(button('查看原视频')?.disabled).toBe(false);
  });

  it('passes the saved platform when reopening a source', async () => {
    const learningItem: VideoLearningItem = {
      ...item('youtube-review'),
      platform: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoId: 'abcdefghijk',
    };

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });
    expect(button('查看原视频')).toBeDefined();
    act(() => button('揭晓答案')?.click());
    expect(button('查看原视频')).toBeDefined();
    await act(async () => {
      button('查看原视频')?.click();
      await Promise.resolve();
    });

    expect(extensionMocks.openSourceAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      }),
    );
  });

  it('opens a manual Video Moment without inventing or requesting a timestamp', async () => {
    const learningItem: VideoLearningItem = {
      ...item('manual-video'),
      sourceType: 'video',
      videoOrigin: 'library',
      platform: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoId: 'abcdefghijk',
      timestampSeconds: null,
      timestampDisplay: null,
      screenshotId: null,
    };

    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });
    expect(button('查看原视频')).toBeDefined();
    expect(container.textContent).not.toContain('00:00');
    expect(container.querySelector('.review-captured-frame')).toBeNull();
    expect(container.querySelector('[data-review-media-kind="video"]')).toBeNull();
    act(() => button('揭晓答案')?.click());
    const sourceContext = container.querySelector<HTMLDetailsElement>('.source-context-disclosure');
    expect(sourceContext).not.toBeNull();
    expect(sourceContext?.querySelector('[aria-label="Nearby caption excerpt"]')).toBeNull();
    expect(container.querySelector('.review-subtitle-context')).toBeNull();
    expect(sourceContext?.querySelector('summary')?.textContent).toBe('来源详情');
    expect(sourceContext?.querySelector('summary')?.getAttribute('aria-label')).toBe(
      'YouTube 的来源详情',
    );
    expect(sourceContext?.textContent).toContain(learningItem.videoTitle);
    expect(button('查看原视频')).toBeDefined();
    await act(async () => {
      button('查看原视频')?.click();
      await Promise.resolve();
    });
    expect(extensionMocks.openSourceAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({ timestampSeconds: null }),
    );
  });

  it('starts a stable due-only session for one Category and names only that Category', async () => {
    const tacticsItem = { ...item('tactics-only'), categoryId: 'category-tactics' };
    const otherItem = { ...item('other-category'), categoryId: 'category-other' };
    const categoryTime = new Date('2026-08-03T10:00:00.000Z');
    const summaries: CategorySummary[] = [
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      {
        category: {
          id: 'category-tactics',
          schemaVersion: 1,
          name: 'Tactics',
          createdAt: categoryTime,
          updatedAt: categoryTime,
          lastUsedAt: categoryTime,
        },
        totalCount: 1,
        dueCount: 1,
        nextReviewAt: now,
      },
      {
        category: {
          id: 'category-other',
          schemaVersion: 1,
          name: 'Other',
          createdAt: categoryTime,
          updatedAt: categoryTime,
          lastUsedAt: categoryTime,
        },
        totalCount: 1,
        dueCount: 1,
        nextReviewAt: now,
      },
    ];
    const loadDueItems = vi.fn(async (_at: Date, categoryId?: string | null) =>
      categoryId === 'category-tactics' ? [tacticsItem] : [tacticsItem, otherItem],
    );
    const countDueItems = vi.fn(async () => 2);
    await renderView({
      items: [tacticsItem, otherItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(tacticsItem)),
      loadDueItems,
      countDueItems,
      loadCategorySummaries: async () => summaries,
      autoStart: false,
    });

    const scopeSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'category-tactics'),
    );
    await act(async () => {
      if (!scopeSelect) throw new Error('Expected the Review Category selector.');
      scopeSelect.value = 'category-tactics';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadDueItems).toHaveBeenLastCalledWith(now, 'category-tactics');
    expect(container.textContent).not.toContain('全局到期');
    expect(container.textContent).toContain('1 条到期 Moment');

    await act(async () => {
      button('开始复习')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Recall tactics-only');
    expect(container.textContent).not.toContain('Recall other-category');
    const scope = container.querySelector('.review-active-scope');
    expect(scope?.classList.contains('sr-only')).toBe(false);
    expect(scope?.textContent).toBe('范围：Tactics');
  });

  it('hides the scope label in a session over everything, keeping the heading as a focus target', async () => {
    await renderView({ items: [item('all-scope')], reviewItem: vi.fn<ReviewItem>() });
    const scope = container.querySelector<HTMLElement>('.review-active-scope');
    expect(scope?.classList.contains('sr-only')).toBe(true);
    expect(scope?.classList.contains('dashboard-page-heading')).toBe(true);
    expect(scope?.getAttribute('tabindex')).toBe('-1');
    expect(scope?.textContent).toBe('范围：全部到期');
    scope?.focus();
    expect(document.activeElement).toBe(scope);
  });

  it('shows the scope label for the uncategorized session too', async () => {
    const uncategorized = item('no-category');
    await renderView({
      items: [uncategorized],
      reviewItem: vi.fn<ReviewItem>(),
      loadCategorySummaries: async () => [
        { category: null, totalCount: 1, dueCount: 1, nextReviewAt: now },
      ],
      autoStart: false,
    });
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('.review-scope-picker select')!;
      select.value = 'uncategorized';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button('开始复习')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const scope = container.querySelector('.review-active-scope');
    expect(scope?.classList.contains('sr-only')).toBe(false);
    expect(scope?.textContent).toBe('范围：未分类');
  });

  it('keeps only the count, the Category control and the start button at entry', async () => {
    await renderView({
      items: [item('entry-only')],
      reviewItem: vi.fn<ReviewItem>(),
      autoStart: false,
    });
    const view = container.querySelector('.review-view');
    for (const removed of [
      '先自己想一遍',
      '准备开始',
      '专注会话',
      '本次范围',
      '按分类复习',
      '全部到期',
      '全局到期',
    ]) {
      expect(view?.textContent).not.toContain(removed);
    }
    expect(container.querySelector('.review-phase-label')).toBeNull();
    expect(container.querySelector('.review-view .eyebrow')).toBeNull();
    expect(container.querySelector('.review-entry-summary')?.textContent).toBe('1 条到期 Moment');
    expect(container.querySelector('.review-scope-picker')?.getAttribute('aria-label')).toBe(
      '按分类复习',
    );
    expect(container.querySelector('.review-scope-picker select')).not.toBeNull();
    expect(button('开始复习')).toBeDefined();
    // The route and tab switches still have somewhere to put focus.
    const heading = container.querySelector<HTMLElement>('h2.dashboard-page-heading');
    expect(heading?.textContent).toBe('到期主动回忆');
    expect(heading?.classList.contains('sr-only')).toBe(true);
    expect(heading?.getAttribute('tabindex')).toBe('-1');
    heading?.focus();
    expect(document.activeElement).toBe(heading);
  });

  it('keeps the empty entry to one line and the ways forward', async () => {
    await renderView({ items: [], reviewItem: vi.fn<ReviewItem>(), autoStart: false });
    expect(container.querySelector('.review-entry-summary')?.textContent).toBe('都跟上了');
    expect(container.textContent).not.toContain('没有到期内容');
    expect(container.querySelector('.review-view .eyebrow')).toBeNull();
    expect(button('查看即将到期')).toBeDefined();
    expect(button('返回首页')).toBeDefined();
  });

  it('shows no labels around the question, while the goal and source stay', async () => {
    const learningItem = { ...item('plain-card'), screenshotId: 'frame' };
    await renderView({ items: [learningItem], reviewItem: vi.fn<ReviewItem>() });
    const view = container.querySelector('.review-view');
    for (const removed of ['正在回忆', '答案已揭示', '回忆提示', '也可揭晓', '空格']) {
      expect(view?.textContent).not.toContain(removed);
    }
    expect(container.querySelector('.review-phase-label')).toBeNull();
    expect(container.querySelector('.review-key-hint')).toBeNull();
    expect(container.querySelector('.review-prompt-block .eyebrow')).toBeNull();
    expect(container.querySelector('figcaption')?.textContent).toBe('Bilibili · 00:42');
    expect(container.querySelectorAll('.review-item-meta .pill')).toHaveLength(1);
    expect(container.querySelector('.review-item-meta .pill.Do')).not.toBeNull();

    act(() => button('揭晓答案')?.click());

    for (const removed of ['答案已揭示', '关键收获', '回忆得怎么样？', '评分后进入下一题。']) {
      expect(view?.textContent).not.toContain(removed);
    }
    expect(container.querySelector('.answer-box .eyebrow')).toBeNull();
    const ratings = button('Good')?.closest('[role="group"]');
    expect(ratings?.getAttribute('aria-label')).toBe('回忆得怎么样？');
    expect(ratings?.hasAttribute('aria-labelledby')).toBe(false);
    // The only explanation of each grade stays on its button.
    expect(button('Again')?.textContent).toContain('没想起来');
    expect(button('Hard')?.textContent).toContain('费力想起');
    expect(button('Good')?.textContent).toContain('正常想起');
    expect(button('Easy')?.textContent).toContain('轻松想起');
  });

  it.each([
    ['Text', textItem('type-text')],
    ['Image', imageItem('type-image')],
  ] as const)('does not label a %s Moment by its media type', async (_label, learningItem) => {
    await renderView({ items: [learningItem], reviewItem: vi.fn<ReviewItem>() });
    const pills = [...container.querySelectorAll('.review-item-meta .pill')];
    expect(pills).toHaveLength(1);
    expect(pills[0]?.classList.contains(learningItem.itemType)).toBe(true);
    expect(pills[0]?.textContent).not.toBe('文字');
    expect(pills[0]?.textContent).not.toBe('图片');
  });

  it('announces saving and failure to screen readers without showing a status line', async () => {
    const learningItem = item('quiet-status');
    let reject!: (error: Error) => void;
    const reviewItem = vi.fn<ReviewItem>(() => new Promise((_, fail) => (reject = fail)));
    await renderView({
      items: [learningItem],
      reviewItem,
      loadDueItems: async () => [learningItem],
    });
    const status = () => container.querySelector('.review-cue-companion [role="status"]');
    expect(status()?.classList.contains('sr-only')).toBe(true);
    expect(status()?.textContent).toBe('');
    act(() => button('揭晓答案')?.click());
    expect(status()?.textContent).toBe('');
    expect(container.querySelector('.review-save-status')).toBeNull();

    act(() => button('Good')?.click());
    expect(status()?.textContent).toBe('正在保存 Good');
    expect(container.querySelector('.review-save-status')).toBeNull();
    expect(button('Good')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      reject(new Error('写入失败'));
      await Promise.resolve();
    });
    expect(status()?.textContent).toBe('保存未确认');
    expect(container.querySelector('.review-save-status')?.textContent).toBe(
      '没保存成功，请刷新后重试。',
    );
    expect(container.textContent).toContain('写入失败');
  });

  it('removes the saved notice but keeps a skip notice, and never lets it linger on later cards', async () => {
    const skipped = item('skip-first');
    const second = item('skip-second');
    const third = item('skip-third');
    const loadDueItems = vi
      .fn<DueItemsLoader>()
      .mockResolvedValueOnce([skipped, second, third])
      .mockResolvedValueOnce([second, third]);
    const reviewItem = vi
      .fn<ReviewItem>()
      .mockRejectedValueOnce(new Error('Review state changed'))
      .mockImplementation(async () => reviewResult(second));
    await renderView({ items: [skipped, second, third], loadDueItems, reviewItem });

    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Recall skip-second');
    expect(container.querySelector('.notice')?.textContent).toContain('已跳过');

    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Recall skip-third');
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.querySelector('.review-step-feedback')).not.toBeNull();
    expect(container.textContent).not.toContain('下次复习');
  });

  it('keeps one completion heading and the next-review date', async () => {
    const learningItem = item('one-heading');
    await renderView({
      items: [learningItem],
      reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
    });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    const copy = container.querySelector('.review-complete-copy');
    expect(container.querySelector('.review-phase-label')).toBeNull();
    expect(container.querySelector('.review-view .eyebrow')).toBeNull();
    expect(container.textContent).not.toContain('专注会话');
    expect(container.textContent).not.toContain('暂不可用');
    expect(copy?.querySelectorAll('h2')).toHaveLength(1);
    expect(copy?.querySelector('h2')?.textContent).toBe('本轮结束');
    expect(document.activeElement).toBe(copy?.querySelector('h2'));
    expect(copy?.textContent).toContain('最早下次复习');
    expect(copy?.querySelector('.review-session-next time')).not.toBeNull();
  });

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) =>
        (candidate.querySelector('span')?.textContent ?? candidate.textContent) === label,
    );
  }

  function resultValue(label: string): string | null | undefined {
    return [...container.querySelectorAll('.review-session-results > div')]
      .find((row) => row.querySelector('dt')?.textContent === label)
      ?.querySelector('dd')?.textContent;
  }

  it('blocks navigation during a pending rating and separates saved reviews from reward failure', async () => {
    const learningItem = item('pending-rating');
    let resolve!: (result: PersistedFsrsReviewResult) => void;
    const reviewItem = vi.fn<ReviewItem>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const reward = vi.fn<ReviewAllowanceRecorder>().mockRejectedValue(new Error('storage failed'));
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    await renderView({ items: [learningItem], reviewItem, recordReviewAllowance: reward });
    act(() => button('揭晓答案')!.click());
    act(() => button('Good')!.click());
    expect(requestEditorLeave()).toBe(false);
    await act(async () => resolve(reviewResult(learningItem)));
    expect(requestEditorLeave()).toBe(true);
    expect(container.textContent).toContain('复习已保存，零花钱没更新');
    expect(container.textContent).toContain('本轮结束');
    expect(reward).toHaveBeenCalledOnce();
  });

  it('keeps the vertical ritual and puts check-in praise in the Learning region after a completed session', async () => {
    const learningItem = item('allowance-complete');
    const reviewItem = vi.fn<ReviewItem>(async () => reviewResult(learningItem));
    const recordReviewAllowance = vi.fn<ReviewAllowanceRecorder>(async () => ({
      state: {
        ...DEFAULT_ALLOWANCE,
        balance: 5,
        currentStreak: 1,
        lastCheckInDate: '2026-07-21',
        reviewStreak: 1,
        lastReviewSessionDate: '2026-07-21',
        totalEarned: 5,
      },
      checkIn: true,
      checkInReward: 5,
      checkInPraise: CHECK_IN_PRAISES[0],
      reviewStreak: 1,
      milestone: null,
      milestoneReward: 0,
      milestonePraise: null,
    }));
    await renderView({ items: [learningItem], reviewItem, recordReviewAllowance });
    act(() => button('揭晓答案')?.click());
    await act(async () => {
      button('Good')?.click();
      await Promise.resolve();
    });

    expect(recordReviewAllowance).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(CHECK_IN_PRAISES[0]);
    expect(container.textContent).toContain('+5 零花钱');
    const completionLayout = container.querySelector('.review-complete-layout');
    const learning = completionLayout?.querySelector('[data-review-stage-region="learning"]');
    const allowanceCopy = learning?.querySelector('[data-review-allowance="true"]');
    expect(allowanceCopy).not.toBeNull();
    expect(completionLayout?.firstElementChild?.getAttribute('data-review-stage-region')).toBe(
      'companion',
    );
    expect(
      completionLayout?.querySelector('[data-review-dialogue-intent="completion"]')?.textContent,
    ).toBe(COMPLETE_POOL[0]);
  });

  describe('companion art', () => {
    // Fixed local clocks: the outfit follows the date, the pose follows the scene and card.
    const today = '2026-10-28';
    const afternoon = new Date(2026, 9, 28, 14, 0);
    const afternoonClock = () => afternoon;

    function companionShell(): HTMLElement | null {
      return container.querySelector<HTMLElement>('.companion');
    }

    function artOf(shell = companionShell()) {
      return {
        state: shell?.getAttribute('data-companion-state'),
        slot: shell?.getAttribute('data-companion-slot'),
        pose: shell?.getAttribute('data-companion-pose'),
        outfit: shell?.getAttribute('data-companion-outfit'),
        motion: shell?.getAttribute('data-companion-motion'),
      };
    }

    function layerImage(key: string): HTMLImageElement | null {
      return container.querySelector<HTMLImageElement>(`img[data-companion-layer="${key}"]`);
    }

    function artSources(): string[] {
      return [...container.querySelectorAll('img')].map((image) => image.getAttribute('src') ?? '');
    }

    function loadAllArt() {
      act(() => {
        for (const image of container.querySelectorAll('img')) {
          image.dispatchEvent(new Event('load'));
        }
      });
    }

    async function rateGood() {
      await act(async () => {
        button('Good')?.click();
        await Promise.resolve();
      });
    }

    async function settleWardrobe() {
      await act(async () => {
        for (let step = 0; step < 6; step += 1) await Promise.resolve();
      });
    }

    function stubWardrobeStorage(initial: unknown) {
      type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
      const listeners = new Set<Listener>();
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn(async (key: string) =>
              key === COMPANION_WARDROBE_STORAGE_KEY ? { [key]: initial } : {},
            ),
            set: vi.fn(async () => undefined),
          },
          onChanged: {
            addListener: (listener: Listener) => listeners.add(listener),
            removeListener: (listener: Listener) => listeners.delete(listener),
          },
        },
      });
      return {
        pin(outfit: CompanionOutfit) {
          act(() => {
            for (const listener of listeners) {
              listener(
                {
                  [COMPANION_WARDROBE_STORAGE_KEY]: {
                    newValue: { version: 1, mode: 'pinned', outfit },
                  },
                },
                'local',
              );
            }
          });
        },
      };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('invites at entry when reviews are due, in the current outfit, keeping the due state', async () => {
      await renderView({
        items: [item('entry-art')],
        reviewItem: vi.fn<ReviewItem>(),
        autoStart: false,
        clock: afternoonClock,
      });

      expect(artOf()).toEqual({
        state: 'due',
        slot: 'invite',
        pose: invitePose(today),
        outfit: outfitForDate(today),
        motion: 'animated',
      });
      expect(layerImage('invite')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), invitePose(today), 'animated'),
      );
      expect(layerImage('recall')?.getAttribute('src')).toBe(
        companionArtPath(outfitForDate(today), 'think', 'static'),
      );
    });

    it('rests at entry by the hour when nothing is due', async () => {
      await renderView({
        items: [],
        reviewItem: vi.fn<ReviewItem>(),
        clock: afternoonClock,
      });

      expect(artOf()).toEqual({
        state: 'idle',
        slot: 'rest',
        pose: idlePoseForHour(14),
        outfit: outfitForDate(today),
        motion: 'animated',
      });
    });

    it('rolls the entry over to the new day when the tab is shown again', async () => {
      let now = new Date(2026, 9, 28, 21, 50);
      await renderView({ items: [], reviewItem: vi.fn<ReviewItem>(), clock: () => now });
      expect(artOf()).toMatchObject({ pose: 'tea', outfit: outfitForDate(today) });

      now = new Date(2026, 9, 29, 8, 0);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(artOf()).toMatchObject({ pose: 'wave', outfit: outfitForDate('2026-10-29') });
    });

    it('keeps the question still, alternates the reveal pose per card and finishes by the day', async () => {
      const cards = [item('art-one'), item('art-two'), item('art-three')];
      const reviewItem = vi.fn<ReviewItem>(async (itemId) =>
        reviewResult(cards.find((card) => card.id === itemId) ?? cards[0]!),
      );
      await renderView({ items: cards, reviewItem, clock: afternoonClock });
      const outfit = outfitForDate(today);

      for (const [cardIndex, card] of cards.entries()) {
        expect(container.textContent).toContain(card.recallPrompt);
        // Recalling: the still think pose, and no animated file anywhere on the page.
        expect(artOf()).toEqual({
          state: 'due',
          slot: 'recall',
          pose: 'think',
          outfit,
          motion: 'static',
        });
        expect(artSources().filter((source) => source.endsWith('.anim.svg'))).toEqual([]);
        // The card's reveal pose waits as a static twin, ready for the switch.
        expect(layerImage('reveal')?.getAttribute('src')).toBe(
          companionArtPath(outfit, revealPose(cardIndex), 'static'),
        );

        act(() => button('揭晓答案')?.click());
        expect(artOf()).toEqual({
          state: 'reviewing',
          slot: 'reveal',
          pose: cardIndex % 2 === 0 ? 'aha' : 'note',
          outfit,
          motion: 'animated',
        });
        expect(layerImage('reveal')?.getAttribute('src')).toBe(
          companionArtPath(outfit, revealPose(cardIndex), 'animated'),
        );
        // The art has not loaded in this test; the ratings never wait for it.
        expect(companionShell()?.hidden).toBe(true);
        expect(button('Good')?.disabled).toBe(false);
        await rateGood();
      }

      expect(reviewItem).toHaveBeenCalledTimes(3);
      expect(container.textContent).toContain('本轮结束');
      expect(artOf()).toEqual({
        state: 'success',
        slot: 'complete',
        pose: reviewCompletePose(today),
        outfit,
        motion: 'animated',
      });
    });

    it('keeps the session outfit when the pin changes mid-session, while the entry follows it', async () => {
      const wardrobe = stubWardrobeStorage({ version: 1, mode: 'pinned', outfit: 'outfit10' });
      const learningItem = item('pinned-session');
      await renderView({
        items: [learningItem],
        reviewItem: vi.fn<ReviewItem>(async () => reviewResult(learningItem)),
        autoStart: false,
        clock: afternoonClock,
        wardrobe: true,
      });
      await settleWardrobe();
      expect(artOf().outfit).toBe('outfit10');

      // Before a session the entry wears whatever is current.
      wardrobe.pin('outfit12');
      expect(artOf().outfit).toBe('outfit12');
      expect(layerImage('invite')?.getAttribute('src')).toBe(
        companionArtPath('outfit12', invitePose(today), 'animated'),
      );

      act(() => button('开始复习')?.click());
      expect(artOf()).toMatchObject({ slot: 'recall', outfit: 'outfit12' });

      wardrobe.pin('outfit1');
      expect(artOf()).toMatchObject({ slot: 'recall', outfit: 'outfit12' });
      expect(artSources().every((source) => source.includes('/outfit12/'))).toBe(true);

      act(() => button('揭晓答案')?.click());
      expect(artOf()).toMatchObject({ slot: 'reveal', pose: 'aha', outfit: 'outfit12' });
      await rateGood();
      expect(container.textContent).toContain('本轮结束');
      expect(artOf()).toMatchObject({ state: 'success', slot: 'complete', outfit: 'outfit12' });
      expect(artSources().every((source) => source.includes('/outfit12/'))).toBe(true);
    });

    it('keeps the outfit and day the session started with across midnight', async () => {
      let current = new Date(2026, 9, 28, 23, 58);
      const tomorrow = '2026-10-29';
      expect(outfitForDate(tomorrow)).not.toBe(outfitForDate(today));
      const first = item('midnight-first');
      const second = item('midnight-second');
      await renderView({
        items: [first, second],
        reviewItem: vi.fn<ReviewItem>(async (itemId) =>
          reviewResult(itemId === first.id ? first : second),
        ),
        clock: () => current,
      });
      expect(artOf()).toMatchObject({ slot: 'recall', outfit: outfitForDate(today) });

      current = new Date(2026, 9, 29, 0, 2);
      act(() => button('揭晓答案')?.click());
      expect(artOf()).toMatchObject({ slot: 'reveal', outfit: outfitForDate(today) });
      await rateGood();
      act(() => button('揭晓答案')?.click());
      expect(artOf()).toMatchObject({ pose: 'note', outfit: outfitForDate(today) });
      await rateGood();
      expect(artOf()).toMatchObject({
        slot: 'complete',
        pose: reviewCompletePose(today),
        outfit: outfitForDate(today),
      });
    });

    it('shows only static files under Reduced Motion, in every scene', async () => {
      const restoreMatchMedia = installReducedMotion(true);
      try {
        const first = item('still-first');
        const second = item('still-second');
        await renderView({
          items: [first, second],
          reviewItem: vi.fn<ReviewItem>(async (itemId) =>
            reviewResult(itemId === first.id ? first : second),
          ),
          autoStart: false,
          clock: afternoonClock,
        });

        function expectOnlyStaticArt(slot: string) {
          loadAllArt();
          const sources = artSources();
          expect(sources.length).toBeGreaterThan(0);
          expect(sources.filter((source) => source.includes('.anim.'))).toEqual([]);
          expect(sources.every((source) => source.endsWith('.svg'))).toBe(true);
          expect(artOf()).toMatchObject({ slot, motion: 'static' });
          expect(layerImage(slot)?.classList.contains('is-active')).toBe(true);
        }

        expectOnlyStaticArt('invite');
        act(() => button('开始复习')?.click());
        expectOnlyStaticArt('recall');
        act(() => button('揭晓答案')?.click());
        expectOnlyStaticArt('reveal');
        await rateGood();
        expectOnlyStaticArt('recall');
        act(() => button('揭晓答案')?.click());
        expect(artOf().pose).toBe('note');
        expectOnlyStaticArt('reveal');
        await rateGood();
        expect(artOf().state).toBe('success');
        expectOnlyStaticArt('complete');
      } finally {
        restoreMatchMedia();
      }
    });
  });

  async function renderView({
    items,
    reviewItem,
    onChanged = () => undefined,
    onGoHome = () => undefined,
    onGoLibrary = () => undefined,
    onViewUpcoming = () => undefined,
    preferredItemId = null,
    previewItem,
    autoStart = true,
    startRequest = null,
    onStartRequestConsumed = () => undefined,
    countDueItems = async () => 0,
    loadDueItems = async () => items,
    loadCategorySummaries = async () => [],
    recordReviewAllowance = async () => null,
    suspendItem,
    clock = () => now,
    wardrobe = false,
  }: {
    items: LearningItem[];
    reviewItem: ReviewItem;
    onChanged?: () => void;
    onGoHome?: () => void;
    onGoLibrary?: () => void;
    onViewUpcoming?: () => void;
    preferredItemId?: string | null;
    previewItem?: (item: LearningItem, reviewedAt: Date) => FsrsPreview;
    autoStart?: boolean;
    startRequest?: ReviewStartRequest | null;
    onStartRequestConsumed?: () => void;
    countDueItems?: (at: Date, categoryId?: string | null) => Promise<number>;
    loadDueItems?: (at: Date, categoryId?: string | null) => Promise<LearningItem[]>;
    loadCategorySummaries?: (at: Date) => Promise<CategorySummary[]>;
    recordReviewAllowance?: ReviewAllowanceRecorder;
    suspendItem?: SuspendItem;
    clock?: () => Date;
    /** Mount inside the wardrobe provider, as the dashboard does. */
    wardrobe?: boolean;
  }) {
    const view = (
      <TodayView
        revision={0}
        preferences={DEFAULT_PREFERENCES}
        onChanged={onChanged}
        onGoHome={onGoHome}
        onGoLibrary={onGoLibrary}
        onViewUpcoming={onViewUpcoming}
        preferredItemId={preferredItemId}
        startRequest={startRequest}
        onStartRequestConsumed={onStartRequestConsumed}
        loadDueItems={loadDueItems}
        countDueItems={countDueItems}
        loadCategorySummaries={loadCategorySummaries}
        reviewItem={reviewItem}
        {...(previewItem ? { previewItem } : {})}
        recordReviewAllowance={recordReviewAllowance}
        {...(suspendItem ? { suspendItem } : {})}
        clock={clock}
      />
    );
    await act(async () => {
      root.render(wardrobe ? <CompanionWardrobeProvider>{view}</CompanionWardrobeProvider> : view);
      await Promise.resolve();
    });
    if (autoStart && items.length > 0) {
      act(() => button('开始复习')?.click());
    }
  }
});

describe('TodayView durable review reward presentation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let repository: ValRecallRepository;
  let wallet: WalletRepository;
  const fallbackReward = vi.fn<ReviewAllowanceRecorder>(async () => null);

  beforeEach(async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    extensionMocks.refreshReviewReminders.mockReset().mockResolvedValue({ ok: true });
    repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'durable-review-ui',
      clock: () => now,
    });
    vi.spyOn(dashboardRepository, 'open').mockImplementation(() => repository.open());
    wallet = new WalletRepository(repository, async () => DEFAULT_ALLOWANCE);
    await wallet.ensureWallet();
    fallbackReward.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    repository.close();
    vi.restoreAllMocks();
  });

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (candidate) =>
        (candidate.querySelector('span')?.textContent ?? candidate.textContent) === label,
    );
  const phase = () =>
    container
      .querySelector('[data-review-session-phase]')
      ?.getAttribute('data-review-session-phase');

  async function settled(assertion: () => void) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
      try {
        assertion();
        return;
      } catch (error) {
        if (attempt === 99) throw error;
      }
    }
  }

  async function start(ids: string[]) {
    for (const id of ids) await repository.createTextItem(textItem(id));
    await act(async () => {
      root.render(
        <TodayView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={() => undefined}
          onGoHome={() => undefined}
          onGoLibrary={() => undefined}
          recordReviewAllowance={fallbackReward}
          clock={() => now}
        />,
      );
    });
    await settled(() => expect(button('开始复习')?.disabled).toBe(false));
    act(() => button('开始复习')!.click());
    expect(phase()).toBe('active');
    expect(container.textContent).not.toContain('零花钱 +');
  }

  async function rate(rating: string) {
    act(() => button('揭晓答案')!.click());
    act(() => button(rating)!.click());
    await settled(() => expect(container.textContent).not.toContain(`正在保存 ${rating}`));
  }

  it.each(['Again', 'Hard', 'Good', 'Easy'])(
    'shows the actual one-yuan receipt for %s only after the default atomic commit',
    async (rating) => {
      await start(['a']);
      act(() => button('揭晓答案')!.click());
      act(() => button(rating)!.click());
      expect(container.textContent).not.toContain('零花钱 +');
      await settled(() => expect(phase()).toBe('complete'));
      expect(container.textContent).toContain('零花钱 +1 元');
      expect(container.textContent).toContain('本轮 +1 元');
      expect(container.textContent).toContain('+5 零花钱');
      expect((await wallet.load()).balance).toBe(6);
      expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(1);
      expect(fallbackReward).not.toHaveBeenCalled();
    },
  );

  it('sums actual committed steps and keeps mastery outside the per-question reward', async () => {
    await start(['a', 'b', 'c']);
    expect(container.querySelector('.review-session-earned')).toBeNull();
    await rate('Good');
    expect(container.textContent).toContain('零花钱 +1 元');
    expect(container.textContent).toContain('Recall b');
    expect(container.querySelector('.review-session-earned')?.textContent).toBe('本轮 +1 元');
    await rate('Hard');
    expect(container.querySelector('.review-step-amount')?.textContent).toBe('+1 元');
    expect(container.querySelector('.review-session-earned')?.textContent).toBe('本轮 +2 元');
    expect((await wallet.load()).balance).toBe(2);
    act(() => button('学成')!.click());
    await settled(() => expect(phase()).toBe('complete'));
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(container.textContent).toContain('本轮 +2 元');
    expect((await wallet.load()).balance).toBe(7);
    expect((await repository.getItem('c'))?.reviewHistory).toHaveLength(0);
    expect((await repository.getItem('c'))?.suspended).toBe(true);
    expect(fallbackReward).not.toHaveBeenCalled();
  });

  it('never announces a failed credit and starts a fresh reward total after queue recovery', async () => {
    await start(['a', 'b']);
    await rate('Good');
    const original = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_NAMES.wallet) throw new Error('零花钱写入失败');
      return original.apply(this, args);
    });
    await rate('Good');
    expect(phase()).toBe('active');
    expect(container.textContent).toContain('零花钱写入失败');
    expect(container.textContent).not.toContain('零花钱 +');
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    // The tally keeps only the first committed receipt; the failed step adds nothing.
    expect(container.querySelector('.review-session-earned')?.textContent).toBe('本轮 +1 元');
    expect((await wallet.load()).balance).toBe(1);
    expect((await repository.getItem('b'))?.reviewHistory).toHaveLength(0);
    fault.mockRestore();
    act(() => button('刷新复习会话')!.click());
    await settled(() => expect(button('揭晓答案')?.disabled).toBe(false));
    expect(container.textContent).toContain('Recall b');
    await rate('Easy');
    expect(phase()).toBe('complete');
    expect(container.textContent).toContain('本轮 +1 元');
    expect(container.textContent).not.toContain('本轮 +2');
    expect((await wallet.load()).balance).toBe(7);
    expect(fallbackReward).not.toHaveBeenCalled();
  });

  it('does not fabricate a payment when the durable service returns a historical zero-reward receipt', async () => {
    await start(['a']);
    const current = (await repository.getItem('a'))!;
    const historical = await new ReviewSessionService(repository).rate(
      { id: 'historical', queue: ['a'], createdAt: now.toISOString() },
      current,
      'Good',
      now,
      new FsrsService({ clock: () => now }),
      now,
    );
    for (const step of historical.session.steps) delete step.rewardAmount;
    vi.spyOn(ReviewSessionService.prototype, 'rate').mockResolvedValue({
      ...historical,
      rewardAmount: 0,
    });
    await rate('Good');
    expect(phase()).toBe('complete');
    expect(container.querySelector('.review-step-feedback[data-rewarded="false"]')).not.toBeNull();
    expect(container.textContent).not.toContain('零花钱 +');
    expect(container.querySelector('.review-earned-total')).toBeNull();
    expect(fallbackReward).not.toHaveBeenCalled();
  });
});

function expectCueSpriteLayout(root: ParentNode) {
  const stage = root.querySelector('.review-stage');
  const learning = stage?.querySelector('[data-review-stage-region="learning"]');
  const companion = learning?.querySelector('[data-review-stage-region="companion"]');
  const controls = stage?.querySelector('[data-review-stage-region="controls"]');
  const cueRow = learning?.querySelector('.review-cue-row');
  expect(stage?.getAttribute('data-review-composition')).toBe('immersive-reading');
  expect(stage?.firstElementChild).toBe(learning);
  expect(learning?.querySelector('.review-reading-column')?.lastElementChild).toBe(controls);
  expect(root.querySelector('.review-count-cluster')).toBeNull();
  expect(root.querySelectorAll('.review-active-scope')).toHaveLength(1);
  expect(root.querySelectorAll('progress')).toHaveLength(1);
  expect(cueRow).not.toBeNull();
  expect(companion?.classList.contains('review-companion-cue')).toBe(true);
  expect(cueRow?.contains(companion ?? null)).toBe(true);
}

function installReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: original,
    });
  };
}

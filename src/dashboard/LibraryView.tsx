import type { EditCommit } from '../database/edit-commit';
import './library-workspace.css';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DetailEditor, type EditableValues } from './MomentEditor';
import { MomentReading } from './MomentReading';
import { platformLabel, sourceLabel } from '../shared/source-labels';

import type {
  CategorySummary,
  LearningItem,
  LearningItemSource,
  ListItemsOptions,
  MomentCategory,
  VideoLearningItem,
} from '../database';
import { isVideoLearningItem, learningItemSource, learningItemTitle } from '../database';
import { CATEGORY_PICKER_VISIBLE_LIMIT } from '../models/category';
import type { LearningItemType } from '../models/learning-item';
import { LEARNING_ITEM_TYPES, learningGoalLabel } from '../models/learning-item';
import { LiveStatus, Notice } from '../shared/components';
import { requestEditorLeaveAsync, useEditProtection } from '../shared/edit-protection';
import { displayError, openSourceAtTimestamp } from '../shared/extension';
import type { ValRecallPreferences } from '../shared/preferences';
import {
  MOTION_DURATION_MS,
  MotionDisclosure,
  safeViewTransition,
  useReducedMotion,
} from '../ui/motion';
import { Companion } from './Companion';
import { repository } from './services';
import { deriveSourceGroups, isItemDue, type DerivedSourceGroup } from './source-groups';
import { libraryEmptyHint, useCaptureShortcut } from '../edition/shortcut';

type StatusFilter = 'all' | 'due' | 'future' | 'suspended';
type SourceFilter = LearningItemSource | 'all';
type LibraryArrangement = 'recent' | 'oldest' | 'due' | 'sources' | 'source-types';
type LibraryViewMode = 'items' | 'sources' | 'source-types';
type CategoryFilter = 'all' | 'uncategorized' | string;

const LIBRARY_SUCCESS_NOTICE_MS = 4_000;
/** A refresh shorter than this never shows its status line or dims the list. */
export const LIBRARY_REFRESH_NOTICE_MS = 300;

function focusNearestStableElement(element: HTMLElement | null): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  const bounds = element.getBoundingClientRect();
  const outsideViewport =
    bounds.top < 0 ||
    bounds.left < 0 ||
    bounds.bottom > window.innerHeight ||
    bounds.right > window.innerWidth;
  if (outsideViewport && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  }
}

interface LibraryDetailRequest {
  key: number;
  itemId: string;
}
const LibraryReadingContext = createContext<{
  id: string | null;
  open: (id: string, trigger: HTMLButtonElement) => void;
  close: (id: string) => void;
  busy: boolean;
}>({ id: null, open: () => undefined, close: () => undefined, busy: false });

export function LibraryView({
  revision,
  active = true,
  preferences,
  onChanged,
  onCreatePracticeTask,
  onReviewItem,
  onAddQuestion,
  initialSelectedItemId = null,
  detailRequest = null,
  onDetailRequestConsumed,
}: {
  revision: number;
  active?: boolean;
  preferences: ValRecallPreferences;
  onChanged: () => void;
  onCreatePracticeTask?: (item: LearningItem) => void;
  onReviewItem?: (item: LearningItem) => void;
  onAddQuestion?: (categoryId: string | null) => void;
  initialSelectedItemId?: string | null;
  detailRequest?: LibraryDetailRequest | null;
  onDetailRequestConsumed?: () => void;
}) {
  const captureShortcut = __VALRECALL_PUBLIC_RELEASE__ ? useCaptureShortcut() : undefined;
  const [items, setItems] = useState<LearningItem[]>([]);
  const [arrangement, setArrangement] = useState<LibraryArrangement>('recent');
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<LearningItemType | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [categorySummaries, setCategorySummaries] = useState<CategorySummary[]>([]);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [editBusyId, setEditBusyId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [renameCategoryName, setRenameCategoryName] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [readingId, setReadingId] = useState<string | null>(initialSelectedItemId);
  const [focusedItem, setFocusedItem] = useState<LearningItem | null>(null);
  const [pane, setPane] = useState<'directory' | 'content'>(
    initialSelectedItemId ? 'content' : 'directory',
  );
  const readingHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const directoryRef = useRef<HTMLDivElement | null>(null);
  const retainedOrderRef = useRef<string[] | null>(null);
  const selectingRef = useRef(false);
  const readingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailRequestSequence = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Which request is running: a new one restarts the wait below.
  const [refreshRequest, setRefreshRequest] = useState(0);
  // Set once one running request outlasts LIBRARY_REFRESH_NOTICE_MS; it stays until a result
  // arrives, so it cannot blink.
  const [showRefreshing, setShowRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [recentlyVisibleIds, setRecentlyVisibleIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'success' | 'warning' | 'error';
  } | null>(null);
  // Results the page already shows are spoken by a hidden status line, so nothing appears or
  // moves. The sequence re-announces an identical sentence. A visible notice stays for what
  // the page cannot show: failures, and how many questions a category merge or delete moved.
  const [liveStatus, setLiveStatus] = useState<{ text: string; seq: number } | null>(null);
  const liveStatusSeq = useRef(0);
  const loadedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const editingSnapshot = useRef<{ id: string | null; items: LearningItem[] }>({
    id: selectedId,
    items,
  });
  editingSnapshot.current = { id: selectedId, items };
  const focusedItemRef = useRef(focusedItem);
  focusedItemRef.current = focusedItem;
  const openReadAt = useRef(revision);
  const categoryRequestRef = useRef(0);
  const categoryFilterRef = useRef(categoryFilter);
  categoryFilterRef.current = categoryFilter;
  const knownItemIdsRef = useRef<Set<string>>(new Set());
  const recentlyVisibleTimerRef = useRef<number | null>(null);
  const pendingFocusItemIdRef = useRef<string | null>(null);
  // Pressing what is already open changes no state, so this is what makes the request get consumed.
  const [focusRequest, setFocusRequest] = useState(0);
  const editBusyIdRef = useRef<string | null>(null);
  useEditProtection({ dirty: false, busy: () => active && editBusyIdRef.current !== null });
  const reducedMotion = useReducedMotion();

  async function loadItems() {
    const requestId = ++loadRequestRef.current;
    const initialLoad = !loadedRef.current;
    if (initialLoad) {
      setLoading(true);
      setLoadFailed(false);
    } else {
      setRefreshing(true);
      setRefreshRequest(requestId);
    }
    try {
      const options: ListItemsOptions = {
        includeReviewHistory: false,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(typeFilter === 'all' ? {} : { itemType: typeFilter }),
        ...(sourceFilter === 'all' ? {} : { source: sourceFilter }),
        ...(categoryFilter === 'all'
          ? {}
          : { categoryId: categoryFilter === 'uncategorized' ? null : categoryFilter }),
        status: statusFilter,
        now: new Date(),
      };
      const nextItems = await repository.listItems(options);
      if (requestId !== loadRequestRef.current) return;
      // The open item can leave the filtered list and stay open, by being reviewed for one. Its pane
      // must still show what is stored, or 编辑 would compare against an old version. Only a change
      // to the data can do that, so changing a filter reads nothing more.
      const open = focusedItemRef.current;
      const openAgain =
        open &&
        openReadAt.current !== revision &&
        editingSnapshot.current.id !== open.id &&
        !nextItems.some((item) => item.id === open.id)
          ? await repository.getItem(open.id).catch(() => undefined)
          : undefined;
      if (requestId !== loadRequestRef.current) return;
      openReadAt.current = revision;
      const nextIds = new Set(nextItems.map((item) => item.id));
      if (loadedRef.current) {
        const newlyVisible = new Set(
          nextItems.filter((item) => !knownItemIdsRef.current.has(item.id)).map((item) => item.id),
        );
        setRecentlyVisibleIds(newlyVisible);
        if (recentlyVisibleTimerRef.current !== null) {
          window.clearTimeout(recentlyVisibleTimerRef.current);
        }
        if (newlyVisible.size > 0) {
          recentlyVisibleTimerRef.current = window.setTimeout(() => {
            recentlyVisibleTimerRef.current = null;
            setRecentlyVisibleIds(new Set());
          }, MOTION_DURATION_MS.standard);
        }
      }
      knownItemIdsRef.current = nextIds;
      loadedRef.current = true;
      const preservedOrder = retainedOrderRef.current;
      const ordered = preservedOrder
        ? [...nextItems].sort((left, right) => {
            const a = preservedOrder.indexOf(left.id);
            const b = preservedOrder.indexOf(right.id);
            return (a < 0 ? Number.MAX_SAFE_INTEGER : a) - (b < 0 ? Number.MAX_SAFE_INTEGER : b);
          })
        : nextItems;
      setItems(ordered);
      setFocusedItem((current) => {
        if (current) {
          if (editingSnapshot.current.id === current.id) return current;
          return (
            nextItems.find((item) => item.id === current.id) ??
            (openAgain?.id === current.id ? openAgain : current)
          );
        }
        return detailRequest
          ? null
          : (nextItems.find((item) => item.id === initialSelectedItemId) ?? nextItems[0] ?? null);
      });
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      if (initialLoad) setLoadFailed(true);
      setNotice({ text: displayError(error, 'The library could not be loaded.'), tone: 'error' });
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void loadItems();
    return () => {
      loadRequestRef.current += 1;
    };
    // Search and filters intentionally trigger a fresh IndexedDB query.
  }, [query, typeFilter, sourceFilter, statusFilter, categoryFilter, revision]);

  // Timed from each request, never from the first of a series of changes, so a run of quick
  // requests never shows the line.
  useEffect(() => {
    if (!refreshing) {
      setShowRefreshing(false);
      return;
    }
    const timer = window.setTimeout(() => setShowRefreshing(true), LIBRARY_REFRESH_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [refreshing, refreshRequest]);

  async function loadCategorySummaries() {
    const request = ++categoryRequestRef.current;
    try {
      const summaries = await repository.listCategorySummaries(new Date());
      if (request !== categoryRequestRef.current) return;
      setCategorySummaries(summaries);
      const categoryFilter = categoryFilterRef.current;
      if (
        categoryFilter !== 'all' &&
        categoryFilter !== 'uncategorized' &&
        !summaries.some((summary) => summary.category?.id === categoryFilter)
      ) {
        setCategoryFilter('all');
        setNotice({
          text: '分类已变更，已切回全部。',
          tone: 'warning',
        });
      }
    } catch (error) {
      if (request !== categoryRequestRef.current) return;
      setNotice({ text: displayError(error, 'Categories could not be loaded.'), tone: 'error' });
    }
  }

  useEffect(() => {
    void loadCategorySummaries();
    return () => {
      categoryRequestRef.current += 1;
    };
  }, [revision]);

  useEffect(() => {
    if (initialSelectedItemId !== null) {
      setReadingId(initialSelectedItemId);
      setPane('content');
    }
  }, [initialSelectedItemId]);

  useEffect(() => {
    if (!detailRequest) return;
    readingTriggerRef.current = null;
    const request = ++detailRequestSequence.current;
    void repository
      .getItem(detailRequest.itemId)
      .then(async (found) => {
        if (request !== detailRequestSequence.current) return;
        if (!(await requestEditorLeaveAsync()) || request !== detailRequestSequence.current) return;
        if (!found) {
          setNotice({
            tone: 'warning',
            text: '这道回忆题已不存在。',
          });
          return;
        }
        clearSecondaryFilters();
        setCategoryFilter(found.categoryId ?? 'uncategorized');
        setSelectedId(null);
        setReadingId(found.id);
        setFocusedItem(found);
        rememberFocusTarget(found.id);
        setPane('content');
        const group = deriveSourceGroups([found], new Date()).groups[0];
        if (group) setExpandedGroupKeys((current) => new Set([...current, group.key]));
      })
      .catch((error) => {
        if (request === detailRequestSequence.current)
          setNotice({
            tone: 'error',
            text: displayError(error, '回忆题打不开，请重试。'),
          });
      })
      .finally(() => {
        if (request === detailRequestSequence.current) onDetailRequestConsumed?.();
      });
    return () => {
      detailRequestSequence.current++;
    };
    // Only a new one-shot request should restart target resolution.
  }, [detailRequest?.key]);

  async function closeReading(itemId: string) {
    if (!(await leaveEditor())) return;
    setPane('directory');
    window.setTimeout(() => {
      if (!activeRef.current) return;
      const target = [...document.querySelectorAll<HTMLElement>('[data-library-read-button]')].find(
        (element) => element.getAttribute('data-library-read-button') === itemId,
      );
      focusNearestStableElement(target ?? readingTriggerRef.current);
    }, 0);
  }

  async function readItem(id: string, trigger?: HTMLButtonElement) {
    if (selectingRef.current || editBusyIdRef.current !== null) return;
    selectingRef.current = true;
    try {
      if (!(await leaveEditor())) return;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return;
      readingTriggerRef.current = trigger ?? null;
      setFocusedItem(item);
      setReadingId(id);
      setPane('content');
      rememberFocusTarget(id);
    } finally {
      selectingRef.current = false;
    }
  }

  useEffect(
    () => () => {
      if (recentlyVisibleTimerRef.current !== null) {
        window.clearTimeout(recentlyVisibleTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const visibleNotice = notice;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === visibleNotice ? null : current));
    }, LIBRARY_SUCCESS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const itemId = pendingFocusItemIdRef.current;
    if (!active || !itemId || selectedId !== null || focusedItem?.id !== itemId) return;
    focusNearestStableElement(readingHeadingRef.current);
    pendingFocusItemIdRef.current = null;
  }, [focusedItem, selectedId, readingId, pane, active, focusRequest]);

  const viewMode: LibraryViewMode =
    arrangement === 'sources'
      ? 'sources'
      : arrangement === 'source-types'
        ? 'source-types'
        : 'items';
  const arrangedItems = useMemo(
    () => arrangeLibraryItems(items, arrangement),
    [arrangement, items],
  );
  const groupingSnapshotTime = useMemo(() => new Date(), [items]);
  const derivedSources = useMemo(
    () => deriveSourceGroups(arrangedItems, groupingSnapshotTime),
    [arrangedItems, groupingSnapshotTime],
  );
  const hasActiveSecondaryFilters =
    query.trim().length > 0 ||
    typeFilter !== 'all' ||
    sourceFilter !== 'all' ||
    statusFilter !== 'all';
  const filterLabels = [
    sourceFilter !== 'all' ? sourceLabel(sourceFilter) : null,
    typeFilter !== 'all' ? learningGoalLabel(typeFilter) : null,
    statusFilter !== 'all'
      ? ({ due: '到期', future: '未到期', suspended: '已暂停' } as const)[statusFilter]
      : null,
  ].filter((label): label is string => label !== null);
  const hasActiveFilters = hasActiveSecondaryFilters || categoryFilter !== 'all';
  const categories = useMemo(
    () =>
      categorySummaries
        .map((summary) => summary.category)
        .filter((category): category is MomentCategory => category !== null),
    [categorySummaries],
  );
  const uncategorizedSummary = categorySummaries.find((summary) => summary.category === null);
  const selectedCategorySummary =
    categoryFilter === 'uncategorized'
      ? uncategorizedSummary
      : categorySummaries.find((summary) => summary.category?.id === categoryFilter);
  const categoryTotals = categorySummaries.reduce(
    (totals, summary) => ({
      total: totals.total + summary.totalCount,
      due: totals.due + summary.dueCount,
    }),
    { total: 0, due: 0 },
  );
  const allMomentsNextReview = categorySummaries.reduce<Date | null>((earliest, summary) => {
    if (summary.nextReviewAt === null) return earliest;
    if (earliest === null || summary.nextReviewAt.getTime() < earliest.getTime()) {
      return summary.nextReviewAt;
    }
    return earliest;
  }, null);
  const selectedCategoryName =
    categoryFilter === 'all'
      ? '全部回忆题'
      : categoryFilter === 'uncategorized'
        ? '未分类'
        : (selectedCategorySummary?.category?.name ?? '全部回忆题');
  const selectedScopeSummary =
    categoryFilter === 'all'
      ? {
          totalCount: categoryTotals.total,
          dueCount: categoryTotals.due,
          nextReviewAt: allMomentsNextReview,
        }
      : {
          totalCount: selectedCategorySummary?.totalCount ?? 0,
          dueCount: selectedCategorySummary?.dueCount ?? 0,
          nextReviewAt: selectedCategorySummary?.nextReviewAt ?? null,
        };
  const momentSearchPlaceholder =
    categoryFilter === 'all' ? '搜索全部回忆题' : `在「${selectedCategoryName}」中搜索`;
  const showCategorySearch =
    categories.length > CATEGORY_PICKER_VISIBLE_LIMIT || categoryQuery.length > 0;

  useEffect(() => {
    const selected = categories.find((category) => category.id === categoryFilter);
    setRenameCategoryName(selected?.name ?? '');
    setMergeTargetId(
      selected ? (categories.find((category) => category.id !== selected.id)?.id ?? null) : null,
    );
  }, [categories, categoryFilter]);

  function announce(text: string) {
    setNotice(null);
    setLiveStatus({ text, seq: ++liveStatusSeq.current });
  }

  async function createCategory() {
    if (!(await leaveEditor())) return;
    setCategoryBusy(true);
    try {
      const category = await repository.createCategory(newCategoryName);
      setNewCategoryName('');
      setCreatingCategory(false);
      setCategoryFilter(category.id);
      announce(`已创建分类「${category.name}」。`);
      await loadCategorySummaries();
    } catch (error) {
      setNotice({ text: displayError(error, '分类无法创建。'), tone: 'error' });
      await loadCategorySummaries();
    } finally {
      setCategoryBusy(false);
    }
  }

  async function renameCategory() {
    if (!(await leaveEditor())) return;
    if (categoryFilter === 'all' || categoryFilter === 'uncategorized') return;
    setCategoryBusy(true);
    try {
      const category = await repository.renameCategory(categoryFilter, renameCategoryName);
      announce(`分类已重命名为「${category.name}」。`);
      await loadCategorySummaries();
    } catch (error) {
      setNotice({ text: displayError(error, '分类无法重命名。'), tone: 'error' });
      await loadCategorySummaries();
    } finally {
      setCategoryBusy(false);
    }
  }

  async function mergeCategory() {
    if (!(await leaveEditor())) return;
    if (categoryFilter === 'all' || categoryFilter === 'uncategorized' || mergeTargetId === null) {
      return;
    }
    const target = categories.find((category) => category.id === mergeTargetId);
    if (!target || !window.confirm(`要把这个分类合并到「${target.name}」吗？`)) return;
    setCategoryBusy(true);
    try {
      const affected = await repository.mergeCategory(categoryFilter, target.id);
      setCategoryFilter(target.id);
      setSelectedId(null);
      setNotice({
        text: `分类已合并。已移动 ${affected} 道回忆题。`,
        tone: 'success',
      });
      onChanged();
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } catch (error) {
      setNotice({
        text: displayError(error, '分类无法合并。'),
        tone: 'error',
      });
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } finally {
      setCategoryBusy(false);
    }
  }

  async function deleteCategory() {
    if (!(await leaveEditor())) return;
    if (categoryFilter === 'all' || categoryFilter === 'uncategorized') return;
    const selected = categories.find((category) => category.id === categoryFilter);
    if (!selected || !window.confirm(`删除分类「${selected.name}」？里面的回忆题会移到未分类。`)) {
      return;
    }
    setCategoryBusy(true);
    try {
      const affected = await repository.deleteCategory(selected.id);
      setCategoryFilter('uncategorized');
      setSelectedId(null);
      setNotice({
        text: `分类已删除。已将 ${affected} 道回忆题移到未分类。`,
        tone: 'success',
      });
      onChanged();
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } catch (error) {
      setNotice({ text: displayError(error, '分类无法删除。'), tone: 'error' });
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } finally {
      setCategoryBusy(false);
    }
  }

  async function deleteItem(item: LearningItem) {
    if (
      editBusyIdRef.current !== null ||
      !window.confirm(`删除「${learningItemTitle(item)}」及其本地复习历史？`)
    )
      return;
    editBusyIdRef.current = item.id;
    setEditBusyId(item.id);
    try {
      await repository.deleteItem(item.id);
      setSelectedId(null);
      setFocusedItem(null);
      setReadingId(null);
      setPane('directory');
      announce('已删除。');
      onChanged();
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } catch (error) {
      setNotice({ text: displayError(error, '条目无法删除。'), tone: 'error' });
    } finally {
      editBusyIdRef.current = null;
      setEditBusyId(null);
    }
  }

  async function toggleSuspended(item: LearningItem) {
    if (editBusyIdRef.current !== null) return;
    editBusyIdRef.current = item.id;
    setEditBusyId(item.id);
    try {
      const updated = await repository.updateItem(item.id, { suspended: !item.suspended });
      // Under a status filter the item leaves the list, and the reload below cannot refresh it.
      if (updated) setFocusedItem((current) => (current?.id === item.id ? updated : current));
      announce(item.suspended ? '已恢复复习。' : '已暂停。');
      onChanged();
      await Promise.all([loadCategorySummaries(), loadItems()]);
    } catch (error) {
      setNotice({ text: displayError(error, '条目无法更新。'), tone: 'error' });
    } finally {
      editBusyIdRef.current = null;
      setEditBusyId(null);
    }
  }

  async function openSource(item: VideoLearningItem) {
    const result = await openSourceAtTimestamp({
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      canonicalUrl: item.canonicalUrl,
      timestampSeconds: item.timestampSeconds,
      pauseAfterSeek: preferences.pauseAfterReopen,
    });
    if (result.ok) {
      announce(
        item.timestampDisplay ? `已打开来源，定位到 ${item.timestampDisplay}。` : '已打开来源。',
      );
      return;
    }
    setNotice({
      text: item.timestampDisplay
        ? `已打开，请手动跳到 ${item.timestampDisplay}。`
        : `来源无法打开。${result.error ?? ''}`,
      tone: 'warning',
    });
  }

  async function openSourceGroup(group: DerivedSourceGroup) {
    const result = await openSourceAtTimestamp({
      platform: group.platform,
      sourceUrl: group.canonicalUrl,
      canonicalUrl: group.canonicalUrl,
      timestampSeconds: null,
      pauseAfterSeek: preferences.pauseAfterReopen,
    });
    if (result.ok) {
      announce(`已打开「${group.title}」的来源。`);
      return;
    }
    setNotice({ text: `来源无法打开。${result.error ?? ''}`, tone: 'warning' });
  }

  function toggleSourceGroup(groupKey: string) {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  async function changeArrangement(nextArrangement: LibraryArrangement) {
    if (nextArrangement === arrangement) return;
    if (!(await leaveEditor())) return;
    retainedOrderRef.current = null;
    safeViewTransition(() => setArrangement(nextArrangement), { reducedMotion });
  }

  function clearSecondaryFilters() {
    setQuery('');
    setSourceFilter('all');
    setTypeFilter('all');
    setStatusFilter('all');
  }

  function rememberFocusTarget(itemId: string) {
    pendingFocusItemIdRef.current = itemId;
    setFocusRequest((request) => request + 1);
  }

  async function closeEditor(itemId: string, discarded = false) {
    if (!discarded && !(await leaveEditor())) return;
    if (discarded) setSelectedId(null);
    rememberFocusTarget(itemId);
    setEditError(null);
    setReadingId(itemId);
  }

  async function selectItemForEditing(itemId: string) {
    if (selectedId === itemId || editBusyIdRef.current !== null) return;
    if (!(await requestEditorLeaveAsync())) return;
    const item = items.find((candidate) => candidate.id === itemId) ?? focusedItem;
    if (!item || item.id !== itemId) return;
    setFocusedItem(item);
    setReadingId(itemId);
    setEditError(null);
    setSelectedId(itemId);
    setPane('content');
  }

  async function openAddQuestion() {
    if (!(await requestEditorLeaveAsync())) return;
    const categoryId =
      categoryFilter === 'all' || categoryFilter === 'uncategorized' ? null : categoryFilter;
    onAddQuestion?.(categoryId);
  }

  async function leaveEditor(): Promise<boolean> {
    if (!(await requestEditorLeaveAsync())) return false;
    setSelectedId(null);
    return true;
  }

  async function changeFilter(change: () => void) {
    if (await leaveEditor()) {
      retainedOrderRef.current = null;
      change();
    }
  }

  async function saveEdits(item: LearningItem, changes: EditableValues, commit: EditCommit) {
    if (editBusyIdRef.current !== null) return;
    if (!changes.title.trim() || !changes.coreLesson.trim() || !changes.recallPrompt.trim()) {
      setEditError('标题、问题和答案要点不能为空。');
      return;
    }
    editBusyIdRef.current = item.id;
    setEditBusyId(item.id);
    setEditError(null);
    try {
      const persisted = await repository.updateItem(
        item.id,
        {
          ...(item.sourceType === 'text' || item.sourceType === 'image'
            ? { title: changes.title.trim() }
            : { videoTitle: changes.title.trim() }),
          itemType: changes.itemType,
          personalNote: changes.personalNote.trim(),
          situation: changes.situation.trim(),
          coreLesson: changes.coreLesson.trim(),
          mistakeToAvoid: changes.mistakeToAvoid.trim(),
          recommendedAction: changes.recommendedAction.trim(),
          recallPrompt: changes.recallPrompt,
          tags: changes.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          categoryId: changes.categoryId,
          ...(item.sourceType === 'text' && item.readingSource
            ? {
                readingSource: {
                  schemaVersion: 1 as const,
                  excerpt: changes.readingExcerpt,
                  bookTitle: changes.readingBook,
                  location: changes.readingLocation,
                },
              }
            : {}),
        },
        commit,
      );
      const updated = persisted ?? item;
      rememberFocusTarget(item.id);
      setItems((current) =>
        current.map((candidate) => (candidate.id === item.id ? updated : candidate)),
      );
      retainedOrderRef.current = items.map((candidate) => candidate.id);
      setFocusedItem(updated);
      setReadingId(item.id);
      setSelectedId(null);
      announce('回忆题已更新。');
      onChanged();
      await loadCategorySummaries();
      return true;
    } catch (error) {
      setEditError(displayError(error, '更改无法保存。'));
    } finally {
      if (editBusyIdRef.current === item.id) editBusyIdRef.current = null;
      setEditBusyId(null);
    }
  }

  function renderItemEditor(item: LearningItem): ReactNode {
    return (
      <DetailEditor
        key={`${item.id}-${selectedId === item.id ? 'open' : 'closing'}`}
        item={item}
        active={active}
        categories={categories}
        busy={editBusyId === item.id}
        error={selectedId === item.id ? editError : null}
        showDiagnostics={preferences.showExtractionDiagnostics}
        onClose={(discarded) => void closeEditor(item.id, discarded)}
        onSave={(changes, commit) => saveEdits(item, changes, commit)}
        {...(isVideoLearningItem(item) ? { onOpen: () => void openSource(item) } : {})}
      />
    );
  }

  return (
    <LibraryReadingContext.Provider
      value={{
        id: focusedItem?.id ?? readingId,
        open: (id, trigger) => {
          void readItem(id, trigger);
        },
        close: (id) => {
          void closeReading(id);
        },
        busy: editBusyId !== null,
      }}
    >
      <section className="library-view" aria-busy={loading || refreshing}>
        <LiveStatus text={liveStatus?.text ?? null} seq={liveStatus?.seq ?? 0} />
        {notice?.tone === 'success' && (
          <div className="library-toast motion-state-change" key={notice.text}>
            <Notice tone="success">{notice.text}</Notice>
          </div>
        )}
        <header className="library-page-header split">
          <h2 className="dashboard-page-heading" tabIndex={-1}>
            资料库
          </h2>
          {onAddQuestion && (
            <button
              className="button"
              disabled={editBusyId !== null}
              onClick={() => void openAddQuestion()}
            >
              添加回忆题
            </button>
          )}
        </header>
        {notice && notice.tone !== 'success' && (
          <div className="motion-state-change" key={`${notice.tone}-${notice.text}`}>
            <Notice tone={notice.tone}>{notice.text}</Notice>
          </div>
        )}
        <div className="library-pane-switch" aria-label="资料库工作区">
          <button
            className={`button ${pane === 'directory' ? '' : 'secondary'}`}
            aria-pressed={pane === 'directory'}
            onClick={() => void closeReading(focusedItem?.id ?? '')}
          >
            目录
          </button>
          <button
            className={`button ${pane === 'content' ? '' : 'secondary'}`}
            aria-pressed={pane === 'content'}
            disabled={!focusedItem}
            onClick={() => {
              setPane('content');
              if (focusedItem) rememberFocusTarget(focusedItem.id);
            }}
          >
            当前题目
          </button>
        </div>
        <div className="library-workspace library-learning-workspace" data-pane={pane}>
          <div className="library-directory card" ref={directoryRef}>
            <details className="library-category-panel">
              <summary>分类 · {selectedCategoryName}</summary>
              <div className="category-sidebar" aria-labelledby="library-category-heading">
                <div className="category-sidebar-heading">
                  <p className="eyebrow">资料库</p>
                  <h2 id="library-category-heading">分类</h2>
                </div>
                <div className="category-desktop-navigation">
                  {showCategorySearch && (
                    <label className="field category-navigation-search">
                      <span className="sr-only">搜索分类</span>
                      <input
                        type="search"
                        value={categoryQuery}
                        placeholder="搜索分类"
                        onChange={(event) => setCategoryQuery(event.target.value)}
                      />
                    </label>
                  )}
                  <CategoryNavigation
                    summaries={categorySummaries}
                    query={categoryQuery}
                    selected={categoryFilter}
                    totals={categoryTotals}
                    onSelect={(value) => changeFilter(() => setCategoryFilter(value))}
                  />
                </div>
                <label className="field category-mobile-picker">
                  <span>分类</span>
                  <select
                    aria-label="资料库分类"
                    value={categoryFilter}
                    onChange={(event) => {
                      const value = event.target.value;
                      void changeFilter(() => setCategoryFilter(value));
                    }}
                  >
                    <option value="all">全部回忆题（{categoryTotals.total}）</option>
                    <option value="uncategorized">
                      未分类（{uncategorizedSummary?.totalCount ?? 0}）
                    </option>
                    {categorySummaries.map(
                      (summary) =>
                        summary.category && (
                          <option value={summary.category.id} key={summary.category.id}>
                            {summary.category.name} ({summary.totalCount})
                          </option>
                        ),
                    )}
                  </select>
                </label>
                {!creatingCategory ? (
                  <button
                    type="button"
                    className="button text-button small-button category-create-toggle"
                    aria-controls="library-new-category"
                    aria-expanded="false"
                    disabled={categoryBusy}
                    onClick={() => setCreatingCategory(true)}
                  >
                    新建分类
                  </button>
                ) : (
                  <form
                    className="category-create-form stack-tight"
                    id="library-new-category"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createCategory();
                    }}
                  >
                    <label className="field">
                      <span>新分类名称</span>
                      <input
                        autoFocus
                        value={newCategoryName}
                        maxLength={80}
                        disabled={categoryBusy}
                        onChange={(event) => setNewCategoryName(event.target.value)}
                      />
                    </label>
                    <div className="cluster">
                      <button
                        className="button small-button"
                        type="submit"
                        disabled={categoryBusy || newCategoryName.trim().length === 0}
                      >
                        创建
                      </button>
                      <button
                        className="button secondary small-button"
                        type="button"
                        disabled={categoryBusy}
                        onClick={() => {
                          setCreatingCategory(false);
                          setNewCategoryName('');
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </details>

            <div className="library-directory-content stack">
              <header className="library-scope-header">
                <div>
                  <p className="eyebrow">当前分类</p>
                  <h2 className="dashboard-page-heading" tabIndex={-1}>
                    {selectedCategoryName}
                  </h2>
                  <p className="muted small library-scope-summary">
                    {selectedScopeSummary.totalCount} 道回忆题 · {selectedScopeSummary.dueCount}{' '}
                    条到期 · {formatNextReview(selectedScopeSummary.nextReviewAt)}
                  </p>
                </div>
                {categoryFilter !== 'all' && categoryFilter !== 'uncategorized' && (
                  <details className="category-management-disclosure">
                    <summary>管理分类</summary>
                    <div className="category-management stack-tight">
                      <div className="cluster">
                        <label className="field category-name-field">
                          <span>重命名所选分类</span>
                          <input
                            value={renameCategoryName}
                            maxLength={80}
                            disabled={categoryBusy}
                            onChange={(event) => setRenameCategoryName(event.target.value)}
                          />
                        </label>
                        <button
                          className="button secondary small-button"
                          disabled={categoryBusy || renameCategoryName.trim().length === 0}
                          onClick={() => void renameCategory()}
                        >
                          重命名
                        </button>
                      </div>
                      {categories.length > 1 && (
                        <div className="cluster category-merge-row">
                          <label className="field category-name-field">
                            <span>合并到</span>
                            <select
                              value={mergeTargetId ?? ''}
                              disabled={categoryBusy}
                              onChange={(event) => setMergeTargetId(event.target.value || null)}
                            >
                              <option value="">选择一个分类</option>
                              {categories
                                .filter((category) => category.id !== categoryFilter)
                                .map((category) => (
                                  <option value={category.id} key={category.id}>
                                    {category.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button
                            className="button secondary small-button"
                            disabled={categoryBusy || mergeTargetId === null}
                            onClick={() => void mergeCategory()}
                          >
                            合并
                          </button>
                        </div>
                      )}
                      <button
                        className="button danger small-button category-delete-button"
                        disabled={categoryBusy}
                        onClick={() => void deleteCategory()}
                      >
                        删除分类
                      </button>
                    </div>
                  </details>
                )}
              </header>

              <div className="library-query" aria-label="回忆题筛选与排列">
                <label className="field">
                  <span className="sr-only">搜索回忆题</span>
                  <input
                    type="search"
                    aria-label="搜索回忆题"
                    className={query.trim() ? 'active-filter' : undefined}
                    placeholder={momentSearchPlaceholder}
                    value={query}
                    onChange={(event) => {
                      const value = event.target.value;
                      void changeFilter(() => setQuery(value));
                    }}
                  />
                </label>
                <details className="library-filter-disclosure">
                  <summary>筛选与排列{hasActiveSecondaryFilters ? ' · 已筛选' : ''}</summary>
                  <div className="toolbar library-toolbar">
                    <label className="field">
                      <span>按来源筛选</span>
                      <select
                        aria-label="按来源筛选"
                        className={sourceFilter !== 'all' ? 'active-filter' : undefined}
                        value={sourceFilter}
                        onChange={(event) => {
                          const value = event.target.value as SourceFilter;
                          void changeFilter(() => setSourceFilter(value));
                        }}
                      >
                        <option value="all">全部来源</option>
                        <option value="text">文字</option>
                        <option value="image">图片</option>
                        <option value="bilibili">Bilibili</option>
                        <option value="youtube">YouTube</option>
                        <option value="douyin">Douyin</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="sr-only">按学习目标筛选</span>
                      <select
                        className={typeFilter !== 'all' ? 'active-filter' : undefined}
                        value={typeFilter}
                        onChange={(event) => {
                          const value = event.target.value as typeof typeFilter;
                          void changeFilter(() => setTypeFilter(value));
                        }}
                      >
                        <option value="all">全部学习目标</option>
                        {LEARNING_ITEM_TYPES.map((type) => (
                          <option value={type} key={type}>
                            {learningGoalLabel(type)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="sr-only">按复习状态筛选</span>
                      <select
                        className={statusFilter !== 'all' ? 'active-filter' : undefined}
                        value={statusFilter}
                        onChange={(event) => {
                          const value = event.target.value as StatusFilter;
                          void changeFilter(() => setStatusFilter(value));
                        }}
                      >
                        <option value="all">全部状态</option>
                        <option value="due">到期</option>
                        <option value="future">未到期</option>
                        <option value="suspended">已暂停</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="sr-only">排序或分组回忆题</span>
                      <select
                        aria-label="排序或分组回忆题"
                        value={arrangement}
                        onChange={(event) =>
                          changeArrangement(event.target.value as LibraryArrangement)
                        }
                      >
                        <option value="recent">最近更新</option>
                        <option value="oldest">最早更新</option>
                        <option value="due">即将到期</option>
                        <option value="sources">按来源分组</option>
                        <option value="source-types">按来源类型分组</option>
                      </select>
                    </label>
                  </div>
                </details>
              </div>
              <div className="library-filter-summary" aria-label="已选筛选">
                {filterLabels.map((label) => (
                  <span className="pill" key={label}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="library-toolbar-status">
                {hasActiveSecondaryFilters && (
                  <button
                    className="button text-button small-button"
                    onClick={() => changeFilter(clearSecondaryFilters)}
                  >
                    清除筛选
                  </button>
                )}
                {showRefreshing && (
                  <span className="dashboard-refresh-status" role="status">
                    <span className="motion-loading-indicator" aria-hidden="true" />
                    正在更新结果
                  </span>
                )}
              </div>

              <div
                className="library-results"
                data-refreshing={showRefreshing}
                key={libraryResultStateKey({
                  loading,
                  loadFailed,
                  itemCount: items.length,
                  viewMode,
                })}
              >
                {loading ? (
                  <div className="card dashboard-loading-state" role="status">
                    <span className="motion-loading-indicator" aria-hidden="true" />
                    <span>正在加载资料库…</span>
                  </div>
                ) : loadFailed ? (
                  <div className="empty-state empty-state-major motion-state-change">
                    <h3>资料库没加载出来</h3>
                    <p>请重新加载。</p>
                    <button className="button" onClick={() => void loadItems()}>
                      重新加载
                    </button>
                  </div>
                ) : items.length === 0 ? (
                  <div
                    className={`empty-state empty-state-major motion-state-change${
                      hasActiveSecondaryFilters ? '' : ' library-empty-state-with-companion'
                    }`}
                  >
                    <div className="library-empty-state-copy">
                      <h3>
                        {sourceFilter !== 'all'
                          ? `没有匹配的${sourceLabel(sourceFilter)} 回忆题`
                          : hasActiveFilters
                            ? '没有匹配的条目'
                            : '还没有学习条目'}
                      </h3>
                      <p>
                        {hasActiveFilters
                          ? categoryFilter !== 'all' &&
                            query.trim().length === 0 &&
                            typeFilter === 'all' &&
                            sourceFilter === 'all' &&
                            statusFilter === 'all'
                            ? '这个分类还是空的。'
                            : '换个关键词或清除筛选。'
                          : __VALRECALL_PUBLIC_RELEASE__
                            ? libraryEmptyHint(captureShortcut)
                            : '点「添加回忆题」，或在视频里按 Alt+Shift+M。'}
                      </p>
                    </div>
                    {!hasActiveSecondaryFilters && (
                      <Companion state="idle" placement="empty" pose="sleepy" message={null} />
                    )}
                  </div>
                ) : viewMode === 'sources' ? (
                  <div className="motion-view-swap">
                    <GroupedSourceList
                      groups={derivedSources.groups}
                      ungrouped={derivedSources.ungrouped}
                      expandedGroupKeys={expandedGroupKeys}
                      highlightedItemIds={recentlyVisibleIds}
                      now={groupingSnapshotTime}
                      onToggle={toggleSourceGroup}
                      onOpenGroup={(group) => void openSourceGroup(group)}
                    />
                  </div>
                ) : viewMode === 'source-types' ? (
                  <div className="motion-view-swap">
                    <SourceTypeGroupedList
                      items={arrangedItems}
                      highlightedItemIds={recentlyVisibleIds}
                      now={groupingSnapshotTime}
                    />
                  </div>
                ) : (
                  <div className="motion-view-swap">
                    <LibraryItemList
                      items={arrangedItems}
                      highlightedItemIds={recentlyVisibleIds}
                      now={groupingSnapshotTime}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
          <main
            className="library-detail card"
            id="library-current-question"
            aria-label="当前回忆题"
            aria-busy={editBusyId !== null}
          >
            {focusedItem ? (
              <>
                <div className="library-detail-heading split">
                  <div>
                    <p className="eyebrow">
                      {joinMeta(
                        sourceLabel(learningItemSource(focusedItem)),
                        libraryStatusLabel(focusedItem, groupingSnapshotTime),
                      )}
                    </p>
                    <h3 ref={readingHeadingRef} tabIndex={-1}>
                      {displayItemTitle(focusedItem)}
                    </h3>
                  </div>
                  <button
                    className="button secondary library-return-directory"
                    onClick={() => void closeReading(focusedItem.id)}
                  >
                    返回目录
                  </button>
                </div>
                {selectedId === focusedItem.id ? (
                  <div
                    data-library-editor-for={focusedItem.id}
                    id={`library-editor-${focusedItem.id}`}
                  >
                    {renderItemEditor(focusedItem)}
                  </div>
                ) : (
                  <section
                    className="library-reading"
                    id={`library-reading-${focusedItem.id}`}
                    aria-label="回忆题详情"
                  >
                    <div className="library-detail-actions cluster">
                      <button
                        className="button"
                        disabled={editBusyId !== null}
                        onClick={() => void selectItemForEditing(focusedItem.id)}
                      >
                        编辑
                      </button>
                      {isVideoLearningItem(focusedItem) && (
                        <button
                          className="button secondary"
                          onClick={() => void openSource(focusedItem)}
                        >
                          打开来源
                        </button>
                      )}
                      {isItemDue(focusedItem, groupingSnapshotTime) && onReviewItem && (
                        <div className="library-review-entry">
                          <button
                            className="button secondary"
                            onClick={() => onReviewItem(focusedItem)}
                          >
                            从本题开始复习
                          </button>
                        </div>
                      )}
                      {onCreatePracticeTask && (
                        <button
                          className="button secondary"
                          onClick={() => onCreatePracticeTask(focusedItem)}
                        >
                          创建练习任务
                        </button>
                      )}
                    </div>
                    <MomentReading item={focusedItem} />
                    <details className="library-item-management">
                      <summary>管理回忆题</summary>
                      <div className="cluster">
                        <button
                          className="button secondary"
                          disabled={editBusyId !== null}
                          onClick={() => void toggleSuspended(focusedItem)}
                        >
                          {focusedItem.suspended ? '取消暂停' : '暂停复习'}
                        </button>
                        <button
                          className="button danger"
                          disabled={editBusyId !== null}
                          onClick={() => void deleteItem(focusedItem)}
                        >
                          删除回忆题
                        </button>
                      </div>
                    </details>
                  </section>
                )}
              </>
            ) : (
              <div className="empty-state">
                <h3>选择一道回忆题</h3>
                <p>从目录里选一道题。</p>
              </div>
            )}
          </main>
        </div>
      </section>
    </LibraryReadingContext.Provider>
  );
}

function CategoryNavigation({
  summaries,
  query,
  selected,
  totals,
  onSelect,
}: {
  summaries: CategorySummary[];
  query: string;
  selected: CategoryFilter;
  totals: { total: number; due: number };
  onSelect: (filter: CategoryFilter) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const uncategorized = summaries.find((summary) => summary.category === null);
  const matching = summaries.filter(
    (summary) =>
      summary.category !== null &&
      (!normalizedQuery || summary.category.name.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const visible = matching.slice(0, CATEGORY_PICKER_VISIBLE_LIMIT);
  const selectedSummary = summaries.find((summary) => summary.category?.id === selected);
  if (
    selectedSummary?.category &&
    !visible.some((summary) => summary.category?.id === selectedSummary.category?.id)
  ) {
    visible.unshift(selectedSummary);
  }

  return (
    <div className="category-navigation" role="navigation" aria-label="资料库分类">
      <CategoryNavigationButton
        active={selected === 'all'}
        label="全部回忆题"
        total={totals.total}
        due={totals.due}
        onClick={() => onSelect('all')}
      />
      <CategoryNavigationButton
        active={selected === 'uncategorized'}
        label="未分类"
        total={uncategorized?.totalCount ?? 0}
        due={uncategorized?.dueCount ?? 0}
        onClick={() => onSelect('uncategorized')}
      />
      {visible.map((summary) => (
        <CategoryNavigationButton
          active={selected === summary.category?.id}
          label={summary.category?.name ?? '未分类'}
          total={summary.totalCount}
          due={summary.dueCount}
          key={summary.category?.id}
          onClick={() => onSelect(summary.category?.id ?? 'uncategorized')}
        />
      ))}
      {matching.length > CATEGORY_PICKER_VISIBLE_LIMIT && (
        <p className="muted small category-result-count">
          显示 {CATEGORY_PICKER_VISIBLE_LIMIT} / {matching.length}。搜索可找到其他分类。
        </p>
      )}
      {normalizedQuery && matching.length === 0 && (
        <p className="muted small">没有匹配这个搜索的分类。</p>
      )}
    </div>
  );
}

function CategoryNavigationButton({
  active,
  label,
  total,
  due,
  onClick,
}: {
  active: boolean;
  label: string;
  total: number;
  due: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`category-navigation-button${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="category-navigation-counts">
        <span>{total}</span>
        {due > 0 && <span className="pill warning">{due} 条到期</span>}
      </span>
    </button>
  );
}

function formatNextReview(value: Date | null): string {
  if (value === null) return '没有已安排的复习';
  if (value.getTime() <= Date.now()) return '现在到期';
  return `下次复习 ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value)}`;
}

function libraryResultStateKey({
  loading,
  loadFailed,
  itemCount,
  viewMode,
}: {
  loading: boolean;
  loadFailed: boolean;
  itemCount: number;
  viewMode: LibraryViewMode;
}): string {
  if (loading) return 'loading';
  if (loadFailed) return 'error';
  if (itemCount === 0) return 'empty';
  return `populated-${viewMode}`;
}

function GroupedSourceList({
  groups,
  ungrouped,
  expandedGroupKeys,
  highlightedItemIds,
  now,
  onToggle,
  onOpenGroup,
}: {
  groups: DerivedSourceGroup[];
  ungrouped: LearningItem[];
  expandedGroupKeys: Set<string>;
  highlightedItemIds: Set<string>;
  now: Date;
  onToggle: (key: string) => void;
  onOpenGroup: (group: DerivedSourceGroup) => void;
}) {
  return (
    <div className="source-group-list">
      {groups.map((group) => (
        <SourceGroupCard
          key={group.key}
          group={group}
          expanded={expandedGroupKeys.has(group.key)}
          highlightedItemIds={highlightedItemIds}
          now={now}
          onToggle={() => onToggle(group.key)}
          onOpenGroup={() => onOpenGroup(group)}
        />
      ))}
      {ungrouped.length > 0 && (
        <section className="source-group ungrouped-items" aria-labelledby="ungrouped-title">
          <div className="source-group-heading">
            <h3 id="ungrouped-title">独立回忆题</h3>
            <span className="pill">{ungrouped.length} 道可见</span>
          </div>
          <LibraryItemList items={ungrouped} highlightedItemIds={highlightedItemIds} now={now} />
        </section>
      )}
    </div>
  );
}

function SourceGroupCard({
  group,
  expanded,
  highlightedItemIds,
  now,
  onToggle,
  onOpenGroup,
}: {
  group: DerivedSourceGroup;
  expanded: boolean;
  highlightedItemIds: Set<string>;
  now: Date;
  onToggle: () => void;
  onOpenGroup: () => void;
}) {
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const contentId = `source-group-${group.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <article className="source-group">
      <div className="source-group-summary">
        <div className="source-group-copy">
          <div className="cluster">
            <span className="pill">{platformLabel(group.platform)}</span>
            <span className="pill">{group.totalCount} 道回忆题</span>
            <span className="pill">{group.dueCount} 道到期</span>
          </div>
          <h3 className="library-title">{group.title}</h3>
          <p className="muted small">
            {group.uploader ? `${group.uploader} · ` : ''}
            {formatSavedRange(group)}
          </p>
          <details>
            <summary>来源详情</summary>
            <button className="button secondary small-button" onClick={onOpenGroup}>
              打开原视频
            </button>
          </details>
        </div>
        <button
          className="button secondary small-button"
          aria-controls={contentId}
          aria-expanded={expanded}
          ref={toggleRef}
          onClick={onToggle}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      <MotionDisclosure
        className="source-group-disclosure"
        id={contentId}
        open={expanded}
        returnFocusRef={toggleRef}
      >
        <div className="source-group-items">
          <LibraryItemList items={group.items} highlightedItemIds={highlightedItemIds} now={now} />
        </div>
      </MotionDisclosure>
    </article>
  );
}

function LibraryItemList({
  items,
  highlightedItemIds,
  now,
}: {
  items: LearningItem[];
  highlightedItemIds: Set<string>;
  now: Date;
}) {
  const reading = useContext(LibraryReadingContext);
  return (
    <div className="library-list">
      {items.map((item) => {
        const selected = reading.id === item.id;
        const highlighted = highlightedItemIds.has(item.id);
        const meta = joinMeta(
          libraryStatusLabel(item, now),
          isVideoLearningItem(item) ? item.timestampDisplay : null,
        );
        return (
          <article
            key={item.id}
            className={`library-row library-directory-row${selected ? ' is-selected' : ''}${highlighted ? ' motion-list-enter' : ''}`}
            data-library-item-id={item.id}
            data-moment-motion={highlighted ? 'created' : undefined}
          >
            <button
              className="library-directory-item"
              data-library-read-button={item.id}
              aria-current={selected ? 'true' : undefined}
              aria-controls="library-current-question"
              disabled={reading.busy}
              onClick={(event) => reading.open(item.id, event.currentTarget)}
            >
              <span className="cluster">
                <span className="pill">
                  {item.sourceType === 'text' && item.readingSource
                    ? '阅读摘录'
                    : sourceLabel(learningItemSource(item))}
                </span>
                {meta && <span className="muted small">{meta}</span>}
              </span>
              <span className="library-item-summary" data-library-item-summary={item.id}>
                {displayItemTitle(item)}
              </span>
              <span className="library-directory-question">{item.recallPrompt}</span>
            </button>
          </article>
        );
      })}
    </div>
  );
}

function SourceTypeGroupedList({
  items,
  highlightedItemIds,
  now,
}: {
  items: LearningItem[];
  highlightedItemIds: Set<string>;
  now: Date;
}) {
  const groups = (['text', 'image', 'bilibili', 'youtube', 'douyin'] as const)
    .map((source) => ({
      source,
      items: items.filter((item) => learningItemSource(item) === source),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <div className="platform-group-list">
      {groups.map((group) => (
        <section
          className="platform-group"
          aria-labelledby={`library-source-${group.source}`}
          key={group.source}
        >
          <div className="platform-group-heading">
            <h3 id={`library-source-${group.source}`}>{sourceLabel(group.source)}</h3>
            <span className="muted small">
              {group.items.length} 道回忆题 ·{' '}
              {group.items.filter((item) => isItemDue(item, now)).length} 道到期
            </span>
          </div>
          <LibraryItemList items={group.items} highlightedItemIds={highlightedItemIds} now={now} />
        </section>
      ))}
    </div>
  );
}

function arrangeLibraryItems(
  items: readonly LearningItem[],
  arrangement: LibraryArrangement,
): LearningItem[] {
  if (arrangement === 'recent' || arrangement === 'sources' || arrangement === 'source-types') {
    return [...items];
  }
  return [...items].sort((left, right) => {
    if (arrangement === 'oldest') {
      return (
        left.updatedAt.getTime() - right.updatedAt.getTime() || left.id.localeCompare(right.id)
      );
    }
    if (left.suspended !== right.suspended) return left.suspended ? 1 : -1;
    return (
      left.fsrsCard.due.getTime() - right.fsrsCard.due.getTime() ||
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  });
}

/** 到期 or 已暂停; a question that is simply scheduled says nothing. */
function libraryStatusLabel(item: LearningItem, now: Date): string | null {
  if (item.suspended) return '已暂停';
  return isItemDue(item, now) ? '到期' : null;
}

function joinMeta(...parts: ReadonlyArray<string | null>): string {
  return parts.filter(Boolean).join(' · ');
}

function displayItemTitle(item: LearningItem): string {
  return learningItemTitle(item).trim() || `${sourceLabel(learningItemSource(item))}条目`;
}

function formatSavedRange(group: DerivedSourceGroup): string {
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const earliest = formatter.format(group.earliestCaptureAt);
  const latest = formatter.format(group.latestCaptureAt);
  return earliest === latest ? `保存于 ${latest}` : `保存于 ${earliest}–${latest}`;
}

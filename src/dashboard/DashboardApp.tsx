import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Header, Notice } from '../shared/components';
import { requestEditorLeaveAsync } from '../shared/edit-protection';
import { AddWorkspace, type AddEntryRequest } from '../authoring/AddWorkspace';
import { DashboardNavigation } from './DashboardNavigation';
import { displayError, refreshReviewReminders } from '../shared/extension';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  type ValRecallPreferences,
} from '../shared/preferences';
import { StatisticsView } from './StatisticsView';
import { DataView } from './DataView';
import {
  dashboardViewFromSearch,
  dashboardHistoryIndex,
  isAddView,
  type DashboardView,
  writeDashboardViewToHistory,
} from './dashboard-route';
import { AllowanceLedgerView } from './AllowanceLedgerView';
import { HomeView, type HomeItemsLoader, type HomeTaskSummaryLoader } from './HomeView';
import { LibraryView } from './LibraryView';
import type { ReviewStartRequest } from './TodayView';
import { ReviewArea } from './ReviewArea';
import { SettingsView, type SettingsCategory } from './SettingsView';
import { localDateKey } from '../models/daily-task';
import { safeViewTransition, useReducedMotion } from '../ui/motion';
import { createPracticeTaskDraft } from './TaskForm';
import { TasksView, type TaskEditorRequest, type TaskEditorRequestInput } from './TasksView';
import { subscribeSyncDataChanged } from '../sync/data-events';
import { CompanionWardrobeProvider } from '../companion/CompanionWardrobe';
import { onAddQuestionRequested } from '../edition/add-question-event';
import { useRewardsState } from '../edition/rewards';

/** The wardrobe ships in the private build only, as its own chunk. */
const WardrobeView = __VALRECALL_PRIVATE_COMPANION_ASSETS__
  ? lazy(() => import('./WardrobeView').then((module) => ({ default: module.WardrobeView })))
  : null;

export interface DashboardAppProps {
  preferenceLoader?: () => Promise<ValRecallPreferences>;
  homeItemsLoader?: HomeItemsLoader;
  homeTaskSummaryLoader?: HomeTaskSummaryLoader;
}

export function DashboardApp({
  preferenceLoader = loadPreferences,
  homeItemsLoader,
  homeTaskSummaryLoader,
}: DashboardAppProps = {}) {
  const [view, setView] = useState<DashboardView>(() =>
    dashboardViewFromSearch(window.location.search),
  );
  const [preferences, setPreferences] = useState<ValRecallPreferences>(DEFAULT_PREFERENCES);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const [addRequest, setAddRequest] = useState<AddEntryRequest>(() => ({
    key: 0,
    mode: view === 'intake' ? 'receive' : 'manual',
    ...(view === 'reading' ? { source: 'reading' as const } : {}),
  }));
  const [reviewStartRequest, setReviewStartRequest] = useState<ReviewStartRequest | null>(null);
  const [detailRequest, setDetailRequest] = useState<{ key: number; itemId: string } | null>(() => {
    const id = new URLSearchParams(window.location.search).get('item');
    return view === 'library' && id && id.length <= 256 ? { key: 0, itemId: id } : null;
  });
  const [preferredReviewItemId, setPreferredReviewItemId] = useState<string | null>(null);
  const [reviewSection, setReviewSection] = useState<'due' | 'upcoming'>('due');
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>('general');
  const [taskEditorRequest, setTaskEditorRequest] = useState<TaskEditorRequest | null>(null);
  const taskEditorRequestKey = useRef(0);
  const routeContentRef = useRef<HTMLDivElement | null>(null);
  const libraryWindowRef = useRef<HTMLDivElement | null>(null);
  const navigationSequence = useRef(0);
  const focusAfterNavigationRef = useRef(false);
  const visitedViewsRef = useRef<Set<DashboardView>>(new Set());
  const reducedMotion = useReducedMotion();
  const historyPosition = useRef({
    index: dashboardHistoryIndex(),
    url: window.location.href,
    state: window.history.state as unknown,
  });
  const restoringHistory = useRef(false);

  useEffect(() => subscribeSyncDataChanged(() => setRevision((current) => current + 1)), []);

  useEffect(() => {
    let active = true;
    void preferenceLoader()
      .then((loaded) => {
        if (active) setPreferences(loaded);
      })
      .catch((caught) => {
        if (active) setError(displayError(caught, '偏好无法加载。'));
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [preferenceLoader]);

  useEffect(() => {
    async function synchronizeFromLocation(event?: PopStateEvent) {
      if (event && restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const nextView = dashboardViewFromSearch(window.location.search);
      const sequence = ++navigationSequence.current;
      const allowed = !event || (await requestEditorLeaveAsync());
      if (sequence !== navigationSequence.current) return;
      if (!allowed) {
        const destination = dashboardHistoryIndex();
        const origin = historyPosition.current;
        if (destination !== null && origin.index !== null && destination !== origin.index) {
          restoringHistory.current = true;
          window.history.go(origin.index - destination);
        } else window.history.replaceState(origin.state, '', origin.url);
        return;
      }
      if (event) {
        if (isAddView(nextView))
          setAddRequest({
            key: ++requestSequence.current,
            mode: nextView === 'intake' ? 'receive' : 'manual',
            ...(nextView === 'reading' ? { source: 'reading' as const } : {}),
          });
        setReviewStartRequest(null);
        const id = new URLSearchParams(window.location.search).get('item');
        setDetailRequest(
          nextView === 'library' && id && id.length <= 256
            ? { key: ++requestSequence.current, itemId: id }
            : null,
        );
      }
      const queryView = new URLSearchParams(window.location.search).get('view');
      if (nextView !== view) {
        focusAfterNavigationRef.current = true;
        safeViewTransition(
          () => {
            flushSync(() => setView(nextView));
          },
          { reducedMotion },
        );
      }
      if (queryView !== nextView || dashboardHistoryIndex() === null)
        writeDashboardViewToHistory(nextView, 'replace');
      historyPosition.current = {
        index: dashboardHistoryIndex(),
        url: window.location.href,
        state: window.history.state as unknown,
      };
    }

    synchronizeFromLocation();
    window.addEventListener('popstate', synchronizeFromLocation);
    return () => window.removeEventListener('popstate', synchronizeFromLocation);
  }, [reducedMotion, view]);

  const focusRouteHeading = (current: DashboardView) => {
    if (!focusAfterNavigationRef.current) return;
    const region = current === 'library' ? libraryWindowRef.current : routeContentRef.current;
    const heading = region?.querySelector<HTMLElement>('.dashboard-page-heading');
    if (heading) {
      heading.focus();
      focusAfterNavigationRef.current = false;
    }
  };

  useEffect(() => {
    if (!ready) return;
    visitedViewsRef.current.add(view);
    focusRouteHeading(view);
  }, [ready, view]);

  const changed = () => {
    setRevision((current) => current + 1);
    void refreshReviewReminders().then((result) => {
      if (!result.ok) {
        console.warn('[ValRecall] Review reminder refresh failed.', result.error);
      }
    });
  };
  const navigateTo = async (nextView: DashboardView, prepare?: () => void) => {
    if (nextView === view && !prepare) return;
    const sequence = ++navigationSequence.current;
    if (!(await requestEditorLeaveAsync()) || sequence !== navigationSequence.current) return;
    prepare?.();
    if (nextView === view) {
      if (dashboardViewFromSearch(window.location.search) !== nextView) {
        writeDashboardViewToHistory(nextView);
        historyPosition.current = {
          index: dashboardHistoryIndex(),
          url: window.location.href,
          state: window.history.state as unknown,
        };
      }
      return;
    }
    if (nextView !== 'review') setReviewStartRequest(null);
    if (nextView !== 'library') setDetailRequest(null);
    const queryView = new URLSearchParams(window.location.search).get('view');
    focusAfterNavigationRef.current = true;
    safeViewTransition(
      () => {
        flushSync(() => {
          setView(nextView);
          if (queryView !== nextView) writeDashboardViewToHistory(nextView);
          historyPosition.current = {
            index: dashboardHistoryIndex(),
            url: window.location.href,
            state: window.history.state as unknown,
          };
        });
      },
      { reducedMotion },
    );
  };
  const openAddQuestion = (categoryId: string | null = null) => {
    navigateTo('add', () =>
      setAddRequest({
        key: ++requestSequence.current,
        mode: 'manual',
        categoryId,
      }),
    );
  };
  if (__VALRECALL_PUBLIC_RELEASE__)
    useEffect(() => onAddQuestionRequested(() => openAddQuestion()));
  const rewards = __VALRECALL_PUBLIC_RELEASE__ ? useRewardsState() : 'on';
  // Replaced, not pushed: Back must not return to a page that would only send it here again.
  if (__VALRECALL_PUBLIC_RELEASE__)
    useEffect(() => {
      if (view !== 'allowance' || rewards !== 'off') return;
      writeDashboardViewToHistory('home', 'replace');
      setView('home');
    }, [rewards, view]);
  const openTaskEditor = (request: TaskEditorRequestInput) => {
    navigateTo('tasks', () => {
      taskEditorRequestKey.current += 1;
      setTaskEditorRequest({ ...request, key: taskEditorRequestKey.current } as TaskEditorRequest);
    });
  };
  const startReview = (preferredItemId: string | null = null, immediately = false) => {
    navigateTo('review', () => {
      setReviewStartRequest(
        immediately ? { key: ++requestSequence.current, preferredItemId } : null,
      );
      setReviewSection('due');
      setPreferredReviewItemId(preferredItemId);
    });
  };
  const openLibrary = (preferredItemId: string | null = null) => {
    navigateTo('library', () => {
      setDetailRequest(
        preferredItemId ? { key: ++requestSequence.current, itemId: preferredItemId } : null,
      );
    });
  };
  const openUpcomingReviews = () => {
    navigateTo('review', () => {
      setReviewSection('upcoming');
      setPreferredReviewItemId(null);
    });
  };
  const openReminderSettings = () => {
    navigateTo('settings', () => {
      setSettingsInitialCategory('reminders');
    });
  };
  const initialViewEntry = !visitedViewsRef.current.has(view);

  return (
    <CompanionWardrobeProvider>
      <main className="app-shell dashboard-shell">
        <div className="page-wrap dashboard-page">
          <div className="dashboard-layout">
            <aside className="dashboard-sidebar">
              <Header />
              <DashboardNavigation
                view={view}
                ready={ready}
                onNavigate={(next) =>
                  next === 'review'
                    ? startReview()
                    : next === 'add'
                      ? openAddQuestion()
                      : void navigateTo(next)
                }
              />
            </aside>
            <div className="dashboard-main" aria-busy={!ready}>
              {error && (
                <div className="motion-state-change" key={error}>
                  <Notice tone="error">{error}</Notice>
                </div>
              )}
              {ready &&
                (isAddView(view) ||
                  ['add', 'reading', 'intake'].some((entry) =>
                    visitedViewsRef.current.has(entry as DashboardView),
                  )) && (
                  <div hidden={!isAddView(view)} className="add-window">
                    <AddWorkspace
                      active={isAddView(view)}
                      request={addRequest}
                      preferences={preferences}
                      onChanged={changed}
                      onViewItem={openLibrary}
                    />
                  </div>
                )}
              {ready && (view === 'library' || visitedViewsRef.current.has('library')) && (
                <div hidden={view !== 'library'} className="library-window" ref={libraryWindowRef}>
                  <LibraryView
                    active={view === 'library'}
                    onAddQuestion={openAddQuestion}
                    detailRequest={detailRequest}
                    onDetailRequestConsumed={() => setDetailRequest(null)}
                    revision={revision}
                    preferences={preferences}
                    onChanged={changed}
                    onCreatePracticeTask={(item) =>
                      openTaskEditor({
                        mode: 'create',
                        initial: createPracticeTaskDraft(item, localDateKey(new Date())),
                      })
                    }
                    onReviewItem={(item) => startReview(item.id, true)}
                  />
                </div>
              )}
              {!ready ? (
                <section className="card dashboard-loading-state" role="status">
                  <span className="motion-loading-indicator" aria-hidden="true" />
                  <span>正在加载 ValRecall…</span>
                </section>
              ) : !isAddView(view) && view !== 'library' ? (
                <div
                  className="dashboard-route-content motion-route-enter"
                  data-dashboard-view={view}
                  data-initial-entry={initialViewEntry}
                  key={view}
                  ref={routeContentRef}
                >
                  {view === 'home' && (
                    <HomeView
                      initialEntry={initialViewEntry}
                      revision={revision}
                      onOpenStatistics={() => navigateTo('statistics')}
                      onStartReview={() => startReview(null, true)}
                      onAddQuestion={() => openAddQuestion()}
                      onViewItem={(item) => openLibrary(item.id)}
                      onOpenTasks={() => navigateTo('tasks')}
                      onEditTask={(task) => openTaskEditor({ mode: 'edit', task })}
                      onViewUpcoming={openUpcomingReviews}
                      onOpenReminderSettings={openReminderSettings}
                      onOpenAllowance={() => navigateTo('allowance')}
                      onTasksChanged={changed}
                      preferences={preferences}
                      {...(homeItemsLoader ? { loadItems: homeItemsLoader } : {})}
                      {...(homeTaskSummaryLoader ? { loadTaskSummary: homeTaskSummaryLoader } : {})}
                    />
                  )}
                  {view === 'review' && (
                    <ReviewArea
                      section={reviewSection}
                      onSectionChange={setReviewSection}
                      revision={revision}
                      preferences={preferences}
                      preferredItemId={preferredReviewItemId}
                      startRequest={reviewStartRequest}
                      onStartRequestConsumed={() => setReviewStartRequest(null)}
                      onChanged={changed}
                      onGoHome={() => navigateTo('home')}
                      onGoLibrary={() => openLibrary()}
                      onViewItem={(item) => openLibrary(item.id)}
                      onOpenReminderSettings={openReminderSettings}
                    />
                  )}
                  {view === 'tasks' && (
                    <TasksView
                      revision={revision}
                      onChanged={changed}
                      editorRequest={taskEditorRequest}
                      onEditorRequestConsumed={() => setTaskEditorRequest(null)}
                    />
                  )}
                  {view === 'settings' && (
                    <SettingsView
                      initialCategory={settingsInitialCategory}
                      preferences={preferences}
                      onSaved={setPreferences}
                      onOpenData={() => navigateTo('data')}
                      onOpenWardrobe={WardrobeView ? () => navigateTo('wardrobe') : undefined}
                    />
                  )}
                  {view === 'wardrobe' && WardrobeView && (
                    <Suspense
                      fallback={
                        <section className="card dashboard-loading-state" role="status">
                          <span className="motion-loading-indicator" aria-hidden="true" />
                          <span>正在加载衣橱…</span>
                        </section>
                      }
                    >
                      <WardrobeView
                        onBackToSettings={() => navigateTo('settings')}
                        onMounted={() => focusRouteHeading('wardrobe')}
                      />
                    </Suspense>
                  )}
                  {view === 'data' && (
                    <DataView onChanged={changed} onBackToSettings={() => navigateTo('settings')} />
                  )}
                  {view === 'statistics' && <StatisticsView revision={revision} />}
                  {__VALRECALL_PUBLIC_RELEASE__
                    ? view === 'allowance' && rewards === 'on' && <AllowanceLedgerView />
                    : view === 'allowance' && <AllowanceLedgerView />}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </CompanionWardrobeProvider>
  );
}

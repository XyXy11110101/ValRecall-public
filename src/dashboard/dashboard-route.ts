export const DASHBOARD_VIEWS = [
  'home',
  'review',
  'tasks',
  'library',
  'settings',
  'data',
  'allowance',
  'statistics',
  'reading',
  'intake',
  'add',
  'wardrobe',
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** Views that exist only in the private build; ordinary builds send them to Home. */
const PRIVATE_DASHBOARD_VIEWS: readonly DashboardView[] = ['wardrobe'];

/** Settings sub-pages: Settings stays the active tab while they are open. */
const SETTINGS_SUBVIEWS: readonly DashboardView[] = ['data', 'wardrobe'];

export const PRIMARY_DASHBOARD_TABS: ReadonlyArray<{
  id: 'home' | 'library' | 'review' | 'statistics';
  label: string;
}> = [
  { id: 'home', label: '首页' },
  { id: 'library', label: '资料库' },
  { id: 'review', label: '复习' },
  { id: 'statistics', label: '学习统计' },
];

export const SECONDARY_DASHBOARD_TABS: ReadonlyArray<{
  id: 'tasks' | 'allowance' | 'settings';
  label: string;
}> = [
  { id: 'tasks', label: '待办' },
  { id: 'allowance', label: '零花钱' },
  { id: 'settings', label: '设置' },
];

export function isAddView(view: DashboardView): boolean {
  return view === 'add' || view === 'reading' || view === 'intake';
}

export function isSettingsSubview(view: DashboardView): boolean {
  return SETTINGS_SUBVIEWS.includes(view);
}

export function dashboardViewFromSearch(
  search: string,
  privateViews: boolean = __VALRECALL_PRIVATE_COMPANION_ASSETS__,
): DashboardView {
  const candidate = new URLSearchParams(search).get('view');
  return isDashboardView(candidate, privateViews) ? candidate : 'home';
}

export function isDashboardView(
  value: unknown,
  privateViews: boolean = __VALRECALL_PRIVATE_COMPANION_ASSETS__,
): value is DashboardView {
  return (
    typeof value === 'string' &&
    (DASHBOARD_VIEWS as readonly string[]).includes(value) &&
    (privateViews || !(PRIVATE_DASHBOARD_VIEWS as readonly string[]).includes(value))
  );
}

export function writeDashboardViewToHistory(
  view: DashboardView,
  mode: 'push' | 'replace' = 'push',
): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  if (view !== 'library' || mode === 'push') url.searchParams.delete('item');
  const method = mode === 'replace' ? 'replaceState' : 'pushState';
  const previous: unknown = window.history.state;
  const state = typeof previous === 'object' && previous !== null ? previous : {};
  const index = dashboardHistoryIndex() ?? 0;
  window.history[method]({ ...state, valrecallIndex: index + (mode === 'push' ? 1 : 0) }, '', url);
}

export function dashboardHistoryIndex(): number | null {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null || !('valrecallIndex' in state)) return null;
  return typeof state.valrecallIndex === 'number' && Number.isSafeInteger(state.valrecallIndex)
    ? state.valrecallIndex
    : null;
}

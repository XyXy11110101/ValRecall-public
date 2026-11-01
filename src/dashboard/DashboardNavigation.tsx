import { useEffect, useState } from 'react';
import { ActionIcon } from '../shared/ActionIcon';
import { useRewardsVisible } from '../edition/rewards';
import {
  isAddView,
  isSettingsSubview,
  PRIMARY_DASHBOARD_TABS,
  SECONDARY_DASHBOARD_TABS,
  type DashboardView,
} from './dashboard-route';

export function DashboardNavigation({
  view,
  ready,
  onNavigate,
}: {
  view: DashboardView;
  ready: boolean;
  onNavigate: (view: DashboardView) => void;
}) {
  const [desktop, setDesktop] = useState(
    () => window.matchMedia?.('(min-width: 901px)').matches ?? window.innerWidth > 900,
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const rewardsOn = __VALRECALL_PUBLIC_RELEASE__ ? useRewardsVisible() : true;
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(min-width: 901px)');
    const change = () => setDesktop(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (['tasks', 'allowance', 'settings'].includes(view) || isSettingsSubview(view)) {
      setMoreOpen(true);
    }
  }, [view]);
  const tab = (entry: { id: DashboardView; label: string }) => {
    const active = view === entry.id || (isSettingsSubview(view) && entry.id === 'settings');
    return (
      <button
        key={entry.id}
        className={`nav-tab motion-press${active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
        disabled={!ready}
        onClick={() => onNavigate(entry.id)}
      >
        <span>{entry.label}</span>
      </button>
    );
  };
  return (
    <>
      <button
        className="button dashboard-add-action"
        aria-current={isAddView(view) ? 'page' : undefined}
        disabled={!ready}
        onClick={() => onNavigate('add')}
      >
        <ActionIcon kind="plus" />
        添加回忆题
      </button>
      <nav className="nav-tabs" aria-label="主导航">
        {PRIMARY_DASHBOARD_TABS.map(tab)}
      </nav>
      <details
        className="dashboard-more"
        open={desktop || moreOpen}
        onToggle={(event) => {
          if (!desktop) setMoreOpen(event.currentTarget.open);
        }}
      >
        <summary>更多</summary>
        <nav className="nav-tabs secondary-nav-tabs" aria-label="辅助导航">
          {(__VALRECALL_PUBLIC_RELEASE__ && !rewardsOn
            ? SECONDARY_DASHBOARD_TABS.filter((entry) => entry.id !== 'allowance')
            : SECONDARY_DASHBOARD_TABS
          ).map(tab)}
        </nav>
      </details>
    </>
  );
}

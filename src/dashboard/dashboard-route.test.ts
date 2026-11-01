import { describe, expect, it } from 'vitest';

import {
  dashboardViewFromSearch,
  isDashboardView,
  isSettingsSubview,
  PRIMARY_DASHBOARD_TABS,
  SECONDARY_DASHBOARD_TABS,
  writeDashboardViewToHistory,
} from './dashboard-route';

describe('dashboard routes', () => {
  it('keeps the existing tasks route as the single todo navigation entry', () => {
    const tabs = [...PRIMARY_DASHBOARD_TABS, ...SECONDARY_DASHBOARD_TABS];
    expect(tabs.filter((tab) => tab.id === 'tasks')).toEqual([{ id: 'tasks', label: '待办' }]);
    expect(tabs.filter((tab) => /每日任务|任务管理/.test(tab.label))).toEqual([]);
    expect(dashboardViewFromSearch('?view=tasks')).toBe('tasks');
  });
  it.each([
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
  ] as const)('accepts the addressable %s view', (view) => {
    expect(dashboardViewFromSearch(`?view=${view}`)).toBe(view);
    expect(isDashboardView(view)).toBe(true);
  });

  it('opens the wardrobe only in the private build', () => {
    expect(dashboardViewFromSearch('?view=wardrobe')).toBe('wardrobe');
    expect(isDashboardView('wardrobe')).toBe(true);
    expect(dashboardViewFromSearch('?view=wardrobe', true)).toBe('wardrobe');

    expect(dashboardViewFromSearch('?view=wardrobe', false)).toBe('home');
    expect(isDashboardView('wardrobe', false)).toBe(false);
    expect(dashboardViewFromSearch('?view=settings', false)).toBe('settings');
    expect(dashboardViewFromSearch('?view=data', false)).toBe('data');
  });

  it('keeps the wardrobe out of the tab lists and under Settings', () => {
    const tabs = [...PRIMARY_DASHBOARD_TABS, ...SECONDARY_DASHBOARD_TABS];
    expect(tabs.map((tab) => tab.id)).not.toContain('wardrobe');
    expect(isSettingsSubview('wardrobe')).toBe(true);
    expect(isSettingsSubview('data')).toBe(true);
    expect(isSettingsSubview('settings')).toBe(false);
    expect(isSettingsSubview('home')).toBe(false);
  });

  it('defaults missing or unsupported values to Home', () => {
    expect(dashboardViewFromSearch('')).toBe('home');
    expect(dashboardViewFromSearch('?view=today')).toBe('home');
    expect(dashboardViewFromSearch('?view=unknown')).toBe('home');
  });

  it('updates only the view query value while preserving other URL state', () => {
    window.history.replaceState({}, '', '/dashboard.html?source=test#section');

    writeDashboardViewToHistory('review');

    expect(window.location.pathname).toBe('/dashboard.html');
    expect(window.location.search).toBe('?source=test&view=review');
    expect(window.location.hash).toBe('#section');
  });
});

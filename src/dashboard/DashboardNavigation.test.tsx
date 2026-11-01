import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardNavigation } from './DashboardNavigation';
import type { DashboardView } from './dashboard-route';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DashboardNavigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(view: DashboardView, onNavigate = vi.fn()) {
    act(() => root.render(<DashboardNavigation view={view} ready onNavigate={onNavigate} />));
    return onNavigate;
  }

  function activeTabs(): Array<string | null> {
    return [...container.querySelectorAll('.nav-tab[aria-current="page"]')].map(
      (tab) => tab.textContent,
    );
  }

  it.each(['settings', 'data', 'wardrobe'] as const)(
    'keeps Settings active and the secondary menu open on %s',
    (view) => {
      vi.stubGlobal('matchMedia', undefined);
      vi.stubGlobal('innerWidth', 600);
      render(view);

      expect(activeTabs()).toEqual(['设置']);
      expect(container.querySelector('details.dashboard-more')?.hasAttribute('open')).toBe(true);
    },
  );

  it('marks no tab for the wardrobe other than Settings and returns there on click', () => {
    const onNavigate = render('wardrobe');

    expect([...container.querySelectorAll('.nav-tab')].map((tab) => tab.textContent)).not.toContain(
      '衣橱',
    );
    const settings = [...container.querySelectorAll<HTMLButtonElement>('.nav-tab')].find(
      (tab) => tab.textContent === '设置',
    );
    act(() => settings?.click());
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('does not mark Settings on the Home route', () => {
    render('home');
    expect(activeTabs()).toEqual(['首页']);
  });
});

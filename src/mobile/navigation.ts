import { useLayoutEffect, useRef, useState } from 'react';

export type MobileTab = 'tasks' | 'wallet' | 'settings';
export type MobilePage = MobileTab | 'add-task' | 'spend' | 'task-history';
export const pageTab = (page: MobilePage): MobileTab =>
  page === 'add-task' || page === 'task-history' ? 'tasks' : page === 'spend' ? 'wallet' : page;
export const isFormPage = (page: MobilePage) => page === 'add-task' || page === 'spend';
export const isSubpage = (page: MobilePage) => isFormPage(page) || page === 'task-history';
const pages: MobilePage[] = ['tasks', 'wallet', 'settings', 'add-task', 'spend', 'task-history'];
const parent = (page: MobilePage): MobileTab => (page === 'spend' ? 'wallet' : 'tasks');

/** One root, at most one alternate tab, and one subpage. Native WebView Back uses this history. */
export function useMobileNavigation() {
  const [page, setPage] = useState<MobilePage>('tasks');
  const current = useRef<MobilePage>('tasks');
  const owner = useRef('');
  const waiting = useRef(false);
  const positions = useRef<Partial<Record<MobilePage, number>>>({});
  const targets = useRef<Partial<Record<MobilePage, string>>>({});
  const transition = useRef(false);
  const pendingTab = useRef<MobileTab | null>(null);

  function leave() {
    positions.current[current.current] = window.scrollY;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.querySelectorAll<HTMLDetailsElement>('.mobile-task-more[open]').forEach((menu) => {
      menu.open = false;
    });
  }
  function show(next: MobilePage) {
    current.current = next;
    transition.current = true;
    setPage(next);
  }
  function focus(id: string) {
    const element = document.getElementById(id);
    if (!element) return;
    if (element instanceof HTMLDetailsElement) element.open = true;
    let ancestor = element.parentElement;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    element.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    element.focus({ preventScroll: true });
  }
  function go(next: MobilePage, target?: string, origin: 'user' | 'system' = 'user') {
    if (origin === 'user') window.dispatchEvent(new Event('valrecall-user-navigation'));
    if (waiting.current) return;
    if (target) targets.current[next] = target;
    if (next === current.current) {
      if (target) {
        focus(target);
        delete targets.current[next];
      }
      return;
    }
    leave();
    if (isSubpage(current.current) && !isSubpage(next)) {
      pendingTab.current = next;
      waiting.current = true;
      window.history.back();
      return;
    }
    if (next === 'tasks' && !isSubpage(current.current)) {
      waiting.current = true;
      window.history.back();
      return;
    }
    const state = { valrecallMobile: owner.current, page: next };
    if (current.current === 'tasks' || isSubpage(next)) {
      window.history.pushState(state, '', '#' + next);
    } else {
      window.history.replaceState(state, '', '#' + next);
    }
    show(next);
  }
  function back(target?: string, origin: 'user' | 'system' = 'user') {
    if (origin === 'user') window.dispatchEvent(new Event('valrecall-user-navigation'));
    if (waiting.current || current.current === 'tasks') return;
    const destination = parent(current.current);
    if (target) targets.current[destination] = target;
    else if (isSubpage(current.current))
      targets.current[destination] =
        current.current === 'spend'
          ? 'mobile-open-spend'
          : current.current === 'task-history'
            ? 'mobile-open-history'
            : 'mobile-open-add';
    leave();
    waiting.current = true;
    window.history.back();
  }
  function complete(form: MobilePage, target?: string) {
    if (current.current === form) back(target, 'system');
    else if (target) targets.current[parent(form)] = target;
  }

  useLayoutEffect(() => {
    owner.current = crypto.randomUUID();
    window.history.replaceState({ valrecallMobile: owner.current, page: 'tasks' }, '', '#tasks');
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    const onPop = (event: PopStateEvent) => {
      if (!waiting.current) window.dispatchEvent(new Event('valrecall-user-navigation'));
      leave();
      waiting.current = false;
      const value: unknown = event.state;
      const next =
        value &&
        typeof value === 'object' &&
        'valrecallMobile' in value &&
        value.valrecallMobile === owner.current &&
        'page' in value &&
        pages.includes(value.page as MobilePage)
          ? (value.page as MobilePage)
          : 'tasks';
      const requested = pendingTab.current;
      pendingTab.current = null;
      if (requested && requested !== next) {
        if (requested === 'tasks') {
          waiting.current = true;
          window.history.back();
          current.current = next;
          return;
        }
        const state = { valrecallMobile: owner.current, page: requested };
        if (next === 'tasks') window.history.pushState(state, '', '#' + requested);
        else window.history.replaceState(state, '', '#' + requested);
        show(requested);
      } else show(next);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.history.scrollRestoration = previousRestoration;
    };
  }, []);

  useLayoutEffect(() => {
    if (!transition.current) return;
    transition.current = false;
    const target = targets.current[page];
    delete targets.current[page];
    if (target === 'mobile-open-history') {
      window.scrollTo({ top: positions.current[page] ?? 0, behavior: 'instant' });
      document.getElementById(target)?.focus({ preventScroll: true });
    } else if (target) focus(target);
    else {
      window.scrollTo({ top: positions.current[page] ?? 0, behavior: 'instant' });
      document.getElementById('mobile-page-heading')?.focus({ preventScroll: true });
    }
  }, [page]);

  return { page, go, back, complete };
}

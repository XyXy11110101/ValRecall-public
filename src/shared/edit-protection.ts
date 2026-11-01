import { useEffect, useRef } from 'react';

interface EditState {
  dirty: boolean;
  busy: boolean;
  retainsDraft?: boolean;
  prepareLeave?: () => Promise<boolean>;
  draftVersion?: unknown;
  /** Text that saves itself: nothing to warn about, but a leave inside the app waits for it. */
  autosaving?: boolean;
}
const editors = new Set<() => EditState>();
let lastField: HTMLElement | null = null;

/** The question asked when leaving would lose text. Its wording is the same wherever it is asked. */
export const DISCARD_AND_LEAVE_QUESTION = '有尚未保存的修改。放弃这些修改并离开？';

/** Called before an action replaces a form, never after changing its route/state. */
export function requestEditorLeave(): boolean {
  const states = [...editors].map((read) => read());
  return requestWithStates(states);
}

function requestWithStates(states: EditState[]): boolean {
  if (states.some((state) => state.busy)) {
    window.alert('正在保存，请稍候再离开。');
    restoreFieldFocus();
    return false;
  }
  if (
    states.some((state) => state.dirty) &&
    !window.confirm(
      states.filter((state) => state.dirty).every((state) => state.retainsDraft)
        ? '离开添加页面？草稿会保留。'
        : DISCARD_AND_LEAVE_QUESTION,
    )
  ) {
    restoreFieldFocus();
    return false;
  }
  return true;
}

function needsPreparing(state: EditState): boolean {
  return (state.dirty || state.autosaving === true) && state.prepareLeave !== undefined;
}

/** Keep mounted input until its exact latest draft has reached durable storage. */
export async function requestEditorLeaveAsync(): Promise<boolean> {
  const snapshots = [...editors].map((read) => ({ read, state: read() }));
  if (snapshots.some(({ state }) => state.busy)) return requestEditorLeave();
  const prepared = new Map<() => EditState, unknown>();
  for (const { read, state } of snapshots) {
    if (!needsPreparing(state) || !state.prepareLeave) continue;
    try {
      if (!(await state.prepareLeave())) {
        restoreFieldFocus();
        return false;
      }
    } catch {
      restoreFieldFocus();
      return false;
    }
    prepared.set(read, state.draftVersion);
  }
  // A user may continue typing or another editor may mount during the write.
  for (const [read, version] of prepared) {
    if (!editors.has(read) || read().draftVersion !== version) {
      restoreFieldFocus();
      return false;
    }
  }
  const remaining = [...editors].map((read) => ({ read, state: read() }));
  if (remaining.some(({ state }) => state.busy)) return requestEditorLeave();
  if (remaining.some(({ read, state }) => needsPreparing(state) && !prepared.has(read))) {
    // Input created during another editor's flush has not been retained by this attempt.
    // Keep the current route instead of offering to discard a durable draft.
    restoreFieldFocus();
    return false;
  }
  if (remaining.some(({ read, state }) => state.dirty && !prepared.has(read)))
    return requestWithStates(
      remaining.filter(({ read }) => !prepared.has(read)).map(({ state }) => state),
    );
  return true;
}

function restoreFieldFocus() {
  const available = (element: HTMLElement) => {
    if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]'))
      return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      )
        return false;
    }
    return true;
  };
  if (lastField && available(lastField)) {
    lastField.focus();
    if (document.activeElement === lastField) return;
  }
  for (const fallback of document.querySelectorAll<HTMLElement>('[data-editor-return-focus]')) {
    if (!available(fallback)) continue;
    fallback.focus();
    if (document.activeElement === fallback) return;
  }
}

/** Registers only mounted editors. Retained reading/intake drafts use their own lifecycle. */
export function useEditProtection(state: {
  dirty: boolean;
  busy: boolean | (() => boolean);
  retainsDraft?: boolean;
  prepareLeave?: () => Promise<boolean>;
  draftVersion?: unknown;
  /** Read live: true while text that saves itself has not been saved yet. */
  autosaving?: () => boolean;
}) {
  const current = useRef(state);
  current.current = state;
  useEffect(() => {
    const read = (): EditState => ({
      dirty: current.current.dirty,
      retainsDraft: current.current.retainsDraft ?? false,
      ...(current.current.prepareLeave ? { prepareLeave: current.current.prepareLeave } : {}),
      draftVersion: current.current.draftVersion,
      busy:
        typeof current.current.busy === 'function' ? current.current.busy() : current.current.busy,
      autosaving: current.current.autosaving?.() ?? false,
    });
    editors.add(read);
    const protect = (event: BeforeUnloadEvent) => {
      if (!read().dirty && !read().busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const rememberField = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        lastField = target;
    };
    window.addEventListener('beforeunload', protect);
    document.addEventListener('focusin', rememberField);
    return () => {
      editors.delete(read);
      window.removeEventListener('beforeunload', protect);
      document.removeEventListener('focusin', rememberField);
      if (editors.size === 0) lastField = null;
    };
  }, []);
}

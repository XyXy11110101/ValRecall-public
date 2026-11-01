import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { requestEditorLeave, requestEditorLeaveAsync, useEditProtection } from './edit-protection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('edit protection', () => {
  it('waits for durable input without a discard prompt and refuses failed or stale writes', async () => {
    let finish: ((ok: boolean) => void) | undefined;
    const prepareLeave = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    function Editor({ version }: { version: number }) {
      useEditProtection({ dirty: true, busy: false, prepareLeave, draftVersion: version });
      return <input />;
    }
    const root = createRoot(document.createElement('div'));
    const confirm = vi.spyOn(window, 'confirm');
    try {
      act(() => root.render(<Editor version={1} />));
      let settled = false;
      const leaving = requestEditorLeaveAsync().then((ok) => {
        settled = true;
        return ok;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish?.(true);
      expect(await leaving).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      const failed = requestEditorLeaveAsync();
      finish?.(false);
      expect(await failed).toBe(false);
      const stale = requestEditorLeaveAsync();
      act(() => root.render(<Editor version={2} />));
      finish?.(true);
      expect(await stale).toBe(false);
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
    }
  });
  it('waits for text that saves itself, with no prompt, and only a leave in the app waits', async () => {
    let unsaved = true;
    const prepareLeave = vi.fn(async () => {
      unsaved = false;
      return true;
    });
    function Editor() {
      useEditProtection({
        dirty: false,
        busy: false,
        autosaving: () => unsaved,
        prepareLeave,
        draftVersion: 1,
      });
      return <input />;
    }
    const root = createRoot(document.createElement('div'));
    const confirm = vi.spyOn(window, 'confirm');
    try {
      act(() => root.render(<Editor />));
      // Nothing to warn about: not before a reload, and not before an action that replaces a form.
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
      expect(requestEditorLeave()).toBe(true);
      expect(prepareLeave).not.toHaveBeenCalled();
      expect(await requestEditorLeaveAsync()).toBe(true);
      expect(prepareLeave).toHaveBeenCalledOnce();
      // Nothing left, so nothing more to wait for.
      expect(await requestEditorLeaveAsync()).toBe(true);
      expect(prepareLeave).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
    }
  });
  it('explains retained workspace drafts without claiming to discard them', () => {
    function RetainedEditor() {
      useEditProtection({ dirty: true, busy: false, retainsDraft: true });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      act(() => root.render(<RetainedEditor />));
      expect(requestEditorLeave()).toBe(false);
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('草稿会保留'));
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
    }
  });
  it('reads live saving locks and removes protection after unmount', () => {
    let busy = false;
    function Editor({ dirty }: { dirty: boolean }) {
      useEditProtection({ dirty, busy: () => busy });
      return <input />;
    }
    const root = createRoot(document.createElement('div'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    try {
      act(() => root.render(<Editor dirty={false} />));
      expect(requestEditorLeave()).toBe(true);
      busy = true;
      expect(requestEditorLeave()).toBe(false);
      expect(alert).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
      busy = false;
      act(() => root.render(<Editor dirty />));
      expect(requestEditorLeave()).toBe(false);
      confirm.mockReturnValue(true);
      expect(requestEditorLeave()).toBe(true);
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
    }
    expect(requestEditorLeave()).toBe(true);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it('stays on the route when another durable editor becomes dirty during a flush', async () => {
    let resolve!: (ok: boolean) => void;
    const firstPrepare = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const secondPrepare = vi.fn().mockResolvedValue(true);
    function Editors({ secondDirty }: { secondDirty: boolean }) {
      useEditProtection({ dirty: true, busy: false, prepareLeave: firstPrepare, draftVersion: 1 });
      useEditProtection({
        dirty: secondDirty,
        busy: false,
        prepareLeave: secondPrepare,
        draftVersion: secondDirty,
      });
      return <input />;
    }
    const root = createRoot(document.createElement('div'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      act(() => root.render(<Editors secondDirty={false} />));
      const leaving = requestEditorLeaveAsync();
      act(() => root.render(<Editors secondDirty />));
      resolve(true);
      expect(await leaving).toBe(false);
      expect(secondPrepare).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
    }
  });

  it.each(['display', 'visibility', 'disabled'] as const)(
    'restores a visible return heading when the remembered field is %s hidden or unfocusable',
    (mode) => {
      function Editor() {
        useEditProtection({ dirty: true, busy: false });
        return (
          <>
            <div className="pane">
              <input />
            </div>
            <div style={{ display: 'none' }}>
              <h2 tabIndex={-1} data-editor-return-focus>
                隐藏的标题
              </h2>
            </div>
            <h2 tabIndex={-1} data-editor-return-focus>
              当前编辑区
            </h2>
          </>
        );
      }
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      try {
        act(() => root.render(<Editor />));
        const input = host.querySelector('input')!;
        input.focus();
        expect(document.activeElement).toBe(input);
        input.blur();
        if (mode === 'disabled') input.disabled = true;
        else
          host.querySelector<HTMLElement>('.pane')!.style[mode] =
            mode === 'display' ? 'none' : 'hidden';
        expect(requestEditorLeave()).toBe(false);
        expect(document.activeElement?.textContent).toBe('当前编辑区');
      } finally {
        act(() => root.unmount());
        host.remove();
        vi.restoreAllMocks();
      }
    },
  );
});

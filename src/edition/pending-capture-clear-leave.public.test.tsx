import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftRepository, setDraftWritesStopped } from '../database/drafts';
import { MESSAGE_PROTOCOL_VERSION } from '../models/messages';
import { useEditProtection } from '../shared/edit-protection';
import {
  clearDeleteNotice,
  readDeleteNotice,
  reloadDataPageAfterDelete,
  reloadWhenDataDeleted,
  type PendingCaptureClearApi,
} from './pending-capture-clear';

vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXTENSION_ID = 'test-extension';
const DASHBOARD = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/dashboard.html` };
const CLEAR_MESSAGE = {
  type: 'VALRECALL_CLEAR_PENDING_CAPTURE',
  version: MESSAGE_PROTOCOL_VERSION,
};
const NOTICE = { text: '已删除。', tone: 'success' as const };

function Editor() {
  useEditProtection({ dirty: true, busy: false });
  return null;
}

/** True when a page's own listener would make the browser ask before leaving. */
function browserWouldAsk(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function apiWithListener() {
  let listener: Parameters<PendingCaptureClearApi['runtime']['onMessage']['addListener']>[0];
  const api: PendingCaptureClearApi = {
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener: (added) => {
          listener = added;
        },
      },
    },
  };
  return { api, dispatch: () => listener(CLEAR_MESSAGE, DASHBOARD, () => undefined) };
}

describe('leaving a page after a delete-all', () => {
  let root: Root;

  beforeEach(async () => {
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Editor />));
    clearDeleteNotice();
    setDraftWritesStopped(false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    // The listener removes itself on the next leave, so a test that reloads does not touch the next.
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    clearDeleteNotice();
    setDraftWritesStopped(false);
  });

  it('asks as usual when nothing was deleted', () => {
    expect(browserWouldAsk()).toBe(true);
  });

  it('another open page does not ask, because a "stay" would keep the deleted text', () => {
    const { api, dispatch } = apiWithListener();
    const reload = vi.fn();
    reloadWhenDataDeleted(api, reload);
    dispatch();
    expect(reload).toHaveBeenCalledOnce();
    expect(browserWouldAsk()).toBe(false);
  });

  it('the data page does not ask either, and holds the result for after the reload', async () => {
    const reload = vi.fn();
    reloadDataPageAfterDelete(NOTICE, reload);
    expect(reload).toHaveBeenCalledOnce();
    expect(browserWouldAsk()).toBe(false);
    expect(readDeleteNotice()).toEqual(NOTICE);
    await expect(
      new DraftRepository({ open: () => Promise.reject(new Error('unused')) } as never).save(
        { id: 'a', scope: 'task', summary: '', payload: null },
        0,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('still reloads when the result cannot be held', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const reload = vi.fn();
    reloadDataPageAfterDelete(NOTICE, reload);
    write.mockRestore();
    expect(reload).toHaveBeenCalledOnce();
    expect(readDeleteNotice()).toBeNull();
  });

  it.each([
    ['nothing stored', null],
    ['text that is not JSON', 'not json'],
    ['the wrong shape', '{"text":1,"tone":"success"}'],
    ['an unknown tone', '{"text":"x","tone":"error"}'],
  ])('reads no result from %s', (_name, stored) => {
    if (stored !== null) sessionStorage.setItem('valrecall.deleteNotice', stored);
    expect(readDeleteNotice()).toBeNull();
  });

  it('reads no result once it was cleared', () => {
    sessionStorage.setItem('valrecall.deleteNotice', JSON.stringify(NOTICE));
    expect(readDeleteNotice()).toEqual(NOTICE);
    clearDeleteNotice();
    expect(readDeleteNotice()).toBeNull();
  });
});

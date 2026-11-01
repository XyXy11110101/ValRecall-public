import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftRepository, setDraftWritesStopped } from '../database/drafts';
import type { CaptureDraft } from '../models/learning-item';
import { MESSAGE_PROTOCOL_VERSION } from '../models/messages';
import { SidePanelApp } from '../sidepanel/SidePanelApp';
import {
  PENDING_CAPTURE_NOT_CLEARED,
  reloadWhenDataDeleted,
  requestPendingCaptureClear,
  type PendingCaptureClearApi,
} from './pending-capture-clear';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXTENSION_ID = 'test-extension';
const CLEAR_MESSAGE = {
  type: 'VALRECALL_CLEAR_PENDING_CAPTURE',
  version: MESSAGE_PROTOCOL_VERSION,
};
const DASHBOARD = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/dashboard.html` };
const SECRET_SCREENSHOT = 'data:image/png;base64,c2VjcmV0';

const draft: CaptureDraft = {
  draftId: 'capture-1',
  schemaVersion: 1,
  platform: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1abc123',
  canonicalUrl: null,
  videoId: 'BV1abc123',
  videoTitle: 'Synthetic',
  uploader: null,
  description: null,
  timestampSeconds: 12,
  timestampDisplay: '00:12',
  videoDurationSeconds: 120,
  chapterTitle: null,
  videoBounds: null,
  screenshotDataUrl: SECRET_SCREENSHOT,
  subtitleBefore: [],
  subtitleCurrent: ['Synthetic source'],
  subtitleAfter: [],
  subtitleCueData: [],
  subtitleStatus: 'current_only',
  subtitleExtractionStrategy: 'visible_video_overlay',
  subtitleConfidence: 'medium',
  capturedAt: '2026-10-21T12:00:00Z',
  extractionDiagnostics: [],
};

function stubChrome() {
  const listeners: Parameters<PendingCaptureClearApi['runtime']['onMessage']['addListener']>[0][] =
    [];
  const sendMessage = vi.fn(async (): Promise<unknown> => ({ ok: true }));
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXTENSION_ID,
      sendMessage,
      onMessage: {
        addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        removeListener: vi.fn(),
      },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    commands: { getAll: vi.fn(async () => []) },
  });
  const dispatch = (message: unknown, sender: { id?: string; url?: string } = DASHBOARD) => {
    const answer = vi.fn();
    const asyncAnswer = listeners.map((listener) => listener(message, sender, answer));
    return { answer, asyncAnswer };
  };
  return { api: chrome as unknown as PendingCaptureClearApi, dispatch, sendMessage, listeners };
}

describe('other open pages after a delete-all', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setDraftWritesStopped(false);
  });

  afterEach(() => {
    setDraftWritesStopped(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reloads for the data page, and never answers for the service worker', () => {
    const { api, dispatch } = stubChrome();
    const reload = vi.fn();
    reloadWhenDataDeleted(api, reload);
    const { answer, asyncAnswer } = dispatch(CLEAR_MESSAGE);
    expect(reload).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
    expect(asyncAnswer).toEqual([false]);
  });

  it.each([
    ['a video page', CLEAR_MESSAGE, { id: EXTENSION_ID, url: 'https://www.bilibili.com/video/x' }],
    [
      'the side panel',
      CLEAR_MESSAGE,
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` },
    ],
    [
      'another extension',
      CLEAR_MESSAGE,
      { id: 'other', url: 'chrome-extension://other/dashboard.html' },
    ],
    ['an old protocol', { ...CLEAR_MESSAGE, version: 0 }, DASHBOARD],
    ['another message', { type: 'VALRECALL_GET_PENDING_CAPTURE', version: 1 }, DASHBOARD],
  ])('ignores %s', async (_name, message, sender) => {
    const { api, dispatch } = stubChrome();
    const reload = vi.fn();
    reloadWhenDataDeleted(api, reload);
    dispatch(message, sender);
    expect(reload).not.toHaveBeenCalled();
    await expect(
      new DraftRepository().save({ id: 'a', scope: 'task', summary: '', payload: null }, 0),
    ).resolves.toMatchObject({ id: 'a' });
  });

  describe('an open side panel holding a capture', () => {
    let container: HTMLDivElement;
    let root: Root;

    async function openWithEdits() {
      const { api, dispatch } = stubChrome();
      const reload = vi.fn();
      reloadWhenDataDeleted(api, reload);
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root.render(
          <SidePanelApp
            initialPending={{ ok: true, draft }}
            initialLoadingCapture={false}
            loadDueCount={async () => 0}
            loadCategories={async () => []}
          />,
        ),
      );
      await vi.waitFor(() =>
        expect(container.querySelector('img.capture-screenshot')?.getAttribute('src')).toBe(
          SECRET_SCREENSHOT,
        ),
      );
      const answer = [...container.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('答案要点'))!
        .querySelector('textarea')!;
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setValue.call(answer, '还没保存的答案');
        answer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return { dispatch, reload };
    }

    const allCaptureDrafts = () => new DraftRepository().list('capture');

    afterEach(() => container.remove());

    it('leaves, and writes neither the text nor the screenshot back on the way out', async () => {
      const { dispatch, reload } = await openWithEdits();

      dispatch(CLEAR_MESSAGE);
      expect(reload).toHaveBeenCalledOnce();
      // Reloading hides the page and tears it down. Both flush open editors.
      document.dispatchEvent(new Event('visibilitychange'));
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 500));
      });

      expect(await allCaptureDrafts()).toEqual([]);
    });

    it('would otherwise have written them back', async () => {
      const { reload } = await openWithEdits();
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(reload).not.toHaveBeenCalled();
      expect(JSON.stringify(await allCaptureDrafts())).toContain(SECRET_SCREENSHOT);
    });
  });

  describe('asking the service worker', () => {
    it('sends the versioned message with nothing else in it', async () => {
      const { sendMessage } = stubChrome();
      await expect(requestPendingCaptureClear()).resolves.toBe(true);
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith(CLEAR_MESSAGE);
    });

    it.each([[undefined], [{ ok: false }], [{ ok: 'yes' }], ['ok']])(
      'does not take %j for a yes',
      async (response) => {
        const { sendMessage } = stubChrome();
        sendMessage.mockResolvedValue(response);
        await expect(requestPendingCaptureClear()).resolves.toBe(false);
      },
    );

    it('says no when the service worker cannot be reached', async () => {
      const { sendMessage } = stubChrome();
      sendMessage.mockRejectedValue(new Error('No receiver'));
      await expect(requestPendingCaptureClear()).resolves.toBe(false);
      expect(PENDING_CAPTURE_NOT_CLEARED).toContain('请再试一次');
    });
  });
});

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ValRecallRepository } from '../database';
import { DraftRepository } from '../database/drafts';
import type { CaptureDraft } from '../models/learning-item';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';

// Only in the public repository: it checks lines the export adds to the service worker.
const screenshot = vi.hoisted(() => ({
  capture: vi.fn(async (): Promise<string> => 'data:image/jpeg;base64,aGVsbG8='),
}));
vi.mock('../background/capture-safety', () => ({
  captureScreenshotSafely: () => screenshot.capture(),
}));

const EXTENSION_ID = 'test-extension';
const CLEAR_MESSAGE = {
  type: 'VALRECALL_CLEAR_PENDING_CAPTURE',
  version: MESSAGE_PROTOCOL_VERSION,
};
const DASHBOARD = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/dashboard.html` };
const GET_PENDING = { type: MESSAGE_TYPES.getPendingCapture, version: MESSAGE_PROTOCOL_VERSION };
const SECRET_SCREENSHOT = 'data:image/png;base64,c2VjcmV0';
const SOURCE_URL = 'https://www.bilibili.com/video/BV1abc123';
const TAB = { id: 7, windowId: 1, url: SOURCE_URL } as never;

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string },
  sendResponse: (response: unknown) => void,
) => boolean | void;

function capture(draftId: string, capturedAt: Date): CaptureDraft {
  return {
    draftId,
    schemaVersion: 1,
    platform: 'bilibili',
    sourceUrl: SOURCE_URL,
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
    screenshotDataUrl: null,
    subtitleBefore: [],
    subtitleCurrent: ['Synthetic source'],
    subtitleAfter: [],
    subtitleCueData: [],
    subtitleStatus: 'current_only',
    subtitleExtractionStrategy: 'visible_video_overlay',
    subtitleConfidence: 'medium',
    capturedAt: capturedAt.toISOString(),
    extractionDiagnostics: [],
  };
}

/** Any chrome call nothing here cares about resolves to nothing; listeners go nowhere. */
function inertApi(): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_target, key) => (key === 'then' ? undefined : inertApi()),
    apply: () => Promise.resolve(undefined),
  });
}

/** The real service worker, loaded fresh on this test's own empty database. */
async function loadBackground() {
  const listeners: Listener[] = [];
  const panelMessages: unknown[] = [];
  const tabsSendMessage = vi.fn(async (): Promise<unknown> => undefined);
  const runtime = {
    id: EXTENSION_ID,
    onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    sendMessage: vi.fn(async (message: unknown) => {
      panelMessages.push(message);
    }),
  };
  vi.stubGlobal(
    'chrome',
    new Proxy(
      {
        runtime: new Proxy(runtime, {
          get: (target, key) => (key in target ? target[key as keyof typeof target] : inertApi()),
        }),
        tabs: {
          sendMessage: tabsSendMessage,
          query: vi.fn(async () => [{ id: 7, windowId: 1, active: true, url: SOURCE_URL }]),
          captureVisibleTab: vi.fn(),
        },
        scripting: { executeScript: vi.fn(async () => []) },
        storage: {
          local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
          onChanged: { addListener: vi.fn() },
        },
      },
      {
        get: (target, key) => (key in target ? target[key as keyof typeof target] : inertApi()),
      },
    ),
  );
  vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
  vi.resetModules();
  const background = await import('../background/index');

  /** What the first listener to answer says, as Chrome would resolve sendMessage. */
  async function send(message: unknown) {
    return new Promise<unknown>((resolve) => {
      for (const listener of listeners) listener(message, DASHBOARD, resolve);
    });
  }
  return { ...background, send, panelMessages, tabsSendMessage };
}

describe('a capture still running during delete-all', () => {
  let repository: ValRecallRepository;
  let drafts: DraftRepository;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    repository = new ValRecallRepository();
    drafts = new DraftRepository(repository);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    screenshot.capture.mockReset();
    screenshot.capture.mockResolvedValue(SECRET_SCREENSHOT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function expectNothingCameBack(
    send: (message: unknown) => Promise<unknown>,
    panelMessages: unknown[],
  ) {
    expect(await send(GET_PENDING)).toMatchObject({
      ok: false,
      error: { message: '还没有待整理的捕获，请再按一次快捷键。' },
    });
    expect(await repository.getMeta('runtime.pendingCapture')).toBeUndefined();
    expect(await drafts.list('capture')).toEqual([]);
    expect(JSON.stringify(panelMessages)).not.toContain(SECRET_SCREENSHOT);
  }

  it('drops it when the delete lands during the screenshot', async () => {
    const { send, startCapture, tabsSendMessage, panelMessages } = await loadBackground();
    tabsSendMessage.mockImplementation(async () => ({
      ok: true,
      draft: capture('in-flight', new Date()),
    }));
    let finish!: (dataUrl: string) => void;
    screenshot.capture.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const running = startCapture(TAB);
    await vi.waitFor(() => expect(screenshot.capture).toHaveBeenCalledOnce());
    await repository.clearAllData();
    expect(await send(CLEAR_MESSAGE)).toEqual({ ok: true });
    finish(SECRET_SCREENSHOT);
    await running;

    await expectNothingCameBack(send, panelMessages);
  });

  it('drops it when the page answers after the delete, with a later capture time', async () => {
    const { send, startCapture, tabsSendMessage, panelMessages } = await loadBackground();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    tabsSendMessage.mockImplementation(async () => {
      await held;
      return { ok: true, draft: capture('in-flight', new Date(Date.now() + 60_000)) };
    });

    const running = startCapture(TAB);
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalledOnce());
    await repository.clearAllData();
    expect(await send(CLEAR_MESSAGE)).toEqual({ ok: true });
    answer();
    await running;

    await expectNothingCameBack(send, panelMessages);
  });

  it('keeps a capture pressed after the delete, even if one from before is still running', async () => {
    const { send, startCapture, tabsSendMessage } = await loadBackground();
    let answerOld!: () => void;
    const heldOld = new Promise<void>((resolve) => {
      answerOld = resolve;
    });
    tabsSendMessage.mockImplementationOnce(async () => {
      await heldOld;
      return { ok: true, draft: capture('old', new Date()) };
    });
    const old = startCapture(TAB);
    await vi.waitFor(() => expect(tabsSendMessage).toHaveBeenCalledOnce());
    await send(CLEAR_MESSAGE);

    tabsSendMessage.mockImplementationOnce(async () => ({
      ok: true,
      draft: capture('new', new Date()),
    }));
    await startCapture(TAB);
    answerOld();
    await old;

    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'new' } });
    expect(await repository.getMeta('runtime.pendingCapture')).toMatchObject({
      draft: { draftId: 'new' },
    });
  });
});

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ValRecallRepository } from '../database';
import { DraftRepository } from '../database/drafts';
import { preservePendingCapture } from '../database/pending-capture';
import type { CaptureDraft } from '../models/learning-item';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';

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
const NO_ANSWER = Symbol('no answer');
const SECRET_SCREENSHOT = 'data:image/png;base64,c2VjcmV0';

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string },
  sendResponse: (response: unknown) => void,
) => boolean | void;

function capture(draftId: string, overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    draftId,
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
    capturedAt: new Date().toISOString(),
    extractionDiagnostics: [],
    ...overrides,
  };
}

/** Any chrome call nothing here cares about resolves to nothing; listeners go nowhere. */
function inertApi(path: string[] = []): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get: (_target, key) => (key === 'then' ? undefined : inertApi([...path, String(key)])),
    apply: () => Promise.resolve(undefined),
  });
}

/** The real service worker, loaded fresh on this test's own empty database. */
async function loadBackground(publicEdition = true) {
  const listeners: Listener[] = [];
  const tabsSendMessage = vi.fn(async (): Promise<unknown> => undefined);
  const runtime = {
    id: EXTENSION_ID,
    onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    sendMessage: vi.fn(async () => undefined),
  };
  vi.stubGlobal(
    'chrome',
    new Proxy(
      {
        runtime: new Proxy(runtime, {
          get: (target, key) =>
            key in target ? target[key as keyof typeof target] : inertApi(['runtime']),
        }),
        tabs: {
          sendMessage: tabsSendMessage,
          query: vi.fn(async () => [
            { id: 7, windowId: 1, active: true, url: capture('any').sourceUrl },
          ]),
          captureVisibleTab: vi.fn(),
        },
        scripting: { executeScript: vi.fn(async () => []) },
        storage: {
          local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
          onChanged: { addListener: vi.fn() },
        },
      },
      {
        get: (target, key) =>
          key in target ? target[key as keyof typeof target] : inertApi([String(key)]),
      },
    ),
  );
  vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', publicEdition);
  vi.resetModules();
  const background = await import('../background/index');

  /** What the first listener to answer says, as Chrome would resolve sendMessage. */
  async function send(message: unknown, sender: { id?: string; url?: string } = DASHBOARD) {
    return new Promise<unknown>((resolve) => {
      let waiting = false;
      for (const listener of listeners) {
        if (listener(message, sender, resolve) === true) waiting = true;
      }
      if (!waiting) setTimeout(() => resolve(NO_ANSWER), 20);
    });
  }
  return { ...background, send, tabsSendMessage };
}

describe('delete-all and the pending capture, in the service worker', () => {
  let repository: ValRecallRepository;
  let drafts: DraftRepository;

  beforeEach(() => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    repository = new ValRecallRepository();
    drafts = new DraftRepository(repository);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    screenshot.capture.mockReset();
    screenshot.capture.mockResolvedValue('data:image/jpeg;base64,aGVsbG8=');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expectNothingPending = (response: unknown) =>
    expect(response).toMatchObject({
      ok: false,
      error: { message: '还没有待整理的捕获，请再按一次快捷键。' },
    });

  it('cannot clear it with the old dismiss message, which needs a capture ID', async () => {
    const { send } = await loadBackground();
    await preservePendingCapture(repository, { ok: true, draft: capture('held') });
    await send(GET_PENDING);
    await repository.clearAllData();

    const refused = await send({
      type: MESSAGE_TYPES.dismissCapture,
      version: MESSAGE_PROTOCOL_VERSION,
    });

    expect(refused).toMatchObject({ ok: false });
    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'held' } });
  });

  it('forgets the capture and screenshot it holds in memory', async () => {
    const { send } = await loadBackground();
    await preservePendingCapture(repository, { ok: true, draft: capture('held') });
    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'held' } });

    await repository.clearAllData();
    expect(await send(CLEAR_MESSAGE)).toEqual({ ok: true });

    const after = await send(GET_PENDING);
    expectNothingPending(after);
    expect(JSON.stringify(after)).not.toContain(SECRET_SCREENSHOT);
  });

  it('removes a capture that reached the database after the clear', async () => {
    const { send } = await loadBackground();
    await repository.clearAllData();
    await preservePendingCapture(repository, { ok: true, draft: capture('late') });
    await drafts.save(
      {
        id: 'open-editor',
        scope: 'capture',
        summary: 'Synthetic',
        payload: { capture: JSON.stringify(capture('late')) },
      },
      0,
    );

    expect(await send(CLEAR_MESSAGE)).toEqual({ ok: true });

    expect(await repository.getMeta('runtime.pendingCapture')).toBeUndefined();
    expect(await drafts.list('capture')).toEqual([]);
  });

  it('keeps drafts of other kinds', async () => {
    const { send } = await loadBackground();
    await drafts.save({ id: 'task', scope: 'task', summary: 'x', payload: { title: 'x' } }, 0);
    await send(CLEAR_MESSAGE);
    expect((await drafts.list('task')).map((row) => row.id)).toEqual(['task']);
  });

  // A capture still running during the delete is tested in the overlay, because a counted rewrite
  // stops it: release-tools/overlay/src/edition/capture-during-delete.public.test.ts.
  it('still takes a capture made after the delete', async () => {
    const { send, startCapture, tabsSendMessage } = await loadBackground();
    await send(CLEAR_MESSAGE);
    tabsSendMessage.mockImplementation(async () => ({
      ok: true,
      draft: capture('after', { capturedAt: new Date(Date.now() + 1000).toISOString() }),
    }));
    await startCapture({ id: 7, windowId: 1, url: capture('any').sourceUrl } as never);
    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'after' } });
  });

  it.each([
    ['a video page', { id: EXTENSION_ID, url: 'https://www.bilibili.com/video/BV1abc123' }],
    [
      'our side panel',
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` },
    ],
    ['another extension', { id: 'other', url: 'chrome-extension://other/dashboard.html' }],
    ['a sender with no address', { id: EXTENSION_ID }],
  ])('refuses the message from %s', async (_name, sender) => {
    const { send } = await loadBackground();
    await preservePendingCapture(repository, { ok: true, draft: capture('kept') });
    expect(await send(GET_PENDING)).toMatchObject({ ok: true });

    expect(await send(CLEAR_MESSAGE, sender)).toEqual({ ok: false });

    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'kept' } });
    expect(await repository.getMeta('runtime.pendingCapture')).toMatchObject({ ok: true });
  });

  it.each([
    ['an old protocol', { ...CLEAR_MESSAGE, version: 0 }],
    ['an unexpected payload', { ...CLEAR_MESSAGE, payload: { draftId: 'x' } }],
  ])('ignores %s', async (_name, message) => {
    const { send } = await loadBackground();
    await preservePendingCapture(repository, { ok: true, draft: capture('kept') });
    expect(await send(message)).toBe(NO_ANSWER);
    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'kept' } });
  });

  it('does not listen for it in the personal edition', async () => {
    const { send } = await loadBackground(false);
    await preservePendingCapture(repository, { ok: true, draft: capture('kept') });
    expect(await send(GET_PENDING)).toMatchObject({ ok: true });
    expect(await send(CLEAR_MESSAGE)).toBe(NO_ANSWER);
    expect(await send(GET_PENDING)).toMatchObject({ ok: true, draft: { draftId: 'kept' } });
  });
});

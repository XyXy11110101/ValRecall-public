import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuleBasedLearningItemGenerator } from '../generators';
import { LEARNING_ITEM_TYPES, type LearningItemType } from '../models/learning-item';
import { MESSAGE_PROTOCOL_VERSION, type CapturePageResponse } from '../models/messages';
import { SidePanelApp } from '../sidepanel/SidePanelApp';
import { installDraftMemoryPort } from '../testing/draft-port';
import { captureErrorText } from './capture-errors';
import { registerCaptureRetry, type CaptureRetryApi } from './capture-retry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RAW_MESSAGE = 'Bilibili video player not ready.';
const failure: CapturePageResponse = {
  ok: false,
  error: { code: 'VIDEO_NOT_FOUND', message: RAW_MESSAGE },
};
const RETRY_MESSAGE = { type: 'VALRECALL_RETRY_CAPTURE', version: MESSAGE_PROTOCOL_VERSION };

function generate(itemType: LearningItemType, chapterTitle: string | null = null) {
  return new RuleBasedLearningItemGenerator().generate({
    platform: 'bilibili',
    itemType,
    coreLesson: '先看结论。',
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    videoTitle: '示例',
    chapterTitle,
  });
}

describe('capture defaults', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(LEARNING_ITEM_TYPES)('asks in Chinese for %s in the public edition', async (itemType) => {
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
    const { fields, validation } = await generate(itemType);
    expect(fields.recallPrompt).toMatch(/^[一-鿿，？]+$/u);
    expect(fields.tags.join(' ')).not.toMatch(/bilibili|avoid|do|notice|understand/iu);
    expect(validation.valid).toBe(true);
  });

  it('uses Chinese tags and keeps the chapter in the public edition', async () => {
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
    const { fields } = await generate('Do', '第二章');
    expect(fields.tags).toEqual(['B站', '去做', '第二章']);
  });

  it('keeps the English defaults in this edition', async () => {
    const { fields } = await generate('Do');
    expect(fields.recallPrompt).toBe('What action should you take in this situation?');
    expect(fields.tags).toEqual(['bilibili', 'do']);
  });
});

describe('capture failure in the side panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sendMessage: ReturnType<typeof vi.fn>;

  const retryButton = () =>
    Array.from(container.querySelectorAll('button')).find((entry) =>
      /重试/u.test(entry.textContent ?? ''),
    );

  async function render() {
    await act(async () =>
      root.render(
        <SidePanelApp
          initialPending={failure}
          initialLoadingCapture={false}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
        />,
      ),
    );
  }

  beforeEach(() => {
    installDraftMemoryPort();
    sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
      commands: { getAll: vi.fn().mockResolvedValue([]) },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows Chinese text by code and retries in the public edition', async () => {
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === RETRY_MESSAGE.type ? { ok: true } : failure,
    );
    await render();
    expect(container.textContent).toContain(captureErrorText('VIDEO_NOT_FOUND'));
    expect(container.textContent).not.toContain(RAW_MESSAGE);

    await act(async () => retryButton()!.click());
    expect(sendMessage).toHaveBeenCalledWith(RETRY_MESSAGE);
    expect(retryButton()!.disabled).toBe(false);
  });

  it('says so when the retry could not run', async () => {
    vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true);
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === RETRY_MESSAGE.type) throw new Error('No receiver');
      return failure;
    });
    await render();
    await act(async () => retryButton()!.click());
    expect(container.textContent).toContain('重试没有成功。请回到视频页，按捕获快捷键。');
    expect(container.textContent).not.toContain('No receiver');
  });

  it('keeps the original text and no retry in this edition', async () => {
    sendMessage.mockResolvedValue(failure);
    await render();
    expect(container.textContent).toContain(RAW_MESSAGE);
    expect(retryButton()).toBeUndefined();
  });
});

describe('registerCaptureRetry', () => {
  function listen(startCapture: () => Promise<void>) {
    let listener!: Parameters<CaptureRetryApi['runtime']['onMessage']['addListener']>[0];
    registerCaptureRetry(
      {
        runtime: {
          id: 'ext',
          onMessage: {
            addListener: (next) => {
              listener = next;
            },
          },
        },
      },
      startCapture,
    );
    return listener;
  }
  const panel = { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' };

  afterEach(() => vi.restoreAllMocks());

  it('runs the capture for our own panel', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();
    expect(listen(start)(RETRY_MESSAGE, panel, respond)).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
  });

  it('reports a capture that throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const respond = vi.fn();
    listen(vi.fn().mockRejectedValue(new Error('boom')))(RETRY_MESSAGE, panel, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: false }));
  });

  it.each([
    { id: 'ext', url: 'https://www.bilibili.com/video/BV1' },
    { id: 'other', url: 'chrome-extension://other/sidepanel.html' },
    { id: 'ext', url: 'chrome-extension://ext/dashboard.html' },
    { id: 'ext' },
  ])('refuses the sender %j', (sender) => {
    const start = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();
    expect(listen(start)(RETRY_MESSAGE, sender, respond)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ ok: false });
  });

  it.each([
    { type: 'OTHER', version: MESSAGE_PROTOCOL_VERSION },
    { type: RETRY_MESSAGE.type },
    null,
  ])('ignores the message %j', (message) => {
    const start = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn();
    expect(listen(start)(message, panel, respond)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});

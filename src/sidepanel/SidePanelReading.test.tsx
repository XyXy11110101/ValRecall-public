import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CaptureDraft } from '../models/learning-item';
import { localDateKey } from '../models/daily-task';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';
import {
  ALLOWANCE_STORAGE_KEY,
  applyCaptureReward,
  DEFAULT_ALLOWANCE,
  loadAllowance,
  normalizeAllowance,
} from '../shared/allowance';
import { saveReading } from '../reading/save-reading';
import { SidePanelApp, type SidePanelAppProps } from './SidePanelApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const draft: CaptureDraft = {
  draftId: 'reading-isolation-video',
  schemaVersion: 2,
  platform: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1reading',
  canonicalUrl: null,
  videoId: 'BV1reading',
  videoTitle: '合成测试视频',
  uploader: null,
  description: null,
  timestampSeconds: 42,
  timestampDisplay: '00:42',
  videoDurationSeconds: 100,
  chapterTitle: null,
  videoBounds: null,
  screenshotDataUrl: null,
  subtitleBefore: [],
  subtitleCurrent: [],
  subtitleAfter: [],
  subtitleCueData: [],
  subtitleStatus: 'unavailable',
  subtitleExtractionStrategy: 'none',
  subtitleConfidence: 'none',
  capturedAt: '2026-10-01T12:00:00Z',
  extractionDiagnostics: [],
};
const loadCategories = async () => [];

describe('side-panel reading integration', () => {
  let host: HTMLDivElement;
  let root: Root;
  let listener: (message: unknown) => void;
  let stored: Record<string, unknown>;
  beforeEach(() => {
    installDraftMemoryPort();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    stored = {};
    listener = () => undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        sendMessage: vi.fn(async () => ({ ok: true, draft })),
        onMessage: {
          addListener: (fn: typeof listener) => {
            listener = fn;
          },
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => stored),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
        },
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent?.startsWith(text))!;
  const type = (element: HTMLTextAreaElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const render = async (props: SidePanelAppProps = {}) => {
    await act(async () =>
      root.render(
        <SidePanelApp loadCategories={loadCategories} loadDueCount={async () => 0} {...props} />,
      ),
    );
  };

  it('preserves both modes and does not switch or replace reading input on a video message', async () => {
    await render();
    const videoQuestion = host.querySelector<HTMLTextAreaElement>('#capture-write-pane textarea')!;
    type(videoQuestion, '手写的视频问题');
    await act(async () => button('阅读摘录').click());
    type(host.querySelector('.reading-capture textarea')!, '正在整理的书籍段落');
    await act(async () =>
      listener({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { ok: true, draft: { ...draft, draftId: 'incoming-second' } },
      }),
    );
    expect(button('阅读摘录').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector<HTMLTextAreaElement>('.reading-capture textarea')?.value).toBe(
      '正在整理的书籍段落',
    );
    expect(button('视频捕获').textContent).toContain('待整理');
    // The button says it on screen; the status line is only for screen readers.
    expect(host.querySelector('.reading-window [role="status"]')?.className).toBe('sr-only');
    await act(async () => button('视频捕获').click());
    type(videoQuestion, '第二个视频问题');
    await act(async () => button('阅读摘录').click());
    expect(host.querySelector<HTMLTextAreaElement>('.reading-capture textarea')?.value).toBe(
      '正在整理的书籍段落',
    );
    await act(async () => button('视频捕获').click());
    expect(videoQuestion.value).toBe('第二个视频问题');
  });

  it('grants the capture reward through the shared form and shares the video check-in', async () => {
    const save = vi.fn(saveReading);
    stored[ALLOWANCE_STORAGE_KEY] = applyCaptureReward(
      DEFAULT_ALLOWANCE,
      localDateKey(new Date()),
      new Date().toISOString(),
    ).state;
    await render({ saveReadingCapture: save });
    await act(async () => button('阅读摘录').click());
    const fields = host.querySelectorAll<HTMLTextAreaElement>('.reading-capture textarea');
    type(fields[0]!, '合成原文');
    type(fields[1]!, '合成阅读问题？');
    type(fields[2]!, '合成答案');
    await act(async () => {
      button('保存阅读摘录').click();
      await vi.waitFor(() => expect(save).toHaveBeenCalled());
      await save.mock.results[0]!.value;
    });
    expect(host.querySelector('.reading-capture')?.textContent).toContain('阅读摘录已保存');
    expect(host.querySelector('.reading-reward')?.textContent).toBe('阅读摘录 +2 零花钱');
    const state = await loadAllowance();
    expect(state.balance).toBe(9);
    expect(normalizeAllowance(stored[ALLOWANCE_STORAGE_KEY]).balance).toBe(7);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(state.ledger.filter((entry) => entry.source === 'capture')).toHaveLength(2);
    expect(state.ledger.filter((entry) => entry.source === 'check-in')).toHaveLength(1);
    expect(state.ledger.filter((entry) => entry.source === 'manual')).toHaveLength(0);
  });

  it('keeps a dashboard-open failure visible in reading mode', async () => {
    await render();
    await act(async () => button('阅读摘录').click());
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error('测试面板无法打开'));
    await act(async () => button('打开学习面板').click());
    expect(
      host.querySelector('.reading-window:not([hidden]) [role="alert"]')?.textContent,
    ).toContain('测试面板无法打开');
    expect(button('阅读摘录').getAttribute('aria-pressed')).toBe('true');
  });
});

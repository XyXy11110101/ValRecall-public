import { installDraftMemoryPort } from '../testing/draft-port';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEmptyCard } from 'ts-fsrs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import { DatabaseError, type MomentCategory, type NewVideoLearningItem } from '../database';
import { DraftRepository } from '../database/drafts';
import { applyCaptureReward, DEFAULT_ALLOWANCE } from '../shared/allowance';
import {
  RuleBasedLearningItemGenerator,
  type LearningItemGenerationInput,
  type LearningItemGenerationResult,
} from '../generators';
import { localDateKey } from '../models/daily-task';
import type { CaptureDraft } from '../models/learning-item';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';
import { SidePanelApp, type SidePanelAppProps } from './SidePanelApp';
import * as dashboard from '../shared/dashboard';
import * as extension from '../shared/extension';

beforeEach(() => {
  installDraftMemoryPort();
});

describe('capture source and question workspace', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function renderCapture(overrides: SidePanelAppProps = {}) {
    const persistItem = vi.fn(async () => undefined);
    const dismissCapture = vi.fn(async () => undefined);
    const recordCaptureAllowance = vi.fn(async () =>
      applyCaptureReward(DEFAULT_ALLOWANCE, '2026-07-24'),
    );
    await act(async () => {
      root.render(
        <SidePanelApp
          initialPending={{
            ok: true,
            draft: {
              ...captureDraft,
              videoTitle: '来源标题也会泄题',
              screenshotDataUrl: 'data:image/png;base64,AA==',
              subtitleCurrent: ['字幕中的秘密答案'],
            },
          }}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
          persistItem={persistItem}
          dismissCapture={dismissCapture}
          recordCaptureAllowance={recordCaptureAllowance}
          convertScreenshot={async () => new Blob(['image'], { type: 'image/png' })}
          {...overrides}
        />,
      );
      await Promise.resolve();
    });
    act(() => {
      setNativeValue(
        labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea')!,
        '我要回忆什么？',
      );
      setNativeValue(
        labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')!,
        '我的秘密答案',
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    return { persistItem, dismissCapture, recordCaptureAllowance };
  }

  it('keeps edited inputs across source/write switches and hides spoilers until preview reveal', async () => {
    const { persistItem, recordCaptureAllowance } = await renderCapture();
    const source = container.querySelector<HTMLElement>('#capture-source-pane')!;
    const write = container.querySelector<HTMLElement>('#capture-write-pane')!;
    expect(source.hidden).toBe(true);
    expect(write.hidden).toBe(false);
    expect(container.querySelector('details.capture-more-options')?.hasAttribute('open')).toBe(
      false,
    );
    const paneButtons = container.querySelector('.capture-pane-nav')!;
    act(() => buttonByText(paneButtons, '来源')!.click());
    expect(source.hidden).toBe(false);
    expect(write.hidden).toBe(true);
    act(() => {
      setNativeValue(
        labelledControl<HTMLInputElement>(source, '视频标题', 'input')!,
        '编辑后的来源标题',
      );
      buttonByText(paneButtons, '写题')!.click();
    });
    expect(labelledControl<HTMLTextAreaElement>(write, '问题', 'textarea')?.value).toBe(
      '我要回忆什么？',
    );
    act(() => buttonByText(container, '模拟复习')!.click());
    const preview = container.querySelector('.capture-question-preview')!;
    expect(preview.textContent).toContain('我要回忆什么？');
    expect(preview.textContent).not.toContain('我的秘密答案');
    expect(preview.textContent).not.toContain('字幕中的秘密答案');
    expect(preview.textContent).not.toContain('编辑后的来源标题');
    expect(source.hidden).toBe(true);
    expect(container.querySelector<HTMLDivElement>('.capture-question-editor')?.hidden).toBe(true);
    expect(container.querySelector('.capture-cue img')).not.toBeNull();
    act(() => buttonByText(preview, '揭晓答案')!.click());
    expect(preview.textContent).toContain('我的秘密答案');
    act(() => buttonByText(container, '编辑')!.click());
    act(() => buttonByText(container, '模拟复习')!.click());
    expect(container.querySelector('.capture-question-preview')?.textContent).not.toContain(
      '我的秘密答案',
    );
    expect(persistItem).not.toHaveBeenCalled();
    expect(recordCaptureAllowance).not.toHaveBeenCalled();
  });

  it('saves once directly from concealed preview and keeps a truthful result with item navigation', async () => {
    const open = vi.spyOn(dashboard, 'openValRecallDashboard').mockResolvedValue({ ok: true });
    const { persistItem, dismissCapture, recordCaptureAllowance } = await renderCapture();
    act(() => buttonByText(container, '模拟复习')!.click());
    await act(async () => {
      const save = buttonByText(container, '保存回忆题')!;
      save.click();
      save.click();
      await Promise.resolve();
    });
    expect(persistItem).toHaveBeenCalledOnce();
    expect(recordCaptureAllowance).toHaveBeenCalledOnce();
    expect(dismissCapture).toHaveBeenCalledWith(captureDraft.draftId);
    expect(persistItem).toHaveBeenCalledWith(
      expect.objectContaining({ recallPrompt: '我要回忆什么？', coreLesson: '我的秘密答案' }),
      expect.any(Blob),
    );
    expect(container.textContent).toContain('零花钱 +7 元');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.querySelector('.capture-save-receipt')).not.toBeNull();
    await act(async () => buttonByText(container, '在资料库查看')!.click());
    expect(open).toHaveBeenCalledWith({ view: 'library', itemId: captureDraft.draftId });
    act(() => buttonByText(container, '继续捕获')!.click());
    expect(container.querySelector('.capture-save-receipt')).toBeNull();
    expect(container.querySelector('.companion-hero h2')?.textContent).toBe('按 Alt+Shift+M 捕获');
    expect(container.querySelector('.notice')).toBeNull();
    expect(persistItem).toHaveBeenCalledOnce();
  });

  it('keeps only the praise, title and time, one reward and two buttons after saving', async () => {
    await renderCapture();
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    const receipt = container.querySelector('.capture-save-receipt')!;
    const hero = container.querySelector('.companion-hero')!;
    const praise = hero.querySelector('h2')!.textContent;
    expect(praise).toBeTruthy();
    expect(hero.textContent).toBe(praise);
    expect(receipt.textContent).toContain('来源标题也会泄题');
    expect(receipt.textContent).toContain('Bilibili · 00:42');
    expect(container.querySelectorAll('.capture-reward-confirmation')).toHaveLength(1);
    expect(container.textContent?.match(/零花钱/g)).toHaveLength(1);
    expect(receipt.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('.notice')).toBeNull();
    for (const removed of ['已加入今天的复习', '记忆线索', '已捕获时刻', '打卡']) {
      expect(container.textContent).not.toContain(removed);
    }
    // "Saved" is still said to screen readers, as the name of the receipt.
    const title = receipt.querySelector('h2.sr-only')!;
    expect(title.textContent).toBe('捕获已保存');
    expect(receipt.getAttribute('aria-labelledby')).toBe(title.id);
    // The praise outlasts the joyful pose, so the idle line never returns under a receipt.
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(hero.getAttribute('data-companion-hero-state')).not.toBe('success');
    expect(hero.querySelector('h2')?.textContent).toBe(praise);
    expect(hero.querySelector('p')).toBeNull();
  });

  it('drops the praise and the receipt as soon as the next capture arrives', async () => {
    let listener!: (value: unknown) => void;
    const old = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: vi.fn(async (message) =>
          message.type === MESSAGE_TYPES.getPendingCapture
            ? { ok: true, draft: old }
            : { ok: true },
        ),
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    try {
      await renderCapture({ initialPending: { ok: true, draft: old } });
      await act(async () => buttonByText(container, '保存回忆题')!.click());
      expect(container.querySelector('.companion-hero h2')?.textContent).toBeTruthy();
      await act(async () =>
        listener({
          type: MESSAGE_TYPES.pendingCaptureChanged,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: { ok: true, draft: { ...old, draftId: 'next-capture', videoTitle: '下一个' } },
        }),
      );
      expect(container.querySelector('.companion-hero h2')?.textContent).toBe('整理这个 Moment');
      expect(container.querySelector('.capture-save-receipt')).toBeNull();
      expect(container.querySelector('.capture-reward-confirmation')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the next capture without what the last one ended on', async () => {
    let listener!: (value: unknown) => void;
    const old = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: vi.fn(async (message) =>
          message.type === MESSAGE_TYPES.getPendingCapture
            ? { ok: true, draft: old }
            : { ok: true },
        ),
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            loadDueCount={async () => 0}
            loadCategories={async () => []}
            dismissCapture={vi.fn(async () => undefined)}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await act(async () => buttonByText(container, '放弃捕获')!.click());
      // Idle: the one place that sentence belongs.
      expect(container.textContent).toContain('已放弃这次捕获');
      await act(async () =>
        listener({
          type: MESSAGE_TYPES.pendingCaptureChanged,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: { ok: true, draft: { ...old, draftId: 'next-capture', videoTitle: '下一个' } },
        }),
      );
      expect(labelledControl<HTMLInputElement>(container, '视频标题', 'input')?.value).toBe(
        '下一个',
      );
      expect(container.querySelector('.capture-save-bar .notice')).toBeNull();
      expect(container.textContent).not.toContain('已放弃这次捕获');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores an older capture without what the last one ended on', async () => {
    const rows = installDraftMemoryPort();
    const old = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
    const restored = { ...old, draftId: 'older-capture', videoTitle: '以前的捕获' };
    rows.set('older-edit', {
      schemaVersion: 1,
      id: 'older-edit',
      scope: 'capture',
      summary: '以前的捕获',
      revision: 1,
      updatedAt: new Date().toISOString(),
      payload: {
        id: 'older-edit',
        capture: JSON.stringify(restored),
        videoTitle: '以前的捕获',
        coreLesson: '以前写的答案',
        recallPrompt: '以前的问题',
        itemType: 'Understand',
        categoryId: null,
      },
    });
    await act(async () => {
      root.render(
        <SidePanelApp
          initialPending={{ ok: true, draft: old }}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    // A message left by the capture being replaced: a source that opened.
    vi.spyOn(extension, 'openSourceAtTimestamp').mockResolvedValue({
      ok: true,
      attempts: 1,
      timestampSeconds: 42,
      error: null,
      diagnostics: [],
    });
    act(() => buttonByText(container.querySelector('.capture-pane-nav')!, '来源')!.click());
    await act(async () => buttonByText(container, '打开来源')!.click());
    expect(container.querySelector('.capture-save-bar .notice')?.textContent).toContain(
      '已打开来源',
    );
    await act(async () => buttonByText(container, '继续')!.click());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')?.value).toBe(
      '以前写的答案',
    );
    expect(container.querySelector('.capture-save-bar .notice')).toBeNull();
  });

  it('keeps the warning when a saved capture cannot confirm its reward', async () => {
    await renderCapture({
      recordCaptureAllowance: vi.fn().mockRejectedValue(new Error('账本写入失败')),
    });
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(container.querySelector('.notice.warning')?.textContent).toBe(
      '已保存，但零花钱未能确认，请查看账本。',
    );
    expect(container.querySelector('.companion-hero h2')?.textContent).toBe('捕获已保存');
    expect(container.querySelector('.capture-reward-confirmation')).toBeNull();
    expect(
      container.querySelector('.capture-save-receipt')?.querySelectorAll('button'),
    ).toHaveLength(2);
  });

  it('keeps the preview and input on save failure and puts retry feedback next to Save', async () => {
    const persistItem = vi.fn().mockRejectedValue(new Error('写入失败'));
    const reward = vi.fn(async () => null);
    await renderCapture({ persistItem, recordCaptureAllowance: reward });
    act(() => buttonByText(container, '模拟复习')!.click());
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(container.querySelector('.capture-save-bar [role="alert"]')?.textContent).toContain(
      '写入失败',
    );
    expect(container.querySelector('.capture-question-preview')?.textContent).toContain(
      '我要回忆什么？',
    );
    expect(container.querySelector('.capture-save-receipt')).toBeNull();
    expect(reward).not.toHaveBeenCalled();
    act(() => buttonByText(container, '编辑')!.click());
    expect(labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')?.value).toBe(
      '我的秘密答案',
    );
  });

  it('keeps input and skips preparation when the pinned draft cannot be retained, then retries', async () => {
    const generator = new RuleBasedLearningItemGenerator();
    const generateLearningItem = vi.fn((input: LearningItemGenerationInput) =>
      generator.generate(input),
    );
    const convertScreenshot = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
    const { persistItem, recordCaptureAllowance } = await renderCapture({
      generateLearningItem,
      convertScreenshot,
    });
    generateLearningItem.mockClear();
    vi.mocked(DraftRepository.prototype.save).mockRejectedValueOnce(new Error('草稿磁盘写入失败'));
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(generateLearningItem).not.toHaveBeenCalled();
    expect(convertScreenshot).not.toHaveBeenCalled();
    expect(persistItem).not.toHaveBeenCalled();
    expect(recordCaptureAllowance).not.toHaveBeenCalled();
    expect(container.querySelector('.capture-save-bar [role="alert"]')?.textContent).toContain(
      '草稿磁盘写入失败',
    );
    expect(labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')?.value).toBe(
      '我的秘密答案',
    );
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(persistItem).toHaveBeenCalledOnce();
    expect(recordCaptureAllowance).toHaveBeenCalledOnce();
  });

  it('takes an invalid preview to its editable field and reveals missing source metadata', async () => {
    const { persistItem } = await renderCapture();
    act(() =>
      setNativeValue(labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')!, ''),
    );
    act(() => buttonByText(container, '模拟复习')!.click());
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    const answer = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')!;
    expect(document.activeElement).toBe(answer);
    expect(container.querySelector('.capture-question-preview')).toBeNull();
    act(() => {
      setNativeValue(answer, '重新填写答案');
      setNativeValue(labelledControl<HTMLInputElement>(container, '视频标题', 'input')!, '');
    });
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(container.querySelector<HTMLElement>('#capture-source-pane')?.hidden).toBe(false);
    expect(container.querySelector('details.source-context-disclosure')?.hasAttribute('open')).toBe(
      true,
    );
    expect(document.activeElement).toBe(
      labelledControl<HTMLInputElement>(container, '视频标题', 'input'),
    );
    expect(persistItem).not.toHaveBeenCalled();
  });

  it('requires explicit discard confirmation and keeps source-open errors beside the action footer', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(extension, 'openSourceAtTimestamp').mockRejectedValue(new Error('来源无法打开'));
    const { dismissCapture } = await renderCapture();
    act(() => buttonByText(container, '放弃捕获')!.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith('放弃这次捕获？');
    expect(dismissCapture).not.toHaveBeenCalled();
    act(() => buttonByText(container.querySelector('.capture-pane-nav')!, '来源')!.click());
    await act(async () => buttonByText(container, '打开来源')!.click());
    expect(container.querySelector('.capture-save-bar [role="alert"]')?.textContent).toContain(
      '来源无法打开',
    );
    expect(labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')?.value).toBe(
      '我的秘密答案',
    );
  });

  it('discards an untouched capture at once, however the auto-filled question looks', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const dismissCapture = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <SidePanelApp
          initialPending={{
            ok: true,
            draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
          }}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
          dismissCapture={dismissCapture}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea')?.value).not.toBe('');
    await act(async () => buttonByText(container, '放弃捕获')!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(dismissCapture).toHaveBeenCalledExactlyOnceWith(captureDraft.draftId);
    expect(container.querySelector('.capture-question-card')).toBeNull();
  });

  it.each([
    [
      'the question',
      () =>
        setNativeValue(labelledControl<HTMLTextAreaElement>(document, '问题', 'textarea')!, '我的'),
    ],
    [
      'the title',
      () =>
        setNativeValue(labelledControl<HTMLInputElement>(document, '视频标题', 'input')!, '改过'),
    ],
    ['the goal', () => document.querySelector<HTMLInputElement>('input[value="Avoid"]')!.click()],
  ])('asks before discarding after an edit to %s', async (_name, change) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const dismissCapture = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <SidePanelApp
          initialPending={{
            ok: true,
            draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
          }}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
          dismissCapture={dismissCapture}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => change());
    await act(async () => buttonByText(container, '放弃捕获')!.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith('放弃这次捕获？');
    expect(dismissCapture).not.toHaveBeenCalled();
  });

  it('focuses the empty field when saving is refused', async () => {
    const persistItem = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <SidePanelApp
          initialPending={{
            ok: true,
            draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
          }}
          loadDueCount={async () => 0}
          loadCategories={async () => []}
          persistItem={persistItem}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    const answer = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')!;
    expect(document.activeElement).toBe(answer);
    expect(container.querySelector('.capture-save-bar [role="alert"]')?.textContent).toBe(
      '保存前请用自己的话写下关键收获。',
    );
    act(() => {
      setNativeValue(answer, '我写下的答案');
      setNativeValue(labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea')!, ' ');
    });
    await act(async () => buttonByText(container, '保存回忆题')!.click());
    expect(document.activeElement).toBe(
      labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea'),
    );
    expect(persistItem).not.toHaveBeenCalled();
  });

  it('never discards a newer editing draft when an older capture cleanup resolves late', async () => {
    const rows = installDraftMemoryPort();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let listener!: (value: unknown) => void;
    let release!: () => void;
    const old = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
    const dismissCapture = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: vi.fn(async (message) =>
          message.type === MESSAGE_TYPES.getPendingCapture
            ? { ok: true, draft: old }
            : { ok: true },
        ),
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    try {
      await renderCapture({ initialPending: { ok: true, draft: old }, dismissCapture });
      act(() => buttonByText(container, '放弃捕获')!.click());
      await act(async () =>
        listener({
          type: MESSAGE_TYPES.pendingCaptureChanged,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: {
            ok: true,
            draft: { ...old, draftId: 'newer-capture', videoTitle: '新的捕获' },
          },
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(600));
      const newerDraft = [...rows.values()].find((row) =>
        JSON.stringify(row.payload).includes('newer-capture'),
      );
      expect(newerDraft).toBeDefined();
      await act(async () => release());
      expect(dismissCapture).toHaveBeenCalledExactlyOnceWith(old.draftId);
      expect(rows.has(newerDraft!.id)).toBe(true);
      expect(labelledControl<HTMLInputElement>(container, '视频标题', 'input')?.value).toBe(
        '新的捕获',
      );
      expect(container.textContent).not.toContain('已放弃这次捕获');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['generation', 'screenshot'] as const)(
    'keeps the original save snapshot and newer draft writable when capture changes during %s',
    async (stage) => {
      const rows = installDraftMemoryPort();
      const old = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
      const newer = {
        ...old,
        draftId: 'capture-during-preparation',
        videoTitle: '新的来源标题',
        timestampSeconds: 93,
        timestampDisplay: '01:33',
        screenshotDataUrl: 'data:image/png;base64,AQ==',
      };
      let listener!: (value: unknown) => void;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = false;
      let entered = false;
      const generator = new RuleBasedLearningItemGenerator();
      const generateLearningItem = vi.fn(async (input: LearningItemGenerationInput) => {
        if (armed && stage === 'generation' && input.videoTitle === old.videoTitle) {
          entered = true;
          await blocked;
        }
        return generator.generate(input);
      });
      const convertScreenshot = vi.fn(async (dataUrl: string) => {
        if (armed && stage === 'screenshot' && dataUrl === old.screenshotDataUrl) {
          entered = true;
          await blocked;
        }
        return new Blob([dataUrl], { type: 'image/png' });
      });
      vi.stubGlobal('chrome', {
        runtime: {
          id: 'test',
          sendMessage: vi.fn(async (message) =>
            message.type === MESSAGE_TYPES.getPendingCapture
              ? { ok: true, draft: old }
              : { ok: true },
          ),
          onMessage: {
            addListener: (handler: typeof listener) => {
              listener = handler;
            },
            removeListener: vi.fn(),
          },
        },
        storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      });
      try {
        const { persistItem, dismissCapture } = await renderCapture({
          initialPending: { ok: true, draft: old },
          loadCategories: async () => [valorantCategory],
          generateLearningItem,
          convertScreenshot,
        });
        act(() => {
          container.querySelector<HTMLInputElement>('input[value="Avoid"]')!.click();
          const category = labelledControl<HTMLSelectElement>(container, '分类', 'select')!;
          category.value = valorantCategory.id;
          category.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => vi.advanceTimersByTimeAsync(200));
        armed = true;
        await act(async () => buttonByText(container, '保存回忆题')!.click());
        expect(entered).toBe(true);
        expect(persistItem).not.toHaveBeenCalled();
        await act(async () =>
          listener({
            type: MESSAGE_TYPES.pendingCaptureChanged,
            version: MESSAGE_PROTOCOL_VERSION,
            payload: { ok: true, draft: newer },
          }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(600));
        const newerDraft = [...rows.values()].find((row) =>
          JSON.stringify(row.payload).includes(newer.draftId),
        );
        expect(newerDraft).toBeDefined();
        await act(async () => release());
        expect(persistItem).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            id: old.draftId,
            videoTitle: old.videoTitle,
            timestampSeconds: old.timestampSeconds,
            recallPrompt: '我要回忆什么？',
            coreLesson: '我的秘密答案',
            referenceAnswer: '我的秘密答案',
            categoryId: valorantCategory.id,
            itemType: 'Avoid',
          }),
          expect.any(Blob),
        );
        expect(convertScreenshot).toHaveBeenCalledExactlyOnceWith(old.screenshotDataUrl);
        expect(dismissCapture).not.toHaveBeenCalled();
        expect(container.querySelector('.capture-save-receipt')).toBeNull();
        expect(labelledControl<HTMLInputElement>(container, '视频标题', 'input')?.value).toBe(
          newer.videoTitle,
        );
        act(() =>
          setNativeValue(
            labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')!,
            '新捕获在旧保存结束后的修改仍要保留',
          ),
        );
        await act(async () => vi.advanceTimersByTimeAsync(600));
        expect(rows.get(newerDraft!.id)?.payload).toMatchObject({
          coreLesson: '新捕获在旧保存结束后的修改仍要保留',
          videoTitle: newer.videoTitle,
        });
      } finally {
        release();
        vi.unstubAllGlobals();
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captureDraft: CaptureDraft = {
  draftId: 'encoding-render-test',
  schemaVersion: 1,
  platform: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1encoding',
  canonicalUrl: null,
  videoId: 'BV1encoding',
  videoTitle: '正确显示的中文标题',
  uploader: '中文创作者',
  description: null,
  timestampSeconds: 42,
  timestampDisplay: '00:42',
  videoDurationSeconds: 120,
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
  capturedAt: '2026-07-20T12:00:00.000Z',
  extractionDiagnostics: [],
};

const valorantCategory: MomentCategory = {
  id: 'category-valorant',
  schemaVersion: 1,
  name: 'Valorant',
  createdAt: new Date('2026-07-20T12:00:00.000Z'),
  updatedAt: new Date('2026-07-20T12:00:00.000Z'),
  lastUsedAt: new Date('2026-07-20T12:00:00.000Z'),
};

function labelledControl<T extends Element>(
  container: ParentNode,
  labelText: string,
  selector: string,
): T | null {
  const label = [...container.querySelectorAll('label')].find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  return label?.querySelector<T>(selector) ?? null;
}

function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

describe('SidePanelApp UTF-8 interface copy', () => {
  it('renders exact Chinese labels without known mojibake fragments', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp initialPending={{ ok: true, draft: captureDraft }} />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const text = rendered.body.textContent ?? '';

    for (const removed of ['创建回忆题', '把这一刻变成一道题', '记忆线索']) {
      expect(text).not.toContain(removed);
    }
    for (const expected of [
      '模拟复习',
      '学习目标',
      '需要避免的错误行为。',
      '需要主动执行的正确行为。',
      '需要识别的信号、规律或情境。',
      '需要理解和解释的原理。',
      '答案要点',
      '保存回忆题',
      '打开学习面板',
    ]) {
      expect(text).toContain(expected);
    }

    for (const corrupted of [
      '\u9352\u6d98\u7f13',
      '\u701b\ufe3f\u7bc4',
      '\u95c7\u20ac\u7455',
      '\u6dc7\u6fc6\u74e8',
      '\u93b5\u64b3\u7d11',
      '\u951f\u65a4\u62f7',
    ]) {
      expect(markup).not.toContain(corrupted);
    }
  });

  it('keeps empty subtitle context out of Capture while retaining bounded diagnostics', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: {
            ...captureDraft,
            extractionDiagnostics: [
              {
                field: 'subtitles',
                strategy: 'no-subtitles-available',
                status: 'failed',
                severity: 'warning',
                message: 'No player-provided or visible DOM subtitle source was accessible.',
              },
            ],
          },
        }}
      />,
    );

    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    expect(rendered.querySelector('.source-context-lines')).toBeNull();
    expect(markup).not.toContain('No reliable nearby caption context');
    expect(markup).toContain('No player-provided or visible DOM subtitle source was accessible.');
  });

  it('shows one canonical Key takeaway field and no guide lines', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp initialPending={{ ok: true, draft: captureDraft }} />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const text = rendered.body.textContent ?? '';
    const takeaway = labelledControl<HTMLTextAreaElement>(rendered, '答案要点', 'textarea');
    const placeholder = takeaway?.getAttribute('placeholder');

    expect(placeholder).toBe('例如：现在就该用掉技能，而不是一直攒着造成压力。');
    expect(rendered.querySelectorAll('textarea')).toHaveLength(2);
    expect(takeaway?.closest('label')?.textContent).toContain('答案要点');
    expect(takeaway?.required).toBe(true);
    expect(takeaway?.hasAttribute('aria-describedby')).toBe(false);
    expect(labelledControl<HTMLTextAreaElement>(rendered, '问题', 'textarea')?.required).toBe(true);
    expect(rendered.querySelector('.capture-question-card .field-help')).toBeNull();
    expect(rendered.querySelector('.capture-question-card')?.getAttribute('aria-label')).toBe(
      '回忆题',
    );
    expect(text).not.toContain('什么问题能把这个 Moment 带回你的脑海？');
    expect(buttonByText(rendered, '重新生成问题')).toBeDefined();
    expect(text).not.toContain('你想从这一刻记住什么？');
    expect(text).not.toContain('这是揭晓答案后显示的关键学习内容。');
    expect(text).not.toContain('Personal note');
    expect(text).not.toContain('Key lesson');
    expect(text).not.toContain('Reference answer');
    expect(rendered.querySelector('.review-preview')).toBeNull();
    expect(markup).not.toContain('What do you want to remember or change?');
  });

  it('keeps Source context collapsed and orders learning content before organisation', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: {
            ...captureDraft,
            screenshotDataUrl: 'data:image/png;base64,AA==',
            subtitleBefore: ['Context before'],
            subtitleCurrent: ['Current nearby caption'],
            subtitleAfter: ['Context after'],
            subtitleStatus: 'timed_context',
            subtitleExtractionStrategy: 'text_track_timed_cues',
            subtitleConfidence: 'high',
          },
        }}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const text = rendered.body.textContent ?? '';
    const disclosure = rendered.querySelector('details.source-context-disclosure');
    const sourceSummary = disclosure?.querySelector('summary');

    expect(disclosure).not.toBeNull();
    expect(disclosure?.hasAttribute('open')).toBe(false);
    expect(sourceSummary?.textContent).toContain('捕获自 Bilibili · 00:42');
    expect(sourceSummary?.getAttribute('aria-label')).toBe('来源上下文：捕获自 Bilibili · 00:42');
    expect(disclosure?.textContent).toContain('Current nearby caption');
    const screenshot = rendered.querySelector('.capture-screenshot');
    expect(rendered.querySelectorAll('.capture-screenshot')).toHaveLength(1);
    expect(screenshot?.closest('details')).toBeNull();
    expect(screenshot?.closest('figure')?.textContent).toContain('Bilibili · 00:42');
    expect(labelledControl(disclosure ?? rendered, '视频标题', 'input')).not.toBeNull();
    expect(buttonByText(disclosure ?? rendered, '打开来源')).toBeDefined();
    expect(text).not.toContain('Subtitle source status');
    expect(rendered.querySelector('#capture-source-pane')?.hasAttribute('hidden')).toBe(true);
    const editorText = rendered.querySelector('.capture-question-editor')?.textContent ?? '';
    expect(editorText.indexOf('问题')).toBeLessThan(editorText.indexOf('答案要点'));
    expect(editorText.indexOf('答案要点')).toBeLessThan(editorText.indexOf('学习目标'));
    expect(text).not.toContain('Reference answer');
  });

  it('renders one Bilibili overlay cue first inside Capture Source context', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: {
            ...captureDraft,
            screenshotDataUrl: 'data:image/png;base64,AA==',
            subtitleCurrent: ['这是当前正在播放的字幕'],
            subtitleStatus: 'current_only',
            subtitleExtractionStrategy: 'visible_video_overlay',
            subtitleConfidence: 'medium',
            extractionDiagnostics: [
              {
                field: 'subtitles',
                strategy: 'subtitle-overlay-fallback',
                status: 'success',
                severity: 'info',
                message: 'Used the visible subtitle overlay fallback.',
              },
            ],
          },
        }}
      />,
    );
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    const disclosure = rendered.querySelector('details.source-context-disclosure');
    const lines = [...(disclosure?.querySelectorAll('.source-context-lines p') ?? [])].map(
      (line) => line.textContent,
    );

    expect(disclosure?.hasAttribute('open')).toBe(false);
    expect(lines).toEqual(['这是当前正在播放的字幕']);
    expect(disclosure?.querySelector('.subtitle-current')).not.toBeNull();
    expect(disclosure?.querySelector('.capture-screenshot')).toBeNull();
    expect(rendered.querySelectorAll('.capture-cue img')).toHaveLength(1);
    expect(disclosure?.textContent?.match(/这是当前正在播放的字幕/g)).toHaveLength(1);
  });

  it('uses platform-neutral empty-state copy and identifies the captured platform', () => {
    const emptyMarkup = renderToStaticMarkup(<SidePanelApp initialPending={null} />);
    const captureMarkup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
        }}
      />,
    );
    const douyinMarkup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: {
            ...captureDraft,
            schemaVersion: 2,
            platform: 'douyin',
            sourceUrl: 'https://www.douyin.com/video/7391234567890123456',
            canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
            videoId: '7391234567890123456',
          },
        }}
      />,
    );

    expect(emptyMarkup).toContain('按 Alt+Shift+M 捕获');
    expect(emptyMarkup).toContain('打开学习面板');
    expect(emptyMarkup).not.toContain('Open a Bilibili video');
    expect(emptyMarkup).not.toContain('还没有等待中的捕获');
    expect(emptyMarkup).not.toContain('empty-state');
    expect(captureMarkup).toContain('捕获自 Bilibili · 00:42');
    expect(douyinMarkup).toContain('捕获自 Douyin · 00:42');
    expect(captureMarkup).not.toContain('<dt>Platform</dt>');
    expect(douyinMarkup).not.toContain('<dt>Platform</dt>');
    expect(captureMarkup).toContain('alt="捕获到的可见视频画面"');
  });

  it('places one state hero before capture notices and interactive cards', () => {
    const idleMarkup = renderToStaticMarkup(
      <SidePanelApp initialPending={null} loadDueCount={async () => 0} />,
    );
    const draftMarkup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{ ok: true, draft: captureDraft }}
        loadDueCount={async () => 0}
      />,
    );
    const errorMarkup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: false,
          error: { code: 'CAPTURE_FAILED', message: 'No visible video was found.' },
        }}
        loadDueCount={async () => 0}
      />,
    );

    expect(idleMarkup).toContain('data-companion-hero-state="idle"');
    expect(idleMarkup).toContain('按 Alt+Shift+M 捕获');
    expect(draftMarkup).toContain('data-companion-hero-state="reviewing"');
    expect(draftMarkup).toContain('整理这个 Moment');
    // The hero head wears today's outfit; the state only picks the expression.
    const idleHead = new DOMParser()
      .parseFromString(idleMarkup, 'text/html')
      .querySelector('.companion-hero img');
    expect(idleHead?.getAttribute('data-companion-pose')).toBe('head-smile');
    expect(idleHead?.getAttribute('src')).toBe(
      companionArtPath(outfitForDate(localDateKey(new Date())), 'head-smile', 'animated'),
    );
    expect(draftMarkup).toContain('data-companion-pose="head-talk"');
    const draftDocument = new DOMParser().parseFromString(draftMarkup, 'text/html');
    expect(draftDocument.querySelector('.companion-hero')?.textContent).not.toContain(
      'Bilibili · 00:42',
    );
    expect(draftDocument.body.textContent?.match(/Bilibili · 00:42/g)).toHaveLength(1);
    expect(errorMarkup).toContain('无法捕获');
    expect(draftMarkup.indexOf('companion-hero')).toBeLessThan(draftMarkup.indexOf('card stack'));
  });

  it('shows a genuine capture-processing state without flashing the whole panel', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp initialPending={null} initialLoadingCapture loadDueCount={async () => 0} />,
    );

    expect(markup).toContain('data-companion-hero-state="reviewing"');
    expect(markup).toContain('正在捕获时刻');
    expect(markup).toContain('motion-loading-indicator');
    expect(markup).not.toContain('skeleton');
    expect(markup).not.toContain('camera-flash');
  });

  it('reveals screenshot arrival and a stable timestamp with no progress steps', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: true,
          draft: {
            ...captureDraft,
            videoTitle:
              'A very long captured title that must wrap without covering the screenshot or save controls',
            screenshotDataUrl: 'data:image/png;base64,AA==',
          },
        }}
      />,
    );

    expect(markup).toContain('capture-screenshot motion-reveal');
    expect(markup).toContain('来源上下文：捕获自 Bilibili · 00:42');
    const rendered = new DOMParser().parseFromString(markup, 'text/html');
    expect(rendered.querySelector('.capture-screenshot')?.closest('details')).toBeNull();
    expect(rendered.querySelectorAll('.capture-screenshot')).toHaveLength(1);
    expect(markup).not.toContain('Moment captured');
    expect(markup).not.toContain('记忆线索');
    expect(markup).not.toContain('data-step-state');
    expect(markup).toContain('motion-press');
  });

  it('keeps capture errors stable and returns the Companion to idle or due presentation', () => {
    const markup = renderToStaticMarkup(
      <SidePanelApp
        initialPending={{
          ok: false,
          error: { code: 'CAPTURE_FAILED', message: 'No visible video was found.' },
        }}
        loadDueCount={async () => 0}
      />,
    );

    expect(markup).toContain('data-companion-hero-state="idle"');
    expect(markup).toContain('card motion-state-change');
    expect(markup).toContain('No visible video was found.');
    expect(markup).not.toContain('shake');
    expect(markup).not.toContain('pulse');
  });

  it('persists only on Save and returns success to due state', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const persistItem = vi.fn(async () => undefined);
    const dismissCapture = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            initialPending={{
              ok: true,
              draft: {
                ...captureDraft,
                screenshotDataUrl: 'data:image/png;base64,AA==',
                subtitleBefore: ['Source context before.'],
                subtitleCurrent: ['Source context current.'],
                subtitleAfter: ['Source context after.'],
                subtitleStatus: 'timed_context',
                subtitleExtractionStrategy: 'text_track_timed_cues',
                subtitleConfidence: 'high',
              },
            }}
            loadDueCount={async () => 0}
            loadCategories={async () => []}
            successDurationMs={1000}
            persistItem={persistItem}
            createInitialCard={() => createEmptyCard(new Date('2026-07-24T12:00:00.000Z'))}
            convertScreenshot={async () => new Blob(['image'], { type: 'image/png' })}
            dismissCapture={dismissCapture}
            recordCaptureAllowance={async () => applyCaptureReward(DEFAULT_ALLOWANCE, '2026-07-24')}
          />,
        );
        await Promise.resolve();
      });

      expect(persistItem).not.toHaveBeenCalled();
      const note = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea');
      await act(async () => {
        if (!note) throw new Error('Expected the 关键收获 field.');
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        valueSetter?.call(note, 'Hold the angle before using utility.');
        note.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(persistItem).not.toHaveBeenCalled();

      const recallPrompt = labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea');
      expect(recallPrompt?.value).toBe(
        'What principle or explanation should you remember from this moment?',
      );
      expect(container.textContent).not.toContain('Reference answer');

      const saveButton = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('保存回忆题'),
      );
      await act(async () => {
        saveButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(persistItem).toHaveBeenCalledOnce();
      expect(persistItem).toHaveBeenCalledWith(
        expect.objectContaining({
          coreLesson: 'Hold the angle before using utility.',
          personalNote: '',
          categoryId: null,
          recallPrompt: 'What principle or explanation should you remember from this moment?',
          referenceAnswer: 'Hold the angle before using utility.',
          reason: '',
          subtitleBefore: ['Source context before.'],
          subtitleCurrent: ['Source context current.'],
          subtitleAfter: ['Source context after.'],
        }),
        expect.any(Blob),
      );
      expect(dismissCapture).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('捕获已保存');
      expect(container.textContent).toBeTruthy();
      expect(container.textContent).toContain('零花钱 +7 元');
      expect(container.querySelector('.capture-save-receipt')).not.toBeNull();
      expect(
        container.querySelector('.companion-hero')?.getAttribute('data-companion-hero-state'),
      ).toBe('success');

      await act(async () => vi.advanceTimersByTime(1000));
      expect(container.querySelector('.capture-save-receipt')).not.toBeNull();
      expect(buttonByText(container, '在资料库查看')).toBeDefined();
      expect(
        container.querySelector('.companion-hero')?.getAttribute('data-companion-hero-state'),
      ).toBe('due');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('preserves the exact edited prompt through Category and metadata changes when saving', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const persistItem = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            initialPending={{
              ok: true,
              draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
            }}
            loadDueCount={async () => 0}
            loadCategories={async () => [valorantCategory]}
            persistItem={persistItem}
            createInitialCard={() => createEmptyCard(new Date('2026-08-03T12:00:00.000Z'))}
            convertScreenshot={async () => new Blob(['image'], { type: 'image/png' })}
            dismissCapture={async () => undefined}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      const prompt = labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea');
      const takeaway = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea');
      const title = labelledControl<HTMLInputElement>(container, '视频标题', 'input');
      const category = labelledControl<HTMLSelectElement>(container, '分类', 'select');
      expect(prompt?.value).toBe(
        'What principle or explanation should you remember from this moment?',
      );

      await act(async () => {
        if (!prompt || !takeaway || !title || !category) {
          throw new Error('Expected editable Capture controls.');
        }
        setNativeValue(prompt, '  Which angle should I hold?\nKeep my spacing.  ');
        setNativeValue(takeaway, 'Hold the angle before using utility.');
        setNativeValue(title, 'Updated platform metadata title');
        category.value = valorantCategory.id;
        category.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(prompt?.value).toBe('  Which angle should I hold?\nKeep my spacing.  ');
      await act(async () => {
        buttonByText(container, '保存回忆题')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(persistItem).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: valorantCategory.id,
          videoTitle: 'Updated platform metadata title',
          recallPrompt: '  Which angle should I hold?\nKeep my spacing.  ',
        }),
        expect.any(Blob),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('blocks saving when either canonical Capture field is empty', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const persistItem = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            initialPending={{
              ok: true,
              draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
            }}
            loadDueCount={async () => 0}
            loadCategories={async () => []}
            persistItem={persistItem}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      const prompt = labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea');
      const takeaway = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea');
      await act(async () => {
        buttonByText(container, '保存回忆题')?.click();
        await Promise.resolve();
      });
      expect(persistItem).not.toHaveBeenCalled();
      expect(container.textContent).toContain('保存前请用自己的话写下关键收获。');

      await act(async () => {
        if (!prompt || !takeaway) throw new Error('Expected editable Capture fields.');
        setNativeValue(takeaway, 'Hold the angle before using utility.');
        setNativeValue(prompt, '  \n  ');
        buttonByText(container, '保存回忆题')?.click();
        await Promise.resolve();
      });

      expect(persistItem).not.toHaveBeenCalled();
      expect(container.textContent).toContain('保存前请填写回忆提示。');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('protects edits from rerenders and delayed generation while regeneration stays explicit', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const realGenerator = new RuleBasedLearningItemGenerator();
    let nextGate: Promise<void> | null = null;
    const generateLearningItem = vi.fn(
      async (input: LearningItemGenerationInput): Promise<LearningItemGenerationResult> => {
        const gate = nextGate;
        nextGate = null;
        if (gate) await gate;
        return realGenerator.generate(input);
      },
    );
    const baseProps = {
      initialPending: {
        ok: true as const,
        draft: {
          ...captureDraft,
          screenshotDataUrl: 'data:image/png;base64,AA==',
          subtitleCurrent: ['Nearby evidence must not replace an authored prompt.'],
          subtitleStatus: 'current_only' as const,
          subtitleExtractionStrategy: 'visible_video_overlay' as const,
          subtitleConfidence: 'medium' as const,
        },
      },
      loadDueCount: async () => 0,
      loadCategories: async () => [valorantCategory],
      generateLearningItem,
    };

    try {
      await act(async () => {
        root.render(<SidePanelApp {...baseProps} />);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      const prompt = labelledControl<HTMLTextAreaElement>(container, '问题', 'textarea');
      const title = labelledControl<HTMLInputElement>(container, '视频标题', 'input');
      expect(prompt?.value).toBe(
        'What principle or explanation should you remember from this moment?',
      );
      await act(async () => {
        if (!prompt) throw new Error('Expected the Recall prompt field.');
        setNativeValue(prompt, 'My durable prompt');
        root.render(<SidePanelApp {...baseProps} />);
      });
      expect(prompt?.value).toBe('My durable prompt');

      let releaseAutomatic: () => void = () => undefined;
      nextGate = new Promise<void>((resolve) => {
        releaseAutomatic = resolve;
      });
      await act(async () => {
        if (!title || !prompt) throw new Error('Expected Capture metadata and prompt fields.');
        setNativeValue(title, 'Metadata arrived later');
        await vi.advanceTimersByTimeAsync(200);
        setNativeValue(prompt, 'Edited while generation was pending');
      });
      await act(async () => {
        releaseAutomatic();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(prompt?.value).toBe('Edited while generation was pending');

      let releaseRegeneration: () => void = () => undefined;
      nextGate = new Promise<void>((resolve) => {
        releaseRegeneration = resolve;
      });
      await act(async () => {
        buttonByText(container, '重新生成问题')?.click();
        await Promise.resolve();
        if (!prompt) throw new Error('Expected the Recall prompt field.');
        setNativeValue(prompt, 'Newer edit after Regenerate');
      });
      await act(async () => {
        releaseRegeneration();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(prompt?.value).toBe('Newer edit after Regenerate');
      expect(container.querySelector('.capture-prompt-actions [role="status"]')?.className).toBe(
        'muted',
      );
      expect(container.textContent).toContain('你改过问题，未替换。');

      await act(async () => {
        buttonByText(container, '重新生成问题')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(prompt?.value).toBe(
        'What principle or explanation should you remember from this moment?',
      );
      // Said to screen readers only: the question changing in place says the same on screen.
      expect(container.querySelector('.capture-prompt-actions [role="status"]')?.className).toBe(
        'sr-only',
      );
      expect(container.textContent).toContain('回忆提示已重新生成。');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('keeps the visible note when a capture changes during regeneration', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const realGenerator = new RuleBasedLearningItemGenerator();
    let gate: Promise<void> | null = null;
    const generateLearningItem = vi.fn(async (input: LearningItemGenerationInput) => {
      const waiting = gate;
      gate = null;
      if (waiting) await waiting;
      return realGenerator.generate(input);
    });
    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            initialPending={{
              ok: true,
              draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
            }}
            loadDueCount={async () => 0}
            loadCategories={async () => []}
            generateLearningItem={generateLearningItem}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await act(async () => {
        buttonByText(container, '重新生成问题')?.click();
        await Promise.resolve();
        setNativeValue(
          labelledControl<HTMLInputElement>(container, '视频标题', 'input')!,
          '新标题',
        );
      });
      await act(async () => {
        release();
        await Promise.resolve();
        await Promise.resolve();
      });
      const status = container.querySelector('.capture-prompt-actions [role="status"]');
      expect(status?.textContent).toBe('捕获已更新，问题未替换。');
      expect(status?.className).toBe('muted');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('opens a new capture with no warning and tells the idle panel what is due', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const props = { loadCategories: async () => [] };
    const heroCopy = () => container.querySelector('.companion-hero-copy');
    try {
      await act(async () => {
        root.render(
          <SidePanelApp
            {...props}
            initialPending={{
              ok: true,
              draft: { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' },
            }}
            loadDueCount={async () => 3}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(container.querySelector('.capture-question-editor .notice')).toBeNull();
      expect(container.textContent).not.toContain('还没有填写关键收获');
      expect(heroCopy()?.textContent).toBe('整理这个 Moment');
      await act(async () => root.unmount());
    } finally {
      vi.useRealTimers();
    }
    const idleRoot = createRoot(container);
    try {
      await act(async () =>
        idleRoot.render(
          <SidePanelApp {...props} initialPending={null} loadDueCount={async () => 3} />,
        ),
      );
      expect(heroCopy()?.querySelector('h2')?.textContent).toBe('按 Alt+Shift+M 捕获');
      expect(heroCopy()?.querySelector('p')?.textContent).toBe('今天有 3 条复习可以开始。');
      expect(buttonByText(container, '打开学习面板')).toBeDefined();
      expect(container.querySelector('.empty-state')).toBeNull();
      await act(async () =>
        idleRoot.render(
          <SidePanelApp {...props} initialPending={null} loadDueCount={async () => 0} />,
        ),
      );
      expect(heroCopy()?.querySelector('p')).toBeNull();
    } finally {
      await act(async () => idleRoot.unmount());
      container.remove();
    }
  });

  describe('what the background answers when the panel opens', () => {
    const NOTHING_PENDING = '还没有待整理的捕获，请再按一次快捷键。';
    async function open(response: unknown) {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      vi.stubGlobal('chrome', {
        runtime: {
          id: 'test',
          sendMessage: vi.fn(async () => response),
          onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      });
      await act(async () =>
        root.render(<SidePanelApp loadDueCount={async () => 2} loadCategories={async () => []} />),
      );
      return {
        container,
        close: async () => {
          await act(async () => root.unmount());
          container.remove();
          vi.unstubAllGlobals();
        },
      };
    }

    it('keeps the wording the idle check depends on in the background', () => {
      expect(readFileSync(resolve('src/background/index.ts'), 'utf8')).toContain(NOTHING_PENDING);
    });

    it('shows the idle panel, not an error, when nothing is waiting', async () => {
      const { container, close } = await open({
        ok: false,
        error: { code: 'CAPTURE_FAILED', message: NOTHING_PENDING },
      });
      try {
        expect(container.querySelector('.companion-hero h2')?.textContent).toBe(
          '按 Alt+Shift+M 捕获',
        );
        expect(container.querySelector('.companion-hero p')?.textContent).toBe(
          '今天有 2 条复习可以开始。',
        );
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).not.toContain(NOTHING_PENDING);
        expect(buttonByText(container, '打开学习面板')).toBeDefined();
      } finally {
        await close();
      }
    });

    it('still reports a real capture failure', async () => {
      const { container, close } = await open({
        ok: false,
        error: { code: 'UNSUPPORTED_PAGE', message: '这个页面不支持捕获。' },
      });
      try {
        expect(container.querySelector('.companion-hero h2')?.textContent).toBe('无法捕获');
        expect(container.querySelector('.companion-hero p')).toBeNull();
        expect(container.querySelector('.card h2')?.textContent).toBe('不支持的页面');
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('这个页面不支持捕获。');
        expect(container.querySelector('.card .eyebrow')).toBeNull();
      } finally {
        await close();
      }
    });
  });

  it('does not let a late initialization overwrite a newer capture event', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    let resolve!: (value: unknown) => void;
    let listener!: (value: unknown) => void;
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: vi.fn(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        ),
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    try {
      await act(async () =>
        root.render(<SidePanelApp loadDueCount={async () => 0} loadCategories={async () => []} />),
      );
      await act(async () =>
        listener({
          type: MESSAGE_TYPES.pendingCaptureChanged,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: {
            ok: true,
            draft: { ...captureDraft, draftId: 'new', videoTitle: 'New capture' },
          },
        }),
      );
      await act(async () => resolve({ ok: true, draft: captureDraft }));
      expect(labelledControl<HTMLInputElement>(host, '视频标题', 'input')?.value).toBe(
        'New capture',
      );
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('saves one fixed draft and keeps a newer capture received while persistence is pending', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const root = createRoot(host);
    const oldDraft = { ...captureDraft, screenshotDataUrl: 'data:image/png;base64,AA==' };
    let resolve!: () => void;
    let listener!: (value: unknown) => void;
    const persist = vi.fn<(item: NewVideoLearningItem, screenshot: Blob) => Promise<void>>(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const dismiss = vi.fn().mockResolvedValue(undefined);
    const reward = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: vi.fn(async (message) =>
          message.type === MESSAGE_TYPES.getPendingCapture
            ? { ok: true, draft: oldDraft }
            : { ok: true },
        ),
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    try {
      await act(async () =>
        root.render(
          <SidePanelApp
            initialPending={{ ok: true, draft: oldDraft }}
            loadDueCount={async () => 0}
            loadCategories={async () => []}
            persistItem={persist}
            dismissCapture={dismiss}
            recordCaptureAllowance={reward}
            convertScreenshot={async () => new Blob(['test'])}
          />,
        ),
      );
      await act(async () =>
        setNativeValue(
          labelledControl<HTMLTextAreaElement>(host, '答案要点', 'textarea')!,
          'An answer to remember.',
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await act(async () => {
        const save = buttonByText(host, '保存回忆题')!;
        save.click();
        save.click();
      });
      expect(persist).toHaveBeenCalledOnce();
      await act(async () =>
        listener({
          type: MESSAGE_TYPES.pendingCaptureChanged,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: {
            ok: true,
            draft: { ...oldDraft, draftId: 'next-capture', videoTitle: 'Next capture' },
          },
        }),
      );
      await act(async () => resolve());
      expect(persist.mock.calls[0]?.[0]).toMatchObject({
        id: oldDraft.draftId,
        videoTitle: oldDraft.videoTitle,
        coreLesson: 'An answer to remember.',
      });
      expect(labelledControl<HTMLInputElement>(host, '视频标题', 'input')?.value).toBe(
        'Next capture',
      );
      expect(dismiss).not.toHaveBeenCalled();
      expect(reward).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    'does not award conflicts and requires verification (%s) before showing saved',
    async (verified) => {
      vi.useFakeTimers();
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const persistItem = vi.fn(async () => {
        throw new DatabaseError('CONFLICT', 'Already saved.');
      });
      const recordCaptureAllowance = vi.fn(async () => ({
        state: {
          ...DEFAULT_ALLOWANCE,
          balance: 2,
          totalEarned: 2,
          lastCapturePraiseIndex: 1,
        },
        captureReward: 2 as const,
        checkIn: false,
        checkInReward: 0,
        praise: '你又抓住一个 Moment 了，真厉害～',
        checkInPraise: null,
      }));

      try {
        await act(async () => {
          root.render(
            <SidePanelApp
              initialPending={{
                ok: true,
                draft: {
                  ...captureDraft,
                  screenshotDataUrl: 'data:image/png;base64,AA==',
                },
              }}
              loadDueCount={async () => 0}
              loadCategories={async () => []}
              successDurationMs={1000}
              persistItem={persistItem}
              recordCaptureAllowance={recordCaptureAllowance}
              verifySavedCapture={async () => verified}
              createInitialCard={() => createEmptyCard(new Date('2026-07-24T12:00:00.000Z'))}
              convertScreenshot={async () => new Blob(['image'], { type: 'image/png' })}
              dismissCapture={async () => undefined}
            />,
          );
          await Promise.resolve();
        });

        const note = labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea');
        await act(async () => {
          if (!note) throw new Error('Expected the 关键收获 field.');
          setNativeValue(note, 'Hold the angle before using utility.');
          await Promise.resolve();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        await act(async () => {
          buttonByText(container, '保存回忆题')?.click();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(persistItem).toHaveBeenCalledOnce();
        expect(recordCaptureAllowance).not.toHaveBeenCalled();
        if (verified) expect(container.textContent).toContain('这次捕获已保存过。');
        else {
          expect(container.textContent).not.toContain('这次捕获已保存过。');
          expect(
            labelledControl<HTMLTextAreaElement>(container, '答案要点', 'textarea')?.value,
          ).toBe('Hold the angle before using utility.');
        }
        expect(container.textContent).not.toContain('+2 零花钱');
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
      }
    },
  );
});

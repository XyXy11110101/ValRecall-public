import { afterEach, describe, expect, it, vi } from 'vitest';

import { CAPTURE_COMMAND } from '../background/routing';
import {
  captureStatusText,
  lastReadCaptureShortcut,
  libraryEmptyHint,
  openShortcutSettings,
  readCaptureShortcut,
} from './shortcut';

const commands = (shortcut: string) => ({
  getAll: async () => [
    { name: '_execute_action', shortcut: 'Ctrl+Q' },
    { name: CAPTURE_COMMAND, shortcut },
  ],
});

describe('readCaptureShortcut', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the key of the capture command and keeps it for later wording', async () => {
    await expect(readCaptureShortcut(commands('Ctrl+Shift+Y'))).resolves.toBe('Ctrl+Shift+Y');
    expect(lastReadCaptureShortcut()).toBe('Ctrl+Shift+Y');
  });

  it('tells an empty key apart from a failed read', async () => {
    await expect(readCaptureShortcut(commands(''))).resolves.toBeNull();
    await expect(
      readCaptureShortcut({ getAll: () => Promise.reject(new Error('no')) }),
    ).resolves.toBeUndefined();
    await expect(readCaptureShortcut({ getAll: async () => [] })).resolves.toBeUndefined();
    await expect(readCaptureShortcut()).resolves.toBeUndefined();
  });

  it('opens the browser shortcut page', () => {
    const create = vi.fn().mockResolvedValue({});
    vi.stubGlobal('chrome', { tabs: { create } });
    openShortcutSettings();
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: 'edge://extensions/shortcuts' });
  });
});

describe('shortcut wording', () => {
  it('uses the real key, says when there is none, and never guesses', () => {
    expect(captureStatusText('Ctrl+Y')).toBe('按 Ctrl+Y 捕获');
    expect(captureStatusText(null)).toBe('还没有设置捕获快捷键');
    expect(captureStatusText(undefined)).toBe('按快捷键捕获');
    expect(libraryEmptyHint('Ctrl+Y')).toBe('点「添加回忆题」，或在视频里按 Ctrl+Y。');
    expect(libraryEmptyHint(null)).toBe('点「添加回忆题」。想在视频里捕获，要先设置快捷键。');
    expect(libraryEmptyHint(undefined)).toBe('点「添加回忆题」，或在视频里按快捷键。');
  });
});

import { useEffect, useState } from 'react';

const CAPTURE_COMMAND_NAME = 'capture-learning-moment';
const SHORTCUT_SETTINGS_URL = 'edge://extensions/shortcuts';

/** A key as the browser shows it. Null: no key is set. Undefined: not read, or it could not be. */
export type CaptureShortcut = string | null | undefined;

export interface CommandsReader {
  getAll(): Promise<ReadonlyArray<{ name?: string | undefined; shortcut?: string | undefined }>>;
}

let lastRead: CaptureShortcut;

export async function readCaptureShortcut(commands?: CommandsReader): Promise<CaptureShortcut> {
  const reader = commands ?? (typeof chrome === 'undefined' ? undefined : chrome.commands);
  try {
    if (!reader) throw new Error('No commands API here.');
    const command = (await reader.getAll()).find((entry) => entry.name === CAPTURE_COMMAND_NAME);
    lastRead = command ? command.shortcut || null : undefined;
  } catch {
    lastRead = undefined;
  }
  return lastRead;
}

/** The latest key, for wording built outside a component. Pair with useCaptureShortcut. */
export function lastReadCaptureShortcut(): CaptureShortcut {
  return lastRead;
}

/** Reads again on return, as the key is set on another page. */
export function useCaptureShortcut(): CaptureShortcut {
  const [shortcut, setShortcut] = useState<CaptureShortcut>(lastRead);
  useEffect(() => {
    let latest = 0;
    const read = () => {
      const current = ++latest;
      void readCaptureShortcut().then((value) => {
        if (current === latest) setShortcut(value);
      });
    };
    const refresh = () => {
      if (document.visibilityState !== 'hidden') read();
    };
    read();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      latest = -1;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return shortcut;
}

export function openShortcutSettings(): void {
  void chrome.tabs
    .create({ url: SHORTCUT_SETTINGS_URL })
    .catch((error: unknown) =>
      console.warn('[ValRecall] Shortcut settings could not be opened.', error),
    );
}

export function captureStatusText(shortcut: CaptureShortcut): string {
  if (shortcut === null) return '还没有设置捕获快捷键';
  return shortcut ? `按 ${shortcut} 捕获` : '按快捷键捕获';
}

export function libraryEmptyHint(shortcut: CaptureShortcut): string {
  if (shortcut === null) return '点「添加回忆题」。想在视频里捕获，要先设置快捷键。';
  return `点「添加回忆题」，或在视频里按${shortcut ? ` ${shortcut}` : '快捷键'}。`;
}

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKING_CARD,
  WORKING_CARD_STORAGE_KEY,
  putDownWork,
  startWork,
} from '../models/working-card';
import { useWorkingCard, type WorkingCardValue } from './use-working-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function fakeChrome(stored: Record<string, unknown> = {}) {
  const values = { ...stored };
  const listeners = new Set<Listener>();
  const local = {
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(values, items)),
    remove: vi.fn(async () => undefined),
  };
  vi.stubGlobal('chrome', {
    storage: {
      local,
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  });
  return {
    values,
    local,
    listeners,
    emit: (newValue: unknown, area = 'local', key = WORKING_CARD_STORAGE_KEY) => {
      for (const listener of listeners) listener({ [key]: { newValue } }, area);
    },
  };
}

describe('useWorkingCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: WorkingCardValue;

  function Probe() {
    latest = useWorkingCard();
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const mount = () => act(async () => root.render(<Probe />));

  it('reads the stored state and only then reports ready', async () => {
    const stored = { version: 1, current: { taskId: 'a', startedOn: '2026-10-30' } };
    fakeChrome({ [WORKING_CARD_STORAGE_KEY]: stored });
    await act(async () => {
      root.render(<Probe />);
      expect(latest?.ready ?? false).toBe(false);
    });
    expect(latest.ready).toBe(true);
    expect(latest.state.current?.taskId).toBe('a');
  });

  it('is ready with defaults when the read fails or chrome has no storage', async () => {
    const chromeApi = fakeChrome();
    chromeApi.local.get.mockRejectedValue(new Error('denied'));
    await mount();
    expect(latest.ready).toBe(true);
    expect(latest.state.current).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.stubGlobal('chrome', {});
    await mount();
    expect(latest.ready).toBe(true);
    await act(async () => latest.update((state) => startWork(state, 'a', '2026-10-30', 0)));
    expect(latest.state.current?.taskId).toBe('a');
  });

  it('never writes defaults over the real record after a failed first read', async () => {
    const trial = { startedOn: '2026-10-20', openOneOffsAtStart: 12, starts: 9 };
    const notes = [{ taskId: 'n', text: 'keep me', date: '2026-10-29' }];
    const chromeApi = fakeChrome({ [WORKING_CARD_STORAGE_KEY]: { version: 1, notes, trial } });
    chromeApi.local.get.mockRejectedValueOnce(new Error('busy'));
    await mount();
    expect(latest.ready).toBe(true);
    expect(latest.state.trial).toBeNull();
    await act(async () => latest.update((state) => startWork(state, 'a', '2026-10-30', 0)));
    expect(chromeApi.values[WORKING_CARD_STORAGE_KEY]).toMatchObject({
      notes,
      trial: { ...trial, starts: 10 },
      current: { taskId: 'a' },
    });
  });

  it('does not write when the record still cannot be read', async () => {
    const chromeApi = fakeChrome();
    chromeApi.local.get.mockRejectedValue(new Error('denied'));
    await mount();
    let failure: unknown;
    await act(async () => {
      await latest
        .update((state) => startWork(state, 'a', '2026-10-30', 0))
        .catch((error: unknown) => {
          failure = error;
        });
    });
    expect(failure).toBeInstanceOf(Error);
    expect(chromeApi.local.set).not.toHaveBeenCalled();
  });

  it('applies writes in order from the latest state', async () => {
    const chromeApi = fakeChrome();
    await mount();
    await act(async () => {
      void latest.update((state) => startWork(state, 'a', '2026-10-30', 3));
      void latest.update((state) => startWork(state, 'b', '2026-10-30', 3));
    });
    expect(latest.state.current?.taskId).toBe('b');
    expect(latest.state.trial).toEqual({
      startedOn: '2026-10-30',
      openOneOffsAtStart: 3,
      starts: 2,
    });
    expect(chromeApi.values[WORKING_CARD_STORAGE_KEY]).toEqual(latest.state);
  });

  it('skips the write when nothing changed', async () => {
    const chromeApi = fakeChrome();
    await mount();
    await act(async () => latest.update((state) => putDownWork(state, '2026-10-30')));
    expect(chromeApi.local.set).not.toHaveBeenCalled();
  });

  it('rejects a failed write, keeps the state, and the next write still runs', async () => {
    const chromeApi = fakeChrome();
    await mount();
    chromeApi.local.set.mockRejectedValueOnce(new Error('quota'));
    let failure: unknown;
    await act(async () => {
      await latest
        .update((state) => startWork(state, 'a', '2026-10-30', 0))
        .catch((error: unknown) => {
          failure = error;
        });
    });
    expect(failure).toBeInstanceOf(Error);
    expect(latest.state.current).toBeNull();
    await act(async () => latest.update((state) => startWork(state, 'b', '2026-10-30', 0)));
    expect(latest.state.current?.taskId).toBe('b');
  });

  it('follows changes from other pages, ignores other keys and areas, and stops on unmount', async () => {
    const chromeApi = fakeChrome();
    await mount();
    const other = { version: 1, current: { taskId: 'other', startedOn: '2026-10-30' } };
    act(() => chromeApi.emit(other, 'sync'));
    act(() => chromeApi.emit(other, 'local', 'valrecall.preferences'));
    expect(latest.state.current).toBeNull();
    act(() => chromeApi.emit(other));
    expect(latest.state.current?.taskId).toBe('other');
    act(() => chromeApi.emit(undefined));
    expect(latest.state).toEqual({ ...DEFAULT_WORKING_CARD, notes: [] });
    await act(async () => root.unmount());
    expect(chromeApi.listeners.size).toBe(0);
    root = createRoot(container);
  });

  it('a change that arrives during the first read wins over that read', async () => {
    const chromeApi = fakeChrome();
    let finishRead: (value: Record<string, unknown>) => void = () => undefined;
    chromeApi.local.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await mount();
    const newer = { version: 1, current: { taskId: 'newer', startedOn: '2026-10-30' } };
    act(() => chromeApi.emit(newer));
    await act(async () => finishRead({}));
    expect(latest.state.current?.taskId).toBe('newer');
  });
});

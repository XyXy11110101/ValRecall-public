import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileAutoSync, type AutoSyncResult } from './auto-sync';

describe('event-driven foreground sync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('does not poll during ten idle minutes; edits still coalesce', async () => {
    const run = vi.fn(async (): Promise<AutoSyncResult> => 'ok');
    const auto = new MobileAutoSync(run, () => true);
    auto.trigger();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run.mock.calls).toEqual([['check']]);
    for (let i = 0; i < 5; i++) {
      auto.changed();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(run).toHaveBeenLastCalledWith('sync');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(2);
    auto.dispose();
  });
  it('coalesces events for one second without swallowing manual sync or edits', async () => {
    const run = vi.fn(async (): Promise<AutoSyncResult> => 'ok');
    const auto = new MobileAutoSync(run, () => true);
    auto.trigger();
    await vi.advanceTimersByTimeAsync(200);
    auto.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    auto.trigger(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenLastCalledWith('sync');
    auto.changed();
    await vi.advanceTimersByTimeAsync(600);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    auto.trigger();
    expect(run).toHaveBeenCalledTimes(4);
    auto.dispose();
  });
  it.each(['retry', 'legacy-retry'] as const)(
    'retries %s only at 5 and 15 seconds, then waits',
    async (result) => {
      const run = vi.fn(async (): Promise<AutoSyncResult> => result);
      const auto = new MobileAutoSync(run, () => true);
      auto.trigger();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600_001);
      expect(run).toHaveBeenCalledTimes(3);
      run.mockResolvedValue('ok');
      auto.changed();
      await vi.advanceTimersByTimeAsync(600);
      expect(run).toHaveBeenCalledTimes(4);
      auto.dispose();
    },
  );
  it('never overlaps and follows up changes made in flight', async () => {
    let finish!: (value: AutoSyncResult) => void;
    const run = vi.fn(
      () =>
        new Promise<AutoSyncResult>((resolve) => {
          finish = resolve;
        }),
    );
    const auto = new MobileAutoSync(run, () => true);
    auto.trigger();
    auto.trigger(true);
    auto.changed();
    auto.changed();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish('ok');
    await vi.advanceTimersByTimeAsync(600);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith('sync');
    finish('ok');
    auto.dispose();
  });
  it('stops hidden/offline retries and resumes even within one second', async () => {
    let allowed = true;
    const run = vi.fn(async (): Promise<AutoSyncResult> => 'retry');
    const auto = new MobileAutoSync(run, () => allowed);
    auto.trigger();
    await vi.advanceTimersByTimeAsync(50);
    allowed = false;
    auto.suspend();
    await vi.advanceTimersByTimeAsync(50);
    allowed = true;
    auto.trigger();
    expect(run).toHaveBeenCalledTimes(2);
    allowed = false;
    auto.suspend();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(2);
    auto.dispose();
  });
  it('stops identity/data failures until explicit recovery and ignores disposal', async () => {
    const run = vi.fn(async (): Promise<AutoSyncResult> => 'stop');
    const auto = new MobileAutoSync(run, () => true);
    auto.trigger();
    await vi.advanceTimersByTimeAsync(10);
    auto.trigger();
    auto.changed();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    auto.trigger(true);
    expect(run).toHaveBeenCalledTimes(2);
    auto.dispose();
    auto.trigger(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

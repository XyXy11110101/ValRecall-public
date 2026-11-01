import { describe, expect, it, vi } from 'vitest';
import type { nativeRequest } from './bridge';
import { readWidgetNavigation, WidgetPublisher } from './widget-bridge';
import { unavailableWidgetProjection } from './widget-projection';

const clock = new Date('2026-10-26T12:00:00Z');
const target = {
  version: 1,
  id: 'intent-1',
  kind: 'task',
  epoch: 'epoch-1',
  taskId: 'task-1',
  occurrenceDate: '2026-10-26',
};

describe('widget navigation boundary', () => {
  it('accepts only known destinations and valid occurrence identity', () => {
    expect(readWidgetNavigation(target)).toEqual(target);
    expect(
      readWidgetNavigation({
        ...target,
        kind: 'add-task',
        epoch: null,
        taskId: null,
        occurrenceDate: null,
      })?.kind,
    ).toBe('add-task');
    for (const value of [
      null,
      {},
      { ...target, url: 'https://example.org' },
      { ...target, kind: 'delete' },
      { ...target, epoch: null },
      { ...target, occurrenceDate: '2026-02-31' },
      { ...target, kind: 'tasks' },
      { ...target, taskId: 'x'.repeat(513) },
    ]) {
      expect(readWidgetNavigation(value)).toBeNull();
    }
  });
  it('preserves opaque task identities accepted by existing synced snapshots', () => {
    const value = { ...target, taskId: '学习:第1章/任务' };
    expect(readWidgetNavigation(value)).toEqual(value);
    expect(readWidgetNavigation({ ...target, taskId: '课'.repeat(512) })?.taskId).toHaveLength(512);
  });
});

describe('ordered widget publication', () => {
  it('keeps one active write and replaces intermediate snapshots with the latest', async () => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const native = vi.fn<typeof nativeRequest>().mockReturnValueOnce(first).mockResolvedValue({});
    const publisher = new WidgetPublisher(native);
    const before = unavailableWidgetProjection('not-ready', clock);
    const intermediate = unavailableWidgetProjection('read-error', clock);
    const after = unavailableWidgetProjection('workspace-changed', clock);
    publisher.publish(before);
    publisher.publish(intermediate);
    publisher.publish(after);
    expect(native).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await Promise.resolve();
    expect(native).toHaveBeenCalledTimes(2);
    expect(native).toHaveBeenNthCalledWith(2, 'widget.publish', { sequence: 2, projection: after });
    publisher.dispose();
  });

  it('does not retry in a loop after failure, but accepts the next state event', async () => {
    const native = vi
      .fn<typeof nativeRequest>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue({});
    const publisher = new WidgetPublisher(native);
    const projection = unavailableWidgetProjection('not-ready', clock);
    publisher.publish(projection);
    await Promise.resolve();
    await Promise.resolve();
    expect(native).toHaveBeenCalledTimes(1);
    publisher.publish(projection);
    expect(native).toHaveBeenCalledTimes(2);
    publisher.dispose();
  });

  it('drops queued publications after unmount without touching business data', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const native = vi.fn<typeof nativeRequest>().mockReturnValue(waiting);
    const publisher = new WidgetPublisher(native);
    publisher.publish(unavailableWidgetProjection('not-ready', clock));
    publisher.publish(unavailableWidgetProjection('read-error', clock));
    publisher.dispose();
    finish();
    await waiting;
    publisher.publish(unavailableWidgetProjection('workspace-changed', clock));
    expect(native).toHaveBeenCalledTimes(1);
  });
});

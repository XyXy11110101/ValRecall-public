import { isRecord } from '../sync/protocol';
import type { nativeRequest } from './bridge';
import type { WidgetProjection } from './widget-projection';

export interface WidgetNavigation {
  version: 1;
  id: string;
  kind: 'tasks' | 'task' | 'add-task';
  epoch: string | null;
  taskId: string | null;
  occurrenceDate: string | null;
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function readWidgetNavigation(value: unknown): WidgetNavigation | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'epoch,id,kind,occurrenceDate,taskId,version' ||
    value.version !== 1 ||
    !identifier(value.id) ||
    !['tasks', 'task', 'add-task'].includes(String(value.kind))
  )
    return null;
  if (value.kind === 'task') {
    if (
      !identifier(value.epoch) ||
      typeof value.taskId !== 'string' ||
      !value.taskId.trim() ||
      value.taskId.length > 512 ||
      typeof value.occurrenceDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.occurrenceDate) ||
      !Number.isFinite(Date.parse(value.occurrenceDate + 'T12:00:00Z')) ||
      new Date(value.occurrenceDate + 'T12:00:00Z').toISOString().slice(0, 10) !==
        value.occurrenceDate
    )
      return null;
  } else if (value.epoch !== null || value.taskId !== null || value.occurrenceDate !== null)
    return null;
  return value as unknown as WidgetNavigation;
}

/** One in-flight write; intermediate renders are replaced by the latest committed view. */
export class WidgetPublisher {
  private sequence = 0;
  private pending: WidgetProjection | null = null;
  private running = false;
  private disposed = false;
  constructor(private readonly native: typeof nativeRequest) {}

  publish(projection: WidgetProjection) {
    if (this.disposed) return;
    this.pending = projection;
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed && this.pending) {
        const projection = this.pending;
        this.pending = null;
        try {
          await this.native('widget.publish', { sequence: ++this.sequence, projection });
        } catch {
          // A widget cache is optional; the next state/resume event retries the latest data.
        }
      }
    } finally {
      this.running = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.pending = null;
  }
}

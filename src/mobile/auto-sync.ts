export type AutoSyncResult = 'ok' | 'legacy' | 'retry' | 'legacy-retry' | 'stop';
export type AutoSyncMode = 'sync' | 'check';
const RETRY_DELAYS = [5_000, 15_000];

/** Event-driven only: one foreground scheduler, finite retries, no idle polling. */
export class MobileAutoSync {
  private active = true;
  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private failures = 0;
  private lastEventAt = -Infinity;

  constructor(
    private readonly run: (mode: AutoSyncMode) => Promise<AutoSyncResult>,
    private readonly allowed: () => boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  trigger(manual = false): void {
    if (manual) this.stopped = false;
    if (!this.canRun() || this.running) return;
    if (!manual) {
      const now = this.clock();
      if (now - this.lastEventAt < 1_000) return;
      this.lastEventAt = now;
    }
    this.clearTimer();
    this.failures = 0;
    void this.attempt(manual || this.dirty ? 'sync' : 'check');
  }

  /** Changes made during a request remain queued for a single follow-up. */
  changed(): void {
    if (!this.active) return;
    this.dirty = true;
    if (!this.canRun() || this.running) return;
    this.failures = 0;
    this.schedule(600, 'sync');
  }

  suspend(): void {
    this.clearTimer();
    this.lastEventAt = -Infinity;
  }

  dispose(): void {
    this.active = false;
    this.clearTimer();
  }

  private canRun(): boolean {
    return this.active && !this.stopped && this.allowed();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number, mode: AutoSyncMode): void {
    this.clearTimer();
    if (!this.canRun()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt(mode);
    }, delay);
  }

  private async attempt(mode: AutoSyncMode): Promise<void> {
    if (!this.canRun() || this.running) return;
    this.running = true;
    this.dirty = false;
    let result: AutoSyncResult = 'stop';
    try {
      result = await this.run(mode);
    } catch {
      /* Unknown/data failures require explicit user recovery. */
    } finally {
      this.running = false;
    }
    if (result === 'stop') this.stopped = true;
    if (!this.canRun()) return;
    if (result === 'retry' || result === 'legacy-retry') {
      const delay = RETRY_DELAYS[this.failures];
      this.failures++;
      if (delay !== undefined) this.schedule(delay, this.dirty ? 'sync' : mode);
      return;
    }
    this.failures = 0;
    if (this.dirty) this.schedule(600, 'sync');
  }
}

import { useCallback, useEffect, useState } from 'react';

import { TASK_CELEBRATION_MS, type TaskCelebration } from '../shared/task-celebration';

export interface TaskCompanionReaction {
  id: string;
  taskId: string;
  localDate: string;
  praise: string;
  /**
   * Today's completed count before this completion, captured when it committed. It picks the
   * reaction pose, so a list refresh during the hold cannot change the pose.
   */
  ordinal: number;
}

/**
 * Presentation only: one committed completion at a time, cleared when the page hides.
 * A newer result replaces the previous moment; nothing here waits for or blocks input.
 */
export function useTaskCelebration() {
  const [current, setCurrent] = useState<TaskCelebration | null>(null);
  const [reaction, setReaction] = useState<TaskCompanionReaction | null>(null);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(() => setCurrent(null), TASK_CELEBRATION_MS.total);
    return () => window.clearTimeout(timer);
  }, [current]);

  useEffect(() => {
    if (!reaction) return;
    const timer = window.setTimeout(() => setReaction(null), TASK_CELEBRATION_MS.companionHold);
    return () => window.clearTimeout(timer);
  }, [reaction]);

  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return;
      setCurrent(null);
      setReaction(null);
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  /** A creation grant passes `companion: false`: it shows the coin without any praise. */
  const celebrate = useCallback(
    (celebration: TaskCelebration, options: { companion?: boolean; ordinal?: number } = {}) => {
      if (document.hidden) return;
      setCurrent(celebration);
      if (options.companion === false) return;
      setReaction({
        id: celebration.id,
        taskId: celebration.taskId,
        localDate: celebration.localDate,
        praise: celebration.praise,
        ordinal: normalizeOrdinal(options.ordinal),
      });
    },
    [],
  );

  /** A committed undo of the celebrated occurrence ends its moment at once. */
  const dismiss = useCallback((taskId: string, localDate: string) => {
    setCurrent((value) =>
      value?.taskId === taskId && value.localDate === localDate ? null : value,
    );
    setReaction((value) =>
      value?.taskId === taskId && value.localDate === localDate ? null : value,
    );
  }, []);

  return { current, reaction, celebrate, dismiss };
}

function normalizeOrdinal(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

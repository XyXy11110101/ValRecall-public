import { useEffect, useState } from 'react';

export type MinuteClockSource = () => Date;

const systemClock: MinuteClockSource = () => new Date();

/** One coarse clock per mounted forecast view; never one timer per item. */
export function useMinuteClock(clock: MinuteClockSource = systemClock): Date {
  const [now, setNow] = useState(() => new Date(clock()));

  useEffect(() => {
    let timer: number | null = null;

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      const current = clock();
      const remainder = current.getTime() % 60_000;
      const delay = (remainder === 0 ? 60_000 : 60_000 - remainder) + 20;
      timer = window.setTimeout(() => {
        timer = null;
        setNow(new Date(clock()));
        schedule();
      }, delay);
    };
    const updateWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(new Date(clock()));
      schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', updateWhenVisible);
    };
  }, [clock]);

  return now;
}

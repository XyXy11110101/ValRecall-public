import { useEffect, useState } from 'react';

/**
 * Work shorter than this never shows its indicator, so a save or a background sync does not
 * flash a status. Shared by the dashboard refresh lines and the phone's background-sync hint.
 */
export const REFRESH_REVEAL_DELAY_MS = 600;

/**
 * Presentation only: true once `active` has stayed true for `delayMs`. One timer per active
 * period, cleared as soon as the work ends, so slow work still shows and fast work never does.
 */
export function useDelayedFlag(active: boolean, delayMs = REFRESH_REVEAL_DELAY_MS): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!active) {
      setRevealed(false);
      return;
    }
    const timer = window.setTimeout(() => setRevealed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && revealed;
}

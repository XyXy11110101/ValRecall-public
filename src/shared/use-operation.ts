import { useRef, useState } from 'react';

/** The ref takes effect before React renders disabled controls. */
export function useOperation() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  function begin(): boolean {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    return true;
  }
  function finish() {
    pending.current = false;
    setBusy(false);
  }
  return { busy, pending, begin, finish };
}

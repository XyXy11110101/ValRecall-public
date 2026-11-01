import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { MOTION_DURATION_MS } from './contracts';
import { useReducedMotion } from './useReducedMotion';

export function MotionDisclosure({
  open,
  id,
  className = '',
  returnFocusRef,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [present, setPresent] = useState(open);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open && regionRef.current?.contains(document.activeElement)) {
      returnFocusRef?.current?.focus({ preventScroll: true });
    }

    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (open) {
      setPresent(true);
      return;
    }

    if (reducedMotion) {
      setPresent(false);
      return;
    }

    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPresent(false);
    }, MOTION_DURATION_MS.standard);
  }, [open, reducedMotion, returnFocusRef]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  if (!present && !open) return null;

  return (
    <div
      className={`motion-disclosure${className ? ` ${className}` : ''}`}
      data-expanded={open}
      id={id}
      ref={regionRef}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="motion-disclosure-inner">{children}</div>
    </div>
  );
}

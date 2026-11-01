export const MOTION_DURATION_MS = {
  instant: 90,
  fast: 140,
  standard: 220,
  emphasis: 320,
  scene: 420,
} as const;

export const MOTION_TIMING_MS = {
  staggerStep: 60,
  confirmationHold: 560,
} as const;

export type MotionDuration = keyof typeof MOTION_DURATION_MS;

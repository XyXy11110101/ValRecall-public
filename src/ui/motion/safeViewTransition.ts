export interface ViewTransitionLike {
  finished: Promise<unknown>;
  ready: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
  skipTransition(): void;
}

export interface SafeViewTransitionOptions {
  documentRef?: Document | null;
  reducedMotion?: boolean;
}

/** Keep route updates immediate. Full-page snapshots made navigation feel staged. */
export function safeViewTransition(
  update: () => void,
  _options: SafeViewTransitionOptions = {},
): ViewTransitionLike | null {
  update();
  return null;
}

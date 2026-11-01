import type { VideoPlatformAdapter } from '../adapters/types';
import type { CapturePageResponse } from '../models/messages';

export interface CaptureConsistencySession {
  draftId: string;
  validate(): boolean;
}

export function createCaptureConsistencySession(
  adapter: Pick<VideoPlatformAdapter, 'createCaptureConsistencyCheck'>,
  response: CapturePageResponse,
): CaptureConsistencySession | null {
  if (!response.ok) return null;
  const check = adapter.createCaptureConsistencyCheck?.() ?? (() => true);
  return { draftId: response.draft.draftId, validate: check };
}

export function validateCaptureConsistencySession(
  session: CaptureConsistencySession | null,
  draftId: string,
): boolean {
  if (session === null || session.draftId !== draftId) return false;
  try {
    return session.validate();
  } catch {
    return false;
  }
}

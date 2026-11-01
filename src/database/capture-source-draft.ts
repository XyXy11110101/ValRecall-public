import type { CaptureDraft } from '../models/learning-item';
import type { LocalDraft } from './drafts';
export function captureSourceDraft(source: CaptureDraft): LocalDraft {
  const id = 'capture-source:' + source.draftId;
  return {
    schemaVersion: 1,
    id,
    scope: 'capture',
    revision: 1,
    updatedAt: source.capturedAt,
    summary: source.videoTitle ?? '',
    payload: {
      id,
      capture: JSON.stringify(source),
      videoTitle: source.videoTitle ?? '',
      coreLesson: '',
      recallPrompt: '',
      itemType: 'Understand',
      categoryId: null,
    },
  };
}

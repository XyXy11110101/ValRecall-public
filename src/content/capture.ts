import { createVideoPlatformAdapter } from '../adapters/registry';
import type { VideoPlatformAdapter } from '../adapters/types';
import { CAPTURE_DRAFT_SCHEMA_VERSION, type CaptureDraft } from '../models/learning-item';
import type { CapturePageResponse } from '../models/messages';
import { formatTimestamp } from '../shared/time';

export interface CapturePageOptions {
  adapter?: VideoPlatformAdapter | null;
  now?: () => Date;
  idGenerator?: () => string;
}

export async function captureCurrentPage(
  options: CapturePageOptions = {},
): Promise<CapturePageResponse> {
  const adapter = options.adapter === undefined ? createVideoPlatformAdapter() : options.adapter;
  if (adapter === null) {
    return unsupportedPage();
  }
  const detection = adapter.detectPage();
  if (!detection.value.supported) {
    return unsupportedPage();
  }

  try {
    const preparation = await adapter.prepareCapture?.();
    if (preparation !== undefined && !preparation.ok) {
      return {
        ok: false,
        error: {
          code: 'VIDEO_NOT_FOUND',
          message: preparation.message,
        },
      };
    }
    const metadata = adapter.extractMetadata().value;
    if (metadata.timestampSeconds === null) {
      return {
        ok: false,
        error: {
          code: 'VIDEO_NOT_FOUND',
          message:
            adapter.platform === 'douyin'
              ? 'The visible video could not be captured safely.'
              : adapter.platform === 'bilibili'
                ? 'Bilibili video player not ready. Wait for the main video to appear, then try again.'
                : 'ValRecall could not find a ready video on this page. Start the video and try again.',
        },
      };
    }

    const subtitles = metadata.subtitleContext;
    const draft: CaptureDraft = {
      draftId: (options.idGenerator ?? defaultIdGenerator)(),
      schemaVersion: CAPTURE_DRAFT_SCHEMA_VERSION,
      platform: adapter.platform,
      sourceUrl: metadata.sourceUrl,
      canonicalUrl: metadata.canonicalUrl,
      videoId: metadata.videoId,
      videoTitle: metadata.videoTitle,
      uploader: metadata.uploader,
      description: metadata.description,
      timestampSeconds: metadata.timestampSeconds,
      timestampDisplay: formatTimestamp(metadata.timestampSeconds),
      videoDurationSeconds: metadata.videoDurationSeconds,
      chapterTitle: metadata.chapterTitle,
      videoBounds: metadata.videoBounds,
      screenshotDataUrl: null,
      subtitleBefore: subtitles.subtitleBefore,
      subtitleCurrent: subtitles.subtitleCurrent,
      subtitleAfter: subtitles.subtitleAfter,
      subtitleCueData: subtitles.cueData,
      subtitleStatus: subtitles.status,
      subtitleExtractionStrategy: subtitles.extractionStrategy,
      subtitleConfidence: subtitles.confidence,
      capturedAt: (options.now ?? (() => new Date()))().toISOString(),
      extractionDiagnostics: metadata.diagnostics,
    };
    return { ok: true, draft };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'CAPTURE_FAILED',
        message:
          error instanceof Error ? error.message : 'ValRecall could not read this video page.',
      },
    };
  }
}

function unsupportedPage(): CapturePageResponse {
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_PAGE',
      message:
        'ValRecall can capture supported Bilibili direct videos or identified Watch Later items, standard YouTube watch pages, and direct or visible modal Douyin videos.',
    },
  };
}

function defaultIdGenerator(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

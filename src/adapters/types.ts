import type {
  ExtractionDiagnostic,
  ExtractionResult,
  PageDetection,
  SeekResult,
  SubtitleContext,
  VideoBounds,
} from '../models/extraction';
import type { VideoPlatform } from '../models/platform';

export interface LocationLike {
  href: string;
  hostname: string;
  pathname: string;
}

export type AdapterLocation = LocationLike;

export interface VideoCaptureMetadata {
  sourceUrl: string;
  canonicalUrl: string | null;
  videoId: string | null;
  videoTitle: string | null;
  uploader: string | null;
  description: string | null;
  timestampSeconds: number | null;
  videoDurationSeconds: number | null;
  videoBounds: VideoBounds | null;
  subtitleContext: SubtitleContext;
  chapterTitle: string | null;
  diagnostics: ExtractionDiagnostic[];
}

export interface SeekOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  pauseAfterSeek?: boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

export type CapturePreparationFailureReason =
  'PANEL_NOT_OPEN' | 'NO_VISIBLE_VIDEO' | 'VIDEO_LOADING' | 'AMBIGUOUS_VIDEO' | 'UNSTABLE_VIDEO';

export type CapturePreparationResult =
  | { ok: true }
  | {
      ok: false;
      reason: CapturePreparationFailureReason;
      message: string;
    };

export interface CapturePreparationOptions {
  retryScheduleMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}

export interface VideoPlatformAdapter {
  readonly platform: VideoPlatform;
  detectPage(): ExtractionResult<PageDetection>;
  extractMetadata(): ExtractionResult<VideoCaptureMetadata>;
  seekToTimestamp(timestampSeconds: number, options?: SeekOptions): Promise<SeekResult>;
  prepareCapture?(options?: CapturePreparationOptions): Promise<CapturePreparationResult>;
  createCaptureConsistencyCheck?(): (() => boolean) | null;
}

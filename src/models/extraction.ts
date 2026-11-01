import type { VideoPlatform } from './platform';

export type DiagnosticStatus = 'success' | 'failed' | 'skipped';
export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ExtractionDiagnostic {
  field: string;
  strategy: string;
  status: DiagnosticStatus;
  severity: DiagnosticSeverity;
  message: string;
}

export interface ExtractionResult<T> {
  value: T;
  diagnostics: ExtractionDiagnostic[];
}

export interface PageDetection {
  supported: boolean;
  platform: VideoPlatform | null;
  videoId: string | null;
}

export interface VideoBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface SubtitleCueData {
  startTime: number | null;
  endTime: number | null;
  text: string;
  source: 'text-track' | 'dom-transcript' | 'visible-overlay';
}

export type SubtitleStatus = 'timed_context' | 'current_only' | 'unavailable';
export type SubtitleExtractionStrategy =
  'text_track_timed_cues' | 'timestamped_transcript_rows' | 'visible_video_overlay' | 'none';
export type SubtitleConfidence = 'high' | 'medium' | 'none';
export type SubtitleRejectionCode =
  | 'hidden'
  | 'zero_bounds'
  | 'outside_active_video'
  | 'excluded_ui_ancestor'
  | 'untimed_transcript_row'
  | 'overlong_text'
  | 'high_ui_label_density'
  | 'settings_text'
  | 'empty_text';

export interface SubtitleRejectionReason {
  strategy: 'timestamped_transcript_rows' | 'visible_video_overlay';
  code: SubtitleRejectionCode;
  message: string;
  selector: string | null;
  textPreview: string | null;
}

/**
 * Strict extraction result. The aliases at the bottom keep the persisted MVP
 * capture contract stable while callers migrate to the explicit status fields.
 */
export type SubtitleAvailability = 'context' | 'current-only' | 'none';

export interface SubtitleContext {
  status: SubtitleStatus;
  extractionStrategy: SubtitleExtractionStrategy;
  confidence: SubtitleConfidence;
  before: string[];
  current: string[];
  after: string[];
  timedCues: SubtitleCueData[];
  diagnostics: ExtractionDiagnostic[];
  rejectionReasons: SubtitleRejectionReason[];

  // Capture/database compatibility aliases.
  subtitleBefore: string[];
  subtitleCurrent: string[];
  subtitleAfter: string[];
  cueData: SubtitleCueData[];
  availability: SubtitleAvailability;
  source: SubtitleCueData['source'] | null;
}

export interface SeekResult {
  ok: boolean;
  attempts: number;
  timestampSeconds: number;
  error: string | null;
  diagnostics: ExtractionDiagnostic[];
}

export const diagnostic = (
  field: string,
  strategy: string,
  status: DiagnosticStatus,
  message: string,
  severity: DiagnosticSeverity = status === 'failed' ? 'warning' : 'info',
): ExtractionDiagnostic => ({ field, strategy, status, severity, message });

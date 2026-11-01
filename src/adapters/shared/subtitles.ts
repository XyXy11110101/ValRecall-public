import type {
  ExtractionDiagnostic,
  SubtitleContext,
  SubtitleCueData,
  SubtitleRejectionReason,
} from '../../models/extraction';

export interface TimedSubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
}

interface SubtitleContextInput {
  status: SubtitleContext['status'];
  extractionStrategy: SubtitleContext['extractionStrategy'];
  before?: string[];
  current?: string[];
  after?: string[];
  timedCues?: SubtitleCueData[];
  diagnostics?: ExtractionDiagnostic[];
  rejectionReasons?: SubtitleRejectionReason[];
}

export function createSubtitleContext(input: SubtitleContextInput): SubtitleContext {
  const before = input.before ?? [];
  const current = input.current ?? [];
  const after = input.after ?? [];
  const timedCues = input.timedCues ?? [];
  const source: SubtitleContext['source'] =
    input.extractionStrategy === 'text_track_timed_cues'
      ? 'text-track'
      : input.extractionStrategy === 'timestamped_transcript_rows'
        ? 'dom-transcript'
        : input.extractionStrategy === 'visible_video_overlay'
          ? 'visible-overlay'
          : null;
  const confidence: SubtitleContext['confidence'] =
    input.status === 'timed_context' ? 'high' : input.status === 'current_only' ? 'medium' : 'none';
  const availability: SubtitleContext['availability'] =
    input.status === 'timed_context'
      ? before.length > 0 || after.length > 0
        ? 'context'
        : 'current-only'
      : input.status === 'current_only'
        ? 'current-only'
        : 'none';
  const compatibilityCueData =
    input.status === 'current_only' && source === 'visible-overlay'
      ? current.map<SubtitleCueData>((text) => ({
          startTime: null,
          endTime: null,
          text,
          source: 'visible-overlay',
        }))
      : timedCues;

  return {
    status: input.status,
    extractionStrategy: input.extractionStrategy,
    confidence,
    before: [...before],
    current: [...current],
    after: [...after],
    timedCues: [...timedCues],
    diagnostics: [...(input.diagnostics ?? [])],
    rejectionReasons: [...(input.rejectionReasons ?? [])],
    subtitleBefore: [...before],
    subtitleCurrent: [...current],
    subtitleAfter: [...after],
    cueData: [...compatibilityCueData],
    availability,
    source,
  };
}

export function selectTimedSubtitleCues(
  cues: readonly TimedSubtitleCue[],
  timestampSeconds: number,
  source: 'text-track' | 'dom-transcript',
): SubtitleContext | null {
  const normalised = cues
    .filter(
      (cue) =>
        Number.isFinite(cue.startTime) &&
        Number.isFinite(cue.endTime) &&
        cue.endTime >= cue.startTime &&
        normalizeSubtitleText(cue.text).length > 0,
    )
    .map((cue) => ({ ...cue, text: normalizeSubtitleText(cue.text) }))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  const currentCandidates = normalised.filter(
    (cue) => cue.startTime <= timestampSeconds && cue.endTime > timestampSeconds,
  );
  if (currentCandidates.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const unique = (values: readonly TimedSubtitleCue[]): TimedSubtitleCue[] => {
    const result: TimedSubtitleCue[] = [];
    for (const cue of values) {
      if (!seen.has(cue.text)) {
        seen.add(cue.text);
        result.push(cue);
      }
    }
    return result;
  };
  const current = unique(currentCandidates);
  const before = unique(normalised.filter((cue) => cue.endTime <= timestampSeconds).slice(-2));
  const after = unique(normalised.filter((cue) => cue.startTime > timestampSeconds).slice(0, 2));
  const toData = (cue: TimedSubtitleCue): SubtitleCueData => ({
    startTime: cue.startTime,
    endTime: cue.endTime,
    text: cue.text,
    source,
  });

  return createSubtitleContext({
    status: 'timed_context',
    extractionStrategy:
      source === 'text-track' ? 'text_track_timed_cues' : 'timestamped_transcript_rows',
    before: before.map((cue) => cue.text),
    current: current.map((cue) => cue.text),
    after: after.map((cue) => cue.text),
    timedCues: [...before, ...current, ...after].map(toData),
  });
}

export function normalizeSubtitleText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

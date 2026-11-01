import type { ExtractionDiagnostic, ExtractionResult, VideoBounds } from '../../models/extraction';
import { diagnostic } from '../../models/extraction';
import { isValidTimeSeconds, parseTimestamp } from '../../shared/time';

export interface RankedVideo {
  video: HTMLVideoElement;
  playing: boolean;
  visible: boolean;
  area: number;
}

export function selectBestVideo(
  videos: readonly HTMLVideoElement[],
  documentRef: Document,
): RankedVideo | null {
  return (
    videos
      .map((video, index) => ({ ...rankVideo(video, documentRef), video, index }))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0] ?? null
  );
}

export function readVideoCurrentTime(
  video: HTMLVideoElement | null,
): ExtractionResult<number | null> {
  try {
    const currentTime = video?.currentTime;
    if (isValidTimeSeconds(currentTime)) {
      return {
        value: currentTime,
        diagnostics: [
          diagnostic(
            'timestamp',
            'html-media-current-time',
            'success',
            'Read the current video timestamp.',
          ),
        ],
      };
    }
  } catch {
    return {
      value: null,
      diagnostics: [
        diagnostic(
          'timestamp',
          'html-media-current-time',
          'failed',
          'The player blocked access to its timestamp.',
        ),
      ],
    };
  }
  return {
    value: null,
    diagnostics: [
      diagnostic(
        'timestamp',
        'html-media-current-time',
        'failed',
        'The video timestamp is unavailable.',
      ),
    ],
  };
}

export function readVideoDuration(video: HTMLVideoElement | null): ExtractionResult<number | null> {
  try {
    const duration = video?.duration;
    if (isValidTimeSeconds(duration) && duration > 0) {
      return {
        value: duration,
        diagnostics: [
          diagnostic('videoDuration', 'html-media-duration', 'success', 'Read the video duration.'),
        ],
      };
    }
  } catch {
    return {
      value: null,
      diagnostics: [
        diagnostic(
          'videoDuration',
          'html-media-duration',
          'failed',
          'The player blocked access to its duration.',
        ),
      ],
    };
  }
  return {
    value: null,
    diagnostics: [
      diagnostic(
        'videoDuration',
        'html-media-duration',
        'failed',
        'The video duration is unavailable.',
      ),
    ],
  };
}

export function readVideoBounds(
  video: HTMLVideoElement | null,
  documentRef: Document,
): ExtractionResult<VideoBounds | null> {
  const rectangle = video === null ? null : safeRectangle(video);
  if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) {
    return {
      value: null,
      diagnostics: [
        diagnostic(
          'videoBounds',
          'bounding-client-rect',
          'failed',
          'The selected video has no visible bounding rectangle.',
        ),
      ],
    };
  }
  return {
    value: {
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
      devicePixelRatio: documentRef.defaultView?.devicePixelRatio ?? 1,
    },
    diagnostics: [
      diagnostic(
        'videoBounds',
        'bounding-client-rect',
        'success',
        'Read the visible video bounds.',
      ),
    ],
  };
}

export function safeRectangle(element: Element): DOMRect | null {
  try {
    return element.getBoundingClientRect();
  } catch {
    return null;
  }
}

export function rectangleOverlapRatio(candidate: DOMRect, container: DOMRect): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(candidate.right, container.right) - Math.max(candidate.left, container.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(candidate.bottom, container.bottom) - Math.max(candidate.top, container.top),
  );
  const candidateArea = candidate.width * candidate.height;
  return candidateArea > 0 ? (intersectionWidth * intersectionHeight) / candidateArea : 0;
}

function rankVideo(
  video: HTMLVideoElement,
  documentRef: Document,
): { score: number; playing: boolean; visible: boolean; area: number } {
  const rectangle = safeRectangle(video);
  const area = rectangle ? Math.max(0, rectangle.width) * Math.max(0, rectangle.height) : 0;
  let playing = false;
  try {
    playing = !video.paused && !video.ended;
  } catch {
    playing = false;
  }
  let visible = area > 0 && !video.hidden && video.getAttribute('aria-hidden') !== 'true';
  try {
    const style = documentRef.defaultView?.getComputedStyle(video);
    visible =
      visible &&
      style?.display !== 'none' &&
      style?.visibility !== 'hidden' &&
      style?.opacity !== '0';
  } catch {
    visible = false;
  }
  return { score: (playing ? 1e12 : 0) + (visible ? 1e9 : 0) + area, playing, visible, area };
}

export function mergeDiagnostics(
  ...results: ReadonlyArray<{ diagnostics: readonly ExtractionDiagnostic[] }>
): ExtractionDiagnostic[] {
  return results.flatMap((result) => [...result.diagnostics]);
}

export function chapterFromTimestampHeadings(
  description: string,
  timestampSeconds: number,
): string | null {
  const headings = description
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(\S.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ start: parseTimestamp(match[1]!), title: normaliseText(match[2]!) }))
    .filter(
      (entry): entry is { start: number; title: string } =>
        entry.start !== null && entry.title.length > 0,
    )
    .sort((left, right) => left.start - right.start);
  return headings.filter((entry) => entry.start <= timestampSeconds).at(-1)?.title ?? null;
}

function normaliseText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

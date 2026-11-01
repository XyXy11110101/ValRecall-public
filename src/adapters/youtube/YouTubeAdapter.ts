import {
  diagnostic,
  type ExtractionDiagnostic,
  type ExtractionResult,
  type PageDetection,
  type SeekResult,
  type SubtitleContext,
  type SubtitleRejectionReason,
  type VideoBounds,
} from '../../models/extraction';
import { isValidTimeSeconds, parseTimestamp } from '../../shared/time';
import {
  createSubtitleContext,
  normalizeSubtitleText,
  selectTimedSubtitleCues,
  type TimedSubtitleCue,
} from '../shared/subtitles';
import {
  extractSubtitleContextFromDomTextTracks,
  extractSubtitleContextFromPageSnapshot,
  type SubtitleTrackExtraction,
} from '../shared/page-subtitles';
import {
  chapterFromTimestampHeadings,
  mergeDiagnostics,
  readVideoBounds,
  readVideoCurrentTime,
  readVideoDuration,
  rectangleOverlapRatio,
  safeRectangle,
  selectBestVideo,
} from '../shared/video';
import type {
  AdapterLocation,
  SeekOptions,
  VideoCaptureMetadata,
  VideoPlatformAdapter,
} from '../types';
import { parseYouTubeWatchUrl } from './url';

export const YOUTUBE_SELECTORS = {
  mainVideos: [
    '#movie_player video.html5-main-video',
    '#player video.html5-main-video',
    'video.html5-main-video',
  ],
  activeAdPlayers: ['#movie_player.ad-showing', '#movie_player.ad-interrupting'],
  liveIndicators: [
    'ytd-watch-flexy[is-live]',
    'ytd-watch-flexy[is-live-content]',
    'meta[itemprop="isLiveBroadcast"][content="true" i]',
    'meta[itemprop="isLiveBroadcast"][content="1"]',
  ],
  visibleTitles: [
    'ytd-watch-metadata h1 yt-formatted-string',
    'h1.ytd-watch-metadata yt-formatted-string',
    '#title h1 yt-formatted-string',
  ],
  uploader: [
    'ytd-video-owner-renderer #channel-name a',
    'ytd-watch-metadata ytd-channel-name a',
    '#owner #channel-name a',
  ],
  descriptions: [
    'ytd-watch-metadata #description-inline-expander',
    'ytd-text-inline-expander#description-inline-expander',
    'ytd-watch-metadata #description',
  ],
  transcriptRows: [
    'ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer',
    'ytd-transcript-segment-renderer',
  ],
  transcriptTimestamp: ['.segment-timestamp', '[class*="segment-timestamp"]'],
  transcriptText: ['.segment-text', 'yt-formatted-string.segment-text'],
  subtitleOverlays: [
    '#movie_player .caption-window .ytp-caption-segment',
    '#movie_player .ytp-caption-segment',
  ],
  activeChapters: ['#movie_player .ytp-chapter-title-content'],
} as const;

const EXCLUDED_YOUTUBE_SUBTITLE_UI = [
  'button',
  'menu',
  'dialog',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="toolbar"]',
  '.ytp-settings-menu',
  '.ytp-chrome-controls',
].join(',');

interface TranscriptExtraction {
  context: SubtitleContext | null;
  rejectionReasons: SubtitleRejectionReason[];
}

export class YouTubeAdapter implements VideoPlatformAdapter {
  readonly platform = 'youtube' as const;
  readonly document: Document;
  readonly location: AdapterLocation;
  private readonly pageSubtitleSnapshot: unknown;

  constructor(
    documentRef: Document = document,
    locationRef?: AdapterLocation,
    pageSubtitleSnapshot: unknown = null,
  ) {
    this.document = documentRef;
    this.location = locationRef ?? documentRef.location;
    this.pageSubtitleSnapshot = pageSubtitleSnapshot;
  }

  detectPage(): ExtractionResult<PageDetection> {
    const parsed = parseYouTubeWatchUrl(this.location.href);
    const live =
      parsed !== null && firstMatch(this.document, YOUTUBE_SELECTORS.liveIndicators) !== null;
    const supported = parsed !== null && !live;
    return {
      value: {
        supported,
        platform: supported ? 'youtube' : null,
        videoId: parsed?.videoId ?? null,
      },
      diagnostics: [
        diagnostic(
          'page',
          'youtube-watch-url',
          supported ? 'success' : 'failed',
          supported
            ? 'Supported YouTube watch page detected.'
            : live
              ? 'Live YouTube watch pages are outside the supported capture boundary.'
              : 'The current URL is not an exact supported YouTube watch page.',
          supported ? 'info' : 'error',
        ),
      ],
    };
  }

  findVideoElement(): ExtractionResult<HTMLVideoElement | null> {
    const videos = uniqueElements(
      YOUTUBE_SELECTORS.mainVideos.flatMap((selector) =>
        Array.from(this.document.querySelectorAll<HTMLVideoElement>(selector)),
      ),
    );
    const selected = selectBestVideo(videos, this.document);
    if (selected === null) {
      return {
        value: null,
        diagnostics: [
          diagnostic(
            'video',
            'youtube-main-player',
            'failed',
            'No YouTube main-player video element was found.',
          ),
        ],
      };
    }

    const adPlayer = firstMatch(this.document, YOUTUBE_SELECTORS.activeAdPlayers);
    if (
      adPlayer !== null &&
      (adPlayer.contains(selected.video) || selected.video.closest('#movie_player') === adPlayer)
    ) {
      return {
        value: null,
        diagnostics: [
          diagnostic(
            'video',
            'youtube-active-ad',
            'failed',
            'The main player is currently showing an advertisement. Retry after the video resumes.',
            'error',
          ),
        ],
      };
    }

    return {
      value: selected.video,
      diagnostics: [
        diagnostic(
          'video',
          'youtube-active-visible-largest',
          'success',
          `Selected one of ${videos.length} YouTube main-player video element(s): ${
            selected.playing ? 'playing, ' : ''
          }${selected.visible ? 'visible, ' : 'not visibly laid out, '}area ${Math.round(selected.area)}px².`,
        ),
      ],
    };
  }

  getVideoTitle(): ExtractionResult<string | null> {
    return runTextStrategies('videoTitle', [
      [
        'visible-youtube-watch-heading',
        () => readVisibleFirst(this.document, YOUTUBE_SELECTORS.visibleTitles),
      ],
      [
        'youtube-title-metadata',
        () => readMetadata(this.document, ['meta[property="og:title"]', 'meta[name="title"]']),
      ],
      ['document-title', () => cleanYouTubeDocumentTitle(this.document.title)],
    ]);
  }

  getCanonicalUrl(): ExtractionResult<string | null> {
    const parsed = parseYouTubeWatchUrl(this.location.href);
    return {
      value: parsed?.canonicalUrl ?? null,
      diagnostics: [
        diagnostic(
          'canonicalUrl',
          'youtube-video-id',
          parsed ? 'success' : 'failed',
          parsed
            ? 'Built the canonical YouTube watch URL from the validated video ID.'
            : 'A canonical YouTube watch URL could not be built.',
        ),
      ],
    };
  }

  getVideoId(): ExtractionResult<string | null> {
    const videoId = parseYouTubeWatchUrl(this.location.href)?.videoId ?? null;
    return {
      value: videoId,
      diagnostics: [
        diagnostic(
          'videoId',
          'youtube-watch-query',
          videoId === null ? 'failed' : 'success',
          videoId === null
            ? 'A valid YouTube watch video ID was not available.'
            : 'Read the exact YouTube video ID from the watch URL.',
        ),
      ],
    };
  }

  getUploader(): ExtractionResult<string | null> {
    return runTextStrategies('uploader', [
      ['youtube-owner-renderer', () => readVisibleFirst(this.document, YOUTUBE_SELECTORS.uploader)],
      [
        'semantic-author',
        () =>
          readMetadata(this.document, [
            'meta[itemprop="author"]',
            'link[itemprop="name"]',
            'meta[name="author"]',
          ]),
      ],
    ]);
  }

  getDescription(): ExtractionResult<string | null> {
    return runTextStrategies(
      'description',
      [
        [
          'youtube-watch-description',
          () =>
            readVisibleFirst(this.document, YOUTUBE_SELECTORS.descriptions, normalizeMultilineText),
        ],
        [
          'standard-description-metadata',
          () =>
            readMetadata(
              this.document,
              ['meta[name="description"]', 'meta[property="og:description"]'],
              normalizeMultilineText,
            ),
        ],
      ],
      normalizeMultilineText,
    );
  }

  getCurrentTime(videoElement?: HTMLVideoElement | null): ExtractionResult<number | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const result = readVideoCurrentTime(videoResult.value);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
  }

  getVideoDuration(videoElement?: HTMLVideoElement | null): ExtractionResult<number | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const result = readVideoDuration(videoResult.value);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
  }

  getVideoBounds(videoElement?: HTMLVideoElement | null): ExtractionResult<VideoBounds | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const result = readVideoBounds(videoResult.value, this.document);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
  }

  getSubtitleContext(
    videoElement?: HTMLVideoElement | null,
    timestampSeconds?: number | null,
    durationSeconds?: number | null,
  ): ExtractionResult<SubtitleContext> {
    const diagnostics: ExtractionDiagnostic[] = [];
    const rejectionReasons: SubtitleRejectionReason[] = [];
    const video = videoElement === undefined ? this.findVideoElement().value : videoElement;
    const timestamp = timestampSeconds ?? safeCurrentTime(video);
    const duration = durationSeconds ?? safeDuration(video);
    let subtitleTracksAvailable = false;

    if (video !== null && video !== undefined && timestamp !== null) {
      const pageTrack = extractSubtitleContextFromPageSnapshot(this.pageSubtitleSnapshot, {
        platform: this.platform,
        href: this.location.href,
        video,
        timestampSeconds: timestamp,
      });
      subtitleTracksAvailable ||= pageTrack.available;
      if (pageTrack.context !== null) {
        diagnostics.push(
          diagnostic(
            'subtitles',
            'text_track_timed_cues',
            'success',
            'Read bounded subtitle context from the selected YouTube player track.',
          ),
          ...pageTrack.diagnostics,
        );
        return {
          value: withSubtitleDetails(pageTrack.context, diagnostics, rejectionReasons),
          diagnostics,
        };
      }

      const domTrack = subtitleContextFromTextTracks(video, timestamp);
      subtitleTracksAvailable ||= domTrack.available;
      if (domTrack.context !== null) {
        diagnostics.push(
          diagnostic(
            'subtitles',
            'text_track_timed_cues',
            'success',
            'Read timed subtitle context from the selected YouTube video text track.',
          ),
          ...pageTrack.diagnostics,
          ...domTrack.diagnostics,
        );
        return {
          value: withSubtitleDetails(domTrack.context, diagnostics, rejectionReasons),
          diagnostics,
        };
      }
      diagnostics.push(
        diagnostic(
          'subtitles',
          'text_track_timed_cues',
          'failed',
          'No selected YouTube player track exposed a cue at the captured timestamp.',
        ),
        ...pageTrack.diagnostics,
        ...domTrack.diagnostics,
      );
    } else {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'text_track_timed_cues',
          'skipped',
          'A video and timestamp are required for text-track subtitles.',
        ),
      );
    }

    const transcript = subtitleContextFromTranscript(this.document, timestamp, duration);
    rejectionReasons.push(...transcript.rejectionReasons);
    if (transcript.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'timestamped_transcript_rows',
          'success',
          'Read subtitle context from visible timestamped YouTube transcript rows.',
        ),
        diagnostic(
          'subtitles',
          'subtitle-transcript-fallback',
          'success',
          'Used the bounded timestamped transcript fallback.',
        ),
      );
      return {
        value: withSubtitleDetails(transcript.context, diagnostics, rejectionReasons),
        diagnostics,
      };
    }
    diagnostics.push(
      diagnostic(
        'subtitles',
        'timestamped_transcript_rows',
        'failed',
        'No reliable visible YouTube transcript row overlapped the captured timestamp.',
      ),
      diagnostic(
        'subtitles',
        'subtitle-transcript-fallback',
        'failed',
        'The timestamped transcript fallback did not yield a cue.',
      ),
    );

    const overlay = subtitleContextFromOverlay(this.document, video);
    rejectionReasons.push(...overlay.rejectionReasons);
    if (overlay.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'visible_video_overlay',
          'success',
          'Read only visible caption text bounded by the selected YouTube video.',
        ),
        diagnostic(
          'subtitles',
          'subtitle-overlay-fallback',
          'success',
          'Used the visible subtitle overlay fallback.',
        ),
      );
      return {
        value: withSubtitleDetails(overlay.context, diagnostics, rejectionReasons),
        diagnostics,
      };
    }
    diagnostics.push(
      diagnostic(
        'subtitles',
        'visible_video_overlay',
        'failed',
        'No safe visible YouTube caption overlay overlapped the selected video.',
      ),
      diagnostic(
        'subtitles',
        'subtitle-overlay-fallback',
        'failed',
        'The visible subtitle overlay fallback did not yield a cue.',
      ),
      diagnostic(
        'subtitles',
        subtitleTracksAvailable ? 'subtitles-available-unreadable' : 'no-subtitles-available',
        'failed',
        subtitleTracksAvailable
          ? 'Subtitles were available, but no bounded cue could be used at capture time.'
          : 'The current YouTube player exposed no available subtitle source.',
        'warning',
      ),
      diagnostic(
        'subtitles',
        'no-accessible-subtitles',
        'failed',
        'No accessible YouTube subtitles were available.',
        'warning',
      ),
    );
    return {
      value: createSubtitleContext({
        status: 'unavailable',
        extractionStrategy: 'none',
        diagnostics,
        rejectionReasons,
      }),
      diagnostics,
    };
  }

  getChapter(
    videoElement?: HTMLVideoElement | null,
    timestampSeconds?: number | null,
    description?: string | null,
  ): ExtractionResult<string | null> {
    const diagnostics: ExtractionDiagnostic[] = [];
    const video = videoElement === undefined ? this.findVideoElement().value : videoElement;
    const timestamp = timestampSeconds ?? safeCurrentTime(video);

    if (video !== null && video !== undefined && timestamp !== null) {
      try {
        const chapter = chapterFromTextTracks(video, timestamp);
        if (chapter !== null) {
          diagnostics.push(
            diagnostic(
              'chapter',
              'chapter-text-track',
              'success',
              'Read the current chapter from a chapter track.',
            ),
          );
          return { value: chapter, diagnostics };
        }
        diagnostics.push(
          diagnostic(
            'chapter',
            'chapter-text-track',
            'failed',
            'No matching accessible chapter cue was found.',
          ),
        );
      } catch {
        diagnostics.push(
          diagnostic(
            'chapter',
            'chapter-text-track',
            'failed',
            'The player blocked its chapter track.',
          ),
        );
      }
    } else {
      diagnostics.push(
        diagnostic(
          'chapter',
          'chapter-text-track',
          'skipped',
          'A video and timestamp are required for chapter cues.',
        ),
      );
    }

    const activeChapter = readVisibleFirst(this.document, YOUTUBE_SELECTORS.activeChapters);
    if (activeChapter !== null) {
      diagnostics.push(
        diagnostic(
          'chapter',
          'youtube-active-chapter',
          'success',
          'Read the current YouTube player chapter.',
        ),
      );
      return { value: activeChapter, diagnostics };
    }
    diagnostics.push(
      diagnostic(
        'chapter',
        'youtube-active-chapter',
        'failed',
        'No visible YouTube player chapter was found.',
      ),
    );

    const descriptionText = description === undefined ? this.getDescription().value : description;
    const descriptionChapter =
      descriptionText !== null && timestamp !== null
        ? chapterFromTimestampHeadings(descriptionText, timestamp)
        : null;
    diagnostics.push(
      diagnostic(
        'chapter',
        'description-timestamp-headings',
        descriptionChapter === null ? 'failed' : 'success',
        descriptionChapter === null
          ? 'No applicable timestamp heading was found.'
          : 'Matched a timestamp heading in the YouTube description.',
      ),
    );
    return { value: descriptionChapter, diagnostics };
  }

  async seekToTimestamp(timestampSeconds: number, options: SeekOptions = {}): Promise<SeekResult> {
    if (!isValidTimeSeconds(timestampSeconds)) {
      return {
        ok: false,
        attempts: 0,
        timestampSeconds,
        error: 'The requested timestamp is invalid.',
        diagnostics: [
          diagnostic(
            'seek',
            'validate-timestamp',
            'failed',
            'The seek timestamp must be finite and non-negative.',
            'error',
          ),
        ],
      };
    }

    const diagnostics: ExtractionDiagnostic[] = [];
    const maxAttempts = clampInteger(options.maxAttempts ?? 8, 1, 20);
    const retryDelayMs = clampInteger(options.retryDelayMs ?? 250, 0, 2_000);
    const wait =
      options.wait ??
      ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const video = this.findVideoElement().value;
      if (video === null) {
        diagnostics.push(
          diagnostic(
            'seek',
            `attempt-${attempt}`,
            'failed',
            'The YouTube main video is not ready.',
          ),
        );
      } else {
        try {
          video.currentTime = timestampSeconds;
          if (options.pauseAfterSeek ?? true) {
            video.pause();
          }
          diagnostics.push(
            diagnostic(
              'seek',
              `attempt-${attempt}`,
              'success',
              'The video was moved to the saved timestamp.',
            ),
          );
          return { ok: true, attempts: attempt, timestampSeconds, error: null, diagnostics };
        } catch (error) {
          diagnostics.push(
            diagnostic(
              'seek',
              `attempt-${attempt}`,
              'failed',
              error instanceof Error ? error.message : 'The video rejected the seek request.',
            ),
          );
        }
      }
      if (attempt < maxAttempts) {
        await wait(retryDelayMs);
      }
    }

    return {
      ok: false,
      attempts: maxAttempts,
      timestampSeconds,
      error: `Unable to seek after ${maxAttempts} attempts.`,
      diagnostics,
    };
  }

  extractMetadata(): ExtractionResult<VideoCaptureMetadata> {
    const detection = this.detectPage();
    const video = this.findVideoElement();
    const title = this.getVideoTitle();
    const canonical = this.getCanonicalUrl();
    const videoId = this.getVideoId();
    const uploader = this.getUploader();
    const description = this.getDescription();
    const timestamp = this.getCurrentTime(video.value);
    const duration = this.getVideoDuration(video.value);
    const bounds = this.getVideoBounds(video.value);
    const subtitles = this.getSubtitleContext(video.value, timestamp.value, duration.value);
    const chapter = this.getChapter(video.value, timestamp.value, description.value);
    const diagnostics = mergeDiagnostics(
      detection,
      video,
      title,
      canonical,
      videoId,
      uploader,
      description,
      timestamp,
      duration,
      bounds,
      subtitles,
      chapter,
    );

    return {
      value: {
        sourceUrl: this.location.href,
        canonicalUrl: canonical.value,
        videoId: videoId.value,
        videoTitle: title.value,
        uploader: uploader.value,
        description: description.value,
        timestampSeconds: timestamp.value,
        videoDurationSeconds: duration.value,
        videoBounds: bounds.value,
        subtitleContext: subtitles.value,
        chapterTitle: chapter.value,
        diagnostics,
      },
      diagnostics,
    };
  }
}

function subtitleContextFromTextTracks(
  video: HTMLVideoElement,
  timestampSeconds: number,
): SubtitleTrackExtraction {
  return extractSubtitleContextFromDomTextTracks(video, timestampSeconds);
}

function subtitleContextFromTranscript(
  documentRef: Document,
  timestampSeconds: number | null,
  durationSeconds: number | null,
): TranscriptExtraction {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const rows = uniqueElements(
    YOUTUBE_SELECTORS.transcriptRows.flatMap((selector) =>
      Array.from(documentRef.querySelectorAll(selector)),
    ),
  );
  const entries: Array<{ startTime: number; text: string }> = [];

  for (const row of rows) {
    const selector = describeElement(row);
    if (!isVisible(row, documentRef)) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          'hidden',
          'Hidden YouTube transcript rows are ignored.',
          selector,
          null,
        ),
      );
      continue;
    }
    if (row.closest(EXCLUDED_YOUTUBE_SUBTITLE_UI)) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          'excluded_ui_ancestor',
          'Transcript candidates inside controls, menus, or dialogs are ignored.',
          selector,
          null,
        ),
      );
      continue;
    }
    const timestampElement = firstMatch(row, YOUTUBE_SELECTORS.transcriptTimestamp);
    const textElement = firstMatch(row, YOUTUBE_SELECTORS.transcriptText);
    const startTime = parseTimestamp(normalizeSubtitleText(timestampElement?.textContent ?? ''));
    const text = normalizeSubtitleText(textElement?.textContent ?? '');
    if (startTime === null) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          'untimed_transcript_row',
          'YouTube transcript rows require a parseable displayed timestamp.',
          selector,
          text,
        ),
      );
      continue;
    }
    if (text.length === 0 || text.length > 280) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          text.length === 0 ? 'empty_text' : 'overlong_text',
          text.length === 0
            ? 'The transcript row had no scoped transcript text.'
            : 'The transcript row was too long to be a reliable subtitle cue.',
          selector,
          text,
        ),
      );
      continue;
    }
    entries.push({ startTime, text });
  }

  entries.sort((left, right) => left.startTime - right.startTime);
  const cues: TimedSubtitleCue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const next = entries[index + 1];
    const endTime = next?.startTime ?? durationSeconds;
    if (endTime !== null && endTime !== undefined && endTime > entry.startTime) {
      cues.push({ startTime: entry.startTime, endTime, text: entry.text });
    }
  }

  return {
    context:
      timestampSeconds === null
        ? null
        : selectTimedSubtitleCues(cues, timestampSeconds, 'dom-transcript'),
    rejectionReasons,
  };
}

function subtitleContextFromOverlay(
  documentRef: Document,
  video: HTMLVideoElement | null | undefined,
): TranscriptExtraction {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const videoRectangle = video ? safeRectangle(video) : null;
  const videoPlayer = video?.closest('#movie_player') ?? null;
  const candidates: Array<{ text: string; score: number }> = [];
  const elements = uniqueElements(
    YOUTUBE_SELECTORS.subtitleOverlays.flatMap((selector) =>
      Array.from(documentRef.querySelectorAll(selector)),
    ),
  );

  for (const element of elements) {
    const selector = describeElement(element);
    const text = normalizeSubtitleText(element.textContent ?? '');
    if (!isVisible(element, documentRef)) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          'hidden',
          'Hidden caption overlays are ignored.',
          selector,
          text,
        ),
      );
      continue;
    }
    if (element.closest(EXCLUDED_YOUTUBE_SUBTITLE_UI)) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          'excluded_ui_ancestor',
          'Caption candidates inside controls, menus, or dialogs are ignored.',
          selector,
          null,
        ),
      );
      continue;
    }
    const candidatePlayer = element.closest('#movie_player');
    const rectangle = safeRectangle(element);
    if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          'zero_bounds',
          'Caption overlays require a non-zero rendered rectangle.',
          selector,
          text,
        ),
      );
      continue;
    }
    const overlap = videoRectangle === null ? 0 : rectangleOverlapRatio(rectangle, videoRectangle);
    if (
      videoRectangle === null ||
      overlap < 0.5 ||
      (videoPlayer !== null && candidatePlayer !== videoPlayer)
    ) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          'outside_active_video',
          'Caption overlays must be bounded by the selected YouTube video.',
          selector,
          text,
        ),
      );
      continue;
    }
    if (text.length === 0 || text.length > 280) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          text.length === 0 ? 'empty_text' : 'overlong_text',
          text.length === 0
            ? 'The caption overlay contained no text.'
            : 'The caption overlay was too long to be reliable spoken text.',
          selector,
          text,
        ),
      );
      continue;
    }
    candidates.push({
      text,
      score:
        overlap * 100 +
        ((rectangle.bottom - videoRectangle.top) / Math.max(1, videoRectangle.height)) * 10,
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  const selected = Array.from(new Set(candidates.slice(0, 4).map(({ text }) => text)));
  return {
    context:
      selected.length === 0
        ? null
        : createSubtitleContext({
            status: 'current_only',
            extractionStrategy: 'visible_video_overlay',
            current: selected,
          }),
    rejectionReasons,
  };
}

function chapterFromTextTracks(video: HTMLVideoElement, timestampSeconds: number): string | null {
  for (const track of indexedList(video.textTracks)) {
    if (track.kind !== 'chapters') {
      continue;
    }
    const cue = readCueList(track.cues).find(
      (candidate) =>
        candidate.startTime <= timestampSeconds && candidate.endTime > timestampSeconds,
    );
    if (cue) {
      return cue.text;
    }
  }
  return null;
}

function readCueList(list: TextTrackCueList | null): TimedSubtitleCue[] {
  if (list === null) {
    return [];
  }
  const cues: TimedSubtitleCue[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const cue = list[index] as (TextTrackCue & { text?: unknown }) | undefined;
    if (
      cue &&
      typeof cue.text === 'string' &&
      isValidTimeSeconds(cue.startTime) &&
      isValidTimeSeconds(cue.endTime) &&
      cue.endTime >= cue.startTime &&
      normalizeSubtitleText(cue.text).length > 0
    ) {
      cues.push({
        startTime: cue.startTime,
        endTime: cue.endTime,
        text: normalizeSubtitleText(cue.text),
      });
    }
  }
  return cues;
}

function withSubtitleDetails(
  context: SubtitleContext,
  diagnostics: ExtractionDiagnostic[],
  rejectionReasons: SubtitleRejectionReason[],
): SubtitleContext {
  return {
    ...context,
    diagnostics: [...diagnostics],
    rejectionReasons: [...rejectionReasons, ...context.rejectionReasons],
  };
}

function runTextStrategies(
  field: string,
  strategies: Array<[string, () => string | null]>,
  normalise: (value: string) => string = normalizeSubtitleText,
): ExtractionResult<string | null> {
  const diagnostics: ExtractionDiagnostic[] = [];
  for (const [strategy, extract] of strategies) {
    let candidate: string | null;
    try {
      candidate = extract();
    } catch {
      candidate = null;
    }
    const value = candidate === null ? '' : normalise(candidate);
    if (value.length > 0) {
      diagnostics.push(diagnostic(field, strategy, 'success', `Read ${field} from ${strategy}.`));
      return { value, diagnostics };
    }
    diagnostics.push(diagnostic(field, strategy, 'failed', `${strategy} did not expose ${field}.`));
  }
  return { value: null, diagnostics };
}

function readVisibleFirst(
  documentRef: Document,
  selectors: readonly string[],
  normalise: (value: string) => string = normalizeSubtitleText,
): string | null {
  for (const selector of selectors) {
    for (const element of documentRef.querySelectorAll(selector)) {
      if (!isVisible(element, documentRef)) {
        continue;
      }
      const value = normalise(element.textContent ?? '');
      if (value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

function readMetadata(
  documentRef: Document,
  selectors: readonly string[],
  normalise: (value: string) => string = normalizeSubtitleText,
): string | null {
  for (const selector of selectors) {
    const element = documentRef.querySelector(selector);
    const raw =
      element?.getAttribute('content') ??
      element?.getAttribute('href') ??
      element?.getAttribute('value') ??
      element?.textContent ??
      '';
    const value = normalise(raw);
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

function cleanYouTubeDocumentTitle(value: string): string | null {
  const cleaned = normalizeSubtitleText(value)
    .replace(/\s+-\s+YouTube\s*$/i, '')
    .trim();
  return cleaned.length > 0 && cleaned.toLocaleLowerCase() !== 'youtube' ? cleaned : null;
}

function normalizeMultilineText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function firstMatch(root: Document | Element, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element !== null) {
      return element;
    }
  }
  return null;
}

function uniqueElements<T extends Element>(elements: readonly T[]): T[] {
  return Array.from(new Set(elements));
}

function indexedList<T extends { length: number; [index: number]: unknown }>(
  list: T,
): Array<T[number]> {
  const values: Array<T[number]> = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index] as T[number] | undefined;
    if (value !== undefined && value !== null) {
      values.push(value);
    }
  }
  return values;
}

function isVisible(element: Element, documentRef: Document): boolean {
  let current: Element | null = element;
  while (current) {
    const htmlElement = current as HTMLElement;
    if (
      htmlElement.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.classList.contains('sr-only') ||
      current.classList.contains('visually-hidden')
    ) {
      return false;
    }
    try {
      const style = documentRef.defaultView?.getComputedStyle(current);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') {
        return false;
      }
    } catch {
      return false;
    }
    current = current.parentElement;
  }
  const rectangle = safeRectangle(element);
  return rectangle !== null && rectangle.width > 0 && rectangle.height > 0;
}

function safeCurrentTime(video: HTMLVideoElement | null | undefined): number | null {
  try {
    return isValidTimeSeconds(video?.currentTime) ? video.currentTime : null;
  } catch {
    return null;
  }
}

function safeDuration(video: HTMLVideoElement | null | undefined): number | null {
  try {
    return isValidTimeSeconds(video?.duration) && video.duration > 0 ? video.duration : null;
  } catch {
    return null;
  }
}

function rejection(
  strategy: SubtitleRejectionReason['strategy'],
  code: SubtitleRejectionReason['code'],
  message: string,
  selector: string | null,
  text: string | null,
): SubtitleRejectionReason {
  const preview = normalizeSubtitleText(text ?? '').slice(0, 120);
  return {
    strategy,
    code,
    message,
    selector,
    textPreview: preview.length > 0 ? preview : null,
  };
}

function describeElement(element: Element): string {
  const classes = Array.from(element.classList).slice(0, 3).join('.');
  return `${element.tagName.toLowerCase()}${classes.length > 0 ? `.${classes}` : ''}`;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

import {
  diagnostic,
  type ExtractionDiagnostic,
  type ExtractionResult,
  type PageDetection,
  type SeekResult,
  type SubtitleContext,
  type SubtitleCueData,
  type SubtitleExtractionStrategy,
  type SubtitleRejectionReason,
  type VideoBounds,
} from '../../models/extraction';
import { isValidTimeSeconds, parseTimestamp } from '../../shared/time';
import {
  extractSubtitleContextFromDomTextTracks,
  extractSubtitleContextFromPageSnapshot,
  type SubtitleTrackExtraction,
} from '../shared/page-subtitles';
import type {
  CapturePreparationOptions,
  CapturePreparationResult,
  SeekOptions as AdapterSeekOptions,
  VideoCaptureMetadata,
  VideoPlatformAdapter,
} from '../types';
import { extractBilibiliVideoId, parseBilibiliVideoUrl } from './url';

export { extractBilibiliVideoId } from './url';

export const BILIBILI_SELECTORS = {
  visibleVideoHeadings: [
    'h1[itemprop="name"]',
    'h1.video-title',
    'h1[title].video-title',
    '.video-info-container h1',
  ],
  knownTitles: ['.video-title:not(h1)', '.bpx-player-video-title'],
  uploader: [
    "[data-testid='up-name']",
    '.up-info-container .up-name',
    '.up-name',
    '.username',
    "a[href*='space.bilibili.com'] .name",
  ],
  description: [
    "[itemprop='description']",
    '.basic-desc-info',
    '.desc-info-text',
    '#v_desc .info',
    '.video-desc-container',
  ],
  transcriptRows: [
    '.bpx-player-subtitle-list .bpx-player-subtitle-item[data-start-time][data-end-time]',
    '.bpx-player-subtitle-list [data-subtitle-start][data-subtitle-end]',
    '.bilibili-player-video-subtitle-list [data-start-time][data-end-time]',
  ],
  subtitleOverlays: [
    '.bili-subtitle-x-subtitle-panel-position',
    '.bpx-player-subtitle-panel-text',
    '.bilibili-player-video-subtitle',
  ],
  activeChapters: [
    '[data-chapter-start].active',
    "[data-chapter-start][aria-current='true']",
    '.chapter-list .active',
    "[class*='chapter'][aria-current='true']",
  ],
} as const;

export type BilibiliCaptureMetadata = VideoCaptureMetadata;
export type SeekOptions = AdapterSeekOptions;

interface LocationLike {
  href: string;
  hostname: string;
  pathname: string;
}

interface SubtitleCueLike {
  startTime: number;
  endTime: number;
  text: string;
}

interface SubtitleCandidateResult {
  context: SubtitleContext | null;
  rejectionReasons: SubtitleRejectionReason[];
  candidateCount?: number;
  overlayStats?: {
    selectorMatchCount: number;
    activePlayerScopedCount: number;
    visibleCandidateCount: number;
    acceptedCandidateCount: number;
    candidates: Array<{
      bounds: { x: number; y: number; width: number; height: number } | null;
      descendantCount: number;
      rejectionCodes: string[];
    }>;
  };
}

interface BilibiliCaptureEvidence {
  videoId: string;
  video: HTMLVideoElement;
}

interface BilibiliVideoCandidate {
  video: HTMLVideoElement;
  index: number;
  visibleArea: number;
  playing: boolean;
  score: number;
}

const DEFAULT_CAPTURE_RETRY_SCHEDULE_MS = [0, 150, 350, 700, 1_200, 2_000] as const;
const MIN_PLAYER_WIDTH = 240;
const MIN_PLAYER_HEIGHT = 135;
const MIN_PLAYER_AREA = MIN_PLAYER_WIDTH * MIN_PLAYER_HEIGHT;
const EXCLUDED_VIDEO_SURFACE_SELECTOR = [
  '[aria-hidden="true"]',
  '[class*="preview" i]',
  '[class*="preload" i]',
  '[class*="recommend" i]',
  '[class*="thumbnail" i]',
].join(',');

export class BilibiliAdapter implements VideoPlatformAdapter {
  readonly platform = 'bilibili' as const;
  readonly document: Document;
  readonly location: LocationLike;
  private readonly pageSubtitleSnapshot: unknown;
  private lastCaptureEvidence: BilibiliCaptureEvidence | null = null;

  constructor(
    documentRef: Document = document,
    locationRef?: LocationLike,
    pageSubtitleSnapshot: unknown = null,
  ) {
    this.document = documentRef;
    this.location = locationRef ?? documentRef.location;
    this.pageSubtitleSnapshot = pageSubtitleSnapshot;
  }

  detectPage(): ExtractionResult<PageDetection> {
    const parsed = parseBilibiliVideoUrl(this.location.href);
    const supported = parsed !== null;

    return {
      value: {
        supported,
        platform: supported ? 'bilibili' : null,
        videoId: parsed?.videoId ?? null,
      },
      diagnostics: [
        diagnostic(
          'page',
          'bilibili-url-identity',
          supported ? 'success' : 'failed',
          supported
            ? parsed.surface === 'watch-later'
              ? 'Supported Bilibili Watch Later video identity detected.'
              : 'Supported Bilibili direct-video page detected.'
            : 'The current URL is neither a supported Bilibili direct-video page nor a valid Watch Later item.',
          supported ? 'info' : 'error',
        ),
      ],
    };
  }

  async prepareCapture(options: CapturePreparationOptions = {}): Promise<CapturePreparationResult> {
    const schedule = normalizeRetrySchedule(
      options.retryScheduleMs ?? DEFAULT_CAPTURE_RETRY_SCHEDULE_MS,
    );
    const wait = options.wait ?? delay;
    const initialIdentity = parseBilibiliVideoUrl(this.location.href);
    let previousTarget = 0;

    for (let attempt = 0; attempt < schedule.length; attempt += 1) {
      const target = schedule[attempt]!;
      if (target > previousTarget) await wait(target - previousTarget);
      previousTarget = target;

      const currentIdentity = parseBilibiliVideoUrl(this.location.href);
      if (
        initialIdentity === null ||
        currentIdentity === null ||
        currentIdentity.videoId !== initialIdentity.videoId
      ) {
        return {
          ok: false,
          reason: 'UNSTABLE_VIDEO',
          message:
            'The Bilibili video changed during capture. Return to the intended item and try again.',
        };
      }

      if (this.findVideoElement().value !== null) return { ok: true };
    }

    return {
      ok: false,
      reason: 'VIDEO_LOADING',
      message:
        'Bilibili video player not ready. Wait for the main video to appear, then try again.',
    };
  }

  findVideoElement(): ExtractionResult<HTMLVideoElement | null> {
    const videos = Array.from(this.document.querySelectorAll<HTMLVideoElement>('video'));
    if (videos.length === 0) {
      return {
        value: null,
        diagnostics: [
          diagnostic('video', 'html-video-elements', 'failed', 'No HTML video element was found.'),
        ],
      };
    }

    const candidates = videos
      .map((video, index) => createVideoCandidate(video, index, this.document))
      .filter((candidate): candidate is BilibiliVideoCandidate => candidate !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.visibleArea - left.visibleArea ||
          left.index - right.index,
      );
    const selected = candidates[0];
    if (selected === undefined) {
      return {
        value: null,
        diagnostics: [
          diagnostic(
            'video',
            'dominant-visible-main-player',
            'failed',
            `Rejected ${videos.length} hidden, tiny, excluded, off-screen, or not-ready video candidate(s).`,
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
          'dominant-visible-main-player',
          'success',
          `Selected one of ${videos.length} video element(s) by dominant rendered area: ${
            selected.playing ? 'playing bonus, ' : 'paused or idle, '
          }${Math.round(selected.visibleArea)}px² visible.`,
        ),
      ],
    };
  }

  getVideoTitle(): ExtractionResult<string | null> {
    const strategies: Array<[string, () => string | null]> = [
      [
        'visible-video-heading',
        () => readVisibleFirst(this.document, BILIBILI_SELECTORS.visibleVideoHeadings),
      ],
      ['reliable-title-metadata', () => readReliableTitleMetadata(this.document)],
      [
        'known-bilibili-title',
        () => readVisibleFirst(this.document, BILIBILI_SELECTORS.knownTitles),
      ],
      ['document-title', () => cleanupDocumentTitle(this.document.title)],
    ];

    return runTextStrategies('videoTitle', strategies);
  }

  getCanonicalUrl(): ExtractionResult<string | null> {
    const strategies: Array<[string, () => string | null]> = [
      ['current-url-identity', () => this.location.href],
      [
        'canonical-link',
        () => this.document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href ?? null,
      ],
      ['open-graph-url', () => readFirst(this.document, ["meta[property='og:url']"])],
    ];
    const diagnostics: ExtractionDiagnostic[] = [];
    const current = parseBilibiliVideoUrl(this.location.href);

    for (const [strategy, extract] of strategies) {
      let candidate: string | null;
      try {
        candidate = extract();
      } catch {
        diagnostics.push(
          diagnostic(
            'canonicalUrl',
            strategy,
            'failed',
            'The page blocked this canonical URL strategy.',
          ),
        );
        continue;
      }
      const parsed = candidate === null ? null : parseBilibiliVideoUrl(candidate);
      if (parsed !== null && current !== null && parsed.videoId === current.videoId) {
        diagnostics.push(
          diagnostic(
            'canonicalUrl',
            strategy,
            'success',
            'Derived the stable direct Bilibili URL from the validated video identity.',
          ),
        );
        return { value: parsed.canonicalUrl, diagnostics };
      }
      diagnostics.push(
        diagnostic(
          'canonicalUrl',
          strategy,
          'failed',
          'This strategy did not expose the same validated Bilibili video identity.',
        ),
      );
    }

    return { value: null, diagnostics };
  }

  getVideoId(canonicalUrl?: string | null): ExtractionResult<string | null> {
    const strategies: Array<[string, () => string | null]> = [
      ['current-url', () => extractBilibiliVideoId(this.location.href)],
      ['canonical-url', () => (canonicalUrl ? extractBilibiliVideoId(canonicalUrl) : null)],
      [
        'page-data-attribute',
        () => {
          const bvid = normalizeText(
            this.document.querySelector<HTMLElement>('[data-bvid]')?.dataset.bvid ?? '',
          );
          if (/^BV[a-zA-Z0-9]+$/.test(bvid)) {
            return bvid;
          }
          const aid = normalizeText(
            this.document.querySelector<HTMLElement>('[data-aid]')?.dataset.aid ?? '',
          );
          return /^\d+$/.test(aid) ? `av${aid}` : null;
        },
      ],
    ];
    return runTextStrategies('videoId', strategies);
  }

  getUploader(): ExtractionResult<string | null> {
    const strategies: Array<[string, () => string | null]> = [
      [
        'semantic-author',
        () =>
          readFirst(this.document, [
            "meta[name='author']",
            "[itemprop='author'] meta[itemprop='name']",
            "[itemprop='author'] [itemprop='name']",
          ]),
      ],
      ['bilibili-uploader-selectors', () => readFirst(this.document, BILIBILI_SELECTORS.uploader)],
    ];
    return runTextStrategies('uploader', strategies);
  }

  getDescription(): ExtractionResult<string | null> {
    const strategies: Array<[string, () => string | null]> = [
      [
        'semantic-description',
        () => readFirst(this.document, ["meta[itemprop='description']"], normalizeMultilineText),
      ],
      [
        'bilibili-description-selectors',
        () => readFirst(this.document, BILIBILI_SELECTORS.description, normalizeMultilineText),
      ],
      [
        'standard-description-metadata',
        () =>
          readFirst(
            this.document,
            ["meta[name='description']", "meta[property='og:description']"],
            normalizeMultilineText,
          ),
      ],
    ];
    return runTextStrategies('description', strategies, normalizeMultilineText);
  }

  getCurrentTime(videoElement?: HTMLVideoElement | null): ExtractionResult<number | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const diagnostics = [...videoResult.diagnostics];
    let currentTime: number | undefined;
    try {
      currentTime = videoResult.value?.currentTime;
    } catch {
      diagnostics.push(
        diagnostic(
          'timestamp',
          'html-media-current-time',
          'failed',
          'The player blocked access to its timestamp.',
        ),
      );
      return { value: null, diagnostics };
    }

    if (!isValidTimeSeconds(currentTime)) {
      diagnostics.push(
        diagnostic(
          'timestamp',
          'html-media-current-time',
          'failed',
          'The video timestamp is unavailable.',
        ),
      );
      return { value: null, diagnostics };
    }

    diagnostics.push(
      diagnostic(
        'timestamp',
        'html-media-current-time',
        'success',
        'Read the current video timestamp.',
      ),
    );
    return { value: currentTime, diagnostics };
  }

  getVideoDuration(videoElement?: HTMLVideoElement | null): ExtractionResult<number | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const diagnostics = [...videoResult.diagnostics];
    let duration: number | undefined;
    try {
      duration = videoResult.value?.duration;
    } catch {
      diagnostics.push(
        diagnostic(
          'videoDuration',
          'html-media-duration',
          'failed',
          'The player blocked access to its duration.',
        ),
      );
      return { value: null, diagnostics };
    }

    if (!isValidTimeSeconds(duration) || duration === 0) {
      diagnostics.push(
        diagnostic(
          'videoDuration',
          'html-media-duration',
          'failed',
          'The video duration is unavailable.',
        ),
      );
      return { value: null, diagnostics };
    }

    diagnostics.push(
      diagnostic('videoDuration', 'html-media-duration', 'success', 'Read the video duration.'),
    );
    return { value: duration, diagnostics };
  }

  getVideoBounds(videoElement?: HTMLVideoElement | null): ExtractionResult<VideoBounds | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const diagnostics = [...videoResult.diagnostics];
    if (videoResult.value === null) {
      diagnostics.push(
        diagnostic(
          'videoBounds',
          'bounding-client-rect',
          'failed',
          'Video bounds are unavailable.',
        ),
      );
      return { value: null, diagnostics };
    }

    let rectangle: DOMRect;
    try {
      rectangle = videoResult.value.getBoundingClientRect();
    } catch {
      diagnostics.push(
        diagnostic(
          'videoBounds',
          'bounding-client-rect',
          'failed',
          'The player bounds could not be read.',
        ),
      );
      return { value: null, diagnostics };
    }
    if (rectangle.width <= 0 || rectangle.height <= 0) {
      diagnostics.push(
        diagnostic(
          'videoBounds',
          'bounding-client-rect',
          'failed',
          'The selected video has no visible bounding rectangle.',
        ),
      );
      return { value: null, diagnostics };
    }

    const bounds: VideoBounds = {
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
      devicePixelRatio: this.document.defaultView?.devicePixelRatio ?? 1,
    };
    diagnostics.push(
      diagnostic(
        'videoBounds',
        'bounding-client-rect',
        'success',
        'Read the visible video bounds.',
      ),
    );
    return { value: bounds, diagnostics };
  }

  getSubtitleContext(
    videoElement?: HTMLVideoElement | null,
    timestampSeconds?: number | null,
  ): ExtractionResult<SubtitleContext> {
    const diagnostics: ExtractionDiagnostic[] = [];
    const rejectionReasons: SubtitleRejectionReason[] = [];
    const video = videoElement === undefined ? this.findVideoElement().value : videoElement;
    const timestamp = timestampSeconds ?? safeCurrentTime(video);
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
            'Read bounded subtitle context from the selected Bilibili player track.',
          ),
          ...pageTrack.diagnostics,
        );
        return {
          value: finalizeSubtitleContext(pageTrack.context, diagnostics, rejectionReasons),
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
            'Read timed subtitle context from the selected Bilibili video text track.',
          ),
          ...pageTrack.diagnostics,
          ...domTrack.diagnostics,
        );
        return {
          value: finalizeSubtitleContext(domTrack.context, diagnostics, rejectionReasons),
          diagnostics,
        };
      }
      diagnostics.push(
        diagnostic(
          'subtitles',
          'text_track_timed_cues',
          'failed',
          'No selected Bilibili player track exposed a cue at the captured timestamp.',
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
          'No video element was available for text tracks.',
        ),
      );
    }

    const transcriptResult = subtitleContextFromDomTranscript(this.document, timestamp);
    rejectionReasons.push(...transcriptResult.rejectionReasons);
    if (transcriptResult.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'timestamped_transcript_rows',
          'success',
          'Read subtitle context from reliable timestamped transcript rows.',
        ),
        diagnostic(
          'subtitles',
          'subtitle-transcript-fallback',
          'success',
          'Used the bounded timestamped transcript fallback.',
        ),
      );
      return {
        value: finalizeSubtitleContext(transcriptResult.context, diagnostics, rejectionReasons),
        diagnostics,
      };
    }
    diagnostics.push(
      diagnostic(
        'subtitles',
        'timestamped_transcript_rows',
        'failed',
        'No reliable timestamped transcript row overlapped the captured timestamp.',
      ),
      diagnostic(
        'subtitles',
        'subtitle-transcript-fallback',
        'failed',
        'The timestamped transcript fallback did not yield a cue.',
      ),
    );

    const overlayResult = subtitleContextFromVisibleOverlay(this.document, video);
    rejectionReasons.push(...overlayResult.rejectionReasons);
    diagnostics.push(
      diagnostic(
        'subtitles',
        'bilibili-visible-overlay-candidates',
        overlayResult.candidateCount && overlayResult.candidateCount > 0 ? 'success' : 'failed',
        overlayResult.overlayStats
          ? `Selector matches=${overlayResult.overlayStats.selectorMatchCount}; active-player scoped=${overlayResult.overlayStats.activePlayerScopedCount}; visible candidates=${overlayResult.overlayStats.visibleCandidateCount}; accepted=${overlayResult.overlayStats.acceptedCandidateCount}; rejection codes: ${summariseRejectionCodes(overlayResult.rejectionReasons)}.`
          : `Inspected ${overlayResult.candidateCount ?? 0} selected-player overlay candidates; rejection codes: ${summariseRejectionCodes(overlayResult.rejectionReasons)}.`,
      ),
      ...(overlayResult.overlayStats?.candidates ?? []).map((candidate, index) =>
        diagnostic(
          'subtitles',
          'bilibili-visible-overlay-instance',
          candidate.rejectionCodes.length === 0 ? 'success' : 'failed',
          `Candidate ${index + 1}: bounds=${candidate.bounds ? `${candidate.bounds.x},${candidate.bounds.y},${candidate.bounds.width},${candidate.bounds.height}` : 'unavailable'}; descendants=${candidate.descendantCount}; rejectionCodes=${candidate.rejectionCodes.join(',') || 'none'}.`,
        ),
      ),
    );
    if (overlayResult.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'visible_video_overlay',
          'success',
          'Read only the current subtitle from an overlay overlapping the selected video.',
        ),
        diagnostic(
          'subtitles',
          'subtitle-overlay-fallback',
          'success',
          'Used the visible subtitle overlay fallback.',
        ),
      );
      return {
        value: finalizeSubtitleContext(overlayResult.context, diagnostics, rejectionReasons),
        diagnostics,
      };
    }
    diagnostics.push(
      diagnostic(
        'subtitles',
        'visible_video_overlay',
        'failed',
        'No safe visible subtitle overlay overlapped the selected video.',
      ),
      diagnostic(
        'subtitles',
        'subtitle-overlay-fallback',
        'failed',
        'The visible subtitle overlay fallback did not yield a cue.',
      ),
    );

    diagnostics.push(
      diagnostic(
        'subtitles',
        subtitleTracksAvailable ? 'subtitles-available-unreadable' : 'no-subtitles-available',
        'failed',
        subtitleTracksAvailable
          ? 'Player subtitles were available but could not be read at the captured timestamp.'
          : 'No player-provided or visible DOM subtitle source was accessible; burned-in image text remains unsupported without OCR.',
        'warning',
      ),
    );
    return {
      value: createSubtitleContext({
        status: 'unavailable',
        extractionStrategy: 'none',
        before: [],
        current: [],
        after: [],
        timedCues: [],
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
            'The player did not allow its chapter track to be read.',
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

    const domChapter = chapterFromDom(this.document, timestamp);
    if (domChapter !== null) {
      diagnostics.push(
        diagnostic(
          'chapter',
          'accessible-chapter-dom',
          'success',
          'Read the current chapter from player controls.',
        ),
      );
      return { value: domChapter, diagnostics };
    }
    diagnostics.push(
      diagnostic(
        'chapter',
        'accessible-chapter-dom',
        'failed',
        'No reliable active chapter element was found.',
      ),
    );

    const descriptionText = description === undefined ? this.getDescription().value : description;
    const descriptionChapter =
      descriptionText !== null && timestamp !== null
        ? chapterFromTimestampHeadings(descriptionText, timestamp)
        : null;
    if (descriptionChapter !== null) {
      diagnostics.push(
        diagnostic(
          'chapter',
          'description-timestamp-headings',
          'success',
          'Matched a timestamp heading in the description.',
        ),
      );
      return { value: descriptionChapter, diagnostics };
    }
    diagnostics.push(
      diagnostic(
        'chapter',
        'description-timestamp-headings',
        'failed',
        'No applicable timestamp heading was found.',
      ),
    );

    return { value: null, diagnostics };
  }

  async seekToTimestamp(timestampSeconds: number, options: SeekOptions = {}): Promise<SeekResult> {
    const diagnostics: ExtractionDiagnostic[] = [];
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

    // A new tab can reload onto /zh-Hans/… before its player exists, so about 10 seconds in all.
    const maxAttempts = clampInteger(options.maxAttempts ?? 20, 1, 20);
    const retryDelayMs = clampInteger(options.retryDelayMs ?? 500, 0, 2_000);
    const pauseAfterSeek = options.pauseAfterSeek ?? true;
    const wait =
      options.wait ??
      ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const video = this.findVideoElement().value;
      if (video === null) {
        diagnostics.push(
          diagnostic('seek', `attempt-${attempt}`, 'failed', 'The video element is not ready.'),
        );
      } else {
        try {
          video.currentTime = timestampSeconds;
          if (pauseAfterSeek) {
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

  extractMetadata(): ExtractionResult<BilibiliCaptureMetadata> {
    this.lastCaptureEvidence = null;
    const diagnostics: ExtractionDiagnostic[] = [];
    const detection = this.detectPage();
    const video = this.findVideoElement();
    const title = this.getVideoTitle();
    const canonical = this.getCanonicalUrl();
    const videoId = this.getVideoId(canonical.value);
    const uploader = this.getUploader();
    const description = this.getDescription();
    const timestamp = this.getCurrentTime(video.value);
    const duration = this.getVideoDuration(video.value);
    const bounds = this.getVideoBounds(video.value);
    const subtitles = this.getSubtitleContext(video.value, timestamp.value);
    const chapter = this.getChapter(video.value, timestamp.value, description.value);

    for (const result of [
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
    ]) {
      diagnostics.push(...result.diagnostics);
    }

    const parsed = parseBilibiliVideoUrl(this.location.href);
    if (
      parsed !== null &&
      video.value !== null &&
      videoId.value === parsed.videoId &&
      timestamp.value !== null &&
      bounds.value !== null
    ) {
      this.lastCaptureEvidence = {
        videoId: parsed.videoId,
        video: video.value,
      };
    }

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

  createCaptureConsistencyCheck(): (() => boolean) | null {
    const evidence = this.lastCaptureEvidence;
    if (evidence === null) return null;

    return () => {
      const currentIdentity = parseBilibiliVideoUrl(this.location.href);
      if (currentIdentity === null || currentIdentity.videoId !== evidence.videoId) return false;
      if (!evidence.video.isConnected || safeCurrentTime(evidence.video) === null) return false;
      const selected = this.findVideoElement().value;
      if (selected !== evidence.video) return false;
      return this.getVideoBounds(selected).value !== null;
    };
  }
}

export function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMultilineText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function selectSubtitleCues(
  cues: readonly SubtitleCueLike[],
  timestampSeconds: number,
  source: SubtitleCueData['source'] = 'text-track',
): SubtitleContext {
  const normalised = cues
    .filter(
      (cue) =>
        Number.isFinite(cue.startTime) &&
        Number.isFinite(cue.endTime) &&
        cue.endTime >= cue.startTime &&
        normalizeText(cue.text).length > 0,
    )
    .map((cue) => ({ ...cue, text: normalizeText(cue.text) }))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);

  const currentCandidates = normalised.filter(
    (cue) => cue.startTime <= timestampSeconds && cue.endTime > timestampSeconds,
  );
  const beforeCandidates = normalised.filter((cue) => cue.endTime <= timestampSeconds).slice(-2);
  const afterCandidates = normalised.filter((cue) => cue.startTime > timestampSeconds).slice(0, 2);
  const seen = new Set<string>();
  const uniqueCurrent = uniqueCues(currentCandidates, seen);
  const uniqueBefore = uniqueCues(beforeCandidates, seen);
  const uniqueAfter = uniqueCues(afterCandidates, seen);
  const toData = (cue: SubtitleCueLike): SubtitleCueData => ({
    startTime: cue.startTime,
    endTime: cue.endTime,
    text: cue.text,
    source,
  });
  const hasContext = uniqueBefore.length > 0 || uniqueAfter.length > 0;
  const hasCurrent = uniqueCurrent.length > 0;
  const before = uniqueBefore.map((cue) => cue.text);
  const current = uniqueCurrent.map((cue) => cue.text);
  const after = uniqueAfter.map((cue) => cue.text);
  const timedCues = [...uniqueBefore, ...uniqueCurrent, ...uniqueAfter].map(toData);

  return createSubtitleContext({
    status: hasCurrent ? 'timed_context' : 'unavailable',
    extractionStrategy:
      hasCurrent && source === 'text-track'
        ? 'text_track_timed_cues'
        : hasCurrent && source === 'dom-transcript'
          ? 'timestamped_transcript_rows'
          : 'none',
    before: hasCurrent ? before : [],
    current: hasCurrent ? current : [],
    after: hasCurrent ? after : [],
    timedCues: hasCurrent ? timedCues : [],
    diagnostics: [],
    rejectionReasons: [],
    confidence: hasCurrent ? 'high' : 'none',
    compatibilityAvailability:
      hasCurrent && hasContext ? 'context' : hasCurrent ? 'current-only' : 'none',
  });
}

interface CreateSubtitleContextInput {
  status: SubtitleContext['status'];
  extractionStrategy: SubtitleExtractionStrategy;
  before: string[];
  current: string[];
  after: string[];
  timedCues: SubtitleCueData[];
  diagnostics: ExtractionDiagnostic[];
  rejectionReasons: SubtitleRejectionReason[];
  confidence?: SubtitleContext['confidence'];
  compatibilityCueData?: SubtitleCueData[];
  compatibilityAvailability?: SubtitleContext['availability'];
}

function createSubtitleContext(input: CreateSubtitleContextInput): SubtitleContext {
  const source: SubtitleContext['source'] =
    input.extractionStrategy === 'text_track_timed_cues'
      ? 'text-track'
      : input.extractionStrategy === 'timestamped_transcript_rows'
        ? 'dom-transcript'
        : input.extractionStrategy === 'visible_video_overlay'
          ? 'visible-overlay'
          : null;
  const confidence =
    input.confidence ??
    (input.status === 'timed_context'
      ? 'high'
      : input.status === 'current_only'
        ? 'medium'
        : 'none');
  const availability =
    input.compatibilityAvailability ??
    (input.status === 'timed_context'
      ? input.before.length > 0 || input.after.length > 0
        ? 'context'
        : 'current-only'
      : input.status === 'current_only'
        ? 'current-only'
        : 'none');

  return {
    status: input.status,
    extractionStrategy: input.extractionStrategy,
    confidence,
    before: [...input.before],
    current: [...input.current],
    after: [...input.after],
    timedCues: [...input.timedCues],
    diagnostics: [...input.diagnostics],
    rejectionReasons: [...input.rejectionReasons],
    subtitleBefore: [...input.before],
    subtitleCurrent: [...input.current],
    subtitleAfter: [...input.after],
    cueData: [...(input.compatibilityCueData ?? input.timedCues)],
    availability,
    source,
  };
}

function finalizeSubtitleContext(
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
  normalise: (value: string) => string = normalizeText,
): ExtractionResult<string | null> {
  const diagnostics: ExtractionDiagnostic[] = [];
  for (const [strategy, extract] of strategies) {
    let value: string;
    try {
      value = normalise(extract() ?? '');
    } catch {
      diagnostics.push(
        diagnostic(field, strategy, 'failed', `${strategy} could not be read from this page.`),
      );
      continue;
    }
    if (value.length > 0) {
      diagnostics.push(
        diagnostic(field, strategy, 'success', `Extracted ${field} using ${strategy}.`),
      );
      return { value, diagnostics };
    }
    diagnostics.push(diagnostic(field, strategy, 'failed', `${strategy} did not expose ${field}.`));
  }
  return { value: null, diagnostics };
}

function readFirst(
  documentRef: Document,
  selectors: readonly string[],
  normalise: (value: string) => string = normalizeText,
): string | null {
  for (const selector of selectors) {
    const element = documentRef.querySelector<HTMLElement>(selector);
    if (element === null) {
      continue;
    }
    const value =
      element instanceof HTMLMetaElement
        ? element.content
        : (element.getAttribute('content') ??
          element.getAttribute('title') ??
          element.innerText ??
          element.textContent ??
          '');
    const normalised = normalise(value);
    if (normalised.length > 0) {
      return normalised;
    }
  }
  return null;
}

function readVisibleFirst(documentRef: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    for (const element of Array.from(documentRef.querySelectorAll<HTMLElement>(selector))) {
      const rectangle = safeRectangle(element);
      if (
        !isElementTreeVisible(element, documentRef) ||
        rectangle === null ||
        rectangle.width <= 0 ||
        rectangle.height <= 0
      ) {
        continue;
      }
      const text = normalizeText(
        element.getAttribute('title') ?? element.innerText ?? element.textContent ?? '',
      );
      if (text.length > 0 && text.length <= 300) {
        return text;
      }
    }
  }
  return null;
}

function readReliableTitleMetadata(documentRef: Document): string | null {
  const openGraphTitle = readFirst(documentRef, ["meta[property='og:title']"]);
  if (openGraphTitle) {
    return cleanupDocumentTitle(openGraphTitle);
  }

  for (const script of Array.from(
    documentRef.querySelectorAll<HTMLScriptElement>("script[type='application/ld+json']"),
  )) {
    try {
      const structuredTitle = findStructuredVideoTitle(JSON.parse(script.textContent ?? ''));
      if (structuredTitle) {
        return cleanupDocumentTitle(structuredTitle);
      }
    } catch {
      // Malformed unrelated JSON-LD is not title evidence.
    }
  }

  const namedMetadata = readFirst(documentRef, ["meta[name='title']"]);
  return namedMetadata ? cleanupDocumentTitle(namedMetadata) : null;
}

function findStructuredVideoTitle(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const title = findStructuredVideoTitle(entry);
      if (title) return title;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  if (types.some((type) => type === 'VideoObject') && typeof record.name === 'string') {
    const title = normalizeText(record.name);
    return title.length > 0 ? title : null;
  }
  return record['@graph'] === undefined ? null : findStructuredVideoTitle(record['@graph']);
}

function cleanupDocumentTitle(title: string): string | null {
  const cleaned = normalizeText(title)
    .replace(/(?:[_\-–—|]\s*)?(?:哔哩哔哩(?:\s*_?\s*bilibili)?|bilibili)(?:[_\-–—|].*)?$/i, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function createVideoCandidate(
  video: HTMLVideoElement,
  index: number,
  documentRef: Document,
): BilibiliVideoCandidate | null {
  if (
    video.hidden ||
    video.getAttribute('aria-hidden') === 'true' ||
    video.matches(EXCLUDED_VIDEO_SURFACE_SELECTOR) ||
    video.closest(EXCLUDED_VIDEO_SURFACE_SELECTOR) !== null
  ) {
    return null;
  }

  const rectangle = safeRectangle(video);
  if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) return null;

  let hiddenByStyle = video.hidden || video.getAttribute('aria-hidden') === 'true';
  try {
    const style = documentRef.defaultView?.getComputedStyle(video);
    hiddenByStyle ||=
      style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0';
  } catch {
    return null;
  }
  if (hiddenByStyle) return null;

  const viewportWidth = Math.max(1, documentRef.defaultView?.innerWidth ?? rectangle.right);
  const viewportHeight = Math.max(1, documentRef.defaultView?.innerHeight ?? rectangle.bottom);
  const visibleWidth = Math.max(
    0,
    Math.min(rectangle.right, viewportWidth) - Math.max(rectangle.left, 0),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(rectangle.bottom, viewportHeight) - Math.max(rectangle.top, 0),
  );
  const visibleArea = visibleWidth * visibleHeight;
  if (
    visibleWidth < MIN_PLAYER_WIDTH ||
    visibleHeight < MIN_PLAYER_HEIGHT ||
    visibleArea < MIN_PLAYER_AREA
  ) {
    return null;
  }

  let metadataReady = false;
  try {
    metadataReady =
      video.readyState >= HTMLMediaElement.HAVE_METADATA ||
      (video.videoWidth > 0 && video.videoHeight > 0);
  } catch {
    return null;
  }
  if (!metadataReady || safeCurrentTime(video) === null) return null;

  let playing = false;
  try {
    playing = !video.paused && !video.ended;
  } catch {
    // Rendered area remains the primary signal when playback state is inaccessible.
  }
  const score = visibleArea * (playing ? 1.05 : 1);
  return { video, index, visibleArea, playing, score };
}

function subtitleContextFromTextTracks(
  video: HTMLVideoElement,
  timestampSeconds: number | null,
): SubtitleTrackExtraction {
  return timestampSeconds === null
    ? { context: null, diagnostics: [], available: false, unreadable: false }
    : extractSubtitleContextFromDomTextTracks(video, timestampSeconds);
}

function subtitleContextFromDomTranscript(
  documentRef: Document,
  timestampSeconds: number | null,
): SubtitleCandidateResult {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const rows = uniqueElements(
    BILIBILI_SELECTORS.transcriptRows.flatMap((selector) =>
      Array.from(documentRef.querySelectorAll(selector)),
    ),
  );
  const timedRows: SubtitleCueLike[] = [];
  for (const row of rows) {
    const selector = describeSubtitleCandidate(row);
    const startTime = readElementTime(row, ['data-subtitle-start', 'data-start-time']);
    const endTime = readElementTime(row, ['data-subtitle-end', 'data-end-time']);
    if (startTime === null || endTime === null || endTime <= startTime) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          'untimed_transcript_row',
          'Transcript rows require reliable start and end timestamps.',
          selector,
          row.textContent,
        ),
      );
      continue;
    }
    const textAssessment = assessDomSubtitleText(row, documentRef, 'timestamped_transcript_rows');
    rejectionReasons.push(...textAssessment.rejectionReasons);
    if (textAssessment.text === null) {
      continue;
    }
    timedRows.push({ startTime, endTime, text: textAssessment.text });
  }

  if (timestampSeconds === null || timedRows.length === 0) {
    return { context: null, rejectionReasons };
  }
  const context = selectSubtitleCues(timedRows, timestampSeconds, 'dom-transcript');
  return {
    context: context.status === 'timed_context' ? context : null,
    rejectionReasons,
  };
}

function subtitleContextFromVisibleOverlay(
  documentRef: Document,
  video: HTMLVideoElement | null | undefined,
): SubtitleCandidateResult {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const playerRoot = selectedBilibiliPlayerRoot(video);
  if (playerRoot === null) {
    return { context: null, rejectionReasons, candidateCount: 0 };
  }
  const videoRectangle = video ? safeRectangle(video) : null;
  const confirmedSelector = '.bili-subtitle-x-subtitle-panel-position';
  const selectorRoots = uniqueElements([
    ...Array.from(documentRef.querySelectorAll(confirmedSelector)).slice(0, 20),
    ...BILIBILI_SELECTORS.subtitleOverlays
      .filter((selector) => selector !== confirmedSelector)
      .flatMap((selector) => Array.from(playerRoot.querySelectorAll(selector)).slice(0, 20)),
  ]).slice(0, 40);
  const scopedRoots: Element[] = [];
  for (const root of selectorRoots) {
    const owner = root.closest(BILIBILI_PLAYER_ROOT_SELECTOR);
    const rectangle = safeRectangle(root);
    const portalIntersectsSelectedVideo =
      owner === null &&
      rectangle !== null &&
      videoRectangle !== null &&
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      rectangleOverlapRatio(rectangle, videoRectangle) >= 0.5;
    if (owner === playerRoot || portalIntersectsSelectedVideo) {
      scopedRoots.push(root);
      continue;
    }
    rejectionReasons.push(
      rejection(
        'visible_video_overlay',
        'outside_active_video',
        'The subtitle wrapper belongs to another player or does not intersect the selected video.',
        describeSubtitleCandidate(root),
        null,
      ),
    );
  }

  const candidates = new Map<string, number>();
  let visibleCandidateCount = 0;
  let elementCount = 0;
  const instanceStats: NonNullable<SubtitleCandidateResult['overlayStats']>['candidates'] = [];
  for (const root of scopedRoots) {
    const elements = subtitleOverlayCandidates(root);
    elementCount += elements.length;
    const instanceRejectionCodes = new Set<string>();
    for (const element of elements) {
      const selector = describeSubtitleCandidate(element);
      const assessment = assessDomSubtitleText(element, documentRef, 'visible_video_overlay');
      rejectionReasons.push(...assessment.rejectionReasons);
      for (const reason of assessment.rejectionReasons) {
        instanceRejectionCodes.add(reason.code);
      }
      const rectangle = safeRectangle(element);
      if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) {
        const reason = rejection(
          'visible_video_overlay',
          'zero_bounds',
          'Overlay candidates must have a non-zero rendered rectangle.',
          selector,
          assessment.text ?? element.textContent,
        );
        rejectionReasons.push(reason);
        instanceRejectionCodes.add(reason.code);
        continue;
      }
      const overlap = videoRectangle ? rectangleOverlapRatio(rectangle, videoRectangle) : 0;
      if (
        videoRectangle === null ||
        videoRectangle.width <= 0 ||
        videoRectangle.height <= 0 ||
        overlap < 0.5
      ) {
        const reason = rejection(
          'visible_video_overlay',
          'outside_active_video',
          'Overlay candidates must substantially overlap the selected active video.',
          selector,
          assessment.text ?? element.textContent,
        );
        rejectionReasons.push(reason);
        instanceRejectionCodes.add(reason.code);
        continue;
      }
      if (isElementTreeVisible(element, documentRef)) visibleCandidateCount += 1;
      if (assessment.text === null) continue;
      const verticalPosition =
        videoRectangle.height > 0
          ? (rectangle.bottom - videoRectangle.top) / videoRectangle.height
          : 0;
      const score = overlap * 100 + Math.min(1, Math.max(0, verticalPosition)) * 10;
      candidates.set(assessment.text, Math.max(candidates.get(assessment.text) ?? 0, score));
    }
    const rootRectangle = safeRectangle(root);
    const descendantCount = Math.min(root.querySelectorAll('*').length, 200);
    instanceStats.push({
      bounds:
        rootRectangle === null
          ? null
          : {
              x: Math.round(rootRectangle.x * 10) / 10,
              y: Math.round(rootRectangle.y * 10) / 10,
              width: Math.round(rootRectangle.width * 10) / 10,
              height: Math.round(rootRectangle.height * 10) / 10,
            },
      descendantCount,
      rejectionCodes: [...instanceRejectionCodes].sort(),
    });
  }

  const overlayStats: NonNullable<SubtitleCandidateResult['overlayStats']> = {
    selectorMatchCount: selectorRoots.length,
    activePlayerScopedCount: scopedRoots.length,
    visibleCandidateCount,
    acceptedCandidateCount: candidates.size,
    candidates: instanceStats.slice(0, 20),
  };

  const selected = [...candidates.entries()]
    .map(([text, score]) => ({ text, score }))
    .sort((left, right) => right.score - left.score)[0];
  if (!selected) {
    return { context: null, rejectionReasons, candidateCount: elementCount, overlayStats };
  }
  const cueData: SubtitleCueData[] = [
    {
      startTime: null,
      endTime: null,
      text: selected.text,
      source: 'visible-overlay',
    },
  ];
  return {
    context: createSubtitleContext({
      status: 'current_only',
      extractionStrategy: 'visible_video_overlay',
      confidence: 'medium',
      before: [],
      current: [selected.text],
      after: [],
      timedCues: [],
      diagnostics: [],
      rejectionReasons: [],
      compatibilityCueData: cueData,
    }),
    rejectionReasons,
    candidateCount: elementCount,
    overlayStats,
  };
}

const BILIBILI_PLAYER_ROOT_SELECTOR = [
  '.bpx-player-container',
  '.bilibili-player',
  '#bilibili-player',
  '.bilibili-player-video-wrap',
].join(',');

function selectedBilibiliPlayerRoot(video: HTMLVideoElement | null | undefined): Element | null {
  return video?.closest(BILIBILI_PLAYER_ROOT_SELECTOR) ?? null;
}

function subtitleOverlayCandidates(root: Element): Element[] {
  const descendants = Array.from(root.querySelectorAll('*'))
    .filter((element) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === 3 && normalizeText(node.textContent ?? '').length > 0,
      ),
    )
    .slice(0, 80);
  return uniqueElements([...descendants, root]);
}

function summariseRejectionCodes(reasons: readonly SubtitleRejectionReason[]): string {
  if (reasons.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code}:${count}`)
    .join(', ');
}

function chapterFromTextTracks(video: HTMLVideoElement, timestampSeconds: number): string | null {
  for (const track of indexedList(video.textTracks)) {
    if (track.kind !== 'chapters') {
      continue;
    }
    const cue = cueList(track.cues).find(
      (candidate) =>
        candidate.startTime <= timestampSeconds && candidate.endTime > timestampSeconds,
    );
    if (cue) {
      return cue.text;
    }
  }
  return null;
}

function chapterFromDom(documentRef: Document, timestampSeconds: number | null): string | null {
  for (const selector of BILIBILI_SELECTORS.activeChapters) {
    const element = documentRef.querySelector(selector);
    const text = normalizeText(element?.textContent ?? '');
    if (text.length > 0) {
      return text;
    }
  }

  if (timestampSeconds === null) {
    return null;
  }
  const timedChapters = Array.from(documentRef.querySelectorAll('[data-chapter-start]'))
    .map((element) => ({
      start: readElementTime(element, ['data-chapter-start']),
      text: normalizeText(element.textContent ?? ''),
    }))
    .filter(
      (entry): entry is { start: number; text: string } =>
        entry.start !== null && entry.text.length > 0,
    )
    .sort((left, right) => left.start - right.start);
  return timedChapters.filter((entry) => entry.start <= timestampSeconds).at(-1)?.text ?? null;
}

export function chapterFromTimestampHeadings(
  description: string,
  timestampSeconds: number,
): string | null {
  const headings = description
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(\S.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ start: parseTimestamp(match[1]!), title: normalizeText(match[2]!) }))
    .filter(
      (entry): entry is { start: number; title: string } =>
        entry.start !== null && entry.title.length > 0,
    )
    .sort((left, right) => left.start - right.start);
  return headings.filter((entry) => entry.start <= timestampSeconds).at(-1)?.title ?? null;
}

function readElementTime(element: Element, attributes: readonly string[]): number | null {
  for (const attribute of attributes) {
    const raw = normalizeText(element.getAttribute(attribute) ?? '');
    if (raw.length === 0) {
      continue;
    }
    const parsed = raw.includes(':') ? parseTimestamp(raw) : Number(raw);
    if (parsed !== null && isValidTimeSeconds(parsed)) {
      return parsed;
    }
  }
  return null;
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

function cueList(list: TextTrackCueList | null): SubtitleCueLike[] {
  if (list === null) {
    return [];
  }
  const cues: SubtitleCueLike[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const cue = list[index] as (TextTrackCue & { text?: unknown }) | undefined;
    if (
      cue &&
      typeof cue.text === 'string' &&
      Number.isFinite(cue.startTime) &&
      Number.isFinite(cue.endTime) &&
      normalizeText(cue.text).length > 0
    ) {
      cues.push({ startTime: cue.startTime, endTime: cue.endTime, text: normalizeText(cue.text) });
    }
  }
  return cues;
}

function uniqueCues(cues: readonly SubtitleCueLike[], seen: Set<string>): SubtitleCueLike[] {
  const unique: SubtitleCueLike[] = [];
  for (const cue of cues) {
    if (!seen.has(cue.text)) {
      seen.add(cue.text);
      unique.push(cue);
    }
  }
  return unique;
}

function uniqueElements(elements: Element[]): Element[] {
  return Array.from(new Set(elements));
}

const EXCLUDED_SUBTITLE_UI_SELECTOR = [
  'button',
  'menu',
  'dialog',
  'select',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="toolbar"]',
  '[aria-modal="true"]',
  '.bpx-player-control-wrap',
  '.bpx-player-control-bottom',
  '.bpx-player-ctrl-setting',
  '.bpx-player-setting-area',
  '.bilibili-player-video-btn-setting',
  '.bpx-player-dm-wrap',
  '[class*="danmaku" i]',
  '[class*="danmu" i]',
  '[class*="barrage" i]',
  '[class*="subtitle-setting" i]',
  '[class*="caption-setting" i]',
  '[class*="setting" i]',
  '[class*="control-panel" i]',
  '[class*="configuration" i]',
].join(',');

const SETTINGS_TEXT_FRAGMENTS = [
  '字幕大小',
  '字幕颜色',
  '恢复默认设置',
  'B站自研的AI原声翻译功能',
] as const;

const SUBTITLE_UI_LABELS = [
  '字幕',
  '关闭',
  '登录可享',
  '添加字幕',
  '暂无字幕',
  '字幕设置',
  '字幕大小',
  '字幕颜色',
  '描边方式',
  '默认位置',
  '背景不透明度',
  '其它设置',
  '恢复默认设置',
  'subtitles',
  'captions',
  'settings',
  'off',
  'color',
  'size',
] as const;

function assessDomSubtitleText(
  element: Element,
  documentRef: Document,
  strategy: 'timestamped_transcript_rows' | 'visible_video_overlay',
): { text: string | null; rejectionReasons: SubtitleRejectionReason[] } {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const selector = describeSubtitleCandidate(element);
  if (!isElementTreeVisible(element, documentRef)) {
    rejectionReasons.push(
      rejection(
        strategy,
        'hidden',
        'Hidden or aria-hidden subtitle candidates are ignored.',
        selector,
        element.textContent,
      ),
    );
  }
  if (element.closest(EXCLUDED_SUBTITLE_UI_SELECTOR)) {
    rejectionReasons.push(
      rejection(
        strategy,
        'excluded_ui_ancestor',
        'The candidate belongs to player controls, a menu, dialog, or settings interface.',
        selector,
        element.textContent,
      ),
    );
  }

  const text = collectVisibleSubtitleText(element, documentRef);
  if (text.length === 0) {
    rejectionReasons.push(
      rejection(
        strategy,
        'empty_text',
        'The candidate had no visible spoken-subtitle text.',
        selector,
        null,
      ),
    );
  }
  const settingsMatches = SETTINGS_TEXT_FRAGMENTS.filter((fragment) => text.includes(fragment));
  if (settingsMatches.length >= 2 || text.includes('B站自研的AI原声翻译功能')) {
    rejectionReasons.push(
      rejection(
        strategy,
        'settings_text',
        'The candidate contains multiple strong subtitle-settings signals.',
        selector,
        text,
      ),
    );
  }
  if (text.length > 280) {
    rejectionReasons.push(
      rejection(
        strategy,
        'overlong_text',
        'The candidate is too long to be a current subtitle overlay or transcript row.',
        selector,
        text,
      ),
    );
  }
  const labelOccurrences = SUBTITLE_UI_LABELS.reduce(
    (count, label) => count + countOccurrences(text.toLocaleLowerCase(), label.toLocaleLowerCase()),
    0,
  );
  const approximateTokenCount = Math.max(1, text.split(/\s+/).length);
  if (labelOccurrences >= 4 && labelOccurrences / approximateTokenCount >= 0.2) {
    rejectionReasons.push(
      rejection(
        strategy,
        'high_ui_label_density',
        'The candidate contains a high density of player-interface labels.',
        selector,
        text,
      ),
    );
  }

  return { text: rejectionReasons.length === 0 ? text : null, rejectionReasons };
}

function collectVisibleSubtitleText(element: Element, documentRef: Document): string {
  const walker = documentRef.createTreeWalker(element, 4);
  const fragments: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (
      parent &&
      isElementTreeVisible(parent, documentRef) &&
      !hasExcludedDescendantAncestor(parent, element)
    ) {
      const text = normalizeText(node.textContent ?? '');
      if (text.length > 0 && !fragments.includes(text)) {
        fragments.push(text);
      }
    }
    node = walker.nextNode();
  }
  return normalizeText(fragments.join(' '));
}

function hasExcludedDescendantAncestor(element: Element, boundary: Element): boolean {
  let current: Element | null = element;
  while (current && current !== boundary) {
    if (current.matches(EXCLUDED_SUBTITLE_UI_SELECTOR)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isElementTreeVisible(element: Element, documentRef: Document): boolean {
  let current: Element | null = element;
  while (current) {
    const htmlElement = current as HTMLElement;
    if (
      htmlElement.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.classList.contains('sr-only') ||
      current.classList.contains('visually-hidden') ||
      current.classList.contains('screen-reader-only')
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
  return true;
}

function safeRectangle(element: Element): DOMRect | null {
  try {
    return element.getBoundingClientRect();
  } catch {
    return null;
  }
}

function rectangleOverlapRatio(candidate: DOMRect, video: DOMRect): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(candidate.right, video.right) - Math.max(candidate.left, video.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(candidate.bottom, video.bottom) - Math.max(candidate.top, video.top),
  );
  const candidateArea = candidate.width * candidate.height;
  return candidateArea > 0 ? (intersectionWidth * intersectionHeight) / candidateArea : 0;
}

function countOccurrences(value: string, fragment: string): number {
  if (fragment.length === 0) return 0;
  let count = 0;
  let index = value.indexOf(fragment);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(fragment, index + fragment.length);
  }
  return count;
}

function describeSubtitleCandidate(element: Element): string {
  const className = Array.from(element.classList).slice(0, 3).join('.');
  return `${element.tagName.toLowerCase()}${className ? `.${className}` : ''}`;
}

function rejection(
  strategy: SubtitleRejectionReason['strategy'],
  code: SubtitleRejectionReason['code'],
  message: string,
  selector: string | null,
  text: string | null,
): SubtitleRejectionReason {
  let preview = normalizeText(text ?? '');
  for (const fragment of SETTINGS_TEXT_FRAGMENTS) {
    preview = preview.replaceAll(fragment, '[settings text]');
  }
  preview = preview.slice(0, 120);
  return {
    strategy,
    code,
    message,
    selector,
    textPreview: preview.length > 0 ? preview : null,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeRetrySchedule(schedule: readonly number[]): number[] {
  const normalized = Array.from(
    new Set(
      schedule
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.floor(value)),
    ),
  ).sort((left, right) => left - right);
  return normalized.length > 0 ? normalized : [0];
}

function safeCurrentTime(video: HTMLVideoElement | null | undefined): number | null {
  if (!video) {
    return null;
  }
  try {
    const currentTime = video.currentTime;
    return isValidTimeSeconds(currentTime) ? currentTime : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

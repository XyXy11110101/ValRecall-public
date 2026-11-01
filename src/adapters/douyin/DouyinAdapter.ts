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
  mergeDiagnostics,
  readVideoBounds,
  readVideoCurrentTime,
  readVideoDuration,
  rectangleOverlapRatio,
  safeRectangle,
} from '../shared/video';
import type {
  AdapterLocation,
  CapturePreparationOptions,
  CapturePreparationResult,
  SeekOptions,
  VideoCaptureMetadata,
  VideoPlatformAdapter,
} from '../types';
import { DOUYIN_VIDEO_ID_PATTERN, parseDouyinVideoUrl } from './url';

export const DOUYIN_SELECTORS = {
  videos: [
    '[data-e2e="detail-video-player"] video',
    '[data-e2e="video-player"] video',
    '.xgplayer video',
    'main video',
    'video',
  ],
  playerRoots: ['[data-e2e="detail-video-player"]', '[data-e2e="video-player"]', '.xgplayer'],
  workContainers: [
    '[data-e2e="video-detail"]',
    '[data-e2e="video-detail-container"]',
    'article[data-e2e*="video"]',
  ],
  workCaptions: [
    '[data-e2e="video-desc"]',
    '[data-e2e="video-title"]',
    '[data-e2e="detail-video-desc"]',
  ],
  uploaders: [
    '[data-e2e="video-author"]',
    '[data-e2e="detail-video-author"]',
    '[data-e2e="author-name"]',
  ],
  descriptions: [
    '[data-e2e="video-desc"]',
    '[data-e2e="detail-video-desc"]',
    '[data-e2e="video-description"]',
  ],
  transcriptRows: ['[data-e2e="video-transcript-item"]', '[data-e2e="caption-transcript-item"]'],
  transcriptTimes: ['[data-e2e="transcript-time"]', '[data-e2e="caption-time"]'],
  transcriptText: ['[data-e2e="transcript-text"]', '[data-e2e="caption-text"]'],
  subtitleOverlays: [
    '[data-e2e="video-subtitle"]',
    '[data-e2e="caption-overlay"]',
    '.xgplayer-texttrack',
  ],
  chapters: ['[data-e2e="video-chapter"]', '.xgplayer-chapter-name'],
  modalRoots: [
    '[aria-modal="true"]',
    '[role="dialog"]',
    '[data-e2e="video-modal"]',
    '[data-e2e="modal-video"]',
    '[data-e2e*="video-modal"]',
  ],
  explicitAds: ['[data-e2e="video-ad"]', '[data-ad-video="true"]', 'video[data-ad="true"]'],
  explicitPreviews: [
    '[data-e2e="video-preview"]',
    '[data-preview-video="true"]',
    '[data-background-video="true"]',
  ],
} as const;

const EXCLUDED_DOUYIN_TEXT_UI = [
  'button',
  'menu',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="toolbar"]',
  '[data-e2e="comment-list"]',
  '[data-e2e="recommend-list"]',
  '.xgplayer-controls',
].join(',');

const PLAYER_ROOT_SELECTOR = DOUYIN_SELECTORS.playerRoots.join(',');
const WORK_CONTAINER_SELECTOR = DOUYIN_SELECTORS.workContainers.join(',');
const EXPLICIT_AD_SELECTOR = DOUYIN_SELECTORS.explicitAds.join(',');
const EXPLICIT_PREVIEW_SELECTOR = DOUYIN_SELECTORS.explicitPreviews.join(',');
const MODAL_ROOT_SELECTOR = DOUYIN_SELECTORS.modalRoots.join(',');
const MINIMUM_VISIBLE_INTERSECTION_AREA = 4;
const DOMINANT_AREA_MULTIPLIER = 1.6;
const MINIMUM_MODAL_FREE_VISIBLE_RATIO = 0.055;
const LARGE_VIEWPORT_VIDEO_RATIO = 0.12;
const SIMILAR_VISIBLE_AREA_RATIO = 0.84;
const DEFAULT_CAPTURE_RETRY_SCHEDULE_MS = [0, 150, 350, 700, 1_200, 2_000] as const;

interface VideoCandidate {
  video: HTMLVideoElement;
  documentIndex: number;
  rectangle: DOMRect;
  area: number;
  visibleArea: number;
  viewportOverlap: number;
  associationTier: number;
  playing: boolean;
  metadataReady: boolean;
  intrinsicDimensions: boolean;
  currentTimePositive: boolean;
  modalOverlap: number;
  viewportAreaRatio: number;
  centreProximity: number;
  topLayerScore: number | null;
  topLayerSamples: number;
  score: number;
}

interface CandidateScan {
  candidates: VideoCandidate[];
  rejected: Map<string, number>;
  visibleButLoading: number;
}

interface CandidateSelection {
  candidate: VideoCandidate | null;
  competitor: VideoCandidate | null;
  confidence:
    | 'direct-associated'
    | 'modal-evidence'
    | 'large-viewport'
    | 'dominant-area'
    | 'only-meaningful-video'
    | 'primary-visual-layer'
    | 'insufficient'
    | 'ambiguous';
  reason: string;
  areaRatioToCompetitor: number | null;
}

interface ScopedSubtitleExtraction {
  context: SubtitleContext | null;
  rejectionReasons: SubtitleRejectionReason[];
}

interface DouyinCaptureEvidence {
  videoId: string;
  surface: 'direct' | 'modal';
  originalUrl: string;
  video: HTMLVideoElement;
  modalSurfaceDetectedAtCapture: boolean;
  timestampSeconds: number;
  bounds: VideoBounds;
  candidateScore: number;
}

type TextStrategy = readonly [string, () => string | null];

export class DouyinAdapter implements VideoPlatformAdapter {
  readonly platform = 'douyin' as const;
  readonly document: Document;
  readonly location: AdapterLocation;
  private readonly pageSubtitleSnapshot: unknown;
  private lastCaptureEvidence: DouyinCaptureEvidence | null = null;
  private lastDetectedIdentity: ReturnType<typeof parseDouyinVideoUrl> = null;

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
    const parsed = parseDouyinVideoUrl(this.location.href);
    this.lastDetectedIdentity = parsed;
    return {
      value: {
        supported: parsed !== null,
        platform: parsed === null ? null : 'douyin',
        videoId: parsed?.videoId ?? null,
      },
      diagnostics: [
        diagnostic(
          'page',
          'douyin-video-url-identity',
          parsed === null ? 'failed' : 'success',
          parsed === null
            ? 'The current URL has neither a supported direct-video path nor one unambiguous numeric modal_id.'
            : parsed.surface === 'direct'
              ? 'Supported Douyin direct-video page detected.'
              : 'Supported Douyin modal-video identity detected.',
          parsed === null ? 'error' : 'info',
        ),
      ],
    };
  }

  async prepareCapture(options: CapturePreparationOptions = {}): Promise<CapturePreparationResult> {
    const schedule = normalizeRetrySchedule(
      options.retryScheduleMs ?? DEFAULT_CAPTURE_RETRY_SCHEDULE_MS,
    );
    const wait = options.wait ?? delay;
    const initialIdentity = this.lastDetectedIdentity ?? parseDouyinVideoUrl(this.location.href);
    let previousTarget = 0;
    let failure: CapturePreparationResult = {
      ok: false,
      reason: 'NO_VISIBLE_VIDEO',
      message: 'No visible video was found for the current Douyin item.',
    };

    for (let attempt = 0; attempt < schedule.length; attempt += 1) {
      const target = schedule[attempt]!;
      if (target > previousTarget) await wait(target - previousTarget);
      previousTarget = target;

      const currentIdentity = parseDouyinVideoUrl(this.location.href);
      if (initialIdentity === null) {
        return {
          ok: false,
          reason: 'UNSTABLE_VIDEO',
          message: 'The Douyin video changed during capture. Try again.',
        };
      }
      if (currentIdentity === null) {
        return initialIdentity.surface === 'modal'
          ? {
              ok: false,
              reason: 'PANEL_NOT_OPEN',
              message: 'Open the video panel before capturing.',
            }
          : {
              ok: false,
              reason: 'UNSTABLE_VIDEO',
              message: 'The Douyin video changed during capture. Try again.',
            };
      }
      if (currentIdentity.videoId !== initialIdentity.videoId) {
        return {
          ok: false,
          reason: 'UNSTABLE_VIDEO',
          message: 'The Douyin video changed during capture. Try again.',
        };
      }

      const result = this.findVideoElement();
      this.recordCaptureDiagnostics(attempt + 1, result.value);
      if (result.value !== null) return { ok: true };
      failure = classifyPreparationFailure(this.document, this.location.href);
    }

    return failure;
  }

  findVideoElement(): ExtractionResult<HTMLVideoElement | null> {
    const parsed = parseDouyinVideoUrl(this.location.href);
    if (parsed === null) {
      return {
        value: null,
        diagnostics: [
          diagnostic(
            'video',
            'douyin-video-identity',
            'failed',
            'A validated direct-path or modal Douyin video ID is required before player selection.',
            'error',
          ),
        ],
      };
    }

    if (
      parsed.surface === 'direct' &&
      hasMismatchedDeclaredPageIdentity(this.document, parsed.videoId)
    ) {
      return {
        value: null,
        diagnostics: [
          diagnostic(
            'video',
            'douyin-stale-page-identity',
            'failed',
            'The direct-page URL changed before Douyin finished replacing the previous video metadata.',
            'error',
          ),
        ],
      };
    }

    const modalRoot =
      parsed.surface === 'modal'
        ? findVisibleModalSurface(this.document, parsed.videoId, this.location.href)
        : null;

    // Modal controls and the media element can be rendered through separate portal
    // roots, and some profile/favourites layouts expose no recognisable modal
    // container at all. Enumerate the whole document; modal overlap is optional score
    // evidence, never a prerequisite for a high-confidence dominant video.
    const videos = Array.from(this.document.querySelectorAll<HTMLVideoElement>('video'));
    const scan = scanVideoCandidates(
      videos,
      this.document,
      parsed.videoId,
      this.location.href,
      parsed.surface,
      modalRoot,
    );
    const diagnostics = [
      diagnostic(
        'video',
        'douyin-modal-surface-evidence',
        modalRoot === null ? 'skipped' : 'success',
        modalRoot === null
          ? 'No recognised modal surface was available; player selection uses visual dominance and stable URL identity.'
          : 'A recognised modal surface is available only as optional overlap score evidence.',
      ),
      ...candidateDiagnostics(videos.length, scan.rejected),
    ];
    if (scan.candidates.length === 0) {
      diagnostics.push(
        diagnostic(
          'video',
          'douyin-reliable-active-video',
          'failed',
          parsed.surface === 'modal'
            ? 'No reliable visible Douyin video was available for the current modal_id.'
            : 'No reliable visible Douyin video could be associated with the direct video page.',
          'error',
        ),
      );
      return { value: null, diagnostics };
    }

    const selection = selectDominantCandidate(
      scan.candidates,
      parsed.surface,
      modalRoot,
      this.document,
    );
    if (selection.confidence === 'ambiguous') {
      diagnostics.push(
        diagnostic(
          'video',
          'douyin-ambiguous-active-video',
          'failed',
          'Multiple similarly sized visible Douyin videos lacked reliable distinguishing evidence, so ValRecall did not guess.',
          'error',
        ),
      );
      return { value: null, diagnostics };
    }
    const selected = selection.candidate;
    if (selected === null) {
      diagnostics.push(
        diagnostic(
          'video',
          'douyin-low-confidence-active-video',
          'failed',
          selection.reason,
          'error',
        ),
      );
      return { value: null, diagnostics };
    }

    diagnostics.push(
      diagnostic(
        'video',
        'douyin-dominant-visible-video',
        'success',
        `Selected one of ${videos.length} Douyin video element(s) with ${selection.confidence} confidence and score ${Math.round(selected.score)}: ${selected.playing ? 'playing, ' : ''}${Math.round(
          selected.viewportOverlap * 100,
        )}% of its rendered bounds visible, ${Math.round(selected.viewportAreaRatio * 100)}% of the viewport, visible area ${Math.round(selected.visibleArea)}px squared.`,
      ),
    );
    return { value: selected.video, diagnostics };
  }

  private recordCaptureDiagnostics(attempt: number, selected: HTMLVideoElement | null): void {
    if (!import.meta.env.DEV) return;
    const parsed = parseDouyinVideoUrl(this.location.href);
    const videos = Array.from(this.document.querySelectorAll<HTMLVideoElement>('video'));
    const modalRoot =
      parsed?.surface === 'modal'
        ? findVisibleModalSurface(this.document, parsed.videoId, this.location.href)
        : null;
    const scan =
      parsed === null
        ? null
        : scanVideoCandidates(
            videos,
            this.document,
            parsed.videoId,
            this.location.href,
            parsed.surface,
            modalRoot,
          );
    const candidateByVideo = new Map(
      scan?.candidates.map((candidate) => [candidate.video, candidate]),
    );
    const selection =
      parsed === null || scan === null
        ? null
        : selectDominantCandidate(scan.candidates, parsed.surface, modalRoot, this.document);
    const candidates = videos.map((video, index) =>
      captureDebugCandidate(
        video,
        index,
        this.document,
        parsed?.videoId ?? null,
        parsed?.surface ?? null,
        this.location.href,
        selected,
        candidateByVideo.get(video) ?? null,
        scan?.candidates ?? [],
      ),
    );

    console.info('[ValRecall][Douyin capture diagnostics]', {
      attempt,
      currentFullUrl: this.location.href,
      resolvedVideoId: parsed?.videoId ?? null,
      identitySource:
        parsed === null ? 'unsupported' : parsed.surface === 'direct' ? 'direct-path' : 'modal_id',
      totalVideos: videos.length,
      connectedVideos: candidates.filter((candidate) => candidate.connected).length,
      visibleVideos: candidates.filter((candidate) => candidate.visible).length,
      modalSurfaceDetected: modalRoot !== null,
      modalSurfaceUsedOnlyAsOptionalScore: parsed?.surface === 'modal',
      candidates,
      finalDominanceConfidence: selection?.confidence ?? null,
      noCandidateAcceptedReason:
        selection === null || selection.candidate !== null ? null : selection.reason,
      finalSelectedCandidate:
        selected === null ? null : videos.findIndex((candidate) => candidate === selected),
    });
  }

  private getMetadataScope(video: HTMLVideoElement | null): Element | null {
    const parsed = parseDouyinVideoUrl(this.location.href);
    if (parsed?.surface === 'modal') {
      return (
        findVisibleModalSurface(this.document, parsed.videoId, this.location.href) ??
        findWorkScope(video)
      );
    }
    return findWorkScope(video);
  }

  getVideoTitle(videoElement?: HTMLVideoElement | null): ExtractionResult<string | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const scope = this.getMetadataScope(videoResult.value);
    const parsed = parseDouyinVideoUrl(this.location.href);
    const videoId = parsed?.videoId ?? null;
    const strategies: TextStrategy[] = [
      [
        'visible-associated-work-caption',
        () =>
          cleanWorkCaption(readVisibleFirst(scope, this.document, DOUYIN_SELECTORS.workCaptions)),
      ],
      [
        'associated-open-graph-title',
        () => readAssociatedOpenGraphTitle(this.document, this.location.href),
      ],
    ];
    if (parsed?.surface === 'direct') {
      strategies.push([
        'cleaned-document-title',
        () => cleanDouyinDocumentTitle(this.document.title),
      ]);
    }
    strategies.push([
      'validated-video-id-fallback',
      () => (videoId === null ? null : `Douyin video ${videoId}`),
    ]);
    const result = runTextStrategies('videoTitle', strategies);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
  }

  getCanonicalUrl(): ExtractionResult<string | null> {
    const parsed = parseDouyinVideoUrl(this.location.href);
    return {
      value: parsed?.canonicalUrl ?? null,
      diagnostics: [
        diagnostic(
          'canonicalUrl',
          'douyin-validated-video-id',
          parsed === null ? 'failed' : 'success',
          parsed === null
            ? 'A canonical Douyin URL could not be built.'
            : 'Built the canonical direct Douyin URL from the validated numeric video ID.',
        ),
      ],
    };
  }

  getVideoId(): ExtractionResult<string | null> {
    const parsed = parseDouyinVideoUrl(this.location.href);
    const videoId = parsed?.videoId ?? null;
    return {
      value: videoId,
      diagnostics: [
        diagnostic(
          'videoId',
          parsed?.surface === 'modal' ? 'douyin-modal-id-query' : 'douyin-direct-video-path',
          videoId === null ? 'failed' : 'success',
          videoId === null
            ? 'A numeric Douyin video ID was not available.'
            : parsed?.surface === 'modal'
              ? 'Read the numeric Douyin video ID from one unambiguous modal_id.'
              : 'Read the numeric Douyin video ID from the validated direct path.',
        ),
      ],
    };
  }

  getUploader(videoElement?: HTMLVideoElement | null): ExtractionResult<string | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const scope = this.getMetadataScope(videoResult.value);
    const structured = findStructuredVideoRecord(
      this.document,
      parseDouyinVideoUrl(this.location.href)?.videoId ?? null,
    );
    const result = runTextStrategies('uploader', [
      [
        'visible-associated-author',
        () => readVisibleFirst(scope, this.document, DOUYIN_SELECTORS.uploaders),
      ],
      ['associated-structured-author', () => structuredAuthor(structured)],
    ]);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
  }

  getDescription(videoElement?: HTMLVideoElement | null): ExtractionResult<string | null> {
    const videoResult =
      videoElement === undefined
        ? this.findVideoElement()
        : { value: videoElement, diagnostics: [] };
    const scope = this.getMetadataScope(videoResult.value);
    const result = runTextStrategies('description', [
      [
        'visible-associated-description',
        () => readVisibleFirst(scope, this.document, DOUYIN_SELECTORS.descriptions),
      ],
      [
        'associated-open-graph-description',
        () => readAssociatedOpenGraph(this.document, this.location.href, 'og:description'),
      ],
    ]);
    return { value: result.value, diagnostics: mergeDiagnostics(videoResult, result) };
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
    const result = readDouyinVideoBounds(videoResult.value, this.document);
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
            'Read bounded subtitle context from the selected Douyin player track.',
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
            'Read timed subtitle context from the selected Douyin video text track.',
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
          'No selected Douyin player track exposed a cue at the captured timestamp.',
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
          'A reliable video and timestamp are required for timed text-track subtitles.',
        ),
      );
    }

    const transcript = subtitleContextFromTranscript(
      findWorkScope(video),
      this.document,
      timestamp,
      duration,
    );
    rejectionReasons.push(...transcript.rejectionReasons);
    if (transcript.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'timestamped_transcript_rows',
          'success',
          'Read subtitle context from visible, scoped, timestamped Douyin transcript rows.',
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
        'No reliable scoped Douyin transcript row overlapped the captured timestamp.',
      ),
      diagnostic(
        'subtitles',
        'subtitle-transcript-fallback',
        'failed',
        'The timestamped transcript fallback did not yield a cue.',
      ),
    );

    const overlay = subtitleContextFromOverlay(findWorkScope(video), this.document, video);
    rejectionReasons.push(...overlay.rejectionReasons);
    if (overlay.context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'visible_video_overlay',
          'success',
          'Read only visible caption text bounded by the selected Douyin video.',
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
        'No safe visible Douyin caption overlay overlapped the selected video.',
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
          : 'The current Douyin player exposed no available subtitle source.',
        'warning',
      ),
      diagnostic(
        'subtitles',
        'no-accessible-subtitles',
        'failed',
        'No accessible Douyin subtitles were available; subtitles remain optional.',
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
              'Read the current chapter from an exposed chapter text track.',
            ),
          );
          return { value: chapter, diagnostics };
        }
        diagnostics.push(
          diagnostic(
            'chapter',
            'chapter-text-track',
            'failed',
            'No accessible chapter cue matched the captured timestamp.',
          ),
        );
      } catch {
        diagnostics.push(
          diagnostic(
            'chapter',
            'chapter-text-track',
            'failed',
            'The selected Douyin video did not expose a readable chapter track.',
          ),
        );
      }
    } else {
      diagnostics.push(
        diagnostic(
          'chapter',
          'chapter-text-track',
          'skipped',
          'A reliable video and timestamp are required for chapter tracks.',
        ),
      );
    }

    const visibleChapter = readVisibleFirst(
      findWorkScope(video),
      this.document,
      DOUYIN_SELECTORS.chapters,
    );
    diagnostics.push(
      diagnostic(
        'chapter',
        'visible-associated-chapter',
        visibleChapter === null ? 'failed' : 'success',
        visibleChapter === null
          ? 'No reliable visible Douyin chapter label was available.'
          : 'Read the visible chapter label associated with the selected Douyin video.',
      ),
    );
    return { value: visibleChapter, diagnostics };
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

    const maxAttempts = clampInteger(options.maxAttempts ?? 3, 1, 10);
    const retryDelayMs = clampInteger(options.retryDelayMs ?? 250, 0, 5_000);
    const pauseAfterSeek = options.pauseAfterSeek ?? true;
    const wait = options.wait ?? delay;
    const diagnostics: ExtractionDiagnostic[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const videoResult = this.findVideoElement();
      diagnostics.push(...videoResult.diagnostics);
      const video = videoResult.value;
      if (video === null) {
        diagnostics.push(
          diagnostic(
            'seek',
            `attempt-${attempt}`,
            'failed',
            'A reliable active Douyin video was not ready.',
          ),
        );
      } else {
        try {
          video.currentTime = timestampSeconds;
          if (pauseAfterSeek) video.pause();
          const observedTimestamp = safeCurrentTime(video);
          const stillSelected = video.isConnected && this.findVideoElement().value === video;
          if (
            !stillSelected ||
            observedTimestamp === null ||
            Math.abs(observedTimestamp - timestampSeconds) > 2
          ) {
            diagnostics.push(
              diagnostic(
                'seek',
                `attempt-${attempt}`,
                'failed',
                !stillSelected
                  ? 'Douyin replaced the selected video before the seek could be verified.'
                  : observedTimestamp === null
                    ? 'The selected Douyin video did not expose a readable position after seeking.'
                    : `The selected Douyin video remained ${Math.abs(observedTimestamp - timestampSeconds).toFixed(1)} seconds from the saved timestamp.`,
              ),
            );
            if (attempt < maxAttempts) await wait(retryDelayMs);
            continue;
          }
          diagnostics.push(
            diagnostic(
              'seek',
              `attempt-${attempt}`,
              'success',
              'The selected Douyin video was moved to the saved timestamp.',
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
      if (attempt < maxAttempts) await wait(retryDelayMs);
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
    const parsed = parseDouyinVideoUrl(this.location.href);
    const title = this.getVideoTitle(video.value);
    const canonical = this.getCanonicalUrl();
    const videoId = this.getVideoId();
    const uploader = this.getUploader(video.value);
    const description = this.getDescription(video.value);
    const timestamp = this.getCurrentTime(video.value);
    const duration = this.getVideoDuration(video.value);
    const bounds = this.getVideoBounds(video.value);
    const subtitles = this.getSubtitleContext(video.value, timestamp.value, duration.value);
    const chapter = this.getChapter(video.value, timestamp.value);
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
    const captureCandidate = currentVideoCandidate(this.document, this.location.href, video.value);
    this.lastCaptureEvidence =
      parsed !== null &&
      video.value !== null &&
      timestamp.value !== null &&
      bounds.value !== null &&
      captureCandidate !== null
        ? {
            videoId: parsed.videoId,
            surface: parsed.surface,
            originalUrl: this.location.href,
            video: video.value,
            modalSurfaceDetectedAtCapture:
              parsed.surface === 'modal' &&
              findVisibleModalSurface(this.document, parsed.videoId, this.location.href) !== null,
            timestampSeconds: timestamp.value,
            bounds: bounds.value,
            candidateScore: captureCandidate.score,
          }
        : null;

    return {
      value: {
        sourceUrl: parsed?.surface === 'modal' ? parsed.canonicalUrl : this.location.href,
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
      const fail = (reason: string): false => {
        if (import.meta.env.DEV) {
          console.info('[ValRecall][Douyin capture identity check]', {
            ok: false,
            reason,
            expectedVideoId: evidence.videoId,
            captureUrl: evidence.originalUrl,
            currentFullUrl: this.location.href,
            modalSurfaceDetectedAtCapture: evidence.modalSurfaceDetectedAtCapture,
          });
        }
        return false;
      };
      const current = parseDouyinVideoUrl(this.location.href);
      if (current === null || current.videoId !== evidence.videoId) {
        return fail('resolved-video-identity-changed');
      }
      const selected = this.findVideoElement().value;
      if (selected === null || !selected.isConnected) return fail('selected-video-unavailable');
      const candidate = currentVideoCandidate(this.document, this.location.href, selected);
      const bounds = readDouyinVideoBounds(selected, this.document).value;
      if (candidate === null || bounds === null || safeCurrentTime(selected) === null) {
        return fail('selected-video-no-longer-stable');
      }

      // A same-ID modal-to-direct SPA transition is safe after the direct player is
      // independently reselected. Other surface changes remain conservative.
      if (evidence.surface === 'modal' && current.surface === 'direct') return true;
      if (current.surface !== evidence.surface || selected !== evidence.video) {
        return fail('capture-surface-or-player-replaced');
      }
      if (current.surface === 'direct') return true;

      const valid =
        selected === evidence.video &&
        safeCurrentTime(evidence.video) !== null &&
        evidence.timestampSeconds >= 0 &&
        evidence.bounds.width > 0 &&
        evidence.bounds.height > 0 &&
        evidence.candidateScore >= 0;
      return valid || fail('modal-video-no-longer-dominant-or-stable');
    };
  }
}

function scanVideoCandidates(
  videos: readonly HTMLVideoElement[],
  documentRef: Document,
  videoId: string,
  pageUrl: string,
  surface: 'direct' | 'modal',
  modalRoot: Element | null,
): CandidateScan {
  const candidates: VideoCandidate[] = [];
  const rejected = new Map<string, number>();
  let visibleButLoading = 0;
  const modalRectangle = modalRoot === null ? null : safeRectangle(modalRoot);
  const viewportWidth = documentRef.defaultView?.innerWidth ?? 0;
  const viewportHeight = documentRef.defaultView?.innerHeight ?? 0;
  const viewportArea = Math.max(1, viewportWidth * viewportHeight);
  for (const [documentIndex, video] of videos.entries()) {
    if (!video.isConnected || video.ownerDocument !== documentRef) {
      increment(rejected, 'detached');
      continue;
    }
    const blockReason = explicitBlockReason(video);
    if (blockReason !== null) {
      increment(rejected, blockReason);
      continue;
    }
    const rectangle = effectiveCandidateRectangle(video);
    const visibility = visibilityMetrics(video, documentRef, rectangle);
    if (rectangle === null || visibility.area <= 0) {
      increment(rejected, 'zero-size');
      continue;
    }
    if (!visibility.rendered) {
      increment(rejected, 'hidden');
      continue;
    }
    if (visibility.visibleArea < MINIMUM_VISIBLE_INTERSECTION_AREA) {
      increment(rejected, 'off-screen');
      continue;
    }

    const declaredId = closestDeclaredVideoId(video);
    if (declaredId !== null && declaredId !== videoId) {
      increment(rejected, 'different-video');
      continue;
    }
    const playerRoot = video.closest(PLAYER_ROOT_SELECTOR);
    const workScope = findWorkScope(video);
    const matchingLink = scopeLinksToVideo(workScope, pageUrl, videoId);
    const associationTier =
      declaredId === videoId || matchingLink
        ? 3
        : playerRoot !== null
          ? 2
          : workScope !== null
            ? 1
            : 0;
    if (surface === 'direct' && associationTier === 0) {
      increment(rejected, 'unassociated');
      continue;
    }

    const readyState = safeVideoNumber(video, 'readyState') ?? 0;
    const videoWidth = safeVideoNumber(video, 'videoWidth') ?? 0;
    const videoHeight = safeVideoNumber(video, 'videoHeight') ?? 0;
    const intrinsicDimensions = videoWidth > 0 && videoHeight > 0;
    const metadataReady = readyState >= HTMLMediaElement.HAVE_METADATA || intrinsicDimensions;
    const currentTime = safeVideoNumber(video, 'currentTime');
    const currentTimePositive = currentTime !== null && currentTime > 0;
    const ended = safeVideoBoolean(video, 'ended') ?? false;
    if (ended && !intrinsicDimensions && !currentTimePositive) {
      increment(rejected, 'ended-without-frame');
      continue;
    }
    if (!metadataReady) {
      visibleButLoading += 1;
      increment(rejected, 'media-loading');
      continue;
    }
    const playing = safePlaying(video);
    const modalOverlap =
      modalRectangle === null ? 0 : rectangleOverlapRatio(rectangle, modalRectangle);
    const centreProximity = rectangleCentreProximity(rectangle, viewportWidth, viewportHeight);
    const topLayer = visualTopLayerEvidence(video, rectangle, documentRef);
    const viewportAreaRatio = visibility.visibleArea / viewportArea;
    const score = scoreVideoCandidate({
      visibleArea: visibility.visibleArea,
      playing,
      metadataReady,
      intrinsicDimensions,
      currentTimePositive,
      modalOverlap,
      associationTier,
      rectangle,
      documentRef,
      centreProximity,
      topLayerScore: topLayer.score,
    });
    candidates.push({
      video,
      documentIndex,
      rectangle,
      area: visibility.visibleArea,
      visibleArea: visibility.visibleArea,
      viewportOverlap: visibility.viewportOverlap,
      associationTier,
      playing,
      metadataReady,
      intrinsicDimensions,
      currentTimePositive,
      modalOverlap,
      viewportAreaRatio,
      centreProximity,
      topLayerScore: topLayer.score,
      topLayerSamples: topLayer.samples,
      score,
    });
  }
  return { candidates, rejected, visibleButLoading };
}

function explicitBlockReason(video: HTMLVideoElement): string | null {
  if (video.matches(EXPLICIT_AD_SELECTOR) || video.closest(EXPLICIT_AD_SELECTOR) !== null) {
    return 'advertisement';
  }
  if (
    video.matches(EXPLICIT_PREVIEW_SELECTOR) ||
    video.closest(EXPLICIT_PREVIEW_SELECTOR) !== null
  ) {
    return 'preview-or-background';
  }
  return null;
}

function effectiveCandidateRectangle(video: HTMLVideoElement): DOMRect | null {
  const ownRectangle = safeRectangle(video);
  if (ownRectangle !== null && ownRectangle.width > 0 && ownRectangle.height > 0) {
    return ownRectangle;
  }

  // Some portal players size a nearby wrapper while the raw video briefly reports a
  // zero rectangle. Walk only a short local ancestor chain and never promote the
  // document body/root into video geometry.
  let current = video.parentElement;
  for (let depth = 0; current !== null && depth < 5; depth += 1) {
    if (current === video.ownerDocument.body || current === video.ownerDocument.documentElement) {
      break;
    }
    const rectangle = safeRectangle(current);
    if (
      rectangle !== null &&
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      current.querySelectorAll('video').length === 1
    ) {
      return rectangle;
    }
    current = current.parentElement;
  }
  return ownRectangle;
}

function readDouyinVideoBounds(
  video: HTMLVideoElement | null,
  documentRef: Document,
): ExtractionResult<VideoBounds | null> {
  const direct = readVideoBounds(video, documentRef);
  if (direct.value !== null || video === null) return direct;
  const rectangle = effectiveCandidateRectangle(video);
  if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) return direct;
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
        'nearby-rendered-wrapper-rect',
        'success',
        'Read stable visible bounds from a nearby rendered player wrapper.',
      ),
    ],
  };
}

function currentVideoCandidate(
  documentRef: Document,
  pageUrl: string,
  video: HTMLVideoElement | null,
): VideoCandidate | null {
  if (video === null) return null;
  const parsed = parseDouyinVideoUrl(pageUrl);
  if (parsed === null) return null;
  const modalRoot =
    parsed.surface === 'modal'
      ? findVisibleModalSurface(documentRef, parsed.videoId, pageUrl)
      : null;
  const scan = scanVideoCandidates(
    Array.from(documentRef.querySelectorAll<HTMLVideoElement>('video')),
    documentRef,
    parsed.videoId,
    pageUrl,
    parsed.surface,
    modalRoot,
  );
  const selection = selectDominantCandidate(
    scan.candidates,
    parsed.surface,
    modalRoot,
    documentRef,
  );
  return selection.candidate?.video === video ? selection.candidate : null;
}

function classifyPreparationFailure(
  documentRef: Document,
  pageUrl: string,
): CapturePreparationResult {
  const parsed = parseDouyinVideoUrl(pageUrl);
  if (parsed === null) {
    return {
      ok: false,
      reason: 'UNSTABLE_VIDEO',
      message: 'The Douyin video changed during capture. Try again.',
    };
  }
  const modalRoot =
    parsed.surface === 'modal'
      ? findVisibleModalSurface(documentRef, parsed.videoId, pageUrl)
      : null;
  const videos = Array.from(documentRef.querySelectorAll<HTMLVideoElement>('video'));
  const scan = scanVideoCandidates(
    videos,
    documentRef,
    parsed.videoId,
    pageUrl,
    parsed.surface,
    modalRoot,
  );
  if (scan.candidates.length === 0 && scan.visibleButLoading > 0) {
    return {
      ok: false,
      reason: 'VIDEO_LOADING',
      message: 'The Douyin video is still loading. Wait briefly and try again.',
    };
  }
  const selection = selectDominantCandidate(
    scan.candidates,
    parsed.surface,
    modalRoot,
    documentRef,
  );
  if (selection.confidence === 'ambiguous') {
    return {
      ok: false,
      reason: 'AMBIGUOUS_VIDEO',
      message:
        'ValRecall found multiple visible videos and could not identify the active one safely.',
    };
  }
  return {
    ok: false,
    reason: 'NO_VISIBLE_VIDEO',
    message:
      parsed.surface === 'modal'
        ? 'No visible video was found for the current Douyin item.'
        : 'No visible Douyin video was found on this page.',
  };
}

function normalizeRetrySchedule(schedule: readonly number[]): number[] {
  const normalized = [...new Set(schedule)]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);
  if (normalized.length === 0 || normalized[0] !== 0) normalized.unshift(0);
  return normalized;
}

function visibilityMetrics(
  element: Element,
  documentRef: Document,
  rectangleOverride?: DOMRect | null,
): {
  rectangle: DOMRect | null;
  area: number;
  visibleArea: number;
  rendered: boolean;
  viewportOverlap: number;
} {
  const rectangle = rectangleOverride === undefined ? safeRectangle(element) : rectangleOverride;
  const area =
    rectangle === null ? 0 : Math.max(0, rectangle.width) * Math.max(0, rectangle.height);
  let rendered = area > 0;
  let current: Element | null = element;
  while (rendered && current !== null) {
    const html = current as HTMLElement;
    if (
      html.hidden ||
      current.getAttribute('aria-hidden') === 'true' ||
      current.hasAttribute('inert')
    ) {
      rendered = false;
      break;
    }
    try {
      const style = documentRef.defaultView?.getComputedStyle(current);
      if (
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.visibility === 'collapse' ||
        Number.parseFloat(style?.opacity ?? '1') <= 0.01
      ) {
        rendered = false;
      }
    } catch {
      // Geometry and explicit visibility attributes remain usable for cross-realm nodes.
    }
    current = current.parentElement;
  }
  return {
    rectangle,
    area,
    visibleArea: rectangle === null ? 0 : viewportIntersectionArea(rectangle, documentRef),
    rendered,
    viewportOverlap: rectangle === null ? 0 : viewportOverlapRatio(rectangle, documentRef),
  };
}

function viewportIntersectionArea(rectangle: DOMRect, documentRef: Document): number {
  const viewportWidth = documentRef.defaultView?.innerWidth ?? 0;
  const viewportHeight = documentRef.defaultView?.innerHeight ?? 0;
  const width = Math.max(0, Math.min(rectangle.right, viewportWidth) - Math.max(rectangle.left, 0));
  const height = Math.max(
    0,
    Math.min(rectangle.bottom, viewportHeight) - Math.max(rectangle.top, 0),
  );
  return width * height;
}

function viewportOverlapRatio(rectangle: DOMRect, documentRef: Document): number {
  const area = rectangle.width * rectangle.height;
  return area > 0 ? viewportIntersectionArea(rectangle, documentRef) / area : 0;
}

function findVisibleModalSurface(
  documentRef: Document,
  videoId: string,
  pageUrl: string,
): Element | null {
  const visible = uniqueElements(
    DOUYIN_SELECTORS.modalRoots.flatMap((selector) =>
      Array.from(documentRef.querySelectorAll(selector)),
    ),
  ).filter((candidate) => {
    const metrics = visibilityMetrics(candidate, documentRef);
    return candidate.isConnected && metrics.rendered && metrics.viewportOverlap > 0;
  });
  const topLevel = visible.filter(
    (candidate) => !visible.some((other) => other !== candidate && other.contains(candidate)),
  );
  const explicitlyMatching = topLevel.filter((candidate) => {
    const declaredIds = declaredVideoIdsInScope(candidate, pageUrl);
    return declaredIds.length > 0 && declaredIds.every((declaredId) => declaredId === videoId);
  });
  if (explicitlyMatching.length === 1) return explicitlyMatching[0]!;
  if (explicitlyMatching.length > 1) return null;

  const withoutConflictingIdentity = topLevel.filter((candidate) => {
    const declaredIds = declaredVideoIdsInScope(candidate, pageUrl);
    return declaredIds.length === 0;
  });
  return withoutConflictingIdentity.length === 1 ? withoutConflictingIdentity[0]! : null;
}

function declaredVideoIdsInScope(scope: Element, pageUrl: string): string[] {
  const identities = new Set<string>();
  const elements = [
    scope,
    ...Array.from(scope.querySelectorAll('[data-video-id], [data-aweme-id], [data-e2e-video-id]')),
  ];
  for (const element of elements) {
    for (const attribute of ['data-video-id', 'data-aweme-id', 'data-e2e-video-id']) {
      const value = element.getAttribute(attribute);
      if (value !== null && DOUYIN_VIDEO_ID_PATTERN.test(value)) identities.add(value);
    }
  }
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    try {
      const parsed = parseDouyinVideoUrl(new URL(anchor.href, pageUrl).href);
      if (parsed !== null) identities.add(parsed.videoId);
    } catch {
      // Malformed links inside the modal do not establish identity.
    }
  }
  return [...identities];
}

function closestDeclaredVideoId(video: HTMLVideoElement): string | null {
  let current: Element | null = video;
  while (current !== null) {
    for (const attribute of ['data-video-id', 'data-aweme-id', 'data-e2e-video-id']) {
      const value = current.getAttribute(attribute);
      if (value !== null && /^[0-9]+$/.test(value)) return value;
    }
    current = current.parentElement;
  }
  return null;
}

function scopeLinksToVideo(scope: Element | null, pageUrl: string, videoId: string): boolean {
  if (scope === null) return false;
  for (const anchor of scope.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    try {
      if (parseDouyinVideoUrl(new URL(anchor.href, pageUrl).href)?.videoId === videoId) return true;
    } catch {
      // Ignore malformed scoped links.
    }
  }
  return false;
}

function compareVideoCandidates(left: VideoCandidate, right: VideoCandidate): number {
  const larger = left.visibleArea >= right.visibleArea ? left : right;
  const smaller = larger === left ? right : left;
  const substantialAreaDifference =
    larger.visibleArea / Math.max(1, smaller.visibleArea) >= DOMINANT_AREA_MULTIPLIER &&
    larger.viewportAreaRatio - smaller.viewportAreaRatio >= 0.04;
  if (substantialAreaDifference) return larger === left ? -1 : 1;
  if (Math.abs(left.score - right.score) >= 1) return right.score - left.score;
  if (Math.abs(left.visibleArea - right.visibleArea) >= 1) {
    return right.visibleArea - left.visibleArea;
  }
  if (left.playing !== right.playing) return left.playing ? -1 : 1;
  if (left.intrinsicDimensions !== right.intrinsicDimensions) {
    return left.intrinsicDimensions ? -1 : 1;
  }
  if (left.currentTimePositive !== right.currentTimePositive) {
    return left.currentTimePositive ? -1 : 1;
  }
  if (left.associationTier !== right.associationTier) {
    return right.associationTier - left.associationTier;
  }
  return left.documentIndex - right.documentIndex;
}

function selectDominantCandidate(
  candidates: readonly VideoCandidate[],
  surface: 'direct' | 'modal',
  modalRoot: Element | null,
  documentRef: Document,
): CandidateSelection {
  if (candidates.length === 0) {
    return {
      candidate: null,
      competitor: null,
      confidence: 'insufficient',
      reason: 'No metadata-ready video passed the visibility and identity safety checks.',
      areaRatioToCompetitor: null,
    };
  }

  const ranked = [...candidates].sort(compareVideoCandidates);
  const selected = ranked[0]!;
  const competitor = ranked
    .slice(1)
    .sort((left, right) => right.visibleArea - left.visibleArea || right.score - left.score)[0];
  const areaRatioToCompetitor =
    competitor === undefined ? null : selected.visibleArea / Math.max(1, competitor.visibleArea);

  if (
    competitor !== undefined &&
    candidatesLackReliableDistinction(selected, competitor, documentRef)
  ) {
    return {
      candidate: null,
      competitor,
      confidence: 'ambiguous',
      reason:
        'The two strongest visible videos have similar area and no reliable activity, association, modal-overlap, or visual-layer distinction.',
      areaRatioToCompetitor,
    };
  }

  if (surface === 'direct') {
    return {
      candidate: selected,
      competitor: competitor ?? null,
      confidence: 'direct-associated',
      reason: 'The selected visible video is associated with the validated direct-video page.',
      areaRatioToCompetitor,
    };
  }

  if (
    modalRoot !== null &&
    (selected.viewportAreaRatio >= 0.03 ||
      selected.modalOverlap >= 0.2 ||
      selected.associationTier >= 2)
  ) {
    return {
      candidate: selected,
      competitor: competitor ?? null,
      confidence: 'modal-evidence',
      reason: 'Optional modal overlap or player association reinforces the selected visible video.',
      areaRatioToCompetitor,
    };
  }
  if (selected.viewportAreaRatio >= LARGE_VIEWPORT_VIDEO_RATIO) {
    return {
      candidate: selected,
      competitor: competitor ?? null,
      confidence: 'large-viewport',
      reason: 'The selected video occupies a large share of the visible viewport.',
      areaRatioToCompetitor,
    };
  }
  if (
    areaRatioToCompetitor !== null &&
    areaRatioToCompetitor >= DOMINANT_AREA_MULTIPLIER &&
    selected.viewportAreaRatio >= MINIMUM_MODAL_FREE_VISIBLE_RATIO
  ) {
    return {
      candidate: selected,
      competitor: competitor ?? null,
      confidence: 'dominant-area',
      reason: 'The selected video is substantially larger than every other eligible video.',
      areaRatioToCompetitor,
    };
  }
  if (competitor === undefined && selected.viewportAreaRatio >= MINIMUM_MODAL_FREE_VISIBLE_RATIO) {
    return {
      candidate: selected,
      competitor: null,
      confidence: 'only-meaningful-video',
      reason: 'The selected video is the only meaningful visible video.',
      areaRatioToCompetitor: null,
    };
  }
  if (
    selected.viewportAreaRatio >= 0.045 &&
    selected.centreProximity >= 0.5 &&
    selected.topLayerScore !== null &&
    selected.topLayerScore >= 0.5
  ) {
    return {
      candidate: selected,
      competitor: competitor ?? null,
      confidence: 'primary-visual-layer',
      reason: 'Viewport position and best-effort visual-layer samples identify the primary video.',
      areaRatioToCompetitor,
    };
  }

  return {
    candidate: null,
    competitor: competitor ?? null,
    confidence: 'insufficient',
    reason:
      'Visible videos were present, but none was large, dominant, uniquely meaningful, or visually primary enough for safe modal capture.',
    areaRatioToCompetitor,
  };
}

function candidatesLackReliableDistinction(
  selected: VideoCandidate,
  competitor: VideoCandidate,
  documentRef: Document,
): boolean {
  const smallerArea = Math.min(selected.visibleArea, competitor.visibleArea);
  const largerArea = Math.max(selected.visibleArea, competitor.visibleArea);
  const similarArea = smallerArea / Math.max(1, largerArea) >= SIMILAR_VISIBLE_AREA_RATIO;
  const bothMeaningful = Math.min(selected.viewportAreaRatio, competitor.viewportAreaRatio) >= 0.04;
  if (!similarArea || !bothMeaningful) return false;

  const viewportArea = Math.max(
    1,
    (documentRef.defaultView?.innerWidth ?? 0) * (documentRef.defaultView?.innerHeight ?? 0),
  );
  const reliableDistinction =
    selected.playing !== competitor.playing ||
    Math.abs(selected.associationTier - competitor.associationTier) >= 2 ||
    Math.abs(selected.modalOverlap - competitor.modalOverlap) >= 0.3 ||
    topLayerDifference(selected.topLayerScore, competitor.topLayerScore) >= 0.5 ||
    Math.abs(selected.score - competitor.score) >= viewportArea * 0.07;
  return !reliableDistinction;
}

function topLayerDifference(left: number | null, right: number | null): number {
  return left === null || right === null ? 0 : Math.abs(left - right);
}

/**
 * Visual dominance is the base score. Playback is a strong but bounded bonus, so a
 * small playing preview cannot defeat a large paused main player. Metadata,
 * intrinsic dimensions, playback progress, optional modal overlap, bounded identity
 * association, viewport-centre proximity and best-effort top-layer evidence add
 * deterministic bonuses.
 * The comparator separately makes a substantially larger video win before bonuses,
 * so a small autoplay preview cannot defeat a dominant paused player.
 */
function scoreVideoCandidate(input: {
  visibleArea: number;
  playing: boolean;
  metadataReady: boolean;
  intrinsicDimensions: boolean;
  currentTimePositive: boolean;
  modalOverlap: number;
  associationTier: number;
  rectangle: DOMRect;
  documentRef: Document;
  centreProximity: number;
  topLayerScore: number | null;
}): number {
  const viewportWidth = input.documentRef.defaultView?.innerWidth ?? 0;
  const viewportHeight = input.documentRef.defaultView?.innerHeight ?? 0;
  const viewportArea = Math.max(1, viewportWidth * viewportHeight);
  return (
    input.visibleArea +
    (input.playing ? viewportArea * 0.08 : 0) +
    (input.metadataReady ? viewportArea * 0.015 : 0) +
    (input.intrinsicDimensions ? viewportArea * 0.02 : 0) +
    (input.currentTimePositive ? viewportArea * 0.015 : 0) +
    input.modalOverlap * viewportArea * 0.06 +
    (input.associationTier / 3) * viewportArea * 0.35 +
    input.centreProximity * viewportArea * 0.02 +
    (input.topLayerScore ?? 0) * viewportArea * 0.03
  );
}

function visualTopLayerEvidence(
  video: HTMLVideoElement,
  rectangle: DOMRect,
  documentRef: Document,
): { score: number | null; samples: number } {
  if (typeof documentRef.elementsFromPoint !== 'function') return { score: null, samples: 0 };
  const viewportWidth = documentRef.defaultView?.innerWidth ?? 0;
  const viewportHeight = documentRef.defaultView?.innerHeight ?? 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) return { score: null, samples: 0 };

  const left = Math.max(0, rectangle.left);
  const right = Math.min(viewportWidth, rectangle.right);
  const top = Math.max(0, rectangle.top);
  const bottom = Math.min(viewportHeight, rectangle.bottom);
  if (right <= left || bottom <= top) return { score: null, samples: 0 };

  const points = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ] as const;
  const visualRoot =
    video.closest(PLAYER_ROOT_SELECTOR) ?? findWorkScope(video) ?? video.parentElement;
  let associatedSamples = 0;
  let samples = 0;
  for (const [xRatio, yRatio] of points) {
    const x = left + (right - left) * xRatio;
    const y = top + (bottom - top) * yRatio;
    let layers: Element[];
    try {
      layers = documentRef.elementsFromPoint(x, y).slice(0, 4);
    } catch {
      continue;
    }
    if (layers.length === 0) continue;
    samples += 1;
    if (
      layers.some(
        (layer) =>
          layer === video ||
          (layer !== documentRef.body &&
            layer !== documentRef.documentElement &&
            layer.contains(video)) ||
          (visualRoot !== null && (layer === visualRoot || visualRoot.contains(layer))),
      )
    ) {
      associatedSamples += 1;
    }
  }
  return samples === 0
    ? { score: null, samples: 0 }
    : { score: associatedSamples / samples, samples };
}

function rectangleCentreProximity(
  rectangle: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 0;
  const centreX = rectangle.left + rectangle.width / 2;
  const centreY = rectangle.top + rectangle.height / 2;
  const distance = Math.hypot(centreX - viewportWidth / 2, centreY - viewportHeight / 2);
  const maximum = Math.hypot(viewportWidth / 2, viewportHeight / 2);
  return Math.max(0, 1 - distance / maximum);
}

function candidateDiagnostics(
  total: number,
  rejected: ReadonlyMap<string, number>,
): ExtractionDiagnostic[] {
  const diagnostics = [
    diagnostic(
      'video',
      'douyin-video-candidate-scan',
      total === 0 ? 'failed' : 'success',
      total === 0
        ? 'No Douyin video elements were present in the current document.'
        : `Inspected all ${total} Douyin video element candidate(s) in the document.`,
    ),
  ];
  for (const [reason, count] of rejected) {
    diagnostics.push(
      diagnostic(
        'video',
        `douyin-reject-${reason}`,
        'failed',
        `Rejected ${count} Douyin video candidate(s): ${reason}.`,
      ),
    );
  }
  return diagnostics;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function safePlaying(video: HTMLVideoElement): boolean {
  try {
    return !video.paused && !video.ended;
  } catch {
    return false;
  }
}

function captureDebugCandidate(
  video: HTMLVideoElement,
  index: number,
  documentRef: Document,
  videoId: string | null,
  surface: 'direct' | 'modal' | null,
  pageUrl: string,
  selected: HTMLVideoElement | null,
  candidate: VideoCandidate | null,
  eligibleCandidates: readonly VideoCandidate[],
): Record<string, unknown> {
  const rectangle = effectiveCandidateRectangle(video);
  const visibility = visibilityMetrics(video, documentRef, rectangle);
  let style: CSSStyleDeclaration | null = null;
  try {
    style = documentRef.defaultView?.getComputedStyle(video) ?? null;
  } catch {
    // Style remains unavailable in the local diagnostic object.
  }

  return {
    index,
    connected: video.isConnected && video.ownerDocument === documentRef,
    visible: visibility.rendered && visibility.viewportOverlap > 0,
    rectangle:
      rectangle === null
        ? null
        : {
            x: rectangle.x,
            y: rectangle.y,
            width: rectangle.width,
            height: rectangle.height,
          },
    viewportIntersectionArea: visibility.visibleArea,
    display: style?.display ?? null,
    visibility: style?.visibility ?? null,
    opacity: style?.opacity ?? null,
    readyState: safeVideoNumber(video, 'readyState'),
    networkState: safeVideoNumber(video, 'networkState'),
    paused: safeVideoBoolean(video, 'paused'),
    ended: safeVideoBoolean(video, 'ended'),
    currentTime: safeVideoNumber(video, 'currentTime'),
    duration: safeVideoNumber(video, 'duration'),
    videoWidth: safeVideoNumber(video, 'videoWidth'),
    videoHeight: safeVideoNumber(video, 'videoHeight'),
    currentSrcPresent: safeCurrentSourcePresent(video),
    score: candidate?.score ?? null,
    viewportAreaRatio: candidate?.viewportAreaRatio ?? null,
    areaRatioToSecondLargest:
      candidate === null || eligibleCandidates.length <= 1
        ? null
        : candidate.visibleArea /
          Math.max(
            1,
            ...eligibleCandidates
              .filter((other) => other.video !== video)
              .map((other) => other.visibleArea),
          ),
    viewportCentreDistanceRatio:
      candidate === null ? null : Math.max(0, 1 - candidate.centreProximity),
    topLayerScore: candidate?.topLayerScore ?? null,
    topLayerSamples: candidate?.topLayerSamples ?? 0,
    modalOverlapScore: candidate?.modalOverlap ?? null,
    rejected: video !== selected,
    rejectionReason:
      video === selected
        ? null
        : currentSelectionRejectionReason(video, documentRef, videoId, surface, pageUrl),
  };
}

function currentSelectionRejectionReason(
  video: HTMLVideoElement,
  documentRef: Document,
  videoId: string | null,
  surface: 'direct' | 'modal' | null,
  pageUrl: string,
): string {
  if (videoId === null || surface === null) return 'unsupported-video-identity';
  if (!video.isConnected || video.ownerDocument !== documentRef) return 'detached';
  const blocked = explicitBlockReason(video);
  if (blocked !== null) return blocked;
  const rectangle = effectiveCandidateRectangle(video);
  const visibility = visibilityMetrics(video, documentRef, rectangle);
  if (rectangle === null || visibility.area <= 0) return 'zero-size';
  if (!visibility.rendered) return 'hidden';
  if (visibility.visibleArea < MINIMUM_VISIBLE_INTERSECTION_AREA) return 'off-screen';
  const declaredId = closestDeclaredVideoId(video);
  if (declaredId !== null && declaredId !== videoId) return 'different-video';
  const associated =
    declaredId === videoId ||
    scopeLinksToVideo(findWorkScope(video), pageUrl, videoId) ||
    video.closest(PLAYER_ROOT_SELECTOR) !== null ||
    findWorkScope(video) !== null;
  if (surface === 'direct' && !associated) return 'unassociated';
  const readyState = safeVideoNumber(video, 'readyState') ?? 0;
  const width = safeVideoNumber(video, 'videoWidth') ?? 0;
  const height = safeVideoNumber(video, 'videoHeight') ?? 0;
  if (readyState < HTMLMediaElement.HAVE_METADATA && (width <= 0 || height <= 0)) {
    return 'media-loading';
  }
  return 'lower-ranked-or-ambiguous';
}

function safeVideoNumber(
  video: HTMLVideoElement,
  property:
    'readyState' | 'networkState' | 'currentTime' | 'duration' | 'videoWidth' | 'videoHeight',
): number | null {
  try {
    const value = video[property];
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

function safeVideoBoolean(video: HTMLVideoElement, property: 'paused' | 'ended'): boolean | null {
  try {
    const value = video[property];
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

function safeCurrentSourcePresent(video: HTMLVideoElement): boolean {
  try {
    return video.currentSrc.length > 0;
  } catch {
    return false;
  }
}

function findWorkScope(video: HTMLVideoElement | null | undefined): Element | null {
  if (video === null || video === undefined) return null;
  return (
    video.closest(WORK_CONTAINER_SELECTOR) ??
    video.closest(MODAL_ROOT_SELECTOR) ??
    video.closest(PLAYER_ROOT_SELECTOR)
  );
}

function runTextStrategies(
  field: string,
  strategies: readonly TextStrategy[],
): ExtractionResult<string | null> {
  const diagnostics: ExtractionDiagnostic[] = [];
  let selected: string | null = null;
  for (const [strategy, extract] of strategies) {
    if (selected !== null) {
      diagnostics.push(
        diagnostic(
          field,
          strategy,
          'skipped',
          `Skipped ${strategy} because a stronger strategy succeeded.`,
        ),
      );
      continue;
    }
    let candidate: string | null;
    try {
      candidate = extract();
    } catch {
      candidate = null;
    }
    const value = normalizeSubtitleText(candidate ?? '');
    if (value.length > 0) {
      selected = value;
      diagnostics.push(diagnostic(field, strategy, 'success', `Read ${field} from ${strategy}.`));
    } else {
      diagnostics.push(
        diagnostic(field, strategy, 'failed', `${strategy} did not expose ${field}.`),
      );
    }
  }
  return { value: selected, diagnostics };
}

function readVisibleFirst(
  scope: Element | null,
  documentRef: Document,
  selectors: readonly string[],
): string | null {
  if (scope === null) return null;
  for (const selector of selectors) {
    for (const element of scope.querySelectorAll(selector)) {
      const metrics = visibilityMetrics(element, documentRef);
      if (!metrics.rendered || metrics.viewportOverlap <= 0) continue;
      const value = normalizeSubtitleText(element.textContent ?? '');
      if (value.length > 0) return value;
    }
  }
  return null;
}

function cleanWorkCaption(value: string | null): string | null {
  const text = normalizeSubtitleText(value ?? '');
  if (text.length === 0 || text.length > 2_000) return null;
  const withoutHashtags = text.replace(/(^|\s)#[^\s#]+/gu, ' ').trim();
  return /[\p{L}\p{N}]/u.test(withoutHashtags) ? text : null;
}

function cleanDouyinDocumentTitle(value: string): string | null {
  const text = normalizeSubtitleText(value)
    .replace(/\s*(?:[-|_]\s*)?(?:\u6296\u97f3|Douyin)\s*$/iu, '')
    .trim();
  return text.length > 0 ? text : null;
}

function readAssociatedOpenGraphTitle(documentRef: Document, pageUrl: string): string | null {
  return cleanWorkCaption(readAssociatedOpenGraph(documentRef, pageUrl, 'og:title'));
}

function readAssociatedOpenGraph(
  documentRef: Document,
  pageUrl: string,
  property: string,
): string | null {
  const page = parseDouyinVideoUrl(pageUrl);
  if (page === null) return null;
  const declaredUrl = documentRef.querySelector('meta[property="og:url"]')?.getAttribute('content');
  if (declaredUrl !== null && declaredUrl !== undefined) {
    const declared = parseDouyinVideoUrl(declaredUrl);
    if (declared === null || declared.videoId !== page.videoId) return null;
  }
  const value = documentRef.querySelector(`meta[property="${property}"]`)?.getAttribute('content');
  return value === null || value === undefined ? null : normalizeSubtitleText(value);
}

function hasMismatchedDeclaredPageIdentity(documentRef: Document, videoId: string): boolean {
  const declaredUrls = [
    documentRef.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    documentRef.querySelector('link[rel="canonical"]')?.getAttribute('href'),
  ];
  return declaredUrls.some((value) => {
    if (value === null || value === undefined || value.trim().length === 0) return false;
    const parsed = parseDouyinVideoUrl(value);
    return parsed !== null && parsed.videoId !== videoId;
  });
}

function findStructuredVideoRecord(
  documentRef: Document,
  videoId: string | null,
): Record<string, unknown> | null {
  if (videoId === null) return null;
  const records = readStructuredVideoRecords(documentRef);
  const associated = records.filter((record) => structuredAssociation(record, videoId) === 'match');
  if (associated.length > 0) return associated[0]!;
  const withoutIdentity = records.filter(
    (record) => structuredAssociation(record, videoId) === 'none',
  );
  return records.length === 1 && withoutIdentity.length === 1 ? withoutIdentity[0]! : null;
}

function readStructuredVideoRecords(documentRef: Document): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const scripts = Array.from(
    documentRef.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 20);
  for (const script of scripts) {
    const source = script.textContent ?? '';
    if (source.length === 0 || source.length > 1_000_000) continue;
    try {
      collectStructuredRecords(JSON.parse(source) as unknown, records, 0);
    } catch {
      // Malformed structured metadata is an optional extraction failure.
    }
  }
  return records;
}

function collectStructuredRecords(
  value: unknown,
  records: Record<string, unknown>[],
  depth: number,
): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStructuredRecords(entry, records, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (isVideoObject(value)) records.push(value);
  const graph = value['@graph'];
  if (graph !== undefined) collectStructuredRecords(graph, records, depth + 1);
}

function isVideoObject(record: Record<string, unknown>): boolean {
  const type = record['@type'];
  return type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
}

function structuredAssociation(
  record: Record<string, unknown>,
  videoId: string,
): 'match' | 'mismatch' | 'none' {
  const identities: string[] = [];
  for (const key of ['url', 'mainEntityOfPage', '@id']) {
    const raw = record[key];
    const value =
      typeof raw === 'string'
        ? raw
        : isRecord(raw) && typeof raw['@id'] === 'string'
          ? raw['@id']
          : null;
    if (value !== null) {
      const parsed = parseDouyinVideoUrl(value);
      if (parsed !== null) identities.push(parsed.videoId);
    }
  }
  if (typeof record.identifier === 'string' && /^[0-9]+$/.test(record.identifier)) {
    identities.push(record.identifier);
  }
  if (identities.length === 0) return 'none';
  return identities.every((identity) => identity === videoId) ? 'match' : 'mismatch';
}

function structuredAuthor(record: Record<string, unknown> | null): string | null {
  for (const raw of [record?.author, record?.creator]) {
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    const value =
      typeof candidate === 'string'
        ? candidate
        : isRecord(candidate) && typeof candidate.name === 'string'
          ? candidate.name
          : null;
    const normalized = normalizeSubtitleText(value ?? '');
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function subtitleContextFromTextTracks(
  video: HTMLVideoElement,
  timestampSeconds: number,
): SubtitleTrackExtraction {
  return extractSubtitleContextFromDomTextTracks(video, timestampSeconds);
}

function subtitleContextFromTranscript(
  scope: Element | null,
  documentRef: Document,
  timestampSeconds: number | null,
  durationSeconds: number | null,
): ScopedSubtitleExtraction {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  if (scope === null) return { context: null, rejectionReasons };
  const entries: Array<{ startTime: number; text: string }> = [];
  const rows = uniqueElements(
    DOUYIN_SELECTORS.transcriptRows.flatMap((selector) =>
      Array.from(scope.querySelectorAll(selector)),
    ),
  );
  for (const row of rows) {
    const textElement = firstMatch(row, DOUYIN_SELECTORS.transcriptText);
    const text = normalizeSubtitleText(textElement?.textContent ?? '');
    if (!isVisibleTextCandidate(row, documentRef)) {
      rejectionReasons.push(rejection('timestamped_transcript_rows', 'hidden', row, text));
      continue;
    }
    if (row.closest(EXCLUDED_DOUYIN_TEXT_UI) !== null) {
      rejectionReasons.push(
        rejection('timestamped_transcript_rows', 'excluded_ui_ancestor', row, ''),
      );
      continue;
    }
    const timestamp = parseTimestamp(
      normalizeSubtitleText(firstMatch(row, DOUYIN_SELECTORS.transcriptTimes)?.textContent ?? ''),
    );
    if (timestamp === null) {
      rejectionReasons.push(
        rejection('timestamped_transcript_rows', 'untimed_transcript_row', row, text),
      );
      continue;
    }
    if (text.length === 0 || text.length > 280) {
      rejectionReasons.push(
        rejection(
          'timestamped_transcript_rows',
          text.length === 0 ? 'empty_text' : 'overlong_text',
          row,
          text,
        ),
      );
      continue;
    }
    entries.push({ startTime: timestamp, text });
  }
  entries.sort((left, right) => left.startTime - right.startTime);
  const cues: TimedSubtitleCue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const endTime = entries[index + 1]?.startTime ?? durationSeconds;
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
  scope: Element | null,
  documentRef: Document,
  video: HTMLVideoElement | null | undefined,
): ScopedSubtitleExtraction {
  const rejectionReasons: SubtitleRejectionReason[] = [];
  const videoRectangle = video === null || video === undefined ? null : safeRectangle(video);
  if (scope === null || videoRectangle === null) return { context: null, rejectionReasons };
  const playerRoot = video?.closest(PLAYER_ROOT_SELECTOR) ?? null;
  const candidates: Array<{ text: string; score: number }> = [];
  const overlays = uniqueElements(
    DOUYIN_SELECTORS.subtitleOverlays.flatMap((selector) =>
      Array.from(scope.querySelectorAll(selector)),
    ),
  );
  for (const element of overlays) {
    const text = normalizeSubtitleText(element.textContent ?? '');
    if (!isVisibleTextCandidate(element, documentRef)) {
      rejectionReasons.push(rejection('visible_video_overlay', 'hidden', element, text));
      continue;
    }
    if (element.closest(EXCLUDED_DOUYIN_TEXT_UI) !== null) {
      rejectionReasons.push(
        rejection('visible_video_overlay', 'excluded_ui_ancestor', element, ''),
      );
      continue;
    }
    const rectangle = safeRectangle(element);
    if (rectangle === null || rectangle.width <= 0 || rectangle.height <= 0) {
      rejectionReasons.push(rejection('visible_video_overlay', 'zero_bounds', element, text));
      continue;
    }
    const overlap = rectangleOverlapRatio(rectangle, videoRectangle);
    const candidateRoot = element.closest(PLAYER_ROOT_SELECTOR);
    if (overlap < 0.5 || (playerRoot !== null && candidateRoot !== playerRoot)) {
      rejectionReasons.push(
        rejection('visible_video_overlay', 'outside_active_video', element, text),
      );
      continue;
    }
    if (text.length === 0 || text.length > 280) {
      rejectionReasons.push(
        rejection(
          'visible_video_overlay',
          text.length === 0 ? 'empty_text' : 'overlong_text',
          element,
          text,
        ),
      );
      continue;
    }
    candidates.push({
      text,
      score: overlap * 100 + rectangle.top / Math.max(1, videoRectangle.height),
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const selected = Array.from(new Set(candidates.slice(0, 4).map((candidate) => candidate.text)));
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

function isVisibleTextCandidate(element: Element, documentRef: Document): boolean {
  const metrics = visibilityMetrics(element, documentRef);
  return metrics.rendered && metrics.viewportOverlap > 0;
}

function chapterFromTextTracks(video: HTMLVideoElement, timestampSeconds: number): string | null {
  for (const track of indexedList(video.textTracks)) {
    if (track.kind !== 'chapters') continue;
    const cue = readCueList(track.cues).find(
      (candidate) =>
        candidate.startTime <= timestampSeconds && candidate.endTime > timestampSeconds,
    );
    if (cue !== undefined) return cue.text;
  }
  return null;
}

function readCueList(list: TextTrackCueList | null): TimedSubtitleCue[] {
  if (list === null) return [];
  const cues: TimedSubtitleCue[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const cue = list[index] as (TextTrackCue & { text?: unknown }) | undefined;
    if (
      cue !== undefined &&
      typeof cue.text === 'string' &&
      isValidTimeSeconds(cue.startTime) &&
      isValidTimeSeconds(cue.endTime) &&
      cue.endTime >= cue.startTime
    ) {
      const text = normalizeSubtitleText(cue.text);
      if (text.length > 0) cues.push({ startTime: cue.startTime, endTime: cue.endTime, text });
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

function rejection(
  strategy: SubtitleRejectionReason['strategy'],
  code: SubtitleRejectionReason['code'],
  element: Element,
  text: string,
): SubtitleRejectionReason {
  const preview = normalizeSubtitleText(text).slice(0, 120);
  return {
    strategy,
    code,
    message: `Rejected a Douyin ${strategy} candidate: ${code}.`,
    selector: describeElement(element),
    textPreview: preview.length > 0 ? preview : null,
  };
}

function firstMatch(root: Element, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const value = root.querySelector(selector);
    if (value !== null) return value;
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
    if (value !== undefined && value !== null) values.push(value);
  }
  return values;
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

function describeElement(element: Element): string {
  const classes = Array.from(element.classList).slice(0, 3).join('.');
  return `${element.tagName.toLowerCase()}${classes.length > 0 ? `.${classes}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

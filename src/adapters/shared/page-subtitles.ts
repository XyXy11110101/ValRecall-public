import type { ExtractionDiagnostic, SubtitleContext } from '../../models/extraction';
import {
  isPageSubtitleSnapshot,
  type BilibiliPlayerDomElementSnapshot,
  type BilibiliSubtitleUrlResolutionSnapshot,
  type BilibiliSubtitleSelectionSnapshot,
  type BilibiliStructuralDiagnosticsSnapshot,
  type BilibiliStructureEntrySnapshot,
  type PageSubtitleSnapshot,
  type PageSubtitleTrackSnapshot,
} from '../../models/page-subtitles';
import type { VideoPlatform } from '../../models/platform';
import { diagnostic } from '../../models/extraction';
import {
  createSubtitleContext,
  normalizeSubtitleText,
  selectTimedSubtitleCues,
  type TimedSubtitleCue,
} from './subtitles';

const MAX_TEXT_LENGTH = 500;
const MAX_CLOCK_DRIFT_SECONDS = 3;

export interface SubtitleTrackExtraction {
  context: SubtitleContext | null;
  diagnostics: ExtractionDiagnostic[];
  available: boolean;
  unreadable: boolean;
}

export interface PageSubtitleSnapshotContext {
  platform: VideoPlatform;
  href: string;
  video: HTMLVideoElement | null;
  timestampSeconds: number | null;
}

export function extractSubtitleContextFromPageSnapshot(
  snapshotValue: unknown,
  context: PageSubtitleSnapshotContext,
): SubtitleTrackExtraction {
  const diagnostics: ExtractionDiagnostic[] = [];
  if (snapshotValue === null || snapshotValue === undefined) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-subtitle-bridge',
        'skipped',
        'No validated MAIN-world subtitle snapshot was available.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: false };
  }
  if (!isPageSubtitleSnapshot(snapshotValue)) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-subtitle-bridge',
        'failed',
        'Rejected an invalid MAIN-world subtitle snapshot.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: false };
  }
  if (!snapshotMatchesCapture(snapshotValue, context)) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-subtitle-stale-response',
        'failed',
        'Rejected a subtitle snapshot from a different page, player, or playback time.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: false };
  }

  diagnostics.push(
    diagnostic(
      'subtitles',
      'main-world-subtitle-bridge',
      'success',
      'Validated a bounded subtitle snapshot from the current player.',
    ),
  );
  if (context.platform === 'bilibili' && snapshotValue.bilibiliIdentity !== undefined) {
    const identityMatched = bilibiliIdentityMatchesContext(snapshotValue, context.href);
    diagnostics.push(
      diagnostic(
        'subtitles',
        'bilibili-active-video-identity',
        identityMatched ? 'success' : 'failed',
        identityMatched
          ? 'The BVID/aid, CID, part, player source, and current page evidence were internally consistent.'
          : 'Rejected Bilibili subtitle evidence with a stale BVID/aid, CID, part, or player identity.',
      ),
    );
    if (!identityMatched) {
      return { context: null, diagnostics, available: false, unreadable: false };
    }
  }
  if (context.platform === 'douyin') {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'douyin-current-work-structured-state',
        snapshotValue.structuredStateInspected ? 'success' : 'skipped',
        snapshotValue.structuredStateInspected
          ? 'Inspected bounded subtitle data associated with the selected Douyin work.'
          : 'No selected-work structured subtitle state was exposed.',
      ),
    );
  }
  const tracks = snapshotValue.tracks.filter(isSubtitleTrack);
  if (tracks.length === 0) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-bridge-track-count',
        'failed',
        'The current player exposed no subtitle tracks.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: false };
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'main-world-bridge-track-count',
      'success',
      `Discovered ${tracks.length} bounded subtitle track${tracks.length === 1 ? '' : 's'}.`,
    ),
  );

  if (context.platform === 'bilibili') {
    diagnostics.push(...bilibiliSelectionDiagnostics(snapshotValue.bilibiliSelection, tracks));
  }

  const selection = selectPreferredTracks(
    tracks,
    snapshotValue.selectedLanguage,
    context.platform,
    snapshotValue.bilibiliIdentity?.matched === true,
  );
  if (selection.tracks.length === 0) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-bridge-track-selection',
        'failed',
        snapshotValue.bilibiliSelection?.finalReason === 'ambiguous'
          ? 'Multiple Bilibili tracks remained ambiguous at the highest available evidence tier; no language was chosen silently.'
          : snapshotValue.selectedLanguage
            ? 'No candidate matched the player-selected subtitle language; unrelated translated tracks were not chosen.'
            : context.platform === 'bilibili' && tracks.length > 1
              ? 'Multiple Bilibili tracks remained ambiguous; no language was chosen silently.'
              : 'No active, language-matched, default, original, or identity-validated sole track was suitable.',
      ),
    );
    return { context: null, diagnostics, available: true, unreadable: true };
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'main-world-bridge-track-selection',
      'success',
      `Selected bridge track ${safeDiagnosticValue(selection.tracks[0]?.id)} (${safeDiagnosticValue(selection.tracks[0]?.language ?? 'language unavailable')}) by ${selection.reason}.`,
    ),
  );

  const selectedTrack = selection.tracks[0];
  if (context.platform === 'bilibili' && selectedTrack) {
    diagnostics.push(
      ...bilibiliSubtitleUrlDiagnostics(selectedTrack.resource?.urlResolution),
      bilibiliSubtitleResourceLoadDiagnostic(selectedTrack),
      diagnostic(
        'subtitles',
        'bilibili-selected-track-resource',
        selectedTrack.resource?.status === 'loaded'
          ? 'success'
          : selectedTrack.resource?.available
            ? 'failed'
            : 'skipped',
        describeBilibiliResource(selectedTrack),
      ),
    );
    diagnostics.push(...bilibiliStructuralDiagnostics(snapshotValue.bilibiliDiagnostics));
  }

  const readable = selection.tracks.filter((track) => track.cues.length > 0);
  if (readable.length === 0) {
    if (context.platform === 'bilibili') {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'bilibili-subtitle-cue-match',
          'failed',
          'The selected Bilibili track exposed no bounded readable cues to match.',
        ),
      );
    }
    diagnostics.push(
      diagnostic(
        'subtitles',
        'main-world-bridge-track-readability',
        'failed',
        'Subtitle tracks were available, but the current page did not expose readable cues.',
      ),
    );
    return { context: null, diagnostics, available: true, unreadable: true };
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'main-world-bridge-track-readability',
      'success',
      `Read ${readable[0]?.cues.length ?? 0} bounded cue candidates from the selected bridge track.`,
    ),
  );

  for (const track of readable) {
    const matched = selectTimedSubtitleCues(
      track.cues,
      context.timestampSeconds ?? 0,
      'text-track',
    );
    if (matched !== null) {
      diagnostics.push(
        ...(context.platform === 'bilibili'
          ? [
              diagnostic(
                'subtitles',
                'bilibili-subtitle-cue-match',
                'success',
                'Matched bounded cues from the selected Bilibili track to the captured timestamp.',
              ),
            ]
          : []),
        diagnostic(
          'subtitles',
          'main-world-bridge-cue-match',
          'success',
          'Matched the selected track to the captured timestamp.',
        ),
      );
      return { context: matched, diagnostics, available: true, unreadable: false };
    }
  }
  diagnostics.push(
    ...(context.platform === 'bilibili'
      ? [
          diagnostic(
            'subtitles',
            'bilibili-subtitle-cue-match',
            'failed',
            'Bounded cues from the selected Bilibili track did not overlap the captured timestamp.',
          ),
        ]
      : []),
    diagnostic(
      'subtitles',
      'main-world-bridge-cue-match',
      'failed',
      'Readable subtitle cues did not overlap the captured timestamp.',
    ),
  );
  return { context: null, diagnostics, available: true, unreadable: false };
}

function bilibiliSubtitleResourceLoadDiagnostic(
  track: PageSubtitleTrackSnapshot,
): ExtractionDiagnostic {
  const resource = track.resource;
  if (!resource || resource.status === 'none' || resource.status === 'not-selected') {
    return diagnostic(
      'subtitles',
      'bilibili-subtitle-resource-load',
      'skipped',
      'No validated selected-track subtitle resource was loaded.',
    );
  }
  if (resource.status === 'embedded-cues') {
    return diagnostic(
      'subtitles',
      'bilibili-subtitle-resource-load',
      'skipped',
      'The selected track already exposed bounded inline cues; no resource request was needed.',
    );
  }
  const succeeded = resource.status === 'loaded';
  return diagnostic(
    'subtitles',
    'bilibili-subtitle-resource-load',
    succeeded ? 'success' : 'failed',
    succeeded
      ? `Loaded ${resource.parsedCueCount} validated cue records from ${safeDiagnosticValue(resource.host ?? undefined)} under the existing bounded resource policy.`
      : `The bounded selected-track resource load ended with status=${resource.status}; no subtitle text was recorded in diagnostics.`,
  );
}

function bilibiliSubtitleUrlDiagnostics(
  resolution: BilibiliSubtitleUrlResolutionSnapshot | undefined,
): ExtractionDiagnostic[] {
  if (resolution === undefined) {
    return [
      diagnostic(
        'subtitles',
        'bilibili-subtitle-url-descriptor',
        'skipped',
        'No bounded subtitle_url descriptor result was available for the selected track.',
      ),
      diagnostic(
        'subtitles',
        'bilibili-subtitle-url-read',
        'skipped',
        'The selected track exposed no bounded subtitle_url read result.',
      ),
      diagnostic(
        'subtitles',
        'bilibili-subtitle-url-normalized',
        'skipped',
        'No selected-track subtitle URL was available to normalize.',
      ),
      diagnostic(
        'subtitles',
        'bilibili-subtitle-resource-validation',
        'skipped',
        'No selected-track subtitle URL was available for first-party validation.',
      ),
    ];
  }
  const hasResolvedValue =
    resolution.resultType === 'protocol-relative-url' ||
    resolution.resultType === 'absolute-https-url' ||
    resolution.resultType === 'string';
  const validated = resolution.validatedHost !== null && resolution.validatedPath !== null;
  const safeHostPath = validated
    ? `${safeDiagnosticValue(resolution.validatedHost ?? undefined)}${resolution.validatedPath}`
    : 'unavailable';
  return [
    diagnostic(
      'subtitles',
      'bilibili-subtitle-url-descriptor',
      resolution.descriptorLocation === 'none' ? 'skipped' : 'success',
      `Known property descriptor location=${resolution.descriptorLocation}; accessor=${resolution.accessorFound ? 'yes' : 'no'}.`,
    ),
    diagnostic(
      'subtitles',
      'bilibili-subtitle-url-read',
      resolution.propertyReadSucceeded ? 'success' : 'failed',
      `Exact selected-track property read=${resolution.propertyReadSucceeded ? 'succeeded' : 'failed'}; resultType=${resolution.resultType}.`,
    ),
    diagnostic(
      'subtitles',
      'bilibili-subtitle-url-normalized',
      validated ? 'success' : hasResolvedValue ? 'failed' : 'skipped',
      validated
        ? `Normalized the selected-track URL to HTTPS; protocolRelative=${resolution.protocolRelative ? 'yes' : 'no'}; safeHostPath=${safeHostPath}.`
        : hasResolvedValue
          ? 'The selected-track value did not normalize to an approved first-party HTTPS URL.'
          : 'The selected-track property produced no bounded URL string.',
    ),
    diagnostic(
      'subtitles',
      'bilibili-subtitle-resource-validation',
      validated ? 'success' : hasResolvedValue ? 'failed' : 'skipped',
      validated
        ? `Accepted the existing A27.1 first-party host/path policy for ${safeHostPath}.`
        : hasResolvedValue
          ? 'Rejected the selected-track URL under the existing A27.1 first-party host/path policy.'
          : 'No bounded selected-track URL reached first-party resource validation.',
    ),
  ];
}

function bilibiliSelectionDiagnostics(
  value: BilibiliSubtitleSelectionSnapshot | undefined,
  fallbackTracks: readonly PageSubtitleTrackSnapshot[],
): ExtractionDiagnostic[] {
  const tracks =
    value?.tracks ??
    fallbackTracks.map(({ id, language, selected, active, default: isDefault, original }) => ({
      id,
      language,
      selected,
      active,
      default: isDefault,
      original,
    }));
  const diagnostics: ExtractionDiagnostic[] = [
    diagnostic(
      'subtitles',
      'bilibili-track-state-summary',
      tracks.length > 0 ? 'success' : 'failed',
      `Recorded ${tracks.length} bounded Bilibili subtitle track state${tracks.length === 1 ? '' : 's'}; only identifiers, language codes, and selection flags are included.`,
    ),
    ...tracks.map((track) =>
      diagnostic(
        'subtitles',
        'bilibili-track-state',
        'success',
        boundedDiagnosticMessage(
          `id=${safeDiagnosticValue(track.id)}; language=${safeDiagnosticValue(track.language ?? 'none')}; selected=${track.selected ? 'yes' : 'no'}; active=${track.active ? 'yes' : 'no'}; default=${track.default ? 'yes' : 'no'}; original=${track.original ? 'yes' : 'no'}.`,
        ),
      ),
    ),
  ];
  if (value === undefined) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'bilibili-active-player-subtitle',
        'skipped',
        'No bounded active Bilibili player subtitle identity was exposed.',
      ),
    );
    return diagnostics;
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'bilibili-active-player-subtitle',
      value.source === 'none' ? 'skipped' : 'success',
      boundedDiagnosticMessage(
        `source=${value.source}; trackId=${safeDiagnosticValue(value.activeTrackId ?? 'none')}; language=${safeDiagnosticValue(value.activeLanguage ?? 'none')}.`,
      ),
    ),
    diagnostic(
      'subtitles',
      'bilibili-track-selection-reason',
      value.finalReason === 'none' || value.finalReason === 'ambiguous' ? 'failed' : 'success',
      `Final bounded Bilibili track selection reason: ${value.finalReason}.`,
    ),
  );
  return diagnostics;
}

function bilibiliStructuralDiagnostics(
  value: BilibiliStructuralDiagnosticsSnapshot | undefined,
): ExtractionDiagnostic[] {
  if (value === undefined) {
    return [
      diagnostic(
        'subtitles',
        'bilibili-structural-diagnostics',
        'skipped',
        'No bounded Bilibili structural diagnostic snapshot was available.',
      ),
    ];
  }
  const selectedEntries = value.stateEntries.filter((entry) => entry.scope === 'selected-track');
  const playerEntries = value.stateEntries.filter(
    (entry) => entry.scope === 'current-player-state',
  );
  const diagnostics: ExtractionDiagnostic[] = [
    diagnostic(
      'subtitles',
      'bilibili-selected-track-structure-summary',
      selectedEntries.length > 0 ? 'success' : 'failed',
      `Recorded ${selectedEntries.length} bounded selected-track structure entries; values were reduced to names, types, lengths, HTTPS presence, safe first-party host/path, and cue-like counts.`,
    ),
    ...selectedEntries.map((entry) => structureEntryDiagnostic(entry)),
    diagnostic(
      'subtitles',
      'bilibili-current-player-state-summary',
      playerEntries.length > 0 ? 'success' : 'failed',
      `Recorded ${playerEntries.length} bounded current-player subtitle-state entries; limit reached: ${value.stateEntryLimitReached ? 'yes' : 'no'}.`,
    ),
    ...playerEntries.map((entry) => structureEntryDiagnostic(entry)),
    diagnostic(
      'subtitles',
      'bilibili-lower-player-dom-summary',
      value.domElements.length > 0 ? 'success' : 'failed',
      `Recorded ${value.domElements.length} bounded visible elements intersecting the selected player video, prioritising its lower region; limit reached: ${value.domElementLimitReached ? 'yes' : 'no'}.`,
    ),
    ...value.domElements.map((element) => domElementDiagnostic(element)),
  ];
  return diagnostics;
}

function structureEntryDiagnostic(entry: BilibiliStructureEntrySnapshot): ExtractionDiagnostic {
  const keys = entry.keys.length > 0 ? entry.keys.join(',') : 'none';
  const safeUrls =
    entry.safeHttpsUrls.length > 0
      ? entry.safeHttpsUrls.map((url) => `${url.host}${url.path}`).join(',')
      : 'none';
  const message = boundedDiagnosticMessage(
    `path=${entry.path}; type=${entry.valueType}; keys=[${keys}]; arrayLength=${entry.arrayLength ?? 'none'}; httpsValue=${entry.httpsValuePresent ? 'yes' : 'no'}; safeHttpsHostPath=[${safeUrls}]; cueLikeItems=${entry.cueLikeItemCount}.`,
  );
  return diagnostic(
    'subtitles',
    entry.scope === 'selected-track'
      ? 'bilibili-selected-track-structure'
      : 'bilibili-current-player-subtitle-state',
    'success',
    message,
  );
}

function domElementDiagnostic(element: BilibiliPlayerDomElementSnapshot): ExtractionDiagnostic {
  return diagnostic(
    'subtitles',
    'bilibili-lower-player-dom-element',
    'success',
    boundedDiagnosticMessage(
      `tag=${element.tag}; classes=[${element.classTokens.join(',') || 'none'}]; dataAttributes=[${element.dataAttributeNames.join(',') || 'none'}]; bounds=${element.bounds.x},${element.bounds.y},${element.bounds.width},${element.bounds.height}; textLength=${element.textLength}.`,
    ),
  );
}

function boundedDiagnosticMessage(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 480);
}

export function extractSubtitleContextFromDomTextTracks(
  video: HTMLVideoElement,
  timestampSeconds: number,
): SubtitleTrackExtraction {
  const diagnostics: ExtractionDiagnostic[] = [];
  let tracks: TextTrack[];
  try {
    tracks = indexedList(video.textTracks).filter(isDomSubtitleTrack);
  } catch {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'dom-video-text-track-count',
        'failed',
        'The selected video blocked text-track discovery.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: true };
  }
  if (tracks.length === 0) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'dom-video-text-track-count',
        'failed',
        'The selected video exposed no subtitle tracks.',
      ),
    );
    return { context: null, diagnostics, available: false, unreadable: false };
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'dom-video-text-track-count',
      'success',
      `Discovered ${tracks.length} DOM subtitle track${tracks.length === 1 ? '' : 's'}.`,
    ),
  );

  const showing = tracks.filter((track) => track.mode === 'showing');
  const active = tracks.filter(
    (track) => track.mode !== 'disabled' && safeCueCount(track.activeCues) > 0,
  );
  const defaults = defaultDomTracks(video, tracks);
  const candidates = uniqueTracks([...showing, ...active, ...defaults]);
  if (candidates.length === 0) {
    diagnostics.push(
      diagnostic(
        'subtitles',
        'dom-video-text-track-selection',
        'failed',
        'No active or default DOM subtitle track could be selected safely.',
      ),
    );
    return { context: null, diagnostics, available: true, unreadable: true };
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'dom-video-text-track-selection',
      'success',
      'Selected an active or default DOM subtitle track.',
    ),
  );

  let readable = false;
  for (const track of candidates) {
    const cues = safeReadCueList(track.cues);
    const activeCues = safeReadCueList(track.activeCues);
    if (cues.length > 0 || activeCues.length > 0) readable = true;
    const context = selectTimedSubtitleCues(cues, timestampSeconds, 'text-track');
    if (context !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'dom-video-text-track-readability',
          'success',
          'Read DOM subtitle cues.',
        ),
        diagnostic(
          'subtitles',
          'dom-video-text-track-cue-match',
          'success',
          'Matched a DOM subtitle cue to the captured timestamp.',
        ),
      );
      return { context, diagnostics, available: true, unreadable: false };
    }
    const activeContext = currentOnlyTextTrackContext(activeCues, timestampSeconds);
    if (activeContext !== null) {
      diagnostics.push(
        diagnostic(
          'subtitles',
          'dom-video-text-track-readability',
          'success',
          'Read active DOM subtitle cues.',
        ),
        diagnostic(
          'subtitles',
          'dom-video-text-track-cue-match',
          'success',
          'Matched an active DOM subtitle cue to the captured timestamp.',
        ),
      );
      return { context: activeContext, diagnostics, available: true, unreadable: false };
    }
  }
  diagnostics.push(
    diagnostic(
      'subtitles',
      'dom-video-text-track-readability',
      readable ? 'success' : 'failed',
      readable
        ? 'Read DOM subtitle cues.'
        : 'Subtitle tracks were available, but their cues were unreadable.',
    ),
    diagnostic(
      'subtitles',
      'dom-video-text-track-cue-match',
      'failed',
      'No readable DOM subtitle cue overlapped the captured timestamp.',
    ),
  );
  return { context: null, diagnostics, available: true, unreadable: !readable };
}

function snapshotMatchesCapture(
  snapshot: PageSubtitleSnapshot,
  context: PageSubtitleSnapshotContext,
): boolean {
  if (
    snapshot.platform !== context.platform ||
    snapshot.href !== context.href ||
    context.video === null ||
    context.timestampSeconds === null ||
    Math.abs(snapshot.video.currentTime - context.timestampSeconds) > MAX_CLOCK_DRIFT_SECONDS
  ) {
    return false;
  }
  const currentSrc = safeVideoSource(context.video);
  return !snapshot.video.currentSrc || !currentSrc || snapshot.video.currentSrc === currentSrc;
}

function selectPreferredTracks(
  tracks: readonly PageSubtitleTrackSnapshot[],
  selectedLanguage: string | null,
  platform: VideoPlatform,
  bilibiliIdentityMatched: boolean,
): {
  tracks: PageSubtitleTrackSnapshot[];
  reason:
    | 'explicit player state'
    | 'selected language'
    | 'default/original metadata'
    | 'sole validated track'
    | 'none';
} {
  const selected = tracks.filter((track) => track.selected);
  if (selected.length > 0) {
    return platform === 'bilibili' && selected.length !== 1
      ? { tracks: [], reason: 'none' }
      : { tracks: selected, reason: 'explicit player state' };
  }
  const active = tracks.filter((track) => track.active || track.mode === 'showing');
  if (active.length > 0) {
    return platform === 'bilibili' && active.length !== 1
      ? { tracks: [], reason: 'none' }
      : { tracks: active, reason: 'explicit player state' };
  }
  if (selectedLanguage) {
    const matchingLanguage = tracks.filter((track) =>
      languageMatches(track.language, selectedLanguage),
    );
    if (matchingLanguage.length > 0) {
      if (platform === 'bilibili' && matchingLanguage.length !== 1) {
        return { tracks: [], reason: 'none' };
      }
      return { tracks: matchingLanguage, reason: 'selected language' };
    }
  }
  const defaults = tracks.filter((track) => (track.default || track.original) && !track.translated);
  if (defaults.length > 0) {
    return platform === 'bilibili' && defaults.length !== 1
      ? { tracks: [], reason: 'none' }
      : { tracks: defaults, reason: 'default/original metadata' };
  }
  if (
    platform === 'bilibili' &&
    bilibiliIdentityMatched &&
    tracks.length === 1 &&
    !tracks[0]?.translated
  ) {
    return { tracks: [tracks[0]!], reason: 'sole validated track' };
  }
  return { tracks: [], reason: 'none' };
}

function bilibiliIdentityMatchesContext(snapshot: PageSubtitleSnapshot, href: string): boolean {
  const identity = snapshot.bilibiliIdentity;
  if (!identity?.matched) return false;
  try {
    const url = new URL(href);
    const pathIdentity = url.pathname.match(
      /^\/(?:(?:zh-Hans|zh-Hant|en|ja)\/)?video\/(BV[A-Za-z0-9]+|av\d+)(?:\/|$)/iu,
    )?.[1];
    const queryBvid = url.searchParams.get('bvid');
    const queryAidValue = url.searchParams.get('aid');
    const queryAid = queryAidValue
      ? /^av\d+$/iu.test(queryAidValue)
        ? queryAidValue
        : /^\d+$/u.test(queryAidValue)
          ? `av${queryAidValue}`
          : null
      : null;
    const currentBvid =
      pathIdentity && /^BV[A-Za-z0-9]+$/iu.test(pathIdentity) ? pathIdentity : queryBvid;
    const currentAid = pathIdentity && /^av\d+$/iu.test(pathIdentity) ? pathIdentity : queryAid;
    const currentPart = Number(url.searchParams.get('p') ?? '1');
    if (
      (!currentBvid && !currentAid) ||
      !Number.isInteger(currentPart) ||
      currentPart !== identity.part
    ) {
      return false;
    }
    return currentBvid
      ? identity.bvid?.toLocaleLowerCase() === currentBvid.toLocaleLowerCase()
      : identity.aid?.toLocaleLowerCase() === currentAid?.toLocaleLowerCase();
  } catch {
    return false;
  }
}

function describeBilibiliResource(track: PageSubtitleTrackSnapshot): string {
  const resource = track.resource;
  if (!resource || !resource.available) {
    return track.cues.length > 0
      ? 'The selected track exposed embedded cues; no subtitle resource request was needed.'
      : 'The selected track exposed no subtitle resource URL.';
  }
  const host = safeDiagnosticValue(resource.host ?? 'host rejected');
  switch (resource.status) {
    case 'loaded':
      return `Loaded and validated ${resource.parsedCueCount} timed cues from the selected first-party resource on ${host}; only bounded context was retained.`;
    case 'rejected':
      return 'Rejected the selected track resource because its HTTPS host or path was not allowlisted.';
    case 'oversized':
      return `Rejected an oversized selected-track subtitle response from ${host}.`;
    case 'malformed':
      return `Rejected a malformed selected-track subtitle response from ${host}.`;
    case 'request-failed':
      return `The selected first-party subtitle resource on ${host} could not be read safely.`;
    case 'not-selected':
      return 'A subtitle resource exists, but its track was not safely selected for retrieval.';
    case 'embedded-cues':
      return 'The selected track exposed embedded cues; no subtitle resource request was needed.';
    case 'none':
      return 'The selected track exposed no subtitle resource URL.';
  }
}

function safeDiagnosticValue(value: string | undefined): string {
  if (!value) return 'unavailable';
  return value.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 80) || 'unavailable';
}

function currentOnlyTextTrackContext(
  cues: readonly TimedSubtitleCue[],
  timestampSeconds: number,
): SubtitleContext | null {
  const current = cues.filter(
    (cue) => cue.startTime <= timestampSeconds && cue.endTime > timestampSeconds,
  );
  if (current.length === 0) return null;
  return createSubtitleContext({
    status: 'current_only',
    extractionStrategy: 'text_track_timed_cues',
    current: current.map((cue) => cue.text),
    timedCues: current.map((cue) => ({ ...cue, source: 'text-track' })),
  });
}

function safeReadCueList(list: TextTrackCueList | null): TimedSubtitleCue[] {
  try {
    if (list === null) return [];
    const cues: TimedSubtitleCue[] = [];
    for (let index = 0; index < Math.min(list.length, 2_000); index += 1) {
      const cue = list[index] as (TextTrackCue & { text?: unknown }) | undefined;
      if (
        cue &&
        typeof cue.text === 'string' &&
        isNonNegativeNumber(cue.startTime) &&
        isNonNegativeNumber(cue.endTime) &&
        cue.endTime >= cue.startTime
      ) {
        const text = normalizeSubtitleText(cue.text);
        if (text.length > 0 && text.length <= MAX_TEXT_LENGTH) {
          cues.push({ startTime: cue.startTime, endTime: cue.endTime, text });
        }
      }
    }
    return cues;
  } catch {
    return [];
  }
}

function defaultDomTracks(video: HTMLVideoElement, tracks: readonly TextTrack[]): TextTrack[] {
  const defaults: TextTrack[] = [];
  for (const element of video.querySelectorAll('track[default]')) {
    if (element instanceof HTMLTrackElement && tracks.includes(element.track)) {
      defaults.push(element.track);
    }
  }
  return defaults;
}

function uniqueTracks(tracks: readonly TextTrack[]): TextTrack[] {
  return [...new Set(tracks)];
}

function indexedList<T>(list: { length: number; [index: number]: T }): T[] {
  return Array.from({ length: list.length }, (_, index) => list[index]).filter(
    (value): value is T => value !== undefined,
  );
}

function safeCueCount(list: TextTrackCueList | null): number {
  try {
    return list?.length ?? 0;
  } catch {
    return 0;
  }
}

function safeVideoSource(video: HTMLVideoElement): string | null {
  try {
    return video.currentSrc || video.src || null;
  } catch {
    return null;
  }
}

function isSubtitleTrack(track: PageSubtitleTrackSnapshot): boolean {
  return track.kind === 'subtitles' || track.kind === 'captions';
}

function isDomSubtitleTrack(track: TextTrack): boolean {
  return track.kind === 'subtitles' || track.kind === 'captions';
}

function languageMatches(trackLanguage: string | null, selectedLanguage: string): boolean {
  if (!trackLanguage) return false;
  const track = trackLanguage.toLocaleLowerCase();
  const selected = selectedLanguage.toLocaleLowerCase();
  return track === selected || track.startsWith(`${selected}-`) || selected.startsWith(`${track}-`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

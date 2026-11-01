import type { VideoPlatform } from './platform';

export const PAGE_SUBTITLE_SNAPSHOT_VERSION = 1 as const;
export const MAX_PAGE_SUBTITLE_TRACKS = 12;
export const MAX_PAGE_SUBTITLE_CUES_PER_TRACK = 9;
export const MAX_PAGE_SUBTITLE_TEXT_LENGTH = 500;
export const MAX_BILIBILI_STRUCTURE_ENTRIES = 32;
export const MAX_BILIBILI_STRUCTURE_KEYS = 20;
export const MAX_BILIBILI_SAFE_URLS_PER_ENTRY = 4;
export const MAX_BILIBILI_PLAYER_DOM_ELEMENTS = 20;

export type PageStructureValueType =
  | 'array'
  | 'object'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'accessor'
  | 'function'
  | 'other';

export interface PageStructureSafeUrlSnapshot {
  host: string;
  path: string;
}

export interface BilibiliStructureEntrySnapshot {
  scope: 'selected-track' | 'current-player-state';
  path: string;
  valueType: PageStructureValueType;
  keys: string[];
  arrayLength: number | null;
  httpsValuePresent: boolean;
  safeHttpsUrls: PageStructureSafeUrlSnapshot[];
  cueLikeItemCount: number;
}

export interface BilibiliPlayerDomElementSnapshot {
  tag: string;
  classTokens: string[];
  dataAttributeNames: string[];
  bounds: { x: number; y: number; width: number; height: number };
  textLength: number;
}

export interface BilibiliStructuralDiagnosticsSnapshot {
  stateEntries: BilibiliStructureEntrySnapshot[];
  stateEntryLimitReached: boolean;
  domElements: BilibiliPlayerDomElementSnapshot[];
  domElementLimitReached: boolean;
}

export type PageSubtitleResourceStatus =
  | 'none'
  | 'embedded-cues'
  | 'not-selected'
  | 'loaded'
  | 'rejected'
  | 'request-failed'
  | 'malformed'
  | 'oversized';

export interface PageSubtitleResourceSnapshot {
  available: boolean;
  status: PageSubtitleResourceStatus;
  host: string | null;
  parsedCueCount: number;
  urlResolution?: BilibiliSubtitleUrlResolutionSnapshot;
}

export type BilibiliSubtitleUrlDescriptorLocation = 'own' | 'prototype' | 'none';
export type BilibiliSubtitleUrlResultType =
  'absent' | 'string' | 'protocol-relative-url' | 'absolute-https-url' | 'invalid-type';

export interface BilibiliSubtitleUrlResolutionSnapshot {
  accessorFound: boolean;
  descriptorLocation: BilibiliSubtitleUrlDescriptorLocation;
  propertyReadSucceeded: boolean;
  resultType: BilibiliSubtitleUrlResultType;
  protocolRelative: boolean;
  validatedHost: string | null;
  validatedPath: string | null;
}

export interface BilibiliSubtitleIdentitySnapshot {
  bvid: string | null;
  aid: string | null;
  cid: string | null;
  part: number;
  matched: boolean;
}

export type BilibiliSubtitleSelectionSource =
  'dom-text-track' | 'player-subtitle-state' | 'active-subtitle-menu' | 'none';

export type BilibiliSubtitleSelectionReason =
  | 'explicit-track-id'
  | 'explicit-active-track'
  | 'explicit-language'
  | 'default-original'
  | 'sole-validated-track'
  | 'ambiguous'
  | 'none';

export interface BilibiliSubtitleTrackStateSnapshot {
  id: string;
  language: string | null;
  selected: boolean;
  active: boolean;
  default: boolean;
  original: boolean;
}

export interface BilibiliSubtitleSelectionSnapshot {
  tracks: BilibiliSubtitleTrackStateSnapshot[];
  activeTrackId: string | null;
  activeLanguage: string | null;
  source: BilibiliSubtitleSelectionSource;
  finalReason: BilibiliSubtitleSelectionReason;
}

export interface PageSubtitleCueSnapshot {
  startTime: number;
  endTime: number;
  text: string;
}

export interface PageSubtitleTrackSnapshot {
  id: string;
  kind: 'subtitles' | 'captions';
  language: string | null;
  label: string | null;
  mode: 'disabled' | 'hidden' | 'showing';
  active: boolean;
  selected: boolean;
  default: boolean;
  original: boolean;
  automatic: boolean;
  translated: boolean;
  cues: PageSubtitleCueSnapshot[];
  resource?: PageSubtitleResourceSnapshot;
}

export interface PageSubtitleSnapshot {
  version: typeof PAGE_SUBTITLE_SNAPSHOT_VERSION;
  requestId: string;
  platform: VideoPlatform;
  href: string;
  collectedAt: number;
  selectedLanguage: string | null;
  structuredStateInspected: boolean;
  bilibiliIdentity?: BilibiliSubtitleIdentitySnapshot;
  bilibiliSelection?: BilibiliSubtitleSelectionSnapshot;
  bilibiliDiagnostics?: BilibiliStructuralDiagnosticsSnapshot;
  video: {
    currentTime: number;
    duration: number | null;
    currentSrc: string | null;
  };
  tracks: PageSubtitleTrackSnapshot[];
}

export function isPageSubtitleSnapshot(value: unknown): value is PageSubtitleSnapshot {
  if (!isRecord(value) || value.version !== PAGE_SUBTITLE_SNAPSHOT_VERSION) return false;
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    !isVideoPlatform(value.platform) ||
    typeof value.href !== 'string' ||
    !isHttpUrl(value.href) ||
    !isFiniteNumber(value.collectedAt) ||
    !(value.selectedLanguage === null || isBoundedString(value.selectedLanguage, 80)) ||
    typeof value.structuredStateInspected !== 'boolean' ||
    !isRecord(value.video) ||
    !isNonNegativeNumber(value.video.currentTime) ||
    !(value.video.duration === null || isNonNegativeNumber(value.video.duration)) ||
    !(value.video.currentSrc === null || isBoundedString(value.video.currentSrc, 2_048)) ||
    !Array.isArray(value.tracks) ||
    value.tracks.length > MAX_PAGE_SUBTITLE_TRACKS
  ) {
    return false;
  }
  return (
    (value.bilibiliIdentity === undefined ||
      isBilibiliSubtitleIdentitySnapshot(value.bilibiliIdentity)) &&
    (value.bilibiliSelection === undefined ||
      isBilibiliSubtitleSelectionSnapshot(value.bilibiliSelection)) &&
    (value.bilibiliDiagnostics === undefined ||
      isBilibiliStructuralDiagnosticsSnapshot(value.bilibiliDiagnostics)) &&
    value.tracks.every(isPageSubtitleTrackSnapshot)
  );
}

function isBilibiliSubtitleSelectionSnapshot(
  value: unknown,
): value is BilibiliSubtitleSelectionSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= MAX_PAGE_SUBTITLE_TRACKS &&
    value.tracks.every(isBilibiliSubtitleTrackStateSnapshot) &&
    (value.activeTrackId === null || isBoundedString(value.activeTrackId, 200)) &&
    (value.activeLanguage === null || isBoundedString(value.activeLanguage, 80)) &&
    ['dom-text-track', 'player-subtitle-state', 'active-subtitle-menu', 'none'].includes(
      String(value.source),
    ) &&
    [
      'explicit-track-id',
      'explicit-active-track',
      'explicit-language',
      'default-original',
      'sole-validated-track',
      'ambiguous',
      'none',
    ].includes(String(value.finalReason))
  );
}

function isBilibiliSubtitleTrackStateSnapshot(
  value: unknown,
): value is BilibiliSubtitleTrackStateSnapshot {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 200) &&
    (value.language === null || isBoundedString(value.language, 80)) &&
    typeof value.selected === 'boolean' &&
    typeof value.active === 'boolean' &&
    typeof value.default === 'boolean' &&
    typeof value.original === 'boolean'
  );
}

function isBilibiliStructuralDiagnosticsSnapshot(
  value: unknown,
): value is BilibiliStructuralDiagnosticsSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.stateEntries) &&
    value.stateEntries.length <= MAX_BILIBILI_STRUCTURE_ENTRIES &&
    value.stateEntries.every(isBilibiliStructureEntrySnapshot) &&
    typeof value.stateEntryLimitReached === 'boolean' &&
    Array.isArray(value.domElements) &&
    value.domElements.length <= MAX_BILIBILI_PLAYER_DOM_ELEMENTS &&
    value.domElements.every(isBilibiliPlayerDomElementSnapshot) &&
    typeof value.domElementLimitReached === 'boolean'
  );
}

function isBilibiliStructureEntrySnapshot(value: unknown): value is BilibiliStructureEntrySnapshot {
  return (
    isRecord(value) &&
    (value.scope === 'selected-track' || value.scope === 'current-player-state') &&
    isStructuralName(value.path, 360) &&
    [
      'array',
      'object',
      'string',
      'number',
      'boolean',
      'null',
      'undefined',
      'accessor',
      'function',
      'other',
    ].includes(String(value.valueType)) &&
    isStructuralNameArray(value.keys, MAX_BILIBILI_STRUCTURE_KEYS, 120) &&
    (value.arrayLength === null ||
      (Number.isInteger(value.arrayLength) && isNonNegativeNumber(value.arrayLength))) &&
    typeof value.httpsValuePresent === 'boolean' &&
    Array.isArray(value.safeHttpsUrls) &&
    value.safeHttpsUrls.length <= MAX_BILIBILI_SAFE_URLS_PER_ENTRY &&
    value.safeHttpsUrls.every(isPageStructureSafeUrlSnapshot) &&
    Number.isInteger(value.cueLikeItemCount) &&
    isNonNegativeNumber(value.cueLikeItemCount) &&
    value.cueLikeItemCount <= 200
  );
}

function isPageStructureSafeUrlSnapshot(value: unknown): value is PageStructureSafeUrlSnapshot {
  return (
    isRecord(value) &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    value.host.length <= 253 &&
    /^[a-z0-9.-]+$/u.test(value.host) &&
    typeof value.path === 'string' &&
    value.path.startsWith('/') &&
    value.path.length <= 300 &&
    !/[?#\r\n\t]/u.test(value.path)
  );
}

function isBilibiliPlayerDomElementSnapshot(
  value: unknown,
): value is BilibiliPlayerDomElementSnapshot {
  const bounds = isRecord(value) && isRecord(value.bounds) ? value.bounds : null;
  return (
    isRecord(value) &&
    typeof value.tag === 'string' &&
    /^[a-z][a-z0-9-]{0,39}$/u.test(value.tag) &&
    isStructuralNameArray(value.classTokens, 12, 80) &&
    isStructuralNameArray(value.dataAttributeNames, 12, 80) &&
    bounds !== null &&
    ['x', 'y', 'width', 'height'].every((key) => isFiniteNumber(bounds[key])) &&
    (bounds.width as number) >= 0 &&
    (bounds.height as number) >= 0 &&
    Number.isInteger(value.textLength) &&
    isNonNegativeNumber(value.textLength) &&
    value.textLength <= 20_000
  );
}

function isStructuralNameArray(value: unknown, maximum: number, maximumLength: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => isStructuralName(entry, maximumLength))
  );
}

function isStructuralName(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function isPageSubtitleTrackSnapshot(value: unknown): value is PageSubtitleTrackSnapshot {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 200) &&
    (value.kind === 'subtitles' || value.kind === 'captions') &&
    (value.language === null || isBoundedString(value.language, 80)) &&
    (value.label === null || isBoundedString(value.label, 200)) &&
    (value.mode === 'disabled' || value.mode === 'hidden' || value.mode === 'showing') &&
    typeof value.active === 'boolean' &&
    typeof value.selected === 'boolean' &&
    typeof value.default === 'boolean' &&
    typeof value.original === 'boolean' &&
    typeof value.automatic === 'boolean' &&
    typeof value.translated === 'boolean' &&
    Array.isArray(value.cues) &&
    value.cues.length <= MAX_PAGE_SUBTITLE_CUES_PER_TRACK &&
    value.cues.every(isPageSubtitleCueSnapshot) &&
    (value.resource === undefined || isPageSubtitleResourceSnapshot(value.resource))
  );
}

function isPageSubtitleResourceSnapshot(value: unknown): value is PageSubtitleResourceSnapshot {
  return (
    isRecord(value) &&
    typeof value.available === 'boolean' &&
    [
      'none',
      'embedded-cues',
      'not-selected',
      'loaded',
      'rejected',
      'request-failed',
      'malformed',
      'oversized',
    ].includes(String(value.status)) &&
    (value.host === null || isBoundedString(value.host, 253)) &&
    Number.isInteger(value.parsedCueCount) &&
    isNonNegativeNumber(value.parsedCueCount) &&
    (value.urlResolution === undefined ||
      isBilibiliSubtitleUrlResolutionSnapshot(value.urlResolution))
  );
}

function isBilibiliSubtitleUrlResolutionSnapshot(
  value: unknown,
): value is BilibiliSubtitleUrlResolutionSnapshot {
  return (
    isRecord(value) &&
    typeof value.accessorFound === 'boolean' &&
    ['own', 'prototype', 'none'].includes(String(value.descriptorLocation)) &&
    typeof value.propertyReadSucceeded === 'boolean' &&
    ['absent', 'string', 'protocol-relative-url', 'absolute-https-url', 'invalid-type'].includes(
      String(value.resultType),
    ) &&
    typeof value.protocolRelative === 'boolean' &&
    (value.validatedHost === null ||
      (isBoundedString(value.validatedHost, 253) && /^[a-z0-9.-]+$/u.test(value.validatedHost))) &&
    (value.validatedPath === null ||
      (typeof value.validatedPath === 'string' &&
        value.validatedPath.startsWith('/') &&
        value.validatedPath.length <= 300 &&
        !/[?#\r\n\t]/u.test(value.validatedPath)))
  );
}

function isBilibiliSubtitleIdentitySnapshot(
  value: unknown,
): value is BilibiliSubtitleIdentitySnapshot {
  return (
    isRecord(value) &&
    (value.bvid === null ||
      (isBoundedString(value.bvid, 80) && /^BV[A-Za-z0-9]+$/u.test(value.bvid))) &&
    (value.aid === null || (isBoundedString(value.aid, 40) && /^av\d+$/u.test(value.aid))) &&
    (value.cid === null || (isBoundedString(value.cid, 40) && /^\d+$/u.test(value.cid))) &&
    Number.isInteger(value.part) &&
    isNonNegativeNumber(value.part) &&
    value.part >= 1 &&
    typeof value.matched === 'boolean'
  );
}

function isPageSubtitleCueSnapshot(value: unknown): value is PageSubtitleCueSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.startTime) &&
    isNonNegativeNumber(value.endTime) &&
    value.endTime >= value.startTime &&
    isBoundedString(value.text, MAX_PAGE_SUBTITLE_TEXT_LENGTH)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVideoPlatform(value: unknown): value is VideoPlatform {
  return value === 'youtube' || value === 'bilibili' || value === 'douyin';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

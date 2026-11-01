import type { VideoPlatform } from '../models/platform';

export interface PageSubtitleBridgeRequest {
  requestId: string;
  platform: VideoPlatform;
  expectedHref: string;
}

/**
 * Runs in the page MAIN world. Keep this function self-contained: Chrome serializes
 * the function body, so imported helpers are intentionally not referenced here.
 */
export async function collectMainWorldSubtitleSnapshot(requestValue: unknown): Promise<unknown> {
  const MAX_TRACKS = 12;
  const MAX_CUES = 9;
  const MAX_TEXT_LENGTH = 500;
  const CONTEXT_WINDOW_SECONDS = 120;
  const MAX_RESOURCE_BYTES = 1_000_000;
  const MAX_RESOURCE_CUES = 20_000;
  const RESOURCE_TIMEOUT_MS = 3_000;
  const MAX_BILIBILI_STRUCTURE_ENTRIES = 32;
  const MAX_BILIBILI_SELECTED_TRACK_ENTRIES = 18;
  const MAX_BILIBILI_STRUCTURE_KEYS = 20;
  const MAX_BILIBILI_SAFE_URLS = 4;
  const MAX_BILIBILI_DOM_ELEMENTS = 20;
  const MAX_BILIBILI_DOM_NODES_INSPECTED = 600;
  const BILIBILI_SUBTITLE_HOSTS = new Set([
    'aisubtitle.hdslb.com',
    'i0.hdslb.com',
    'i1.hdslb.com',
    'i2.hdslb.com',
  ]);
  const BILIBILI_DIAGNOSTIC_HOST_SUFFIXES = ['bilibili.com', 'hdslb.com', 'bilivideo.com'] as const;

  type StructureValueType =
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
  type BilibiliStructureEntry = {
    scope: 'selected-track' | 'current-player-state';
    path: string;
    valueType: StructureValueType;
    keys: string[];
    arrayLength: number | null;
    httpsValuePresent: boolean;
    safeHttpsUrls: Array<{ host: string; path: string }>;
    cueLikeItemCount: number;
  };
  type BilibiliDomElement = {
    tag: string;
    classTokens: string[];
    dataAttributeNames: string[];
    bounds: { x: number; y: number; width: number; height: number };
    textLength: number;
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const isPlatform = (value: unknown): value is VideoPlatform =>
    value === 'youtube' || value === 'bilibili' || value === 'douyin';
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const text = (value: unknown, maximum = MAX_TEXT_LENGTH): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
  const normalise = (value: string): string =>
    value
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const safeRecordValue = (record: Record<string, unknown>, keys: readonly string[]): unknown => {
    for (const key of keys) {
      try {
        if (key in record) return record[key];
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const structuralName = (value: string, maximum = 120): string | null =>
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
      ? value
      : null;
  const safeOwnKeys = (value: object): string[] => {
    try {
      return Object.keys(value)
        .map((key) => structuralName(key))
        .filter((key): key is string => key !== null)
        .slice(0, MAX_BILIBILI_STRUCTURE_KEYS);
    } catch {
      return [];
    }
  };
  const safeOwnValue = (value: object, key: string): { value: unknown; accessor: boolean } => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return { value: undefined, accessor: false };
      if (!('value' in descriptor)) return { value: undefined, accessor: true };
      return { value: descriptor.value, accessor: false };
    } catch {
      return { value: undefined, accessor: true };
    }
  };
  const structureValueType = (value: unknown, accessor = false): StructureValueType => {
    if (accessor) return 'accessor';
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
      case 'object':
        return 'object';
      case 'string':
        return 'string';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'undefined':
        return 'undefined';
      case 'function':
        return 'function';
      default:
        return 'other';
    }
  };
  const safeDiagnosticUrl = (value: string): { host: string; path: string } | null => {
    if (!/^https:\/\//iu.test(value) && !/^\/\//u.test(value)) return null;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      const hostname = url.hostname.toLocaleLowerCase();
      const firstParty = BILIBILI_DIAGNOSTIC_HOST_SUFFIXES.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
      );
      if (
        url.protocol !== 'https:' ||
        !firstParty ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0 ||
        url.pathname.length === 0 ||
        url.pathname.length > 300 ||
        /[\r\n\t?#]/u.test(url.pathname)
      ) {
        return null;
      }
      return { host: hostname, path: url.pathname };
    } catch {
      return null;
    }
  };
  const cueLikeItemCount = (value: unknown): number => {
    if (!Array.isArray(value)) return 0;
    let count = 0;
    for (const item of value.slice(0, 200)) {
      if (!isRecord(item)) continue;
      const keys = new Set(safeOwnKeys(item).map((key) => key.toLocaleLowerCase()));
      const hasStart = ['starttime', 'start_time', 'start', 'from', 'begin', 'time'].some((key) =>
        keys.has(key),
      );
      const hasEnd = ['endtime', 'end_time', 'end', 'to', 'finish'].some((key) => keys.has(key));
      const hasText = ['text', 'content', 'caption', 'subtitle', 'utterance'].some((key) =>
        keys.has(key),
      );
      if (hasStart && hasEnd && hasText) count += 1;
    }
    return count;
  };
  const appendStructureEntries = (
    target: BilibiliStructureEntry[],
    root: unknown,
    scope: BilibiliStructureEntry['scope'],
    rootPath: string,
    maximumEntries: number,
  ): boolean => {
    const queue: Array<{ value: unknown; accessor: boolean; path: string; depth: number }> = [
      { value: root, accessor: false, path: rootPath, depth: 0 },
    ];
    const seen = new WeakSet<object>();
    let limited = false;
    while (queue.length > 0) {
      if (target.length >= maximumEntries) {
        limited = true;
        break;
      }
      const next = queue.shift();
      if (!next) break;
      const valueType = structureValueType(next.value, next.accessor);
      const objectValue =
        !next.accessor && typeof next.value === 'object' && next.value !== null ? next.value : null;
      if (objectValue !== null) {
        if (seen.has(objectValue)) continue;
        seen.add(objectValue);
      }
      const directKeys = objectValue === null ? [] : safeOwnKeys(objectValue);
      const nestedArrayKeys = Array.isArray(next.value)
        ? next.value
            .slice(0, 3)
            .filter((item): item is object => typeof item === 'object' && item !== null)
            .flatMap(safeOwnKeys)
        : [];
      const keys = [
        ...new Set([...directKeys.filter((key) => !/^\d+$/u.test(key)), ...nestedArrayKeys]),
      ].slice(0, MAX_BILIBILI_STRUCTURE_KEYS);
      const httpsValuePresent =
        typeof next.value === 'string' &&
        (/^https:\/\//iu.test(next.value) || /^\/\//u.test(next.value));
      const safeUrl = typeof next.value === 'string' ? safeDiagnosticUrl(next.value) : null;
      target.push({
        scope,
        path: next.path,
        valueType,
        keys,
        arrayLength: Array.isArray(next.value) ? next.value.length : null,
        httpsValuePresent,
        safeHttpsUrls: safeUrl === null ? [] : [safeUrl].slice(0, MAX_BILIBILI_SAFE_URLS),
        cueLikeItemCount: cueLikeItemCount(next.value),
      });
      if (next.depth >= 3 || objectValue === null || next.accessor) continue;
      if (Array.isArray(next.value)) {
        for (const child of next.value.slice(0, 3)) {
          if (typeof child === 'object' && child !== null) {
            queue.push({
              value: child,
              accessor: false,
              path: `${next.path}[]`,
              depth: next.depth + 1,
            });
          }
        }
        continue;
      }
      for (const key of directKeys) {
        const child = safeOwnValue(objectValue, key);
        queue.push({
          value: child.value,
          accessor: child.accessor,
          path: `${next.path}.${key}`,
          depth: next.depth + 1,
        });
      }
    }
    return limited || queue.length > 0;
  };
  const safeString = (record: Record<string, unknown>, keys: readonly string[]): string | null => {
    const value = safeRecordValue(record, keys);
    return typeof value === 'string' && value.length <= 200 ? value : null;
  };
  const safeIdentifier = (
    record: Record<string, unknown>,
    keys: readonly string[],
    maximum = 200,
  ): string | null => {
    const value = safeRecordValue(record, keys);
    const identifier =
      typeof value === 'string'
        ? value.trim()
        : finite(value) && Number.isInteger(value)
          ? String(value)
          : '';
    return identifier.length > 0 && identifier.length <= maximum ? identifier : null;
  };
  const safeOwnIdentifier = (
    record: Record<string, unknown>,
    keys: readonly string[],
    maximum = 200,
  ): string | null => {
    for (const key of keys) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) continue;
        const value = descriptor.value;
        const identifier =
          typeof value === 'string'
            ? value.trim()
            : finite(value) && Number.isInteger(value)
              ? String(value)
              : '';
        if (identifier.length > 0 && identifier.length <= maximum) return identifier;
      } catch {
        return null;
      }
    }
    return null;
  };
  const safeLongString = (
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string | null => {
    const value = safeRecordValue(record, keys);
    return typeof value === 'string' && value.length > 0 && value.length <= 2_048 ? value : null;
  };
  type BilibiliSubtitleUrlResolution = {
    value: string | null;
    accessorFound: boolean;
    descriptorLocation: 'own' | 'prototype' | 'none';
    propertyReadSucceeded: boolean;
    resultType:
      'absent' | 'string' | 'protocol-relative-url' | 'absolute-https-url' | 'invalid-type';
    protocolRelative: boolean;
    validatedHost: string | null;
    validatedPath: string | null;
  };
  const absentBilibiliSubtitleUrl = (): BilibiliSubtitleUrlResolution => ({
    value: null,
    accessorFound: false,
    descriptorLocation: 'none',
    propertyReadSucceeded: false,
    resultType: 'absent',
    protocolRelative: false,
    validatedHost: null,
    validatedPath: null,
  });
  const boundedStringFromKnownUrlValue = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const bounded = value.trim();
      return bounded.length > 0 && bounded.length <= 2_048 ? bounded : null;
    }
    if (!isRecord(value)) return null;
    for (const key of ['url', 'href', 'value', 'subtitle_url'] as const) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
          continue;
        }
        const bounded = descriptor.value.trim();
        if (bounded.length > 0 && bounded.length <= 2_048) return bounded;
      } catch {
        return null;
      }
    }
    return null;
  };
  const readSelectedBilibiliSubtitleUrl = (value: unknown): BilibiliSubtitleUrlResolution => {
    if (!isRecord(value)) return absentBilibiliSubtitleUrl();
    let descriptor: PropertyDescriptor | undefined;
    let descriptorLocation: BilibiliSubtitleUrlResolution['descriptorLocation'] = 'none';
    let current: object | null = value;
    for (let depth = 0; current !== null && depth <= 3; depth += 1) {
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, 'subtitle_url');
      } catch {
        descriptor = undefined;
      }
      if (descriptor) {
        descriptorLocation = depth === 0 ? 'own' : 'prototype';
        break;
      }
      try {
        current = Object.getPrototypeOf(current);
      } catch {
        current = null;
      }
    }
    const accessorFound = descriptor !== undefined && !('value' in descriptor);
    let rawValue: unknown;
    try {
      rawValue =
        descriptor !== undefined && 'value' in descriptor
          ? descriptor.value
          : Reflect.get(value, 'subtitle_url', value);
    } catch {
      return {
        ...absentBilibiliSubtitleUrl(),
        accessorFound,
        descriptorLocation,
        resultType: 'invalid-type',
      };
    }
    const propertyReadSucceeded = true;
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return {
        ...absentBilibiliSubtitleUrl(),
        accessorFound,
        descriptorLocation,
        propertyReadSucceeded,
      };
    }
    const urlValue = boundedStringFromKnownUrlValue(rawValue);
    if (urlValue === null) {
      return {
        ...absentBilibiliSubtitleUrl(),
        accessorFound,
        descriptorLocation,
        propertyReadSucceeded,
        resultType: 'invalid-type',
      };
    }
    const protocolRelative = urlValue.startsWith('//');
    const absoluteHttps = /^https:\/\//iu.test(urlValue);
    return {
      value: urlValue,
      accessorFound,
      descriptorLocation,
      propertyReadSucceeded,
      resultType: protocolRelative
        ? 'protocol-relative-url'
        : absoluteHttps
          ? 'absolute-https-url'
          : 'string',
      protocolRelative,
      validatedHost: null,
      validatedPath: null,
    };
  };
  const safeBoolean = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
    const value = safeRecordValue(record, keys);
    return value === true || value === 1 || value === '1';
  };
  const toSeconds = (value: unknown): number | null => {
    const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (!finite(numeric) || numeric < 0) return null;
    return numeric > 100_000 ? numeric / 1_000 : numeric;
  };
  const readCue = (value: unknown): { startTime: number; endTime: number; text: string } | null => {
    if (!isRecord(value)) return null;
    const startTime = toSeconds(
      safeRecordValue(value, ['startTime', 'start_time', 'start', 'from', 'begin', 'time']),
    );
    const endTime = toSeconds(
      safeRecordValue(value, ['endTime', 'end_time', 'end', 'to', 'finish']),
    );
    const rawText = safeString(value, ['text', 'content', 'caption', 'subtitle', 'utterance']);
    const cueText = rawText === null ? '' : normalise(rawText);
    if (
      startTime === null ||
      endTime === null ||
      endTime < startTime ||
      cueText.length === 0 ||
      cueText.length > MAX_TEXT_LENGTH
    ) {
      return null;
    }
    return { startTime, endTime, text: cueText };
  };
  const boundCues = (
    cues: readonly { startTime: number; endTime: number; text: string }[],
    timestamp: number,
  ): { startTime: number; endTime: number; text: string }[] => {
    const nearby = cues
      .filter(
        (cue) =>
          cue.endTime >= timestamp - CONTEXT_WINDOW_SECONDS &&
          cue.startTime <= timestamp + CONTEXT_WINDOW_SECONDS,
      )
      .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
    const current = nearby.filter((cue) => cue.startTime <= timestamp && cue.endTime > timestamp);
    const before = nearby.filter((cue) => cue.endTime <= timestamp).slice(-2);
    const after = nearby.filter((cue) => cue.startTime > timestamp).slice(0, 2);
    const seen = new Set<string>();
    return [...before, ...current, ...after]
      .filter((cue) => {
        const key = `${cue.startTime}:${cue.endTime}:${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_CUES);
  };
  const readKnownCueArray = (
    record: Record<string, unknown>,
    timestamp: number,
  ): { startTime: number; endTime: number; text: string }[] => {
    for (const key of ['cues', 'events', 'body', 'segments', 'items'] as const) {
      const value = safeRecordValue(record, [key]);
      if (!Array.isArray(value)) continue;
      return boundCues(
        value
          .slice(0, 4_000)
          .map(readCue)
          .filter((cue) => cue !== null),
        timestamp,
      );
    }
    return [];
  };
  const readCueList = (
    list: TextTrackCueList | null,
    timestamp: number,
  ): { startTime: number; endTime: number; text: string }[] => {
    try {
      if (list === null) return [];
      const cues: { startTime: number; endTime: number; text: string }[] = [];
      for (let index = 0; index < Math.min(list.length, 4_000); index += 1) {
        const cue = list[index] as (TextTrackCue & { text?: unknown }) | undefined;
        const parsed = readCue(cue);
        if (parsed !== null) cues.push(parsed);
      }
      return boundCues(cues, timestamp);
    } catch {
      return [];
    }
  };
  const cueCount = (list: TextTrackCueList | null): number => {
    try {
      return list?.length ?? 0;
    } catch {
      return 0;
    }
  };
  const normaliseBilibiliSubtitleUrl = (value: string | null): URL | null => {
    if (value === null) return null;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value, location.href);
      if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.port.length > 0 ||
        !BILIBILI_SUBTITLE_HOSTS.has(url.hostname) ||
        !/^\/bfs\/(?:ai_subtitle|subtitle)\//u.test(url.pathname)
      ) {
        return null;
      }
      url.hash = '';
      return url;
    } catch {
      return null;
    }
  };
  const readLimitedResponseText = async (
    response: Response,
  ): Promise<{ status: 'ok'; text: string } | { status: 'oversized' }> => {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESOURCE_BYTES) {
      return { status: 'oversized' };
    }
    if (!response.body) {
      const responseText = await response.text();
      return new TextEncoder().encode(responseText).byteLength <= MAX_RESOURCE_BYTES
        ? { status: 'ok', text: responseText }
        : { status: 'oversized' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESOURCE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 'oversized' };
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: 'ok', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  };
  const loadBilibiliSubtitleResource = async (
    resourceUrlValue: string | null,
    timestampSeconds: number,
  ): Promise<{
    cues: { startTime: number; endTime: number; text: string }[];
    resource: {
      available: boolean;
      status: 'none' | 'loaded' | 'rejected' | 'request-failed' | 'malformed' | 'oversized';
      host: string | null;
      parsedCueCount: number;
    };
  }> => {
    if (resourceUrlValue === null) {
      return {
        cues: [],
        resource: { available: false, status: 'none', host: null, parsedCueCount: 0 },
      };
    }
    const resourceUrl = normaliseBilibiliSubtitleUrl(resourceUrlValue);
    if (resourceUrl === null) {
      return {
        cues: [],
        resource: { available: true, status: 'rejected', host: null, parsedCueCount: 0 },
      };
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(resourceUrl.href, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      const responseUrl = normaliseBilibiliSubtitleUrl(response.url);
      const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
      if (
        !response.ok ||
        response.redirected ||
        responseUrl === null ||
        responseUrl.href !== resourceUrl.href ||
        (!contentType.includes('application/json') && !contentType.includes('text/plain'))
      ) {
        return {
          cues: [],
          resource: {
            available: true,
            status: 'request-failed',
            host: resourceUrl.hostname,
            parsedCueCount: 0,
          },
        };
      }
      const body = await readLimitedResponseText(response);
      if (body.status === 'oversized') {
        return {
          cues: [],
          resource: {
            available: true,
            status: 'oversized',
            host: resourceUrl.hostname,
            parsedCueCount: 0,
          },
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return {
          cues: [],
          resource: {
            available: true,
            status: 'malformed',
            host: resourceUrl.hostname,
            parsedCueCount: 0,
          },
        };
      }
      if (
        !isRecord(parsed) ||
        !Array.isArray(parsed.body) ||
        parsed.body.length > MAX_RESOURCE_CUES
      ) {
        return {
          cues: [],
          resource: {
            available: true,
            status: 'malformed',
            host: resourceUrl.hostname,
            parsedCueCount: 0,
          },
        };
      }
      const parsedCues = parsed.body.map(readCue).filter((cue) => cue !== null);
      if (parsedCues.length !== parsed.body.length) {
        return {
          cues: [],
          resource: {
            available: true,
            status: 'malformed',
            host: resourceUrl.hostname,
            parsedCueCount: parsedCues.length,
          },
        };
      }
      return {
        cues: boundCues(parsedCues, timestampSeconds),
        resource: {
          available: true,
          status: 'loaded',
          host: resourceUrl.hostname,
          parsedCueCount: parsedCues.length,
        },
      };
    } catch {
      return {
        cues: [],
        resource: {
          available: true,
          status: 'request-failed',
          host: resourceUrl.hostname,
          parsedCueCount: 0,
        },
      };
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };

  if (!isRecord(requestValue)) return null;
  const requestId = text(requestValue.requestId, 200);
  const expectedHref = text(requestValue.expectedHref, 2_048);
  const platform = requestValue.platform;
  if (requestId === null || expectedHref === null || !isPlatform(platform)) return null;
  const hrefAtStart = location.href;

  const visibleArea = (video: HTMLVideoElement): number => {
    try {
      const style = getComputedStyle(video);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0)
        return 0;
      const rect = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      return width * height;
    } catch {
      return 0;
    }
  };
  const videos = Array.from(document.querySelectorAll('video'));
  const selectedVideo = videos
    .map((video) => ({
      video,
      score:
        visibleArea(video) +
        (!video.paused && !video.ended ? 1_000_000_000 : 0) +
        (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? 100_000_000 : 0),
    }))
    .sort((left, right) => right.score - left.score)[0]?.video;
  if (!selectedVideo) return null;

  const collectBilibiliPlayerDomStructure = (): {
    elements: BilibiliDomElement[];
    limitReached: boolean;
  } => {
    const safeBounds = (element: Element): DOMRect | null => {
      try {
        const bounds = element.getBoundingClientRect();
        return finite(bounds.x) && finite(bounds.y) && finite(bounds.width) && finite(bounds.height)
          ? bounds
          : null;
      } catch {
        return null;
      }
    };
    const videoBounds = safeBounds(selectedVideo);
    if (videoBounds === null || videoBounds.width <= 0 || videoBounds.height <= 0) {
      return { elements: [], limitReached: false };
    }
    let fallbackRoot: Element = selectedVideo.parentElement ?? selectedVideo;
    let matchedPlayerRoot: Element | null = null;
    let ancestor: Element | null = selectedVideo.parentElement;
    for (let level = 0; ancestor && level < 7; level += 1, ancestor = ancestor.parentElement) {
      const tokens = Array.from(ancestor.classList);
      if (
        tokens.some((token) => /(?:^|[-_])(?:bpx|bilibili|video)?player(?:[-_]|$)/iu.test(token))
      ) {
        matchedPlayerRoot = ancestor;
      }
      if (level < 3) fallbackRoot = ancestor;
    }
    const playerRoot = matchedPlayerRoot ?? fallbackRoot;
    const lowerTop = videoBounds.top + videoBounds.height * 0.5;
    const lowerBottom = videoBounds.bottom;
    const lowerLeft = videoBounds.left;
    const lowerRight = videoBounds.right;
    const queue: Element[] = [playerRoot];
    const candidates: Array<{ score: number; element: BilibiliDomElement }> = [];
    let inspected = 0;
    let traversalLimited = false;
    while (queue.length > 0 && inspected < MAX_BILIBILI_DOM_NODES_INSPECTED) {
      const element = queue.shift();
      if (!element) break;
      inspected += 1;
      const children = Array.from(element.children);
      if (children.length > 80) traversalLimited = true;
      queue.push(...children.slice(0, 80));

      const bounds = safeBounds(element);
      if (bounds === null || bounds.width <= 0 || bounds.height <= 0) continue;
      const overlapsVideo =
        bounds.right > lowerLeft &&
        bounds.left < lowerRight &&
        bounds.bottom > videoBounds.top &&
        bounds.top < lowerBottom;
      if (!overlapsVideo) continue;
      const overlapsLowerRegion = bounds.bottom > lowerTop && bounds.top < lowerBottom;
      try {
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) <= 0
        ) {
          continue;
        }
      } catch {
        continue;
      }
      const classTokens = Array.from(element.classList)
        .map((token) => structuralName(token, 80))
        .filter((token): token is string => token !== null)
        .slice(0, 12);
      const dataAttributeNames = Array.from(element.attributes)
        .map((attribute) => attribute.name)
        .filter((name) => name.startsWith('data-'))
        .map((name) => structuralName(name, 80))
        .filter((name): name is string => name !== null)
        .slice(0, 12);
      let textLength = 0;
      let directTextLength = 0;
      try {
        textLength = Math.min(element.textContent?.length ?? 0, 20_000);
        directTextLength = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .reduce((total, node) => total + (node.textContent?.length ?? 0), 0);
      } catch {
        // Structural metadata remains useful when text access is blocked.
      }
      const structuralTokens = [...classTokens, ...dataAttributeNames].join(' ');
      const subtitleRelated = /subtitle|caption|texttrack|cue|danmu|player/iu.test(
        structuralTokens,
      );
      if (!subtitleRelated && directTextLength === 0 && textLength === 0) continue;
      const area = Math.max(1, bounds.width * bounds.height);
      const score =
        (overlapsLowerRegion ? 2_000_000 : 0) +
        (subtitleRelated ? 1_000_000 : 0) +
        (directTextLength > 0 ? 100_000 : 0) +
        Math.min(textLength, 20_000) -
        Math.min(area / Math.max(1, videoBounds.width * videoBounds.height), 1) * 100;
      candidates.push({
        score,
        element: {
          tag: element.tagName.toLocaleLowerCase().slice(0, 40),
          classTokens,
          dataAttributeNames,
          bounds: {
            x: Math.round(bounds.x * 10) / 10,
            y: Math.round(bounds.y * 10) / 10,
            width: Math.round(bounds.width * 10) / 10,
            height: Math.round(bounds.height * 10) / 10,
          },
          textLength,
        },
      });
    }
    if (queue.length > 0) traversalLimited = true;
    candidates.sort((left, right) => right.score - left.score);
    return {
      elements: candidates.slice(0, MAX_BILIBILI_DOM_ELEMENTS).map(({ element }) => element),
      limitReached: traversalLimited || candidates.length > MAX_BILIBILI_DOM_ELEMENTS,
    };
  };

  const timestamp =
    finite(selectedVideo.currentTime) && selectedVideo.currentTime >= 0
      ? selectedVideo.currentTime
      : 0;
  const videoSourceAtStart = selectedVideo.currentSrc || selectedVideo.src || null;
  const defaultTracks = new Set<TextTrack>();
  for (const element of selectedVideo.querySelectorAll('track[default]')) {
    if (element instanceof HTMLTrackElement) defaultTracks.add(element.track);
  }
  const tracks: Array<{
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
    cues: { startTime: number; endTime: number; text: string }[];
    resourceUrl: string | null;
    rawStructureSource: { path: string; value: unknown } | null;
    resource: {
      available: boolean;
      status:
        | 'none'
        | 'embedded-cues'
        | 'not-selected'
        | 'loaded'
        | 'rejected'
        | 'request-failed'
        | 'malformed'
        | 'oversized';
      host: string | null;
      parsedCueCount: number;
      urlResolution?: Omit<BilibiliSubtitleUrlResolution, 'value'>;
    };
  }> = [];
  const addTrack = (track: (typeof tracks)[number]) => {
    const key = `${track.id}|${track.language ?? ''}|${track.label ?? ''}`;
    const existing = tracks.find(
      (candidate) => `${candidate.id}|${candidate.language ?? ''}|${candidate.label ?? ''}` === key,
    );
    if (existing) {
      if (existing.cues.length === 0 && track.cues.length > 0) existing.cues = track.cues;
      existing.active ||= track.active;
      existing.selected ||= track.selected;
      existing.default ||= track.default;
      existing.original ||= track.original;
      existing.automatic ||= track.automatic;
      existing.translated ||= track.translated;
      existing.resourceUrl ??= track.resourceUrl;
      existing.rawStructureSource ??= track.rawStructureSource;
      if (!existing.resource.available && track.resource.available) {
        existing.resource = track.resource;
      }
      if (existing.mode === 'disabled' && track.mode !== 'disabled') existing.mode = track.mode;
      return;
    }
    if (tracks.length < MAX_TRACKS) tracks.push(track);
  };

  try {
    for (let index = 0; index < Math.min(selectedVideo.textTracks.length, MAX_TRACKS); index += 1) {
      const track = selectedVideo.textTracks[index];
      if (!track || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
      const activeCues = readCueList(track.activeCues, timestamp);
      const cues = readCueList(track.cues, timestamp);
      const label = track.label || null;
      addTrack({
        id: track.id || `dom-${index}`,
        kind: track.kind,
        language: track.language || null,
        label,
        mode: track.mode,
        active: track.mode === 'showing' || cueCount(track.activeCues) > 0,
        selected: track.mode === 'showing',
        default: defaultTracks.has(track),
        original: /\boriginal\b|\u539f\u58f0|\u539f\u6587/u.test(label ?? ''),
        automatic:
          /\b(?:asr|auto(?:matic)?(?:ally)? generated)\b|\u81ea\u52a8|AI\u751f\u6210/iu.test(
            label ?? '',
          ),
        translated: /\btranslat(?:e|ed|ion)\b|\u7ffb\u8bd1/u.test(label ?? ''),
        cues: cues.length > 0 ? cues : activeCues,
        resourceUrl: null,
        rawStructureSource: null,
        resource: {
          available: false,
          status: cues.length > 0 || activeCues.length > 0 ? 'embedded-cues' : 'none',
          host: null,
          parsedCueCount: cues.length > 0 ? cues.length : activeCues.length,
        },
      });
    }
  } catch {
    // The validated empty/metadata snapshot lets the coordinator report unreadable state.
  }

  let selectedLanguage = tracks.find((track) => track.selected)?.language ?? null;
  const page = globalThis as unknown as Record<string, unknown>;
  const addMetadataTrack = (
    value: unknown,
    prefix: string,
    selectedId: string | null = null,
    rawStructurePath: string | null = null,
  ) => {
    if (!isRecord(value)) return;
    const language = safeString(value, ['languageCode', 'language_code', 'lang', 'lan', 'locale']);
    const label = safeString(value, ['name', 'label', 'displayName', 'lan_doc', 'title']);
    const id =
      safeIdentifier(value, [
        'id',
        'trackId',
        'track_id',
        'vss_id',
        'sid',
        'lan',
        'languageCode',
      ]) ?? `${prefix}-${language ?? label ?? tracks.length}`;
    const kindValue = safeString(value, ['kind', 'type', 'trackKind']);
    const automatic =
      kindValue === 'asr' ||
      safeBoolean(value, ['isAutoGenerated', 'is_auto_generated', 'automatic']) ||
      safeRecordValue(value, ['ai_status', 'aiStatus']) === 1 ||
      /\bauto(?:matic)?(?:ally)? generated\b|\u81ea\u52a8|AI\u751f\u6210/iu.test(label ?? '');
    const translated =
      safeBoolean(value, ['isTranslated', 'is_translated', 'translated']) ||
      /\btranslat(?:e|ed|ion)\b|\u7ffb\u8bd1/iu.test(label ?? '');
    const selected =
      (selectedId !== null && id === selectedId) ||
      safeBoolean(value, ['selected', 'isSelected', 'is_selected']);
    const active =
      selected || safeBoolean(value, ['active', 'isActive', 'is_active', 'showing', 'isShowing']);
    const cues = readKnownCueArray(value, timestamp);
    const resourceUrl =
      rawStructurePath === null
        ? safeLongString(value, ['subtitle_url', 'subtitleUrl', 'url', 'src'])
        : null;
    addTrack({
      id,
      kind: kindValue === 'captions' ? 'captions' : 'subtitles',
      language,
      label,
      mode: active ? 'showing' : 'disabled',
      active,
      selected,
      default: safeBoolean(value, ['isDefault', 'is_default', 'default']),
      original:
        safeBoolean(value, ['isOriginal', 'is_original', 'original']) ||
        /\boriginal\b|\u539f\u58f0|\u539f\u6587/iu.test(label ?? ''),
      automatic,
      translated,
      cues,
      resourceUrl,
      rawStructureSource: rawStructurePath === null ? null : { path: rawStructurePath, value },
      resource: {
        available: resourceUrl !== null,
        status: cues.length > 0 ? 'embedded-cues' : resourceUrl === null ? 'none' : 'not-selected',
        host: normaliseBilibiliSubtitleUrl(resourceUrl)?.hostname ?? null,
        parsedCueCount: cues.length,
      },
    });
  };

  if (platform === 'youtube') {
    const player = document.getElementById('movie_player') as
      (HTMLElement & { getOption?: (namespace: string, option: string) => unknown }) | null;
    try {
      const selected = player?.getOption?.('captions', 'track');
      const selectedRecord = isRecord(selected) ? selected : null;
      const selectedId = selectedRecord
        ? safeString(selectedRecord, ['id', 'trackId', 'vss_id', 'languageCode'])
        : null;
      if (selectedRecord) {
        selectedLanguage =
          safeString(selectedRecord, ['languageCode', 'language_code']) ?? selectedLanguage;
        addMetadataTrack(selectedRecord, 'youtube-selected', selectedId);
      }
      const trackList = player?.getOption?.('captions', 'tracklist');
      if (Array.isArray(trackList)) {
        for (const value of trackList.slice(0, MAX_TRACKS)) {
          addMetadataTrack(value, 'youtube-player', selectedId);
        }
      }
    } catch {
      // Page APIs are optional; exposed text tracks and fallbacks remain available.
    }
  }

  let bilibiliIdentity:
    | {
        bvid: string | null;
        aid: string | null;
        cid: string | null;
        part: number;
        matched: boolean;
      }
    | undefined;
  let bilibiliDiagnostics:
    | {
        stateEntries: BilibiliStructureEntry[];
        stateEntryLimitReached: boolean;
        domElements: BilibiliDomElement[];
        domElementLimitReached: boolean;
      }
    | undefined;
  let bilibiliSelection:
    | {
        tracks: Array<{
          id: string;
          language: string | null;
          selected: boolean;
          active: boolean;
          default: boolean;
          original: boolean;
        }>;
        activeTrackId: string | null;
        activeLanguage: string | null;
        source: 'dom-text-track' | 'player-subtitle-state' | 'active-subtitle-menu' | 'none';
        finalReason:
          | 'explicit-track-id'
          | 'explicit-active-track'
          | 'explicit-language'
          | 'default-original'
          | 'sole-validated-track'
          | 'ambiguous'
          | 'none';
      }
    | undefined;
  if (platform === 'bilibili') {
    const initialState = isRecord(page.__INITIAL_STATE__) ? page.__INITIAL_STATE__ : null;
    const initialVideo =
      initialState && isRecord(initialState.videoData) ? initialState.videoData : null;
    const initialSubtitle =
      initialVideo && isRecord(initialVideo.subtitle) ? initialVideo.subtitle : null;
    const playInfo = isRecord(page.__playinfo__) ? page.__playinfo__ : null;
    const playData = playInfo && isRecord(playInfo.data) ? playInfo.data : null;
    const playSubtitle = playData && isRecord(playData.subtitle) ? playData.subtitle : null;
    for (const candidate of [
      {
        list: initialSubtitle?.list,
        path: '__INITIAL_STATE__.videoData.subtitle.list[]',
      },
      { list: playSubtitle?.subtitles, path: '__playinfo__.data.subtitle.subtitles[]' },
    ]) {
      if (!Array.isArray(candidate.list)) continue;
      for (const value of candidate.list.slice(0, MAX_TRACKS)) {
        addMetadataTrack(value, 'bilibili-player', null, candidate.path);
      }
    }

    const parseUrlIdentity = (
      href: string,
    ): { bvid: string | null; aid: string | null; part: number } | null => {
      try {
        const url = new URL(href);
        if (url.hostname !== 'www.bilibili.com' && url.hostname !== 'bilibili.com') return null;
        const pathMatch = url.pathname.match(/^\/video\/(BV[A-Za-z0-9]+|av\d+)(?:\/|$)/iu);
        const bvidFromQuery = url.searchParams.get('bvid');
        const aidFromQueryValue = url.searchParams.get('aid');
        const aidFromQuery = aidFromQueryValue
          ? /^av\d+$/iu.test(aidFromQueryValue)
            ? aidFromQueryValue
            : /^\d+$/u.test(aidFromQueryValue)
              ? `av${aidFromQueryValue}`
              : null
          : null;
        const identity = pathMatch?.[1] ?? bvidFromQuery ?? aidFromQuery;
        if (!identity) return null;
        const partValue = Number(url.searchParams.get('p') ?? '1');
        if (!Number.isInteger(partValue) || partValue < 1) return null;
        return {
          bvid: /^BV[A-Za-z0-9]+$/iu.test(identity) ? identity : null,
          aid: /^av\d+$/iu.test(identity) ? identity.toLocaleLowerCase() : null,
          part: partValue,
        };
      } catch {
        return null;
      }
    };
    const decimalString = (value: unknown): string | null => {
      const numeric = typeof value === 'string' ? value : finite(value) ? String(value) : '';
      return /^\d+$/u.test(numeric) ? numeric : null;
    };
    const bvidString = (value: unknown): string | null =>
      typeof value === 'string' && /^BV[A-Za-z0-9]+$/iu.test(value) ? value : null;
    const aidString = (value: unknown): string | null => {
      const numeric = decimalString(value);
      return numeric === null ? null : `av${numeric}`;
    };
    const expectedIdentity = parseUrlIdentity(expectedHref);
    const actualIdentity = parseUrlIdentity(hrefAtStart);
    const pages = initialVideo && Array.isArray(initialVideo.pages) ? initialVideo.pages : [];
    const activePage = pages.find(
      (value) =>
        isRecord(value) &&
        Number(safeRecordValue(value, ['page', 'p'])) === (actualIdentity?.part ?? 1),
    );
    const playerBvids = [
      initialState ? bvidString(safeRecordValue(initialState, ['bvid'])) : null,
      initialVideo ? bvidString(safeRecordValue(initialVideo, ['bvid'])) : null,
      playData ? bvidString(safeRecordValue(playData, ['bvid'])) : null,
    ].filter((value): value is string => value !== null);
    const playerAids = [
      initialState ? aidString(safeRecordValue(initialState, ['aid'])) : null,
      initialVideo ? aidString(safeRecordValue(initialVideo, ['aid'])) : null,
      playData ? aidString(safeRecordValue(playData, ['aid'])) : null,
    ].filter((value): value is string => value !== null);
    const playerCids = [
      decimalString(page.cid),
      initialState ? decimalString(safeRecordValue(initialState, ['cid'])) : null,
      initialVideo ? decimalString(safeRecordValue(initialVideo, ['cid'])) : null,
      playData ? decimalString(safeRecordValue(playData, ['cid'])) : null,
      isRecord(activePage) ? decimalString(safeRecordValue(activePage, ['cid'])) : null,
    ].filter((value): value is string => value !== null);
    const bvid = actualIdentity?.bvid ?? playerBvids[0] ?? null;
    const aid = actualIdentity?.aid ?? playerAids[0] ?? null;
    const identityMatches =
      expectedIdentity !== null &&
      actualIdentity !== null &&
      expectedIdentity.bvid?.toLocaleLowerCase() === actualIdentity.bvid?.toLocaleLowerCase() &&
      expectedIdentity.aid === actualIdentity.aid &&
      expectedIdentity.part === actualIdentity.part &&
      playerBvids.every(
        (value) => bvid === null || value.toLocaleLowerCase() === bvid.toLocaleLowerCase(),
      ) &&
      playerAids.every((value) => aid === null || value === aid) &&
      new Set(playerCids).size <= 1;
    bilibiliIdentity = {
      bvid,
      aid,
      cid: playerCids[0] ?? null,
      part: actualIdentity?.part ?? 1,
      matched: identityMatches,
    };

    type ActiveBilibiliSubtitleEvidence = {
      trackId: string | null;
      language: string | null;
      label: string | null;
      source: 'player-subtitle-state' | 'active-subtitle-menu';
    };
    const evidenceKey = (evidence: ActiveBilibiliSubtitleEvidence): string =>
      `${evidence.trackId ?? ''}|${evidence.language ?? ''}|${evidence.label ?? ''}`.toLocaleLowerCase();
    const activeEvidence = new Map<string, ActiveBilibiliSubtitleEvidence>();
    const currentPlayerSubtitleStates: Record<string, unknown>[] = [];
    for (const globalKey of ['player', 'bilibiliPlayer'] as const) {
      const globalPlayer = safeOwnValue(page, globalKey);
      if (!isRecord(globalPlayer.value) || globalPlayer.accessor) continue;
      for (const controllerKey of [
        'subtitle',
        'subtitleController',
        'subtitleManager',
        'caption',
        'captionController',
      ] as const) {
        const controller = safeOwnValue(globalPlayer.value, controllerKey);
        if (isRecord(controller.value) && !controller.accessor) {
          currentPlayerSubtitleStates.push(controller.value);
          for (const stateKey of ['state', 'current', 'config'] as const) {
            const state = safeOwnValue(controller.value, stateKey);
            if (isRecord(state.value) && !state.accessor) {
              currentPlayerSubtitleStates.push(state.value);
            }
          }
        }
      }
    }
    for (const state of [initialSubtitle, playSubtitle, ...currentPlayerSubtitleStates].slice(
      0,
      12,
    )) {
      if (!state) continue;
      const trackId = safeOwnIdentifier(state, [
        'selected_track_id',
        'selectedTrackId',
        'active_track_id',
        'activeTrackId',
        'current_track_id',
        'currentTrackId',
        'selected_sid',
        'selectedSid',
      ]);
      const language = safeOwnIdentifier(
        state,
        [
          'selected_language',
          'selectedLanguage',
          'active_language',
          'activeLanguage',
          'current_language',
          'currentLanguage',
          'selected_lan',
          'selectedLan',
        ],
        80,
      );
      if (trackId !== null || language !== null) {
        const evidence: ActiveBilibiliSubtitleEvidence = {
          trackId,
          language,
          label: null,
          source: 'player-subtitle-state',
        };
        activeEvidence.set(evidenceKey(evidence), evidence);
      }
    }

    const selectedPlayerRoot = selectedVideo.closest(
      '.bpx-player-container,.bilibili-player,#bilibili-player,.bilibili-player-video-wrap',
    );
    if (selectedPlayerRoot) {
      const menuRoots = Array.from(
        selectedPlayerRoot.querySelectorAll(
          [
            '.bpx-player-ctrl-subtitle-language',
            '.bili-subtitle-x-subtitle-language',
            '.bili-subtitle-x-subtitle-menu',
          ].join(','),
        ),
      ).slice(0, 6);
      const activeItemSelector = [
        '[aria-selected="true"]',
        '[aria-checked="true"]',
        '[aria-current="true"]',
        '[data-selected="true"]',
        '[data-active="true"]',
        '.bpx-state-active',
        '.bili-state-active',
        '.active',
        '.selected',
        '[class$="-active"]',
        '[class$="-selected"]',
      ].join(',');
      const activeItems = new Set<Element>();
      for (const root of menuRoots) {
        if (root.matches(activeItemSelector)) activeItems.add(root);
        for (const item of Array.from(root.querySelectorAll(activeItemSelector)).slice(0, 20)) {
          activeItems.add(item);
        }
      }
      for (const item of [...activeItems].slice(0, 20)) {
        const attribute = (names: readonly string[], maximum: number): string | null => {
          for (const name of names) {
            try {
              const value = item.getAttribute(name)?.trim() ?? '';
              if (value.length > 0 && value.length <= maximum) return value;
            } catch {
              return null;
            }
          }
          return null;
        };
        const trackId = attribute(
          ['data-track-id', 'data-subtitle-id', 'data-sid', 'data-id', 'data-value'],
          200,
        );
        const language = attribute(
          ['data-language', 'data-language-code', 'data-lang', 'data-lan', 'lang'],
          80,
        );
        let label: string | null = null;
        try {
          const value = normalise(item.textContent ?? '');
          if (
            value.length > 0 &&
            value.length <= 120 &&
            !/^(?:off|none|关闭|无字幕|不显示)$/iu.test(value)
          ) {
            label = value;
          }
        } catch {
          label = null;
        }
        if (trackId !== null || language !== null || label !== null) {
          const evidence: ActiveBilibiliSubtitleEvidence = {
            trackId,
            language,
            label,
            source: 'active-subtitle-menu',
          };
          activeEvidence.set(evidenceKey(evidence), evidence);
        }
      }
    }

    const uniqueEvidence = [...activeEvidence.values()];
    const exactIdentifierMatches = (value: string | null, expected: string | null): boolean =>
      value !== null &&
      expected !== null &&
      value.toLocaleLowerCase() === expected.toLocaleLowerCase();
    const languageMatches = (value: string | null, expected: string | null): boolean => {
      if (value === null || expected === null) return false;
      const trackLanguage = value.toLocaleLowerCase();
      const playerLanguage = expected.toLocaleLowerCase();
      return (
        trackLanguage === playerLanguage ||
        trackLanguage.startsWith(`${playerLanguage}-`) ||
        playerLanguage.startsWith(`${trackLanguage}-`)
      );
    };
    const identifierEvidence = uniqueEvidence.filter((evidence) => evidence.trackId !== null);
    const identifierMatches = tracks.filter((track) =>
      identifierEvidence.some((evidence) => exactIdentifierMatches(track.id, evidence.trackId)),
    );
    const identifierEvidenceAmbiguous = identifierMatches.length > 1;
    if (identifierMatches.length === 1) {
      identifierMatches[0]!.selected = true;
      identifierMatches[0]!.active = true;
      identifierMatches[0]!.mode = 'showing';
    }

    const selectedTracks = tracks.filter((track) => track.selected);
    const activeTracks = tracks.filter((track) => track.active || track.mode === 'showing');
    const languageEvidence = uniqueEvidence.filter(
      (evidence) => evidence.language !== null || evidence.label !== null,
    );
    const languageTracks = tracks.filter((track) =>
      languageEvidence.some(
        (evidence) =>
          languageMatches(track.language, evidence.language) ||
          exactIdentifierMatches(track.label, evidence.label),
      ),
    );
    if (selectedTracks.length === 0 && activeTracks.length === 0 && languageTracks.length === 1) {
      languageTracks[0]!.active = true;
      languageTracks[0]!.mode = 'showing';
    }
    const defaultTracksFromMetadata = tracks.filter(
      (track) => (track.default || track.original) && !track.translated,
    );
    let selectedTrack: (typeof tracks)[number] | undefined;
    let finalSelectionReason:
      | 'explicit-track-id'
      | 'explicit-active-track'
      | 'explicit-language'
      | 'default-original'
      | 'sole-validated-track'
      | 'ambiguous'
      | 'none' = 'none';
    if (selectedTracks.length > 0) {
      selectedTrack = selectedTracks.length === 1 ? selectedTracks[0] : undefined;
      finalSelectionReason = selectedTrack ? 'explicit-track-id' : 'ambiguous';
    } else if (identifierEvidenceAmbiguous) {
      finalSelectionReason = 'ambiguous';
    } else if (activeTracks.length > 0) {
      selectedTrack = activeTracks.length === 1 ? activeTracks[0] : undefined;
      finalSelectionReason = selectedTrack ? 'explicit-active-track' : 'ambiguous';
    } else if (languageTracks.length > 0) {
      selectedTrack = languageTracks.length === 1 ? languageTracks[0] : undefined;
      finalSelectionReason = selectedTrack ? 'explicit-language' : 'ambiguous';
    } else if (defaultTracksFromMetadata.length > 0) {
      selectedTrack =
        defaultTracksFromMetadata.length === 1 ? defaultTracksFromMetadata[0] : undefined;
      finalSelectionReason = selectedTrack ? 'default-original' : 'ambiguous';
    } else if (tracks.length === 1 && !tracks[0]?.translated) {
      selectedTrack = tracks[0];
      finalSelectionReason = 'sole-validated-track';
    }
    if (selectedTrack === undefined && finalSelectionReason === 'none' && tracks.length > 1) {
      finalSelectionReason = 'ambiguous';
    }
    const resolvedEvidence = uniqueEvidence.find(
      (evidence) =>
        selectedTrack !== undefined &&
        (exactIdentifierMatches(selectedTrack.id, evidence.trackId) ||
          languageMatches(selectedTrack.language, evidence.language) ||
          exactIdentifierMatches(selectedTrack.label, evidence.label)),
    );
    const reportedEvidence =
      resolvedEvidence ?? (uniqueEvidence.length === 1 ? uniqueEvidence[0] : undefined);
    if (selectedTrack) {
      selectedLanguage = selectedTrack.language ?? resolvedEvidence?.language ?? selectedLanguage;
    }
    const selectionSource = tracks.some(
      (track) => track.selected && track.rawStructureSource === null,
    )
      ? 'dom-text-track'
      : tracks.some((track) => track.selected || track.active)
        ? (reportedEvidence?.source ?? 'player-subtitle-state')
        : (reportedEvidence?.source ?? 'none');
    bilibiliSelection = {
      tracks: tracks.map(({ id, language, selected, active, default: isDefault, original }) => ({
        id,
        language,
        selected,
        active,
        default: isDefault,
        original,
      })),
      activeTrackId: selectedTrack?.id ?? reportedEvidence?.trackId ?? null,
      activeLanguage: selectedTrack?.language ?? reportedEvidence?.language ?? null,
      source: selectionSource,
      finalReason: finalSelectionReason,
    };
    if (selectedTrack && identityMatches) {
      const selectedRawSubtitleUrl = readSelectedBilibiliSubtitleUrl(
        selectedTrack.rawStructureSource?.value,
      );
      const validatedSubtitleUrl = normaliseBilibiliSubtitleUrl(selectedRawSubtitleUrl.value);
      const urlResolution: Omit<BilibiliSubtitleUrlResolution, 'value'> = {
        accessorFound: selectedRawSubtitleUrl.accessorFound,
        descriptorLocation: selectedRawSubtitleUrl.descriptorLocation,
        propertyReadSucceeded: selectedRawSubtitleUrl.propertyReadSucceeded,
        resultType: selectedRawSubtitleUrl.resultType,
        protocolRelative: selectedRawSubtitleUrl.protocolRelative,
        validatedHost: validatedSubtitleUrl?.hostname ?? null,
        validatedPath: validatedSubtitleUrl?.pathname ?? null,
      };
      selectedTrack.resource = {
        ...selectedTrack.resource,
        urlResolution,
      };
      if (selectedRawSubtitleUrl.value !== null) {
        selectedTrack.resourceUrl = selectedRawSubtitleUrl.value;
        selectedTrack.resource = {
          available: true,
          status: 'not-selected',
          host: validatedSubtitleUrl?.hostname ?? null,
          parsedCueCount: 0,
          urlResolution,
        };
      }
      if (selectedTrack.cues.length > 0) {
        selectedTrack.resource = {
          ...selectedTrack.resource,
          status: 'embedded-cues',
          parsedCueCount: selectedTrack.cues.length,
        };
      } else if (selectedTrack.resourceUrl !== null) {
        const loaded = await loadBilibiliSubtitleResource(selectedTrack.resourceUrl, timestamp);
        selectedTrack.cues = loaded.cues;
        selectedTrack.resource = { ...loaded.resource, urlResolution };
      }
    }

    const stateEntries: BilibiliStructureEntry[] = [];
    let stateEntryLimitReached = false;
    if (selectedTrack?.rawStructureSource) {
      const selectedTrackLimited = appendStructureEntries(
        stateEntries,
        selectedTrack.rawStructureSource.value,
        'selected-track',
        selectedTrack.rawStructureSource.path,
        MAX_BILIBILI_SELECTED_TRACK_ENTRIES,
      );
      stateEntryLimitReached = stateEntryLimitReached || selectedTrackLimited;
    }
    for (const root of [
      { value: initialSubtitle, path: '__INITIAL_STATE__.videoData.subtitle' },
      { value: playSubtitle, path: '__playinfo__.data.subtitle' },
      { value: selectedVideo.textTracks, path: 'selectedVideo.textTracks' },
    ]) {
      if (root.value === null || root.value === undefined) continue;
      const rootLimited = appendStructureEntries(
        stateEntries,
        root.value,
        'current-player-state',
        root.path,
        MAX_BILIBILI_STRUCTURE_ENTRIES,
      );
      stateEntryLimitReached = stateEntryLimitReached || rootLimited;
      if (stateEntries.length >= MAX_BILIBILI_STRUCTURE_ENTRIES) break;
    }
    let playerNode: Element | null = selectedVideo;
    let playerStateRoots = 0;
    for (
      let level = 0;
      playerNode && level < 7 && stateEntries.length < MAX_BILIBILI_STRUCTURE_ENTRIES;
      level += 1, playerNode = playerNode.parentElement
    ) {
      const record = playerNode as unknown as object;
      for (const key of safeOwnKeys(record)) {
        if (!/subtitle|caption|texttrack|player|bpx|vue|react/iu.test(key)) continue;
        const child = safeOwnValue(record, key);
        if (
          child.accessor ||
          (typeof child.value !== 'object' && typeof child.value !== 'string')
        ) {
          continue;
        }
        const safeKey = structuralName(key);
        if (safeKey === null) continue;
        const playerRootLimited = appendStructureEntries(
          stateEntries,
          child.value,
          'current-player-state',
          `selectedPlayer.${safeKey}`,
          MAX_BILIBILI_STRUCTURE_ENTRIES,
        );
        stateEntryLimitReached = stateEntryLimitReached || playerRootLimited;
        playerStateRoots += 1;
        if (playerStateRoots >= 6 || stateEntries.length >= MAX_BILIBILI_STRUCTURE_ENTRIES) {
          break;
        }
      }
      if (playerStateRoots >= 6) break;
    }
    const domStructure = collectBilibiliPlayerDomStructure();
    bilibiliDiagnostics = {
      stateEntries: stateEntries.slice(0, MAX_BILIBILI_STRUCTURE_ENTRIES),
      stateEntryLimitReached,
      domElements: domStructure.elements,
      domElementLimitReached: domStructure.limitReached,
    };
  }

  let structuredStateInspected = false;
  if (platform === 'douyin') {
    structuredStateInspected = true;
    const frameworkRoots: unknown[] = [];
    let node: Element | null = selectedVideo;
    for (let level = 0; node && level < 7; level += 1, node = node.parentElement) {
      const record = node as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (/^__(?:reactProps|reactFiber|vueParentComponent)/u.test(key)) {
          try {
            frameworkRoots.push(record[key]);
          } catch {
            // Ignore inaccessible framework properties.
          }
        }
      }
    }
    const seen = new WeakSet<object>();
    const queue = frameworkRoots.map((value) => ({ value, depth: 0, subtitleScope: false }));
    const structuredCues: { startTime: number; endTime: number; text: string }[] = [];
    let inspected = 0;
    while (queue.length > 0 && inspected < 400 && structuredCues.length < 80) {
      const entry = queue.shift();
      if (!entry || entry.depth > 6 || !isRecord(entry.value)) continue;
      if (seen.has(entry.value)) continue;
      seen.add(entry.value);
      inspected += 1;
      if (entry.subtitleScope) {
        const cue = readCue(entry.value);
        if (cue !== null) structuredCues.push(cue);
      }
      for (const [key, child] of Object.entries(entry.value)) {
        const childSubtitleScope = entry.subtitleScope || /subtitle|caption|texttrack/iu.test(key);
        const associationPath =
          /^(?:props|memoizedProps|pendingProps|currentWork|aweme|awemeDetail|detail|data|video)$/iu.test(
            key,
          );
        if ((!childSubtitleScope && !associationPath) || entry.depth >= 6) continue;
        if (Array.isArray(child)) {
          for (const value of child.slice(0, 80)) {
            queue.push({ value, depth: entry.depth + 1, subtitleScope: childSubtitleScope });
          }
        } else if (isRecord(child)) {
          queue.push({ value: child, depth: entry.depth + 1, subtitleScope: childSubtitleScope });
        }
      }
    }
    const duration = selectedVideo.duration;
    const normalisedStructuredCues = structuredCues.map((cue) => {
      const appearsToUseMilliseconds =
        finite(duration) && duration > 0 && cue.endTime > Math.max(duration * 4, 1_000);
      return appearsToUseMilliseconds
        ? { ...cue, startTime: cue.startTime / 1_000, endTime: cue.endTime / 1_000 }
        : cue;
    });
    const bounded = boundCues(normalisedStructuredCues, timestamp);
    if (bounded.length > 0) {
      addTrack({
        id: 'douyin-current-work-state',
        kind: 'subtitles',
        language: selectedLanguage,
        label: null,
        mode: 'showing',
        active: true,
        selected: true,
        default: false,
        original: true,
        automatic: false,
        translated: false,
        cues: bounded,
        resourceUrl: null,
        rawStructureSource: null,
        resource: {
          available: false,
          status: 'embedded-cues',
          host: null,
          parsedCueCount: bounded.length,
        },
      });
    }
  }

  const videoSourceAtEnd = selectedVideo.currentSrc || selectedVideo.src || null;
  const playerEvidenceStable =
    location.href === hrefAtStart && videoSourceAtEnd === videoSourceAtStart;
  if (bilibiliIdentity && !playerEvidenceStable) {
    bilibiliIdentity = { ...bilibiliIdentity, matched: false };
  }
  const finalTimestamp =
    playerEvidenceStable && finite(selectedVideo.currentTime) && selectedVideo.currentTime >= 0
      ? selectedVideo.currentTime
      : timestamp;

  return {
    version: 1,
    requestId,
    platform,
    href: hrefAtStart,
    collectedAt: Date.now(),
    selectedLanguage,
    structuredStateInspected,
    ...(bilibiliIdentity ? { bilibiliIdentity } : {}),
    ...(bilibiliSelection ? { bilibiliSelection } : {}),
    ...(bilibiliDiagnostics ? { bilibiliDiagnostics } : {}),
    video: {
      currentTime: finalTimestamp,
      duration:
        finite(selectedVideo.duration) && selectedVideo.duration >= 0
          ? selectedVideo.duration
          : null,
      currentSrc: videoSourceAtStart,
    },
    tracks: tracks
      .slice(0, MAX_TRACKS)
      .map(
        ({ resourceUrl: _resourceUrl, rawStructureSource: _rawStructureSource, ...track }) => track,
      ),
  };
}

import { platformLabel } from '../shared/source-labels';
import type { LearningItem, VideoLearningItem } from '../database';
import {
  getSourceGroupingIdentity,
  type SourceGroupingIdentity,
} from '../adapters/source-grouping';

export interface DerivedSourceGroup extends SourceGroupingIdentity {
  title: string;
  titleFallback: boolean;
  uploader: string | null;
  representativeScreenshotId: string | null;
  earliestCaptureAt: Date;
  latestCaptureAt: Date;
  totalCount: number;
  dueCount: number;
  items: VideoLearningItem[];
}

export interface DerivedSourceGroups {
  groups: DerivedSourceGroup[];
  ungrouped: LearningItem[];
}

export function deriveSourceGroups(items: readonly LearningItem[], now: Date): DerivedSourceGroups {
  const groupedItems = new Map<
    string,
    { identity: SourceGroupingIdentity; items: VideoLearningItem[] }
  >();
  const ungrouped: LearningItem[] = [];

  for (const item of items) {
    if (item.sourceType === 'text' || item.sourceType === 'image') {
      ungrouped.push(item);
      continue;
    }
    const identity = getSourceGroupingIdentity(item);
    if (identity === null) {
      ungrouped.push(item);
      continue;
    }
    const current = groupedItems.get(identity.key);
    if (current) {
      current.items.push(item);
    } else {
      groupedItems.set(identity.key, { identity, items: [item] });
    }
  }

  const groups = [...groupedItems.values()]
    .map(({ identity, items: sourceItems }) => buildGroup(identity, sourceItems, now))
    .sort(
      (left, right) =>
        right.latestCaptureAt.getTime() - left.latestCaptureAt.getTime() ||
        left.key.localeCompare(right.key),
    );

  return {
    groups,
    ungrouped: ungrouped.sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
    ),
  };
}

export function isItemDue(item: LearningItem, now: Date): boolean {
  return !item.suspended && item.fsrsCard.due.getTime() <= now.getTime();
}

function buildGroup(
  identity: SourceGroupingIdentity,
  sourceItems: readonly VideoLearningItem[],
  now: Date,
): DerivedSourceGroup {
  let titleSource: VideoLearningItem | null = null;
  let uploaderSource: VideoLearningItem | null = null;
  let screenshotSource: VideoLearningItem | null = null;
  let earliestCapture = Infinity;
  let latestCapture = -Infinity;
  let dueCount = 0;

  for (const item of sourceItems) {
    if (item.videoTitle?.trim()) titleSource = newerCapture(titleSource, item);
    if (item.uploader?.trim()) uploaderSource = newerCapture(uploaderSource, item);
    if (item.screenshotId !== null) screenshotSource = newerCapture(screenshotSource, item);
    const capturedAt = item.createdAt.getTime();
    earliestCapture = Math.min(earliestCapture, capturedAt);
    latestCapture = Math.max(latestCapture, capturedAt);
    if (isItemDue(item, now)) dueCount += 1;
  }

  const extractedTitle = titleSource?.videoTitle?.trim() ?? null;
  const title = extractedTitle ?? `${platformLabel(identity.platform)} ${identity.videoId}`;

  return {
    ...identity,
    title,
    titleFallback: extractedTitle === null,
    uploader: uploaderSource?.uploader?.trim() ?? null,
    representativeScreenshotId: screenshotSource?.screenshotId ?? null,
    earliestCaptureAt: new Date(earliestCapture),
    latestCaptureAt: new Date(latestCapture),
    totalCount: sourceItems.length,
    dueCount,
    items: sortItemsByVideoTimestamp(sourceItems),
  };
}

function sortItemsByVideoTimestamp(items: readonly VideoLearningItem[]): VideoLearningItem[] {
  return [...items].sort(
    (left, right) =>
      (left.timestampSeconds ?? Number.POSITIVE_INFINITY) -
        (right.timestampSeconds ?? Number.POSITIVE_INFINITY) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  );
}

function newerCapture(
  current: VideoLearningItem | null,
  candidate: VideoLearningItem,
): VideoLearningItem {
  if (current === null) return candidate;
  const order =
    current.createdAt.getTime() - candidate.createdAt.getTime() ||
    candidate.id.localeCompare(current.id);
  return order < 0 ? candidate : current;
}

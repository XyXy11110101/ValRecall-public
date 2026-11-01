import {
  getLearningReceipt,
  learningFingerprint,
  type CaptureRewardSummary,
  type LearningCommit,
} from '../database/learning-commits';
import { DraftRepository, type DraftToken } from '../database/drafts';
import {
  DatabaseError,
  ValRecallRepository,
  learningItemTitle,
  type LearningItem,
} from '../database';
import { FsrsService, type ShortTermReviewMode } from '../fsrs';
import { readingTitle } from '../reading/reading-draft';
import { formatTimestamp, parseTimestamp } from '../shared/time';
import { parseManualVideoSource } from '../shared/video-url';
import { manualDraftIssue, type ManualQuestionDraft } from './manual-draft';

export interface ManualQuestionReceipt {
  item: LearningItem;
  allowance: CaptureRewardSummary | null;
  manualReward: number | null;
  warning: string | null;
}
export interface ManualSaveDependencies {
  repository: Pick<
    ValRecallRepository,
    | 'open'
    | 'createTextItem'
    | 'createImageItem'
    | 'createManualVideoItem'
    | 'getItem'
    | 'getImageAsset'
    | 'getCategory'
  >;
  clock?: () => Date;
}
const defaults: ManualSaveDependencies = { repository: new ValRecallRepository() };

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(new Error('图片读取失败。'));
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsArrayBuffer(blob);
  });
}

/** A retry can acknowledge its exact saved draft, but must never overwrite another payload. */
export async function saveManualQuestion(
  draft: ManualQuestionDraft,
  mode: ShortTermReviewMode,
  dependencies = defaults,
  draftToken?: DraftToken,
): Promise<ManualQuestionReceipt> {
  const issue = manualDraftIssue(draft);
  if (issue) throw new Error(issue);
  const reading = draft.source === 'reading';
  const common = {
    id: draft.id,
    itemType: draft.itemType,
    categoryId: draft.categoryId,
    coreLesson: draft.coreLesson.trim(),
    recallPrompt: reading ? draft.recallPrompt.trim() : draft.recallPrompt,
    referenceAnswer: draft.coreLesson.trim(),
    tags: draft.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    fsrsCard: new FsrsService({
      shortTermReviewMode: mode,
      ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    }).createInitialCard(),
  };
  const title = reading ? readingTitle(draft.recallPrompt) : draft.title.trim();
  const readingSource = {
    schemaVersion: 1 as const,
    excerpt: draft.excerpt,
    bookTitle: draft.bookTitle.trim(),
    location: draft.location.trim(),
  };
  const video = draft.source === 'video' ? parseManualVideoSource(draft.videoUrl)! : null;
  const seconds = draft.timestamp.trim() ? parseTimestamp(draft.timestamp) : null;
  const { image, ...textFields } = draft;
  const commit: LearningCommit = {
    id: draft.id,
    kind: reading ? 'capture' : 'manual',
    fingerprint: await learningFingerprint(
      [
        textFields,
        image ? { width: image.width, height: image.height, type: image.blob.type } : null,
        mode,
      ],
      image?.blob,
    ),
    ...(draftToken ? { draft: draftToken } : {}),
  };
  let item: LearningItem;
  try {
    if (draft.source === 'image')
      item = await dependencies.repository.createImageItem(
        { ...common, title },
        draft.image!,
        commit,
      );
    else if (video)
      item = await dependencies.repository.createManualVideoItem(
        {
          ...common,
          ...video,
          videoTitle: title,
          timestampSeconds: seconds,
          timestampDisplay: seconds === null ? null : formatTimestamp(seconds),
        },
        commit,
      );
    else
      item = await dependencies.repository.createTextItem(
        {
          ...common,
          title,
          ...(reading ? { readingSource } : {}),
        },
        commit,
      );
  } catch (caught) {
    if (!(caught instanceof DatabaseError) || caught.code !== 'CONFLICT') throw caught;
    if (await getLearningReceipt(dependencies.repository, commit.id)) throw caught;
    const saved = await dependencies.repository.getItem(draft.id);
    // Creation resolves a concurrently deleted category to uncategorized. Accept
    // that same fallback on retry, but never ignore a still-existing category.
    const categoryMatches =
      saved?.categoryId === common.categoryId ||
      (saved?.categoryId === null &&
        common.categoryId !== null &&
        !(await dependencies.repository.getCategory(common.categoryId)));
    const sourceMatches =
      saved &&
      (draft.source === 'image'
        ? saved.sourceType === 'image' &&
          saved.imageWidth === draft.image!.width &&
          saved.imageHeight === draft.image!.height &&
          saved.imageMimeType === draft.image!.blob.type
        : video
          ? saved.sourceType === 'video' &&
            saved.videoOrigin === 'library' &&
            saved.sourceUrl === video.sourceUrl &&
            saved.timestampSeconds === seconds
          : saved.sourceType === 'text' &&
            (reading
              ? JSON.stringify(saved.readingSource) === JSON.stringify(readingSource)
              : !saved.readingSource && !saved.noteSource));
    let matches = Boolean(
      sourceMatches &&
      saved &&
      learningItemTitle(saved) === title &&
      saved.recallPrompt === common.recallPrompt &&
      saved.coreLesson === common.coreLesson &&
      categoryMatches &&
      saved.itemType === common.itemType &&
      JSON.stringify(saved.tags) === JSON.stringify(common.tags),
    );
    if (matches && saved?.sourceType === 'image') {
      const stored = await dependencies.repository.getImageAsset(saved.imageAssetId);
      if (!stored || stored.size !== draft.image!.blob.size) matches = false;
      else {
        const [left, right] = await Promise.all([blobBytes(stored), blobBytes(draft.image!.blob)]);
        matches =
          left.length === right.length && left.every((byte, index) => byte === right[index]);
      }
    }
    if (!matches || !saved)
      throw new DatabaseError('CONFLICT', '这道题已按旧内容保存过，请先到资料库查看。');
    if (draftToken) await new DraftRepository(dependencies.repository).discard(draftToken);
    return {
      item: saved,
      allowance: null,
      manualReward: null,
      warning: '这道题已保存过。',
    };
  }
  const receipt = await getLearningReceipt(dependencies.repository, commit.id);
  if (!receipt) throw new Error('无法确认是否已保存，请重试。');
  return { item, allowance: receipt.capture, manualReward: receipt.manualReward, warning: null };
}

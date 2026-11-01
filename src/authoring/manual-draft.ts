import type { LearningItemType } from '../models/learning-item';
import type { PreparedLibraryImage } from '../shared/library-image';
import { readingDraftIssue, type ReadingDraft } from '../reading/reading-draft';
import { parseTimestamp } from '../shared/time';
import { parseManualVideoSource } from '../shared/video-url';
import { isDraftValue, type DraftValue } from '../database/drafts';
import { preparedLibraryImageIssue } from '../shared/library-image';

export type ManualQuestionSource = 'direct' | 'reading' | 'image' | 'video';
export interface ManualQuestionDraft extends ReadingDraft {
  source: ManualQuestionSource;
  title: string;
  tags: string;
  image: PreparedLibraryImage | null;
  imageName: string;
  videoUrl: string;
  timestamp: string;
}

export function manualDraftValue(draft: ManualQuestionDraft): DraftValue {
  if (!isDraftValue(draft)) throw new Error('草稿包含无法保留的内容。');
  return draft;
}

export function readManualDraft(value: DraftValue): ManualQuestionDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Blob)
    throw new Error('手动草稿无效。');
  const text = [
    'id',
    'title',
    'tags',
    'imageName',
    'videoUrl',
    'timestamp',
    'recallPrompt',
    'coreLesson',
    'excerpt',
    'bookTitle',
    'location',
  ];
  if (
    !text.every((key) => typeof value[key] === 'string') ||
    !value.id ||
    !['direct', 'reading', 'image', 'video'].includes(String(value.source)) ||
    !['Avoid', 'Do', 'Notice', 'Understand'].includes(String(value.itemType)) ||
    !(value.categoryId === null || typeof value.categoryId === 'string')
  )
    throw new Error('手动草稿字段无效。');
  if (value.image !== null) {
    const image = value.image;
    if (
      !image ||
      typeof image !== 'object' ||
      Array.isArray(image) ||
      image instanceof Blob ||
      !(image.blob instanceof Blob) ||
      typeof image.width !== 'number' ||
      typeof image.height !== 'number' ||
      preparedLibraryImageIssue({ blob: image.blob, width: image.width, height: image.height })
    )
      throw new Error('草稿图片无效。');
  }
  return value as unknown as ManualQuestionDraft;
}

export function newManualDraft(
  previous?: Pick<ManualQuestionDraft, 'source' | 'categoryId' | 'bookTitle'>,
): ManualQuestionDraft {
  return {
    id: crypto.randomUUID(),
    source: previous?.source ?? 'direct',
    categoryId: previous?.categoryId ?? null,
    title: '',
    recallPrompt: '',
    coreLesson: '',
    itemType: 'Understand' satisfies LearningItemType,
    tags: '',
    excerpt: '',
    bookTitle: previous?.bookTitle ?? '',
    location: '',
    image: null,
    imageName: '',
    videoUrl: '',
    timestamp: '',
  };
}

export function manualDraftSignature(draft: ManualQuestionDraft): string {
  const { id, source, ...fields } = draft;
  void id;
  void source;
  return JSON.stringify(fields);
}

export function manualDraftIssue(draft: ManualQuestionDraft): string | null {
  if (draft.source === 'reading') return readingDraftIssue(draft);
  if (!draft.title.trim() || !draft.recallPrompt.trim() || !draft.coreLesson.trim())
    return '标题、回忆问题和答案要点都是必填的。';
  if (draft.source === 'image' && !draft.image) return '保存前请选择一张有效图片。';
  if (draft.source === 'video') {
    if (!parseManualVideoSource(draft.videoUrl))
      return '请输入支持的 YouTube、Bilibili 或 Douyin 视频链接。';
    if (draft.timestamp.trim() && parseTimestamp(draft.timestamp) === null)
      return '可选时间戳请使用 MM:SS 或 HH:MM:SS。';
  }
  return null;
}

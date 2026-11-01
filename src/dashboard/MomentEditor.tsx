import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import { editState, type EditCommit } from '../database/edit-commit';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LearningItem, MomentCategory } from '../database';
import { isImageLearningItem, isVideoLearningItem, learningItemTitle } from '../database';
import type { LearningItemType } from '../models/learning-item';
import { LEARNING_ITEM_TYPES, learningGoalLabel } from '../models/learning-item';
import { Diagnostics, Notice, SourceContextDisclosure } from '../shared/components';
import { useEditProtection } from '../shared/edit-protection';
import { ItemThumbnail } from './ItemThumbnail';
import {
  createLegacyNoteEditorInitialState,
  mergeLegacyPersonalNote,
  normalizeLegacyNoteWhitespace,
} from './legacy-personal-note';
import { classifyLegacyReason } from './legacy-reason';
import { classifyLegacyReferenceAnswer } from './legacy-reference-answer';

import { platformLabel } from '../shared/source-labels';
import { stickyBarClearance } from '../ui/sticky-bar-clearance';
export interface EditableValues {
  readingExcerpt: string;
  readingBook: string;
  readingLocation: string;
  title: string;
  itemType: LearningItemType;
  categoryId: string | null;
  /** @deprecated Retained only while an explicitly edited legacy record is resolved. */
  personalNote: string;
  situation: string;
  coreLesson: string;
  mistakeToAvoid: string;
  recommendedAction: string;
  recallPrompt: string;
  tags: string;
}

export function DetailEditor({
  item: initialItem,
  active = true,
  categories,
  busy,
  error,
  showDiagnostics,
  onClose,
  onOpen,
  onSave,
}: {
  item: LearningItem;
  active?: boolean;
  categories: MomentCategory[];
  busy: boolean;
  error: string | null;
  showDiagnostics: boolean;
  onClose: (discarded?: boolean) => void;
  onOpen?: () => void;
  onSave: (values: EditableValues, commit: EditCommit) => Promise<boolean | void> | boolean | void;
}) {
  const [item] = useState(initialItem);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (active) headingRef.current?.focus({ preventScroll: true });
  }, [active]);
  const initialLegacyState = createLegacyNoteEditorInitialState(item.coreLesson, item.personalNote);
  const videoItem = isVideoLearningItem(item) ? item : null;
  const capturedVideoItem = videoItem?.videoOrigin !== 'library' ? videoItem : null;
  const legacyReferenceAnswer = classifyLegacyReferenceAnswer({
    referenceAnswer: item.referenceAnswer,
    coreLesson: initialLegacyState.coreLesson,
  });
  const legacyReason = classifyLegacyReason({
    reason: item.reason,
    coreLesson: initialLegacyState.coreLesson,
    referenceAnswer: item.referenceAnswer,
    situation: item.situation,
    mistakeToAvoid: item.mistakeToAvoid,
    recommendedAction: item.recommendedAction,
    ...(capturedVideoItem
      ? {
          subtitleBefore: capturedVideoItem.subtitleBefore,
          subtitleCurrent: capturedVideoItem.subtitleCurrent,
          subtitleAfter: capturedVideoItem.subtitleAfter,
        }
      : {}),
  });
  const [values, setValues] = useState<EditableValues>({
    readingExcerpt: item.sourceType === 'text' ? (item.readingSource?.excerpt ?? '') : '',
    readingBook: item.sourceType === 'text' ? (item.readingSource?.bookTitle ?? '') : '',
    readingLocation: item.sourceType === 'text' ? (item.readingSource?.location ?? '') : '',
    title: learningItemTitle(item),
    itemType: item.itemType,
    categoryId: item.categoryId,
    personalNote: initialLegacyState.personalNote,
    situation: item.situation,
    coreLesson: initialLegacyState.coreLesson,
    mistakeToAvoid: item.mistakeToAvoid,
    recommendedAction: item.recommendedAction,
    recallPrompt: item.recallPrompt,
    tags: item.tags.join(', '),
  });
  const [legacyResolution, setLegacyResolution] = useState(initialLegacyState.resolution);
  const baseline = useRef(JSON.stringify({ values, legacyResolution }));
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [expectedState, setExpectedState] = useState(() => editState(item));
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const payload = useMemo(
    () => ({
      id: draftId,
      targetId: item.id,
      expectedState,
      values: { ...values },
      legacyResolution,
    }),
    [draftId, item.id, expectedState, values, legacyResolution],
  );
  const dirty = JSON.stringify({ values, legacyResolution }) !== baseline.current;
  const durable = useDurableDraft({
    id: draftId,
    scope: 'library:' + item.id,
    active,
    summary: values.title,
    payload,
    dirty,
    onRestore(value, row) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        value.id !== row.id ||
        value.targetId !== item.id ||
        typeof value.expectedState !== 'string' ||
        !value.values ||
        typeof value.values !== 'object' ||
        value.values instanceof Blob ||
        Array.isArray(value.values) ||
        !['none', 'keep', 'merge', 'discard'].includes(String(value.legacyResolution))
      )
        throw new Error('编辑草稿格式无效。');
      const restored = value.values;
      if (
        !Object.keys(values).every((key) =>
          key === 'categoryId'
            ? restored[key] === null || typeof restored[key] === 'string'
            : typeof restored[key] === 'string',
        ) ||
        !LEARNING_ITEM_TYPES.includes(restored.itemType as LearningItemType)
      )
        throw new Error('编辑草稿字段无效。');
      setValues(restored as unknown as EditableValues);
      setLegacyResolution(value.legacyResolution as typeof legacyResolution);
      setDraftId(row.id);
      setExpectedState(value.expectedState);
      baseline.current = '';
      setDraftError(null);
    },
  });
  useEditProtection({
    dirty: active && dirty && !durable.retained,
    busy: active && (busy || saving),
    prepareLeave: durable.prepareLeave,
    draftVersion: durable.version,
  });
  async function discardEdits() {
    if (busy || locked.current || (dirty && !window.confirm('放弃这次修改？'))) return;
    locked.current = true;
    setSaving(true);
    try {
      await durable.discardCurrent();
      onClose(true);
    } catch (failure) {
      setDraftError(failure instanceof Error ? failure.message : '没能放弃草稿，请重试。');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }
  async function save() {
    if (busy || locked.current) return;
    locked.current = true;
    setSaving(true);
    setDraftError(null);
    try {
      const token = await durable.flush();
      if (await onSave(values, { expectedState, ...(token ? { draft: token } : {}) }))
        durable.markCommitted();
    } catch (failure) {
      setDraftError(failure instanceof Error ? failure.message : '草稿保存失败。');
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }

  const set = (field: keyof EditableValues, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  return (
    <article className="library-detail-editor stack" aria-busy={busy || saving}>
      <div className="split">
        <div>
          <p className="eyebrow">当前题目</p>
          <h3 ref={headingRef} tabIndex={-1}>
            编辑回忆题
          </h3>
        </div>
        <button
          className="button secondary small-button"
          disabled={busy || saving}
          onClick={() => onClose()}
        >
          收起编辑
        </button>
      </div>
      {error && (
        <div data-edit-error>
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <DraftRecovery draft={durable} disabled={busy || saving} />
      {draftError && <Notice tone="error">{draftError}</Notice>}
      <fieldset className="detail-editor-fields stack" disabled={busy || saving}>
        {isImageLearningItem(item) && (
          <ItemThumbnail
            screenshotId={item.imageAssetId}
            alt={`${item.title} 的图片`}
            className="screenshot image-moment-cue"
            missingLabel="图片不可用"
          />
        )}
        <EditInput
          label={isVideoLearningItem(item) ? '视频标题' : '标题'}
          value={values.title}
          onChange={(value) => set('title', value)}
        />
        <EditInput
          label="问题"
          value={values.recallPrompt}
          onChange={(value) => set('recallPrompt', value)}
          help="什么问题能把这道回忆题带回你的脑海？"
        />
        <EditInput
          label="答案要点"
          value={values.coreLesson}
          onChange={(value) => set('coreLesson', value)}
          help="复习时揭晓。"
        />
        {item.sourceType === 'text' && item.readingSource && (
          <details className="reading-source-details">
            <summary>编辑原文与出处</summary>
            <div className="stack">
              <EditInput
                label="阅读原文"
                value={values.readingExcerpt}
                onChange={(value) => set('readingExcerpt', value)}
              />
              <EditInput
                label="书名"
                value={values.readingBook}
                onChange={(value) => set('readingBook', value)}
              />
              <EditInput
                label="章节或页码"
                value={values.readingLocation}
                onChange={(value) => set('readingLocation', value)}
              />
            </div>
          </details>
        )}
        {initialLegacyState.legacy.kind === 'distinct' && (
          <section className="legacy-note-panel stack-tight" aria-labelledby="legacy-note-heading">
            <div>
              <h4 id="legacy-note-heading">旧版备注</h4>
            </div>
            <p className="muted small">可以合并到答案要点，或丢弃。</p>
            <blockquote>{initialLegacyState.legacy.value}</blockquote>
            <p className="small" role="status">
              {legacyResolution === 'keep'
                ? ''
                : legacyResolution === 'merge'
                  ? '保存时会把旧版备注移入答案要点。'
                  : '保存时会丢弃旧版备注。'}
            </p>
            <div className="cluster">
              <button
                className="button secondary small-button motion-press"
                onClick={() => {
                  setValues((current) => ({
                    ...current,
                    coreLesson: mergeLegacyPersonalNote(
                      current.coreLesson,
                      initialLegacyState.legacy.value,
                    ),
                    personalNote: '',
                  }));
                  setLegacyResolution('merge');
                }}
              >
                合并到答案要点
              </button>
              <button
                className="button secondary small-button motion-press"
                onClick={() => {
                  setValues((current) => ({
                    ...current,
                    coreLesson:
                      normalizeLegacyNoteWhitespace(item.coreLesson).length === 0 &&
                      normalizeLegacyNoteWhitespace(current.coreLesson) ===
                        normalizeLegacyNoteWhitespace(initialLegacyState.legacy.value)
                        ? ''
                        : current.coreLesson,
                    personalNote: '',
                  }));
                  setLegacyResolution('discard');
                }}
              >
                丢弃旧版备注
              </button>
            </div>
          </section>
        )}
        {legacyReferenceAnswer.kind === 'distinct' && (
          <details className="legacy-note-panel stack-tight">
            <summary>旧版答案</summary>
            <p className="muted small">只读</p>
            <blockquote>{legacyReferenceAnswer.value}</blockquote>
          </details>
        )}
        <details className="library-editor-options">
          <summary>更多选项 · 分类、标签与学习目标</summary>
          <div className="field-grid">
            <label className="field">
              <span>学习目标</span>
              <select
                value={values.itemType}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    itemType: event.target.value as LearningItemType,
                  }))
                }
              >
                {LEARNING_ITEM_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {learningGoalLabel(type)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>分类</span>
              <select
                value={values.categoryId ?? ''}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    categoryId: event.target.value || null,
                  }))
                }
              >
                <option value="">未分类</option>
                {categories.map((category) => (
                  <option value={category.id} key={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>标签（用逗号分隔）</span>
            <input value={values.tags} onChange={(event) => set('tags', event.target.value)} />
          </label>
        </details>
        <details>
          <summary>旧版结构化字段</summary>
          <div className="stack-tight">
            <EditInput
              label="情境"
              value={values.situation}
              onChange={(value) => set('situation', value)}
            />
            <div className="field-grid">
              <EditInput
                label="需要避免的错误"
                value={values.mistakeToAvoid}
                onChange={(value) => set('mistakeToAvoid', value)}
              />
              <EditInput
                label="建议行动"
                value={values.recommendedAction}
                onChange={(value) => set('recommendedAction', value)}
              />
            </div>
          </div>
        </details>
        {legacyReason.kind === 'distinct' && (
          <details className="legacy-note-panel stack-tight">
            <summary>旧版解释</summary>
            <blockquote>{legacyReason.value}</blockquote>
          </details>
        )}
        {videoItem && (
          <SourceContextDisclosure
            summary={
              capturedVideoItem
                ? `捕获自 ${platformLabel(videoItem.platform)}${videoItem.timestampDisplay ? ` · ${videoItem.timestampDisplay}` : ''}`
                : `来自 ${platformLabel(videoItem.platform)} 的视频${videoItem.timestampDisplay ? ` · ${videoItem.timestampDisplay}` : ''}`
            }
            before={capturedVideoItem?.subtitleBefore ?? []}
            current={capturedVideoItem?.subtitleCurrent ?? []}
            after={capturedVideoItem?.subtitleAfter ?? []}
          >
            {capturedVideoItem && (
              <ItemThumbnail
                screenshotId={capturedVideoItem.screenshotId}
                alt={`来自「${capturedVideoItem.videoTitle}」的捕获时刻`}
                className="screenshot"
              />
            )}
            {(videoItem.uploader || videoItem.chapterTitle) && (
              <dl className="metadata">
                {videoItem.uploader && (
                  <>
                    <dt>创作者</dt>
                    <dd>{videoItem.uploader}</dd>
                  </>
                )}
                {videoItem.chapterTitle && (
                  <>
                    <dt>章节</dt>
                    <dd>{videoItem.chapterTitle}</dd>
                  </>
                )}
              </dl>
            )}
            {onOpen && (
              <button className="button secondary small-button" onClick={onOpen}>
                打开来源
              </button>
            )}
            {capturedVideoItem && (
              <Diagnostics
                diagnostics={capturedVideoItem.extractionDiagnostics}
                open={showDiagnostics}
              />
            )}
          </SourceContextDisclosure>
        )}
        <div ref={stickyBarClearance} className="cluster form-actions library-editor-actions">
          <button className="button" aria-busy={busy || saving} onClick={() => void save()}>
            {busy || saving ? '保存中…' : '保存更改'}
          </button>
          <button className="button text-button" onClick={() => void discardEdits()}>
            放弃修改
          </button>
        </div>
      </fieldset>
    </article>
  );
}

export function EditInput({
  label,
  value,
  onChange,
  help,
  required = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        required={required}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {help && <small className="field-help">{help}</small>}
    </label>
  );
}

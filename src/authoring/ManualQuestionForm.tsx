import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import { useEditProtection } from '../shared/edit-protection';
import { manualDraftValue, readManualDraft } from './manual-draft';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ValRecallRepository,
  learningItemTitle,
  type LearningItem,
  type MomentCategory,
} from '../database';
import {
  LEARNING_ITEM_TYPES,
  learningGoalLabel,
  type LearningItemType,
} from '../models/learning-item';
import { RecallFields } from '../reading/RecallFields';
import { ReadingSourceDetails } from '../reading/ReadingSourceDetails';
import { clozeFromSelection, READING_GUIDES } from '../reading/reading-draft';
import { Notice } from '../shared/components';
import { displayError, refreshReviewReminders } from '../shared/extension';
import {
  libraryImageFileIssue,
  prepareLibraryImage,
  type PreparedLibraryImage,
} from '../shared/library-image';
import { DEFAULT_PREFERENCES, type ValRecallPreferences } from '../shared/preferences';
import { parseManualVideoSource } from '../shared/video-url';
import {
  manualDraftSignature,
  manualDraftIssue,
  newManualDraft,
  type ManualQuestionDraft,
  type ManualQuestionSource,
} from './manual-draft';
import { saveManualQuestion, type ManualQuestionReceipt } from './save-manual';
import { stickyBarClearance } from '../ui/sticky-bar-clearance';
import './authoring.css';

export type { ManualQuestionSource } from './manual-draft';
export interface ManualSourceRequest {
  key: number;
  source?: ManualQuestionSource;
  categoryId?: string | null;
}
export interface ManualQuestionFormProps {
  active?: boolean;
  protectionActive?: boolean;
  preferences?: ValRecallPreferences;
  sourceRequest?: ManualSourceRequest;
  initialCategoryId?: string | null;
  onSaved?: (item: LearningItem) => void;
  onViewItem?: (id: string) => void;
  onDraftStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
  loadCategories?: () => Promise<MomentCategory[]>;
  save?: typeof saveManualQuestion;
  /** The browser side panel embeds just the reading source. */
  readingOnly?: boolean;
  embedded?: boolean;
  onReceive?: () => void;
}
const repository = new ValRecallRepository();
const defaultCategories = () => repository.listCategories();
const SOURCE_LABELS: Record<ManualQuestionSource, string> = {
  direct: '直接出题',
  reading: '阅读摘录',
  image: '图片',
  video: '视频链接',
};

type ManualField = 'excerpt' | 'title' | 'prompt' | 'answer' | 'image' | 'videoUrl' | 'timestamp';
const SOURCE_PANE_FIELDS: ReadonlySet<ManualField> = new Set([
  'excerpt',
  'image',
  'videoUrl',
  'timestamp',
]);

/** The control `manualDraftIssue` rejected, found in the same order as its checks. */
function invalidManualField(draft: ManualQuestionDraft): ManualField {
  if (draft.source === 'reading') {
    if (!draft.excerpt.trim()) return 'excerpt';
    return draft.recallPrompt.trim() ? 'answer' : 'prompt';
  }
  if (!draft.title.trim()) return 'title';
  if (!draft.recallPrompt.trim()) return 'prompt';
  if (!draft.coreLesson.trim()) return 'answer';
  if (draft.source === 'image') return 'image';
  return parseManualVideoSource(draft.videoUrl) ? 'timestamp' : 'videoUrl';
}

export function ManualQuestionForm({
  active = true,
  protectionActive = active,
  preferences = DEFAULT_PREFERENCES,
  sourceRequest,
  initialCategoryId = null,
  onSaved,
  onViewItem,
  onDraftStateChange,
  loadCategories = defaultCategories,
  save = saveManualQuestion,
  readingOnly = false,
  embedded = false,
  onReceive,
}: ManualQuestionFormProps) {
  const [draft, setDraft] = useState(() =>
    newManualDraft({
      source: readingOnly ? 'reading' : (sourceRequest?.source ?? 'direct'),
      categoryId:
        sourceRequest?.categoryId === undefined ? initialCategoryId : sourceRequest.categoryId,
      bookTitle: '',
    }),
  );
  const [categories, setCategories] = useState<MomentCategory[]>([]);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryAttempt, setCategoryAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [receipt, setReceipt] = useState<ManualQuestionReceipt | null>(null);
  const [preview, setPreview] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [pane, setPane] = useState<'source' | 'question'>(readingOnly ? 'source' : 'question');
  const [guide, setGuide] = useState(0);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const lock = useRef(false);
  const baseline = useRef(manualDraftSignature(draft));
  const preparingRef = useRef(false);
  const imageRequest = useRef(0);
  const consumedRequest = useRef<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldControls = useRef<Partial<Record<ManualField, HTMLElement | null>>>({});
  const fieldToFocus = useRef<ManualField | null>(null);
  // A second refusal changes nothing else, so this is what makes it render and be consumed.
  const [focusRequest, setFocusRequest] = useState(0);
  const paneHeading = useRef<HTMLHeadingElement>(null);
  const paneFocus = useRef(false);
  const headingId = useId();
  const busy = saving || preparing;
  const dirty = !receipt && manualDraftSignature(draft) !== baseline.current;
  const durable = useDurableDraft({
    id: draft.id,
    scope: readingOnly ? 'reading' : 'manual',
    summary: draft.title || draft.recallPrompt,
    payload: manualDraftValue(draft),
    dirty,
    active,
    onRestore: (value, row) => {
      const restored = readManualDraft(value);
      if (restored.id !== row.id) throw new Error('草稿身份不一致。');
      if (readingOnly && restored.source !== 'reading') throw new Error('这份草稿不是阅读摘录。');
      baseline.current = '';
      setDraft(restored);
      setReceipt(null);
      setError(null);
      setPreview(false);
      // The selection indexed the text just replaced.
      setSelection({ start: 0, end: 0 });
    },
  });
  useEditProtection({
    dirty: protectionActive && dirty && !durable.retained,
    busy: protectionActive && busy,
    prepareLeave: durable.prepareLeave,
    draftVersion: durable.version,
  });
  const reading = draft.source === 'reading';
  const Heading = embedded ? 'h3' : 'h2';
  const stateListener = useRef(onDraftStateChange);
  stateListener.current = onDraftStateChange;

  useEffect(() => {
    stateListener.current?.({ dirty: dirty && !durable.retained, busy });
  }, [dirty, busy, durable.retained]);
  useEffect(() => {
    if (!sourceRequest || consumedRequest.current === sourceRequest.key || busy) return;
    consumedRequest.current = sourceRequest.key;
    if (receipt) {
      const next = newManualDraft({
        source: sourceRequest.source ?? draft.source,
        categoryId:
          sourceRequest.categoryId === undefined ? draft.categoryId : sourceRequest.categoryId,
        bookTitle: draft.bookTitle,
      });
      baseline.current = manualDraftSignature(next);
      setDraft(next);
      setReceipt(null);
      setError(null);
      setPreview(false);
      return;
    }
    const next = {
      ...draft,
      ...(sourceRequest.source ? { source: sourceRequest.source } : {}),
      ...(!dirty && sourceRequest.categoryId !== undefined
        ? { categoryId: sourceRequest.categoryId }
        : {}),
    };
    if (!dirty) baseline.current = manualDraftSignature(next);
    setDraft(next);
    setError(null);
    setPreview(false);
  }, [sourceRequest, busy, receipt, draft, dirty]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void loadCategories()
      .then((rows) => {
        if (current) {
          setCategories(rows);
          setCategoryError(null);
        }
      })
      .catch((caught: unknown) => {
        if (current) setCategoryError(displayError(caught, '分类加载失败，可先保存为未分类。'));
      });
    return () => {
      current = false;
    };
  }, [active, categoryAttempt, loadCategories]);
  useEffect(() => {
    if (active) heading.current?.focus();
  }, [active, preview, receipt]);
  useEffect(() => {
    if ((!dirty || durable.retained) && !busy) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, busy, durable.retained]);
  useEffect(
    () => () => {
      imageRequest.current++;
    },
    [],
  );

  useEffect(() => {
    if (paneFocus.current) {
      paneHeading.current?.focus();
      paneFocus.current = false;
    }
  }, [pane, preview]);
  // Runs after the heading and pane focus effects, so the rejected field keeps the focus.
  useEffect(() => {
    if (!fieldToFocus.current) return;
    fieldControls.current[fieldToFocus.current]?.focus();
    fieldToFocus.current = null;
  }, [focusRequest]);
  function switchPane(next: 'source' | 'question') {
    paneFocus.current = true;
    setPane(next);
  }
  const controlRef = (field: ManualField) => (element: HTMLElement | null) => {
    fieldControls.current[field] = element;
  };
  function showInvalidDraft(issue: string) {
    const field = invalidManualField(draft);
    fieldToFocus.current = field;
    setFocusRequest((request) => request + 1);
    setError(issue);
    setPreview(false);
    setPane(SOURCE_PANE_FIELDS.has(field) ? 'source' : 'question');
  }
  function openPreview() {
    const issue = manualDraftIssue(draft);
    if (issue) {
      showInvalidDraft(issue);
      return;
    }
    setRevealed(false);
    setPreview(true);
    switchPane('question');
  }

  function set<K extends keyof ManualQuestionDraft>(key: K, value: ManualQuestionDraft[K]) {
    if (lock.current || preparingRef.current) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  }
  async function reset(discard: boolean) {
    if (lock.current || preparingRef.current) return;
    if (discard && dirty && !window.confirm(reading ? '放弃这条阅读摘录？' : '放弃这道回忆题？'))
      return;
    if (discard && dirty) {
      lock.current = true;
      setSaving(true);
      try {
        await durable.discardCurrent();
      } catch (failure) {
        setError(displayError(failure, '草稿未丢弃。'));
        setPane('question');
        return;
      } finally {
        lock.current = false;
        setSaving(false);
      }
    }
    imageRequest.current++;
    const next = newManualDraft(draft);
    baseline.current = manualDraftSignature(next);
    setDraft(next);
    setReceipt(null);
    setError(null);
    setPreview(false);
    setSelection({ start: 0, end: 0 });
    fieldControls.current.excerpt?.focus();
  }
  const selectedText = draft.excerpt.slice(selection.start, selection.end);
  const cloze = clozeFromSelection(draft.excerpt, selection.start, selection.end);
  function useSelection(mask: boolean) {
    if (busy || !selectedText.trim() || (mask && !cloze)) return;
    setDraft((current) => ({ ...current, ...(mask ? cloze! : { coreLesson: selectedText }) }));
    setError(null);
  }
  async function selectImage(file: File | null) {
    if (lock.current || preparingRef.current) return;
    const request = ++imageRequest.current;
    setDraft((current) => ({ ...current, image: null, imageName: '' }));
    if (!file) {
      setDraft((current) => ({ ...current, image: null, imageName: '' }));
      return;
    }
    const issue = libraryImageFileIssue(file);
    if (issue) {
      setError(issue);
      setPane('source');
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    setError(null);
    try {
      const image = await prepareLibraryImage(file);
      if (request === imageRequest.current)
        setDraft((current) => ({ ...current, image, imageName: file.name }));
    } catch (caught) {
      if (request === imageRequest.current) {
        setError(displayError(caught, '所选图片无法处理。'));
        setPane('source');
      }
    } finally {
      if (request === imageRequest.current) {
        preparingRef.current = false;
        setPreparing(false);
      }
    }
  }
  async function submit() {
    if (lock.current || preparingRef.current || receipt) return;
    const issue = manualDraftIssue(draft);
    if (issue) {
      showInvalidDraft(issue);
      return;
    }
    lock.current = true;
    setSaving(true);
    setError(null);
    setPane('question');
    try {
      const token = await durable.flush();
      const saved = await save(draft, preferences.shortTermReviewMode, undefined, token);
      durable.markCommitted();
      setReceipt(saved);
      try {
        onSaved?.(saved.item);
      } catch {
        setError('已保存，列表未更新，请刷新。');
      }
      void refreshReviewReminders();
    } catch (caught) {
      setError('保存失败：' + displayError(caught, '请重试。'));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const readingSource = {
    schemaVersion: 1 as const,
    excerpt: draft.excerpt,
    bookTitle: draft.bookTitle,
    location: draft.location,
  };
  const sourceDetails = reading ? (
    <ReadingSourceDetails source={readingSource} />
  ) : draft.source === 'video' ? (
    <details className="reading-source-details">
      <summary>来源信息</summary>
      <p>
        {draft.videoUrl}
        {draft.timestamp ? ` · ${draft.timestamp}` : ''}
      </p>
    </details>
  ) : null;

  if (receipt) {
    const savedLabel = reading ? '阅读摘录已保存' : '回忆题已保存';
    const praise = __VALRECALL_PUBLIC_RELEASE__ ? undefined : receipt.allowance?.praise;
    return (
      <section className="reading-capture manual-question-form stack" aria-labelledby={headingId}>
        <Heading className="manual-receipt-heading" id={headingId} ref={heading} tabIndex={-1}>
          {praise ? (
            <>
              <span className="sr-only">{savedLabel}</span>
              {praise}
            </>
          ) : (
            savedLabel
          )}
        </Heading>
        <p className="reading-question">
          <strong>{learningItemTitle(receipt.item)}</strong>
        </p>
        {receipt.allowance && (
          <p className="reading-reward" role="status">
            阅读摘录 +{receipt.allowance.captureReward} 零花钱
            {receipt.allowance.checkIn ? ` · 每日打卡 +${receipt.allowance.checkInReward}` : ''}
          </p>
        )}
        {receipt.manualReward !== null && (
          <p className="reading-reward" role="status">
            手动出题 +{receipt.manualReward} 零花钱
          </p>
        )}
        {/* A flag && child would leave a false in the private children, so both editions fold here. */}
        {__VALRECALL_PUBLIC_RELEASE__ ? (
          <>
            {error && <Notice tone="error">{error}</Notice>}
            {receipt.warning && <Notice tone="warning">{receipt.warning}</Notice>}
          </>
        ) : (
          receipt.warning && <Notice tone="warning">{receipt.warning}</Notice>
        )}
        <div className="cluster">
          <button className="button" onClick={() => reset(false)}>
            继续记录
          </button>
          {onViewItem && (
            <button className="button secondary" onClick={() => onViewItem(receipt.item.id)}>
              在资料库查看
            </button>
          )}
        </div>
      </section>
    );
  }
  return (
    <section
      className={`reading-capture manual-question-form stack${readingOnly ? ' manual-reading-only' : ''}`}
      aria-labelledby={headingId}
    >
      {/* The focus target for this form: the mode switch above already names it on screen. */}
      <Heading className="sr-only" id={headingId} ref={heading} tabIndex={-1}>
        {embedded ? '手动创建' : reading ? '阅读摘录' : '手动出题'}
      </Heading>
      {onReceive && (
        <header>
          <button className="button secondary" onClick={onReceive}>
            接收整理结果
          </button>
        </header>
      )}
      <DraftRecovery draft={durable} disabled={busy} />
      <div className="manual-pane-switch" role="group" aria-label="工作区">
        <button
          type="button"
          className="button secondary"
          aria-pressed={pane === 'source'}
          disabled={busy || preview}
          onClick={() => switchPane('source')}
        >
          来源材料
        </button>
        <button
          type="button"
          className="button secondary"
          aria-pressed={pane === 'question'}
          disabled={busy}
          onClick={() => switchPane('question')}
        >
          写题与预览
        </button>
      </div>
      <form
        className="stack"
        noValidate
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="reading-fields manual-editor-grid" disabled={busy} data-pane={pane}>
          <aside className="manual-materials stack" aria-label="来源材料">
            <h4
              className="manual-pane-heading"
              ref={pane === 'source' ? paneHeading : undefined}
              tabIndex={-1}
            >
              来源材料
            </h4>
            {preview ? (
              <p className="muted">预览时隐藏来源。</p>
            ) : (
              <>
                {!readingOnly && (
                  <fieldset className="manual-source-picker">
                    <legend className="sr-only">出题来源</legend>
                    <div className="cluster">
                      {(Object.keys(SOURCE_LABELS) as ManualQuestionSource[]).map((source) => (
                        <button
                          type="button"
                          className="button secondary"
                          key={source}
                          aria-pressed={draft.source === source}
                          onClick={() => set('source', source)}
                        >
                          {SOURCE_LABELS[source]}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}
                {reading && (
                  <div className="manual-source-panel stack">
                    <label className="field">
                      <span>原文</span>
                      <textarea
                        ref={controlRef('excerpt')}
                        rows={8}
                        value={draft.excerpt}
                        placeholder="粘贴书籍或 PDF 中的一段文字…"
                        onChange={(event) => {
                          set('excerpt', event.target.value);
                          setSelection({ start: 0, end: 0 });
                        }}
                        onSelect={(event) =>
                          setSelection({
                            start: event.currentTarget.selectionStart,
                            end: event.currentTarget.selectionEnd,
                          })
                        }
                      />
                    </label>
                    <div className="cluster">
                      <button
                        type="button"
                        className="button secondary small-button"
                        disabled={!selectedText.trim()}
                        onClick={() => useSelection(false)}
                      >
                        用作答案要点
                      </button>
                      <button
                        type="button"
                        className="button secondary small-button"
                        disabled={!cloze}
                        onClick={() => useSelection(true)}
                      >
                        选中挖空
                      </button>
                    </div>
                    <details className="reading-source-details">
                      <summary>出处</summary>
                      <div className="stack">
                        <label className="field">
                          <span>书名</span>
                          <input
                            value={draft.bookTitle}
                            onChange={(event) => set('bookTitle', event.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span>章节或页码</span>
                          <input
                            value={draft.location}
                            onChange={(event) => set('location', event.target.value)}
                          />
                        </label>
                      </div>
                    </details>
                  </div>
                )}
                {draft.source === 'image' && (
                  <div className="manual-source-panel stack">
                    <label className="field">
                      <span>主图</span>
                      <input
                        ref={controlRef('image')}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        required={!draft.image}
                        onChange={(event) => void selectImage(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    {draft.image && (
                      <ImagePreview image={draft.image} title={draft.imageName || draft.title} />
                    )}
                    {preparing && <p role="status">正在处理图片…</p>}
                  </div>
                )}
                {draft.source === 'video' && (
                  <div className="manual-source-panel stack">
                    <label className="field">
                      <span>视频链接</span>
                      <input
                        ref={controlRef('videoUrl')}
                        type="url"
                        required
                        value={draft.videoUrl}
                        placeholder="YouTube、Bilibili 或 Douyin 链接"
                        onChange={(event) => set('videoUrl', event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>时间戳</span>
                      <input
                        ref={controlRef('timestamp')}
                        inputMode="numeric"
                        placeholder="MM:SS 或 HH:MM:SS"
                        value={draft.timestamp}
                        onChange={(event) => set('timestamp', event.target.value)}
                      />
                    </label>
                  </div>
                )}
                {error && pane === 'source' && <Notice tone="error">{error}</Notice>}
                <button
                  type="button"
                  className="button secondary manual-continue"
                  onClick={() => switchPane('question')}
                >
                  继续写题
                </button>
              </>
            )}
          </aside>
          <div className="manual-question-panel stack">
            <div className="manual-question-toolbar">
              <h4
                className="manual-pane-heading"
                ref={pane === 'question' ? paneHeading : undefined}
                tabIndex={-1}
              >
                {preview ? '预览回忆题' : '当前回忆题'}
              </h4>
              <div className="cluster" role="group" aria-label="题目显示方式">
                <button
                  type="button"
                  className="button secondary small-button"
                  aria-pressed={!preview}
                  onClick={() => {
                    setPreview(false);
                    switchPane('question');
                  }}
                >
                  {preview ? '返回编辑' : '编辑'}
                </button>
                <button
                  type="button"
                  className="button secondary small-button"
                  aria-pressed={preview}
                  onClick={openPreview}
                >
                  预览回忆题
                </button>
              </div>
            </div>
            {preview ? (
              <div className="manual-preview stack">
                {draft.source === 'image' && draft.image && (
                  <ImagePreview image={draft.image} title="" />
                )}
                <h3 className="reading-question">{draft.recallPrompt}</h3>
                {revealed ? (
                  <div className="stack">
                    <h4>答案要点</h4>
                    <p className="reading-answer">{draft.coreLesson}</p>
                    {sourceDetails}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setRevealed(true)}
                  >
                    揭晓答案
                  </button>
                )}
              </div>
            ) : (
              <>
                {!reading && (
                  <label className="field">
                    <span>标题</span>
                    <input
                      ref={controlRef('title')}
                      required
                      value={draft.title}
                      onChange={(event) => set('title', event.target.value)}
                    />
                  </label>
                )}
                {reading && (
                  <details className="reading-source-details">
                    <summary>提问思路</summary>
                    <div className="stack reading-guides">
                      <div className="cluster" role="group" aria-label="提问方向">
                        {READING_GUIDES.map((entry, index) => (
                          <button
                            key={entry.label}
                            type="button"
                            className="button secondary small-button"
                            aria-pressed={guide === index}
                            onClick={() => setGuide(index)}
                          >
                            {entry.label}
                          </button>
                        ))}
                      </div>
                      <p className="muted small">{READING_GUIDES[guide]!.example}</p>
                    </div>
                  </details>
                )}
                <RecallFields
                  prompt={draft.recallPrompt}
                  answer={draft.coreLesson}
                  onPrompt={(value) => set('recallPrompt', value)}
                  onAnswer={(value) => set('coreLesson', value)}
                  promptRef={controlRef('prompt')}
                  answerRef={controlRef('answer')}
                />
                <details className="reading-source-details">
                  <summary>更多选项 · 分类、标签与学习目标</summary>
                  <div className="field-grid">
                    <label className="field">
                      <span>分类</span>
                      <select
                        value={draft.categoryId ?? ''}
                        onChange={(event) => set('categoryId', event.target.value || null)}
                      >
                        <option value="">未分类</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>学习目标</span>
                      <select
                        value={draft.itemType}
                        onChange={(event) =>
                          set('itemType', event.target.value as LearningItemType)
                        }
                      >
                        {LEARNING_ITEM_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {learningGoalLabel(type)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>标签（用逗号分隔）</span>
                      <input
                        value={draft.tags}
                        onChange={(event) => set('tags', event.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </>
            )}
            {categoryError && (
              <Notice tone="warning">
                {categoryError}
                <button
                  type="button"
                  className="button secondary small-button"
                  onClick={() => setCategoryAttempt((value) => value + 1)}
                >
                  重试分类
                </button>
              </Notice>
            )}
            <div ref={stickyBarClearance} className="manual-save-area stack">
              {error && pane !== 'source' && <Notice tone="error">{error}</Notice>}
              <div className="cluster form-actions">
                <button
                  className="button primary-action"
                  type="submit"
                  disabled={busy}
                  aria-busy={saving}
                >
                  {saving ? '保存中…' : reading ? '保存阅读摘录' : '保存回忆题'}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => reset(true)}
                >
                  放弃本条
                </button>
              </div>
            </div>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function ImagePreview({ image, title }: { image: PreparedLibraryImage; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const value = URL.createObjectURL(image.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [image]);
  return url ? (
    <img
      className="moment-image-preview manual-image-preview"
      src={url}
      alt={title ? `${title} 预览` : '所选图片预览'}
    />
  ) : null;
}

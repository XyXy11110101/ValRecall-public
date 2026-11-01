import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import { useEditProtection } from '../shared/edit-protection';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ValRecallRepository, type MomentCategory } from '../database';
import type { IntakeEntryResult, IntakeResult } from '../database/intake-types';
import { Notice } from '../shared/components';
import { displayError } from '../shared/extension';
import { rewardsVisible } from '../edition/rewards';
import type { ValRecallPreferences } from '../shared/preferences';
import {
  INTAKE_MAX_BYTES,
  intakeQuestionKey,
  parseIntakePackage,
  questionIssue,
  type IntakePackageV1,
  type IntakeQuestion,
  type IntakeSelection,
} from './package';
import {
  countCategoryOverrides,
  hasOwnCategory,
  intakeQuestionCategory,
  readIntakeDraft,
  UNIFORM_INTAKE_CATEGORY,
  withDefaultCategory,
  withoutQuestionCategory,
  withQuestionCategory,
  type IntakeCategoryChoice,
} from './intake-draft';
import {
  estimateIntakeSelection,
  forgetIntakeEntry,
  intakeQuestionStatus,
  mergeIntakeEntries,
  type IntakeEntryIndex,
} from './intake-status';
import { saveIntake, type IntakeSaveReceipt } from './save-intake';
import { NoteContentView } from './NoteContentView';
import './intake-workspace.css';

const repository = new ValRecallRepository();
const loadCategories = () => repository.listCategories();
const previewIntake = (selection: IntakeSelection) => repository.previewIntake(selection);

/** Automatic checks wait for a short pause in selection or editing. */
export const INTAKE_CHECK_DELAY_MS = 250;
/**
 * A check request that settles within this time after it starts never shows pending
 * text, a spinner or a dimmed save action. The native disabled state still blocks saving.
 */
export const INTAKE_PENDING_NOTICE_MS = 300;

interface IntakeCheck {
  report: IntakeResult;
  /** The exact selection this report answers; null once it is known to be outdated. */
  selection: IntakeSelection | null;
  /** Every outcome known for this package, merged across reports. */
  known: IntakeEntryIndex;
}

const isConflict = (entry: IntakeEntryResult) => entry.status === 'conflict';
const NOTHING_KNOWN: IntakeEntryIndex = new Map();
/** Space left between the sticky bar and a revealed target. */
const REVEAL_GAP_PX = 8;

/**
 * Focus without letting the browser jump the page; scroll only when the target is
 * hidden. `reveal` is a short element that must be visible with the target (for
 * example the back button above a heading). A sticky `cover` that is taller than the
 * CSS scroll margin can still hide it after scrollIntoView, so the gap is closed here.
 */
function focusInPlace(
  element: HTMLElement | null | undefined,
  cover?: HTMLElement | null,
  reveal: HTMLElement | null = null,
) {
  if (!element) return;
  element.focus({ preventScroll: true });
  const area = reveal ?? element;
  const bounds = area.getBoundingClientRect();
  // A zero box is not rendered (or not laid out), so there is nothing to reveal.
  if (bounds.width === 0 && bounds.height === 0) return;
  const coverBottom = () => (cover ? Math.max(0, cover.getBoundingClientRect().bottom) : 0);
  const bottom = window.innerHeight || document.documentElement.clientHeight;
  const target = area === element ? bounds : element.getBoundingClientRect();
  if (bounds.top >= coverBottom() && target.bottom <= bottom) return;
  if (typeof area.scrollIntoView === 'function') area.scrollIntoView({ block: 'nearest' });
  if (!cover) return;
  const hidden = coverBottom() - area.getBoundingClientRect().top;
  if (hidden > 0 && typeof window.scrollBy === 'function')
    window.scrollBy({ top: -(hidden + REVEAL_GAP_PX) });
}

function CategorySelect({
  value,
  categories,
  loaded,
  disabled,
  onChange,
  ...attributes
}: {
  value: string | null;
  categories: readonly MomentCategory[];
  loaded: boolean;
  disabled: boolean;
  onChange: (categoryId: string | null) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  // A restored choice whose category was deleted stays visible so the row can be found.
  const unknownId =
    value !== null && !categories.some((category) => category.id === value) ? value : null;
  return (
    <select
      {...attributes}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">未分类</option>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
      {unknownId !== null && (
        <option value={unknownId}>{loaded ? '已不存在的分类' : '分类加载中…'}</option>
      )}
    </select>
  );
}

export interface IntakeViewProps {
  active?: boolean;
  protectionActive?: boolean;
  embedded?: boolean;
  preferences: ValRecallPreferences;
  onChanged: () => void;
  onViewItem: (id: string) => void;
  onDraftStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
  categoriesLoader?: () => Promise<MomentCategory[]>;
  preview?: typeof previewIntake;
  save?: typeof saveIntake;
}

export function IntakeView({
  active = true,
  protectionActive = active,
  embedded = false,
  preferences,
  onChanged,
  onViewItem,
  onDraftStateChange,
  categoriesLoader = loadCategories,
  preview = previewIntake,
  save = saveIntake,
}: IntakeViewProps) {
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [text, setText] = useState('');
  const [packet, setPacket] = useState<IntakePackageV1 | null>(null);
  const [selectedQuestions, setSelectedQuestions] = useState<Set<string>>(new Set());
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [pane, setPane] = useState<'directory' | 'detail'>('directory');
  const [editing, setEditing] = useState<{ key: string; original: IntakeQuestion } | null>(null);
  const [categories, setCategories] = useState<MomentCategory[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [categoryChoice, setCategoryChoice] =
    useState<IntakeCategoryChoice>(UNIFORM_INTAKE_CATEGORY);
  const [categoryError, setCategoryError] = useState(false);
  const [categoryAttempt, setCategoryAttempt] = useState(0);
  const [checked, setChecked] = useState<IntakeCheck | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [checking, setChecking] = useState(false);
  // Set once a running check request outlasts INTAKE_PENDING_NOTICE_MS, or when save
  // is pressed during a check; it stays until a result arrives, so it cannot blink.
  const [showPending, setShowPending] = useState(false);
  // A save pressed while the selection was being checked; it runs once that exact
  // selection is fresh and still saveable.
  const [saveIntent, setSaveIntent] = useState<IntakeSelection | null>(null);
  const [pendingCommit, setPendingCommit] = useState<IntakeSelection | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const checkRequest = useRef(0);
  const [receipt, setReceipt] = useState<IntakeSaveReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const packetArea = useRef<HTMLDivElement>(null);
  const selectionBar = useRef<HTMLDivElement>(null);
  const defaultCategoryBlock = useRef<HTMLDivElement>(null);
  const focusAfterCategoryRetry = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const directoryButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusTarget = useRef<'detail' | 'directory' | 'editor' | 'edit-button' | null>(null);
  const ids = useId();

  // Serialising up to 1 MiB is tied to the package only, never to a checkbox.
  const packetText = useMemo(() => (packet ? JSON.stringify(packet) : null), [packet]);
  const draftPayload = useMemo(
    () => ({
      id: draftId,
      text,
      packetText,
      selected: [...selectedQuestions],
      currentKey,
      defaultCategory: categoryChoice.defaultCategory,
      questionCategories: categoryChoice.overrides,
    }),
    [draftId, text, packetText, selectedQuestions, currentKey, categoryChoice],
  );
  const durable = useDurableDraft({
    id: draftId,
    scope: 'intake',
    summary: packet
      ? '整理回忆题 · ' + packet.records.reduce((n, row) => n + row.questions.length, 0) + ' 道'
      : '未解析的整理包',
    payload: draftPayload,
    dirty: Boolean((text || packet) && !receipt),
    active,
    onRestore: (value, row) => {
      const restored = readIntakeDraft(value, row.id);
      setDraftId(restored.id);
      setText(restored.text);
      setPacket(restored.packet);
      setSelectedQuestions(new Set(restored.selected));
      setCategoryChoice(restored.categories);
      setCurrentKey(restored.currentKey);
      setEditing(null);
      setReceipt(null);
      setChecked(null);
      setError(null);
      setPane('directory');
    },
  });

  useEditProtection({
    dirty: protectionActive && Boolean((text || packet) && !receipt && !durable.retained),
    busy: protectionActive && busy,
    prepareLeave: durable.prepareLeave,
    draftVersion: durable.version,
  });

  useEffect(() => {
    onDraftStateChange?.({
      dirty: Boolean((text || packet) && !receipt && !durable.retained),
      busy,
    });
  }, [text, packet, receipt, busy, onDraftStateChange, durable.retained]);

  // The page heading takes focus when the view opens, never when categories reload.
  useEffect(() => {
    if (active) focusInPlace(heading.current);
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void categoriesLoader()
      .then((rows) => {
        if (current) {
          setCategories(rows);
          setCategoriesLoaded(true);
          setCategoryError(false);
        }
      })
      .catch(() => {
        if (!current) return;
        focusAfterCategoryRetry.current = false;
        setCategoryError(true);
      });
    return () => {
      current = false;
    };
  }, [active, categoriesLoader, categoryAttempt]);
  useEffect(() => {
    if (((!text && !packet) || receipt || durable.retained) && !busy) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [text, packet, receipt, durable.retained, busy]);
  useEffect(() => {
    if (!active) return;
    // In the single-pane layout the back button above the heading must show as well.
    const returnShown = (returnButton.current?.getClientRects().length ?? 0) > 0;
    if (focusTarget.current === 'detail')
      focusInPlace(
        detailHeading.current,
        selectionBar.current,
        returnShown ? returnButton.current : null,
      );
    if (focusTarget.current === 'directory' && currentKey)
      focusInPlace(directoryButtons.current.get(currentKey), selectionBar.current);
    if (focusTarget.current === 'editor') focusInPlace(promptInput.current, selectionBar.current);
    if (focusTarget.current === 'edit-button')
      focusInPlace(editButton.current, selectionBar.current);
    focusTarget.current = null;
  }, [active, currentKey, pane, editing]);

  // The sticky bar wraps differently at each width and with each category name, so
  // its real height drives the sticky offsets and scroll margins under it.
  const packetShown = packet !== null && !receipt;
  useEffect(() => {
    const bar = selectionBar.current;
    const area = packetArea.current;
    if (!packetShown || !bar || !area || typeof ResizeObserver !== 'function') return;
    const write = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height);
      if (height > 0) area.style.setProperty('--intake-cover', `${height}px`);
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      area.style.removeProperty('--intake-cover');
    };
  }, [packetShown]);

  const candidates = useMemo(
    () =>
      packet?.records.flatMap((record) =>
        record.questions.map((question) => ({
          key: intakeQuestionKey(record.id, question.id),
          record,
          question,
        })),
      ) ?? [],
    [packet],
  );
  const current = candidates.find((candidate) => candidate.key === currentKey) ?? candidates[0];
  const currentIndex = current ? candidates.indexOf(current) : -1;
  const unselectedMaterials =
    packet?.records.filter((record) => record.questions.length === 0) ?? [];
  const selectedCount = candidates.filter((candidate) =>
    selectedQuestions.has(candidate.key),
  ).length;
  const invalidCount = candidates.filter(
    (candidate) => selectedQuestions.has(candidate.key) && questionIssue(candidate.question),
  ).length;
  // Without a category catalog every question is shown and saved as 未分类; the
  // choices themselves are kept so a successful retry brings them back.
  const effectiveCategories = categoryError ? UNIFORM_INTAKE_CATEGORY : categoryChoice;
  const categoriesDisabled = busy || categoryError || !categoriesLoaded;
  const overrideCount = countCategoryOverrides(
    effectiveCategories,
    candidates.map((candidate) => candidate.key),
  );
  // After a successful 重试分类 the retry notice disappears; continue at the package select.
  useEffect(() => {
    if (!focusAfterCategoryRetry.current || categoryError || !categoriesLoaded) return;
    focusAfterCategoryRetry.current = false;
    focusInPlace(defaultCategoryBlock.current?.querySelector('select'));
  }, [categoryError, categoriesLoaded]);

  function invalidate() {
    checkRequest.current++;
    setCheckError(null);
    setError(null);
  }
  function parse(source: string) {
    try {
      const parsed = parseIntakePackage(source);
      setPacket(parsed);
      setChecked(null);
      setSaveIntent(null);
      setReceipt(null);
      setError(null);
      setCategoryChoice(UNIFORM_INTAKE_CATEGORY);
      setEditing(null);
      setPreviewing(false);
      setRevealed(false);
      setPane('directory');
      const first = parsed.records.find((record) => record.questions.length > 0);
      setCurrentKey(first ? intakeQuestionKey(first.id, first.questions[0]!.id) : null);
      setSelectedQuestions(
        new Set(
          parsed.records.flatMap((record) =>
            record.questions
              .filter((question) => !question.needsConfirmation)
              .map((question) => intakeQuestionKey(record.id, question.id)),
          ),
        ),
      );
      focusInPlace(heading.current);
    } catch (caught) {
      setError(displayError(caught, '整理包无法读取。'));
    }
  }
  async function readFile(file: File) {
    if (locked.current) return;
    // A file that is too large replaces nothing, so it never needs the question.
    if (file.size > INTAKE_MAX_BYTES) {
      setError('整理包超过 1 MiB，请拆包。');
      return;
    }
    if ((text || packet) && !receipt && !window.confirm('用这个文件替换当前内容？')) return;
    locked.current = true;
    setBusy(true);
    try {
      const source = await file.text();
      setText(source);
      parse(source);
    } catch {
      setError('文件无法读取，请重选文件或粘贴内容。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const selectionSnapshot = useMemo<IntakeSelection | null>(() => {
    if (!packet) return null;
    const records = packet.records
      .map((record) => ({
        ...record,
        questions: record.questions
          .filter((question) => selectedQuestions.has(intakeQuestionKey(record.id, question.id)))
          .map((question) => ({ ...question, needsConfirmation: false })),
      }))
      .filter((record) => record.questions.length > 0);
    const questionCategories: Record<string, string | null> = {};
    for (const record of records)
      for (const question of record.questions) {
        const key = intakeQuestionKey(record.id, question.id);
        questionCategories[key] = intakeQuestionCategory(effectiveCategories, key);
      }
    return { package: { ...packet, records }, categories: {}, questionCategories };
  }, [packet, selectedQuestions, effectiveCategories]);
  const retryingCommit = pendingCommit !== null && pendingCommit === selectionSnapshot;
  const latestSelection = useRef(selectionSnapshot);
  latestSelection.current = selectionSnapshot;
  const latestCheck = useRef(checked);
  latestCheck.current = checked;

  // The last result stays on screen while a newer selection is checked. Only a
  // result for exactly the current selection is fresh enough to save against.
  const report = checked?.report ?? null;
  const fresh =
    checked !== null && selectionSnapshot !== null && checked.selection === selectionSnapshot;
  const freshReport = fresh ? checked.report : null;
  const freshConflicts = freshReport?.entries.some(isConflict) ?? false;
  const shownConflicts = report?.entries.some(isConflict) ?? false;
  const checkable =
    active &&
    !busy &&
    !receipt &&
    selectionSnapshot !== null &&
    selectedCount > 0 &&
    invalidCount === 0;
  // A failed check is not pending: its error and retry action are shown instead.
  const pendingCheck = checkable && !fresh && checkError === null;
  const entryIndex = checked?.known ?? NOTHING_KNOWN;
  const estimate = useMemo(
    () => estimateIntakeSelection(candidates, selectedQuestions, entryIndex),
    [candidates, selectedQuestions, entryIndex],
  );
  const saveCount = freshReport ? freshReport.questions : estimate.newQuestions;
  // Known conflicts among the selected questions, updated at once on every toggle.
  const conflictsAhead = freshReport ? freshConflicts : estimate.conflicts > 0;
  const canSave =
    !busy &&
    freshReport !== null &&
    !freshConflicts &&
    (freshReport.questions > 0 || retryingCommit) &&
    selectedCount > 0 &&
    invalidCount === 0;
  // What a quick check is expected to allow; the look follows it at once and stays.
  const looksSaveable = fresh
    ? canSave
    : !busy &&
      selectedCount > 0 &&
      invalidCount === 0 &&
      !conflictsAhead &&
      (saveCount > 0 || retryingCommit);
  // During a quick check the action keeps that look and stays natively disabled; the
  // spinner and dimming wait for showPending.
  const quietCheck: 'quiet' | 'quiet-off' | undefined =
    pendingCheck && !showPending ? (looksSaveable ? 'quiet' : 'quiet-off') : undefined;

  useEffect(() => {
    const request = ++checkRequest.current;
    setCheckError(null);
    if (
      !active ||
      busy ||
      receipt ||
      !selectionSnapshot ||
      selectedCount === 0 ||
      invalidCount > 0 ||
      latestCheck.current?.selection === selectionSnapshot
    ) {
      setChecking(false);
      setShowPending(false);
      return;
    }
    setChecking(true);
    let slow: number | undefined;
    const timer = window.setTimeout(() => {
      // Pending feedback is timed from the request itself, never from the first of a
      // series of changes, so a quick request never shows it.
      slow = window.setTimeout(() => {
        if (request === checkRequest.current) setShowPending(true);
      }, INTAKE_PENDING_NOTICE_MS);
      const settle = () => {
        window.clearTimeout(slow);
        if (request !== checkRequest.current || latestSelection.current !== selectionSnapshot)
          return false;
        setChecking(false);
        setShowPending(false);
        return true;
      };
      void preview(selectionSnapshot).then(
        (result) => {
          if (!settle()) return;
          setChecked((previous) => ({
            report: result,
            selection: selectionSnapshot,
            known: mergeIntakeEntries(previous?.known, result),
          }));
        },
        (caught: unknown) => {
          if (settle()) setCheckError(displayError(caught, '无法核对本地记录，请重试。'));
        },
      );
    }, INTAKE_CHECK_DELAY_MS);
    // A pending state already on screen stays until a result arrives: no blink.
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(slow);
      if (checkRequest.current === request) checkRequest.current++;
    };
  }, [
    selectionSnapshot,
    selectedCount,
    invalidCount,
    active,
    busy,
    receipt,
    preview,
    checkAttempt,
  ]);
  // A save pressed during a quick check runs once that exact selection is fresh; any
  // further change, a failed check or a refusal drops it, so nothing saves unseen.
  const submitLatest = useRef<() => Promise<void>>(async () => undefined);
  useLayoutEffect(() => {
    if (saveIntent === null) return;
    if (saveIntent !== selectionSnapshot || checkError !== null || busy || receipt) {
      setSaveIntent(null);
      return;
    }
    if (!fresh) return;
    setSaveIntent(null);
    if (canSave) void submitLatest.current();
  }, [saveIntent, selectionSnapshot, checkError, busy, receipt, fresh, canSave]);
  function rememberSave() {
    if (quietCheck !== 'quiet' || !selectionSnapshot) return;
    setSaveIntent(selectionSnapshot);
    // Answer the press at once: the pending look stays until the check settles.
    setShowPending(true);
  }
  async function submit() {
    if (
      locked.current ||
      !freshReport ||
      checking ||
      !selectionSnapshot ||
      freshConflicts ||
      (freshReport.questions === 0 && !retryingCommit) ||
      receipt ||
      selectedCount === 0 ||
      invalidCount > 0
    )
      return;
    locked.current = true;
    checkRequest.current++;
    setBusy(true);
    setError(null);
    try {
      const finalReport = await preview(selectionSnapshot);
      setChecked((previous) => ({
        report: finalReport,
        selection: selectionSnapshot,
        known: mergeIntakeEntries(previous?.known, finalReport),
      }));
      if (finalReport.entries.some(isConflict)) {
        setError('出现冲突题，请在目录中排除后重试。');
        return;
      }
      if (finalReport.questions === 0 && !retryingCommit) {
        setError('所选题目都已接收过。');
        return;
      }
      const token = await durable.flush();
      setPendingCommit(selectionSnapshot);
      const saved = await save(
        selectionSnapshot,
        preferences.shortTermReviewMode,
        undefined,
        token,
      );
      durable.markCommitted();
      setPendingCommit(null);
      setReceipt(saved);
      try {
        onChanged();
      } catch {
        setError('已保存，列表未更新，请刷新。');
      }
      focusInPlace(heading.current);
    } catch (caught) {
      setError('保存失败：' + displayError(caught, '请重试。'));
      // Keep the last result visible but never fresh: a new check must run first.
      setChecked((previous) => previous && { ...previous, selection: null });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  submitLatest.current = submit;
  async function reset() {
    if (locked.current) return;
    if (!receipt && (packet || text) && !window.confirm('放弃这次整理？')) return;
    locked.current = true;
    setBusy(true);
    try {
      if (!receipt) await durable.discardCurrent();
    } catch (failure) {
      setError(displayError(failure, '草稿未删除。'));
      return;
    } finally {
      locked.current = false;
      setBusy(false);
    }
    setPendingCommit(null);
    setDraftId(crypto.randomUUID());
    setPacket(null);
    setText('');
    setChecked(null);
    setReceipt(null);
    setError(null);
    setEditing(null);
    focusInPlace(heading.current);
  }
  function toggle(key: string, include: boolean) {
    setSelectedQuestions((previous) => {
      const next = new Set(previous);
      if (include) next.add(key);
      else next.delete(key);
      return next;
    });
    invalidate();
  }
  function chooseDefaultCategory(categoryId: string | null) {
    setCategoryChoice((previous) => withDefaultCategory(previous, categoryId));
    invalidate();
  }
  function chooseQuestionCategory(key: string, categoryId: string | null) {
    setCategoryChoice((previous) => withQuestionCategory(previous, key, categoryId));
    invalidate();
  }
  function followQuestionCategory(key: string) {
    setCategoryChoice((previous) => withoutQuestionCategory(previous, key));
    invalidate();
    // The follow action disappears with the override; keep focus on this question's select.
    focusInPlace(document.getElementById(`${ids}-detail-category`), selectionBar.current);
  }
  function followDefaultCategory() {
    setCategoryChoice((previous) => ({ defaultCategory: previous.defaultCategory, overrides: {} }));
    invalidate();
    // The reset action disappears with the overrides; keep focus on the package choice.
    focusInPlace(defaultCategoryBlock.current?.querySelector('select'));
  }
  function updateQuestion(recordId: string, question: IntakeQuestion) {
    setPacket((previous) =>
      previous
        ? {
            ...previous,
            records: previous.records.map((record) =>
              record.id === recordId
                ? {
                    ...record,
                    questions: record.questions.map((value) =>
                      value.id === question.id ? question : value,
                    ),
                  }
                : record,
            ),
          }
        : previous,
    );
    // A selected question keeps its last outcome until the next check replaces it; an
    // unselected one is not checked again, so its outcome for the old content is dropped.
    const key = intakeQuestionKey(recordId, question.id);
    if (!selectedQuestions.has(key))
      setChecked(
        (previous) => previous && { ...previous, known: forgetIntakeEntry(previous.known, key) },
      );
    invalidate();
  }
  function openQuestion(key: string) {
    setCurrentKey(key);
    setPreviewing(false);
    setRevealed(false);
    setPane('detail');
    setEditing(null);
    focusTarget.current = 'detail';
  }
  function viewSaved(entries: IntakeEntryResult[]) {
    const seen = new Set<string>();
    return (
      <ul className="intake-receipt-list">
        {entries
          .filter((entry) => {
            if (
              entry.kind !== 'question' ||
              entry.deleted ||
              entry.status === 'conflict' ||
              seen.has(entry.targetId)
            )
              return false;
            seen.add(entry.targetId);
            return true;
          })
          .map((entry) => (
            <li key={entry.targetId}>
              <button className="button secondary" onClick={() => onViewItem(entry.targetId)}>
                查看回忆题：
                {
                  packet?.records
                    .find((record) => record.id === entry.recordId)
                    ?.questions.find((question) => question.id === entry.questionId)?.prompt
                }
              </button>
            </li>
          ))}
      </ul>
    );
  }

  const saveLabel = busy
    ? '保存中…'
    : retryingCommit
      ? '核对上次保存结果'
      : saveCount === 0 && selectedCount > 0 && invalidCount === 0
        ? '没有新题需要保存'
        : `保存已选 ${saveCount} 道题`;
  const selectionHint =
    saveIntent !== null
      ? '检查后自动保存'
      : pendingCheck && showPending
        ? '正在检查…'
        : invalidCount > 0
          ? '先修改或取消需要补全的题'
          : conflictsAhead && selectedCount > 0
            ? '有冲突题，排除后才能保存'
            : '';
  // One stable summary: the same lines update in place, a stale result is muted.
  const summaryResult = selectedCount > 0 && invalidCount === 0 ? report : null;
  const summaryHeadline =
    selectedCount === 0
      ? '尚未选择回忆题'
      : invalidCount > 0
        ? `已选题目中有 ${invalidCount} 道需要补全问题或答案`
        : report
          ? `将新增 ${report.questions} 道回忆题`
          : '正在核对重复与冲突';
  const summaryNote =
    selectedCount === 0
      ? '勾选要接收的回忆题。'
      : invalidCount > 0
        ? '请修改，或取消选择后继续。'
        : !report
          ? ''
          : shownConflicts
            ? '有冲突题，请在目录中排除。'
            : retryingCommit
              ? '上次保存未确认，请先检查。'
              : report.questions > 0
                ? __VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()
                  ? '可以保存了。'
                  : '今天首次打卡另 +5。'
                : '没有新题。';
  const duplicateCount =
    summaryResult?.entries.filter((entry) => entry.status === 'duplicate').length ?? null;
  const conflictCount = summaryResult?.entries.filter(isConflict).length ?? null;
  const fact = (value: number | null, prefix = '') => (value === null ? '—' : prefix + value);
  const currentIncluded = current ? selectedQuestions.has(current.key) : false;
  const currentStatus = current
    ? intakeQuestionStatus(current.question, currentIncluded, entryIndex.get(current.key))
    : null;
  const currentCategory = current ? intakeQuestionCategory(effectiveCategories, current.key) : null;
  const currentOwn = current ? hasOwnCategory(effectiveCategories, current.key) : false;
  // Questions already in the library, from everything checked for this package. It sits
  // below the workspace and does not depend on the current ticks, so nothing above the
  // checkbox under the pointer grows or shrinks with each check.
  const existing = useMemo(() => {
    const seen = new Set<string>();
    const rows: { targetId: string; prompt: string }[] = [];
    for (const candidate of candidates) {
      const entry = entryIndex.get(candidate.key);
      if (entry?.status !== 'duplicate' || entry.deleted || seen.has(entry.targetId)) continue;
      seen.add(entry.targetId);
      rows.push({ targetId: entry.targetId, prompt: candidate.question.prompt });
    }
    return rows;
  }, [candidates, entryIndex]);

  return (
    <section className="intake-view question-intake stack" aria-busy={busy}>
      <header>
        {!embedded && <p className="eyebrow">从聊天到回忆</p>}
        <h2
          className={embedded ? 'intake-embedded-heading' : 'dashboard-page-heading'}
          ref={heading}
          tabIndex={-1}
        >
          接收 ChatGPT 整理
        </h2>
        <p className="muted">选出值得回忆的问题。</p>
      </header>
      <DraftRecovery draft={durable} disabled={busy} />
      {error && (!packet || receipt) && <Notice tone="error">{error}</Notice>}
      {receipt ? (
        <div className="stack">
          <Notice tone={receipt.questions > 0 ? 'success' : 'info'}>
            {receipt.questions > 0
              ? `已新增 ${receipt.questions} 道回忆题。`
              : '本次没有新增回忆题。'}
            {__VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()
              ? ''
              : receipt.rewardAmount !== null && receipt.rewardAmount > 0
                ? `获得 ${receipt.rewardAmount} 零花钱。`
                : ''}
          </Notice>
          {receipt.warning && <Notice tone="warning">{receipt.warning}</Notice>}
          {unselectedMaterials.length > 0 && (
            <p className="muted">{unselectedMaterials.length} 条无题材料未保存。</p>
          )}
          {viewSaved(receipt.entries)}
          <button className="button secondary" onClick={reset}>
            接收下一份
          </button>
        </div>
      ) : !packet ? (
        <div className="intake-input stack">
          {__VALRECALL_PUBLIC_RELEASE__ ? null : (
            <details className="reading-source-details">
              <summary>如何从手机聊天带到这里</summary>
              <ol className="intake-guide">
                <li>在手机 ChatGPT 里记下想法，或上传截图后核对转录文字。</li>
                <li>回到电脑，请 valrecall-organize 整理指定材料，生成有依据的回忆题。</li>
                <li>把 JSON 粘贴到下方，或选择 JSON 文件；逐题核对后保存。</li>
              </ol>
              <p className="muted small">没装 skill 时，可用 README 里的整理提示。</p>
            </details>
          )}
          <label className="field">
            <span>整理包 JSON</span>
            <textarea
              rows={9}
              value={text}
              disabled={busy}
              placeholder="粘贴 valrecall-intake 整理包，或完整的 JSON 代码块…"
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          </label>
          <div className="cluster">
            <button className="button" disabled={busy || !text.trim()} onClick={() => parse(text)}>
              读取并预览
            </button>
            <label className="button secondary intake-file">
              选择 JSON 文件
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          <p className="muted small">完整备份请到设置 → 备份与恢复导入。</p>
        </div>
      ) : (
        <div className="stack intake-packet" ref={packetArea}>
          <div className="intake-selection-bar" ref={selectionBar}>
            <div className="intake-selection-summary">
              <p className="intake-selection-count">
                已选 <strong>{selectedCount}</strong> / {candidates.length} 道
                <span className="intake-count-noun">回忆题</span>
              </p>
              <p className="muted small intake-selection-hint">{selectionHint}</p>
            </div>
            {candidates.length > 0 && (
              <div className="intake-default-category" ref={defaultCategoryBlock}>
                <label className="intake-default-category-field">
                  <span>统一分类</span>
                  <CategorySelect
                    value={effectiveCategories.defaultCategory}
                    categories={categories}
                    loaded={categoriesLoaded}
                    disabled={categoriesDisabled}
                    aria-describedby={`${ids}-override-note`}
                    onChange={chooseDefaultCategory}
                  />
                </label>
                <p className="muted small intake-override-note" id={`${ids}-override-note`}>
                  {categoryError ? (
                    '分类加载失败，将保存为未分类'
                  ) : overrideCount === 0 ? (
                    '全部题目跟随统一分类'
                  ) : (
                    <>
                      <span>{overrideCount} 道单独设置 ·</span>
                      <button
                        type="button"
                        className="button text-button intake-follow-all"
                        disabled={categoriesDisabled}
                        onClick={followDefaultCategory}
                      >
                        全部跟随统一分类
                      </button>
                    </>
                  )}
                </p>
              </div>
            )}
            {/* While a quick check runs the native button is disabled and lets the
                pointer through to this slot, so a press is remembered, not dropped. */}
            <span
              className="intake-save-slot"
              data-check={quietCheck}
              onClick={(event) => {
                // Only a press that passed through the disabled button lands here.
                if (event.target === event.currentTarget) rememberSave();
              }}
            >
              <button
                className="button primary-action intake-save"
                disabled={!canSave}
                aria-busy={busy || pendingCheck}
                data-check={quietCheck}
                onClick={() => void submit()}
              >
                {saveLabel}
              </button>
            </span>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {checkError && (
            <Notice tone="error">
              {checkError}
              <button
                className="button secondary"
                onClick={() => setCheckAttempt((value) => value + 1)}
              >
                重试核对
              </button>
            </Notice>
          )}
          {candidates.length > 0 && (
            <section
              className={`notice intake-check-summary${invalidCount > 0 || (summaryResult && shownConflicts) ? ' warning' : ''}`}
              aria-label="核对结果"
              aria-live="polite"
              aria-atomic="true"
              aria-busy={pendingCheck}
              data-stale={summaryResult && !fresh ? 'true' : undefined}
            >
              <p className="intake-check-headline">{summaryHeadline}</p>
              <ul className="intake-check-facts">
                <li>
                  新增 <strong>{fact(summaryResult?.questions ?? null)}</strong> 道
                </li>
                <li>
                  重复跳过 <strong>{fact(duplicateCount)}</strong> 道
                </li>
                <li>
                  冲突 <strong>{fact(conflictCount)}</strong> 道
                </li>
                <li>
                  基础奖励{' '}
                  <strong>{fact(summaryResult ? summaryResult.questions * 2 : null, '+')}</strong>
                </li>
              </ul>
              <p className="small intake-check-note">{summaryNote}</p>
            </section>
          )}
          {categoryError && (
            <Notice tone="warning">
              <button
                className="button secondary"
                onClick={() => {
                  focusAfterCategoryRetry.current = true;
                  setCategoryAttempt((value) => value + 1);
                }}
              >
                重试分类
              </button>
            </Notice>
          )}
          {candidates.length === 0 ? (
            <div className="empty-state">
              <h3>这份材料还没有回忆题</h3>
              <p>请回到 ChatGPT 补充问题和答案后再接收。</p>
            </div>
          ) : (
            <div className="intake-workspace" data-pane={pane}>
              <aside className="intake-directory" aria-label="候选回忆题目录">
                <h3>候选回忆题</h3>
                <ol>
                  {candidates.map((candidate, index) => {
                    const included = selectedQuestions.has(candidate.key);
                    const status = intakeQuestionStatus(
                      candidate.question,
                      included,
                      entryIndex.get(candidate.key),
                    );
                    const category = intakeQuestionCategory(effectiveCategories, candidate.key);
                    const own = hasOwnCategory(effectiveCategories, candidate.key);
                    const rowId = `${ids}-row-${index}`;
                    return (
                      <li
                        key={candidate.key}
                        className={candidate.key === current?.key ? 'is-current' : ''}
                        data-category={own ? 'override' : undefined}
                      >
                        <label className="intake-directory-check">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={included}
                            aria-label={`${candidate.question.needsConfirmation ? '已核对依据，接收' : '接收'}第 ${index + 1} 道回忆题`}
                            onChange={(event) => toggle(candidate.key, event.target.checked)}
                          />
                        </label>
                        <button
                          type="button"
                          className="intake-directory-open"
                          disabled={busy}
                          ref={(node) => {
                            if (node) directoryButtons.current.set(candidate.key, node);
                            else directoryButtons.current.delete(candidate.key);
                          }}
                          aria-current={candidate.key === current?.key ? 'true' : undefined}
                          aria-describedby={`${rowId}-status`}
                          onClick={() => openQuestion(candidate.key)}
                        >
                          <span className="intake-directory-number">{index + 1}</span>
                          <span className="intake-directory-copy">
                            <span className="intake-directory-prompt">
                              {candidate.question.prompt.trim() || '待补充的问题'}
                            </span>
                            {!previewing && (
                              <span className="intake-directory-title muted small">
                                {candidate.record.title}
                              </span>
                            )}
                          </span>
                        </button>
                        <div className="intake-directory-meta">
                          <span
                            id={`${rowId}-status`}
                            className={`intake-directory-status small ${status.tone === 'error' ? 'field-error' : 'muted'}`}
                          >
                            {status.label}
                          </span>
                          {own && (
                            <span className="intake-category-flag small" id={`${rowId}-flag`}>
                              单独<span className="sr-only">设置，不跟随统一分类</span>
                            </span>
                          )}
                          <CategorySelect
                            className="intake-row-category"
                            value={category}
                            categories={categories}
                            loaded={categoriesLoaded}
                            disabled={categoriesDisabled}
                            aria-label={`第 ${index + 1} 题分类`}
                            {...(own ? { 'aria-describedby': `${rowId}-flag` } : {})}
                            onChange={(categoryId) =>
                              chooseQuestionCategory(candidate.key, categoryId)
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </aside>
              {current && currentStatus && (
                <article className="intake-detail stack" aria-label="当前回忆题" key={current.key}>
                  <button
                    className="button secondary intake-return"
                    ref={returnButton}
                    disabled={busy}
                    onClick={() => {
                      setPane('directory');
                      focusTarget.current = 'directory';
                    }}
                  >
                    返回题目目录
                  </button>
                  <div className="intake-detail-title">
                    <p className="muted small">
                      第 {currentIndex + 1} / {candidates.length} 题
                      {!previewing && ` · ${current.record.title}`}
                    </p>
                    <h3 ref={detailHeading} tabIndex={-1}>
                      核对这道回忆题
                    </h3>
                  </div>
                  {current.question.needsConfirmation && (
                    // Shown for the question itself, not for its selection, so ticking
                    // it never moves the content or the checkbox under the pointer.
                    <div className="notice warning intake-confirm-note">
                      这题需要核实依据，确认后再勾选。
                    </div>
                  )}
                  <p
                    className={`intake-detail-status ${currentStatus.tone === 'error' ? 'field-error' : 'muted'}`}
                  >
                    {currentStatus.detail}
                  </p>
                  <div className="cluster" role="group" aria-label="题目显示方式">
                    <button
                      className="button secondary"
                      disabled={busy}
                      aria-pressed={!previewing}
                      onClick={() => {
                        setPreviewing(false);
                        setRevealed(false);
                      }}
                    >
                      {previewing ? '返回核对' : '核对内容'}
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      aria-pressed={previewing}
                      onClick={() => {
                        setPreviewing(true);
                        setRevealed(false);
                      }}
                    >
                      模拟复习预览
                    </button>
                  </div>
                  <fieldset className="reading-fields stack" disabled={busy}>
                    {previewing ? (
                      <div className="intake-question-reading stack">
                        <h4>问题</h4>
                        <p className="intake-read-prompt">
                          {current.question.prompt || '尚未填写问题'}
                        </p>
                        {revealed ? (
                          <>
                            <h4>答案要点</h4>
                            <p className="intake-read-answer">
                              {current.question.answer || '尚未填写答案'}
                            </p>
                          </>
                        ) : (
                          <button className="button secondary" onClick={() => setRevealed(true)}>
                            揭晓答案
                          </button>
                        )}
                      </div>
                    ) : editing?.key === current.key ? (
                      <div className="stack">
                        <label className="field">
                          <span>回忆问题</span>
                          <textarea
                            ref={promptInput}
                            rows={3}
                            value={current.question.prompt}
                            onChange={(event) =>
                              updateQuestion(current.record.id, {
                                ...current.question,
                                prompt: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>答案要点</span>
                          <textarea
                            rows={5}
                            value={current.question.answer}
                            onChange={(event) =>
                              updateQuestion(current.record.id, {
                                ...current.question,
                                answer: event.target.value,
                              })
                            }
                          />
                        </label>
                        <div className="cluster">
                          <button
                            className="button secondary"
                            onClick={() => {
                              setEditing(null);
                              focusTarget.current = 'edit-button';
                            }}
                          >
                            完成编辑
                          </button>
                          <button
                            className="button secondary"
                            onClick={() => {
                              if (
                                current.question.prompt !== editing.original.prompt ||
                                current.question.answer !== editing.original.answer
                              ) {
                                if (!window.confirm('放弃这次修改？')) return;
                                updateQuestion(current.record.id, editing.original);
                              }
                              setEditing(null);
                              focusTarget.current = 'edit-button';
                            }}
                          >
                            放弃修改
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="intake-question-reading stack">
                        <section>
                          <h4>回忆问题</h4>
                          <p className="intake-read-prompt">
                            {current.question.prompt || '尚未填写问题'}
                          </p>
                        </section>
                        <section>
                          <h4>答案要点</h4>
                          <p className="intake-read-answer">
                            {current.question.answer || '尚未填写答案'}
                          </p>
                        </section>
                        <button
                          className="button secondary"
                          ref={editButton}
                          onClick={() => {
                            setEditing({ key: current.key, original: { ...current.question } });
                            focusTarget.current = 'editor';
                          }}
                        >
                          编辑问题与答案
                        </button>
                      </div>
                    )}
                    <label className="intake-check">
                      <input
                        type="checkbox"
                        checked={currentIncluded}
                        onChange={(event) => toggle(current.key, event.target.checked)}
                      />
                      <span>
                        {current.question.needsConfirmation
                          ? '已核对依据，接收这道题'
                          : '接收这道回忆题'}
                      </span>
                    </label>
                    {!previewing && (
                      <div className="field intake-category">
                        <label htmlFor={`${ids}-detail-category`}>这道题的分类</label>
                        <CategorySelect
                          id={`${ids}-detail-category`}
                          value={currentCategory}
                          categories={categories}
                          loaded={categoriesLoaded}
                          disabled={categoriesDisabled}
                          aria-describedby={`${ids}-detail-category-note`}
                          onChange={(categoryId) => chooseQuestionCategory(current.key, categoryId)}
                        />
                        <p
                          className="muted small intake-category-note"
                          id={`${ids}-detail-category-note`}
                        >
                          {currentOwn ? (
                            <>
                              <span>单独设置 ·</span>
                              <button
                                type="button"
                                className="button text-button"
                                disabled={categoriesDisabled}
                                onClick={() => followQuestionCategory(current.key)}
                              >
                                改为跟随统一分类
                              </button>
                            </>
                          ) : (
                            '跟随统一分类'
                          )}
                        </p>
                      </div>
                    )}
                  </fieldset>
                  {(!previewing || revealed) && (
                    <details className="reading-source-details">
                      <summary>来源材料 · 原文、感想与 AI 整理</summary>
                      <NoteContentView content={current.record} />
                    </details>
                  )}
                </article>
              )}
            </div>
          )}
          {existing.length > 0 && (
            <details className="reading-source-details intake-existing">
              <summary>{existing.length} 道已在资料库 · 查看</summary>
              <ul className="intake-receipt-list">
                {existing.map((row) => (
                  <li key={row.targetId}>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => onViewItem(row.targetId)}
                    >
                      查看回忆题：{row.prompt}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!previewing && unselectedMaterials.length > 0 && (
            <details className="reading-source-details intake-unsaved-materials">
              <summary>{unselectedMaterials.length} 条无题材料 · 未保存</summary>
              {unselectedMaterials.map((record) => (
                <section key={record.id}>
                  <h3>{record.title}</h3>
                  <NoteContentView content={record} />
                </section>
              ))}
            </details>
          )}
          <div className="cluster intake-package-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPacket(null);
                setChecked(null);
                setError(null);
                setEditing(null);
                setText(JSON.stringify(packet, null, 2));
                focusInPlace(heading.current);
              }}
            >
              返回 JSON
            </button>
            <button className="button secondary" disabled={busy} onClick={reset}>
              放弃本次
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

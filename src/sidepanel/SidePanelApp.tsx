import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import {
  getLearningReceipt,
  learningFingerprint,
  type CaptureRewardSummary,
  type LearningCommit,
} from '../database/learning-commits';
import { isCaptureDraft } from '../models/messages';
import { platformLabel } from '../shared/source-labels';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from 'ts-fsrs';

import {
  DatabaseError,
  ValRecallRepository,
  isVideoLearningItem,
  type MomentCategory,
  type NewVideoLearningItem,
} from '../database';
import { FsrsService } from '../fsrs';
import {
  RuleBasedLearningItemGenerator,
  type LearningItemGenerationInput,
  type LearningItemGenerationResult,
} from '../generators';
import type {
  CaptureDraft,
  LearningItemDraftFields,
  LearningItemType,
} from '../models/learning-item';
import { learningGoalLabel, validateLearningItemDraft } from '../models/learning-item';
import {
  isCapturePageResponse,
  isValRecallMessage,
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type CapturePageResponse,
} from '../models/messages';
import { Diagnostics, Header, Notice, SourceContextDisclosure } from '../shared/components';
import { CategoryPicker } from '../shared/CategoryPicker';
import { openValRecallDashboard } from '../shared/dashboard';
import {
  dataUrlToBlob,
  displayError,
  hasExtensionRuntime,
  openSourceAtTimestamp,
  refreshReviewReminders,
} from '../shared/extension';
import { loadPreferences, type ValRecallPreferences } from '../shared/preferences';
import {
  buildScheduledLearningItemInput,
  keyTakeawayValidationMessage,
  LEARNING_GOALS,
  recallPromptValidationMessage,
  scheduleAutomaticPreview,
  summariseSubtitleSource,
} from './editor';
import { recordSuccessfulCapture } from '../shared/allowance';
import {
  CompanionHero,
  resolveCompanionHeroState,
  useTemporaryCompanionSuccess,
} from './CompanionHero';
import { ReadingCapture } from '../reading/ReadingCapture';
import type { saveReading } from '../reading/save-reading';
import { stickyBarClearance } from '../ui/sticky-bar-clearance';
import './capture-workspace.css';
import {
  captureStatusText,
  lastReadCaptureShortcut,
  useCaptureShortcut,
} from '../edition/shortcut';
import { captureErrorText } from '../edition/capture-errors';
import { requestCaptureRetry } from '../edition/capture-retry';

const repository = new ValRecallRepository();
const fsrsService = new FsrsService();
const generator = new RuleBasedLearningItemGenerator();
const generateRuleBasedLearningItem = (input: LearningItemGenerationInput) =>
  generator.generate(input);
const loadRepositoryDueCount = () => repository.countDueReviewItems(new Date());
const verifyStoredCapture = async (draft: CaptureDraft) => {
  const item = await repository.getItem(draft.draftId);
  return (
    item != null &&
    isVideoLearningItem(item) &&
    item.sourceUrl === draft.sourceUrl &&
    item.timestampSeconds === draft.timestampSeconds
  );
};
const persistRepositoryItem = (
  item: NewVideoLearningItem,
  screenshot: Blob,
  commit?: LearningCommit,
) => repository.createItem(item, screenshot, commit);
const loadRepositoryCategories = () => repository.listCategories();
const createRepositoryCategory = (name: string) => repository.createCategory(name);
const createInitialFsrsCard = () => fsrsService.createInitialCard();
const dismissPendingCapture = async (draftId?: string) => {
  const response: unknown = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.dismissCapture,
    version: MESSAGE_PROTOCOL_VERSION,
    payload: { draftId },
  });
  if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true)
    throw new Error('捕获清理失败。');
};

/** The background's answer when no capture is waiting. For this panel that is simply idle. */
const NOTHING_PENDING_MESSAGE = '还没有待整理的捕获，请再按一次快捷键。';

/** Read out by screen readers only: the question changing in front of you says the same. */
const PROMPT_REGENERATED = '回忆提示已重新生成。';

const EMPTY_FIELDS: LearningItemDraftFields = {
  situation: '',
  coreLesson: '',
  mistakeToAvoid: '',
  recommendedAction: '',
  reason: '',
  recallPrompt: '',
  referenceAnswer: '',
  tags: [],
};

type PendingState = CapturePageResponse | null;

interface SavedCaptureReceipt {
  itemId: string;
  platform: CaptureDraft['platform'];
  timestampDisplay: string;
  videoTitle: string;
}

export interface SidePanelAppProps {
  initialPending?: PendingState;
  initialLoadingCapture?: boolean;
  loadDueCount?: () => Promise<number>;
  successDurationMs?: number;
  persistItem?: (
    item: NewVideoLearningItem,
    screenshot: Blob,
    commit?: LearningCommit,
  ) => Promise<unknown>;
  verifySavedCapture?: (draft: CaptureDraft) => Promise<boolean>;
  loadCategories?: () => Promise<MomentCategory[]>;
  createCategory?: (name: string) => Promise<MomentCategory>;
  createInitialCard?: () => Card;
  convertScreenshot?: (dataUrl: string) => Promise<Blob>;
  dismissCapture?: (draftId?: string) => Promise<void>;
  generateLearningItem?: (
    input: LearningItemGenerationInput,
  ) => Promise<LearningItemGenerationResult>;
  recordCaptureAllowance?: () => Promise<CaptureRewardSummary | null>;
  saveReadingCapture?: typeof saveReading;
}

export function SidePanelApp({
  initialPending = null,
  initialLoadingCapture,
  loadDueCount = loadRepositoryDueCount,
  successDurationMs = 2400,
  persistItem = persistRepositoryItem,
  verifySavedCapture = verifyStoredCapture,
  loadCategories = loadRepositoryCategories,
  createCategory = createRepositoryCategory,
  createInitialCard = createInitialFsrsCard,
  convertScreenshot = dataUrlToBlob,
  dismissCapture = dismissPendingCapture,
  generateLearningItem = generateRuleBasedLearningItem,
  recordCaptureAllowance = () => recordSuccessfulCapture(),
  saveReadingCapture,
}: SidePanelAppProps = {}) {
  const [captureMode, setCaptureMode] = useState<'video' | 'reading'>('video');
  const [capturePane, setCapturePane] = useState<'source' | 'write'>('write');
  const [questionMode, setQuestionMode] = useState<'edit' | 'preview'>('edit');
  const [answerRevealed, setAnswerRevealed] = useState(false);
  const [openingSource, setOpeningSource] = useState(false);
  const sourceRequest = useRef(0);
  const sourceInFlight = useRef(false);
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const sourceTitleInput = useRef<HTMLInputElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const answerInput = useRef<HTMLTextAreaElement>(null);
  const fieldToFocus = useRef<'title' | 'question' | 'answer' | null>(null);
  const [readingVisited, setReadingVisited] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState(() => ({
    pending: initialPending as PendingState,
    editId: crypto.randomUUID() as string,
  }));
  const pending = captureState.pending;
  const captureStateRef = useRef(captureState);
  captureStateRef.current = captureState;
  const beforeCaptureChange = useRef<() => Promise<unknown>>(() => Promise.resolve());
  const captureChange = useRef(0);
  function setPending(next: PendingState) {
    const request = ++captureChange.current;
    const previous = captureStateRef.current;
    const replace = () => {
      if (request !== captureChange.current) return;
      setCaptureState((current) => ({
        pending: next,
        editId:
          next?.ok && (!current.pending?.ok || current.pending.draft.draftId !== next.draft.draftId)
            ? crypto.randomUUID()
            : current.editId,
      }));
    };
    if (previous.pending?.ok && next?.ok && previous.pending.draft.draftId !== next.draft.draftId) {
      void beforeCaptureChange
        .current()
        .then(replace)
        .catch(() =>
          setMessage({
            text: '存草稿失败，仍停在当前题。新捕获可稍后打开。',
            tone: 'error',
          }),
        );
    } else replace();
  }
  const [preferences, setPreferences] = useState<ValRecallPreferences | null>(null);
  const [itemType, setItemType] = useState<LearningItemType>('Understand');
  const [editorDraftId, setEditorDraftId] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [coreLesson, setCoreLesson] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categories, setCategories] = useState<MomentCategory[]>([]);
  const [categoryLoadError, setCategoryLoadError] = useState<string | null>(null);
  const [, setFields] = useState<LearningItemDraftFields>(EMPTY_FIELDS);
  const [recallPrompt, setRecallPrompt] = useState('');
  const [regeneratingPrompt, setRegeneratingPrompt] = useState(false);
  const [promptStatus, setPromptStatus] = useState<string | null>(null);
  const [previewWarning, setPreviewWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingCapture, setLoadingCapture] = useState(
    () => initialLoadingCapture ?? (initialPending === null && hasExtensionRuntime()),
  );
  const [dueCount, setDueCount] = useState(0);
  const [savedReceipt, setSavedReceipt] = useState<SavedCaptureReceipt | null>(null);
  const [captureAllowance, setCaptureAllowance] = useState<CaptureRewardSummary | null>(null);
  const [temporarySuccess, triggerTemporarySuccess] =
    useTemporaryCompanionSuccess(successDurationMs);
  const [message, setMessage] = useState<{
    text: string;
    tone: 'error' | 'success' | 'warning';
  } | null>(null);
  const initialisedDraftIdRef = useRef<string | null>(null);
  const recallPromptEditedRef = useRef(false);
  const promptEditRevisionRef = useRef(0);
  const automaticGenerationRequestRef = useRef(0);
  const promptRegenerationRequestRef = useRef(0);
  const latestGenerationInputRef = useRef<LearningItemGenerationInput | null>(null);
  const captureRevisionRef = useRef(0);
  const saveInFlight = useRef(false);
  const mounted = useRef(true);
  // Only to re-render: companionStatus reads the key this stores.
  if (__VALRECALL_PUBLIC_RELEASE__) useCaptureShortcut();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      captureRevisionRef.current += 1;
      promptRegenerationRequestRef.current += 1;
    };
  }, []);

  const draft = pending?.ok ? pending.draft : null;
  const draftPayload = useMemo(
    () => ({
      id: captureState.editId,
      capture: draft ? JSON.stringify(draft) : null,
      videoTitle,
      coreLesson,
      recallPrompt,
      itemType,
      categoryId,
    }),
    [captureState.editId, draft, videoTitle, coreLesson, recallPrompt, itemType, categoryId],
  );
  const durable = useDurableDraft({
    id: captureState.editId,
    scope: 'capture',
    summary: videoTitle,
    payload: draftPayload,
    dirty: Boolean(draft && editorDraftId === draft.draftId && !savedReceipt),
    onRestore: (value, row) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        value.id !== row.id ||
        typeof value.capture !== 'string' ||
        !['videoTitle', 'coreLesson', 'recallPrompt'].every(
          (key) => typeof value[key] === 'string',
        ) ||
        !['Avoid', 'Do', 'Notice', 'Understand'].includes(String(value.itemType)) ||
        !(value.categoryId === null || typeof value.categoryId === 'string')
      )
        throw new Error('捕获编辑草稿无效。');
      const restored: unknown = JSON.parse(value.capture);
      if (!isCaptureDraft(restored)) throw new Error('捕获来源记录无效。');
      initialisedDraftIdRef.current = restored.draftId;
      recallPromptEditedRef.current = true;
      captureChange.current++;
      captureRevisionRef.current++;
      sourceRequest.current++;
      sourceInFlight.current = false;
      setOpeningSource(false);
      setCaptureState({ pending: { ok: true, draft: restored }, editId: row.id });
      setEditorDraftId(restored.draftId);
      setVideoTitle(value.videoTitle as string);
      setCoreLesson(value.coreLesson as string);
      setRecallPrompt(value.recallPrompt as string);
      setItemType(value.itemType as LearningItemType);
      setCategoryId(value.categoryId);
      setSavedReceipt(null);
      setMessage(null);
      setCaptureMode('video');
      setCapturePane('write');
      setQuestionMode('edit');
    },
  });
  beforeCaptureChange.current = () => durable.flush();

  useEffect(() => {
    let active = true;
    void loadDueCount()
      .then((count) => {
        if (active) setDueCount(normalizeDueCount(count));
      })
      .catch(() => {
        // Due status is optional decoration; capture remains fully usable if the read fails.
      });
    return () => {
      active = false;
    };
  }, [loadDueCount]);

  useEffect(() => {
    let active = true;
    void loadCategories()
      .then((loaded) => {
        if (!active) return;
        setCategories(loaded);
        setCategoryLoadError(null);
      })
      .catch(() => {
        if (active) setCategoryLoadError('分类加载失败，将保存为未分类。');
      });
    return () => {
      active = false;
    };
  }, [loadCategories]);

  useEffect(() => {
    let active = true;
    async function initialise() {
      const request = initializationRevision;
      const loadedPreferences = await loadPreferences();
      if (!active) return;
      setPreferences(loadedPreferences);
      setItemType(loadedPreferences.defaultItemType);
      if (!hasExtensionRuntime()) {
        setLoadingCapture(false);
        setMessage({
          text: '把构建后的 dist 文件夹加载到 Edge 后，捕获消息才可用。',
          tone: 'warning',
        });
        return;
      }
      const response: unknown = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.getPendingCapture,
        version: MESSAGE_PROTOCOL_VERSION,
      });
      if (!isCapturePageResponse(response)) throw new Error('捕获数据无效，请重新捕获。');
      if (active && request === captureRevisionRef.current) {
        setPending(
          !response.ok && response.error.message === NOTHING_PENDING_MESSAGE ? null : response,
        );
        setLoadingCapture(false);
      }
    }

    const initializationRevision = captureRevisionRef.current;

    const listener = (incoming: unknown) => {
      if (!isValRecallMessage(incoming) || incoming.type !== MESSAGE_TYPES.pendingCaptureChanged)
        return;
      captureRevisionRef.current += 1;
      automaticGenerationRequestRef.current += 1;
      promptRegenerationRequestRef.current += 1;
      setPending(incoming.payload);
      setLoadingCapture(false);
    };

    void initialise().catch((error) => {
      if (active && captureRevisionRef.current === initializationRevision) {
        setLoadingCapture(false);
        setMessage({
          text: displayError(error, '无法加载等待中的捕获。'),
          tone: 'error',
        });
      }
    });
    if (hasExtensionRuntime()) chrome.runtime.onMessage.addListener(listener);
    return () => {
      active = false;
      if (hasExtensionRuntime()) chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (!draft) {
      initialisedDraftIdRef.current = null;
      setEditorDraftId(null);
      return;
    }
    if (!preferences) return;
    if (initialisedDraftIdRef.current === draft.draftId) return;
    initialisedDraftIdRef.current = draft.draftId;
    automaticGenerationRequestRef.current += 1;
    promptRegenerationRequestRef.current += 1;
    promptEditRevisionRef.current += 1;
    recallPromptEditedRef.current = false;
    setSavedReceipt(null);
    setCaptureAllowance(null);
    setCapturePane('write');
    setQuestionMode('edit');
    setAnswerRevealed(false);
    sourceRequest.current++;
    sourceInFlight.current = false;
    setOpeningSource(false);
    setEditorDraftId(draft.draftId);
    setVideoTitle(draft.videoTitle ?? '');
    setCoreLesson('');
    setCategoryId(null);
    setItemType(preferences.defaultItemType);
    setFields(EMPTY_FIELDS);
    setRecallPrompt('');
    setPromptStatus(null);
    // What the last capture ended on says nothing about this one.
    setMessage(null);
  }, [draft, preferences]);

  useEffect(
    () => setAnswerRevealed(false),
    [draft?.draftId, questionMode, recallPrompt, coreLesson],
  );

  useEffect(() => {
    if (!fieldToFocus.current) return;
    const control =
      fieldToFocus.current === 'title'
        ? sourceTitleInput.current
        : fieldToFocus.current === 'question'
          ? questionInput.current
          : answerInput.current;
    if (fieldToFocus.current === 'title') {
      const disclosure = sourceTitleInput.current?.closest('details');
      if (disclosure) disclosure.open = true;
    }
    control?.focus();
    fieldToFocus.current = null;
  });

  function showInvalidField(field: 'title' | 'question' | 'answer') {
    fieldToFocus.current = field;
    setCapturePane(field === 'title' ? 'source' : 'write');
    if (field === 'title') setSourceExpanded(true);
    else setQuestionMode('edit');
  }

  const subtitleStatus = useMemo(() => {
    if (!draft) return { label: '', tone: 'warning' as const, reliable: false };
    return summariseSubtitleSource(draft);
  }, [draft]);

  const generationInput = useMemo<LearningItemGenerationInput | null>(() => {
    if (!draft || editorDraftId !== draft.draftId) return null;
    return {
      platform: draft.platform,
      itemType,
      coreLesson,
      subtitleReliable: subtitleStatus.reliable,
      subtitleBefore: draft.subtitleBefore,
      subtitleCurrent: draft.subtitleCurrent,
      subtitleAfter: draft.subtitleAfter,
      videoTitle: videoTitle || draft.videoTitle,
      chapterTitle: draft.chapterTitle,
    };
  }, [coreLesson, draft, editorDraftId, itemType, subtitleStatus.reliable, videoTitle]);
  latestGenerationInputRef.current = generationInput;

  useEffect(() => {
    if (!generationInput) {
      automaticGenerationRequestRef.current += 1;
      setFields(EMPTY_FIELDS);
      setRecallPrompt('');
      recallPromptEditedRef.current = false;
      promptEditRevisionRef.current += 1;
      setPromptStatus(null);
      setPreviewWarning(null);
      return;
    }
    let active = true;
    const requestId = ++automaticGenerationRequestRef.current;
    const editRevisionAtStart = promptEditRevisionRef.current;
    const cancel = scheduleAutomaticPreview(async () => {
      try {
        const result = await generateLearningItem(generationInput);
        if (!active || requestId !== automaticGenerationRequestRef.current) return;
        setFields(result.fields);
        setPreviewWarning(result.warnings[0] ?? null);
        if (
          !recallPromptEditedRef.current &&
          editRevisionAtStart === promptEditRevisionRef.current
        ) {
          setRecallPrompt(result.fields.recallPrompt);
        }
      } catch (error) {
        if (active && requestId === automaticGenerationRequestRef.current) {
          setPreviewWarning(displayError(error, '复习预览无法生成。'));
        }
      }
    });
    return () => {
      active = false;
      cancel();
    };
  }, [generateLearningItem, generationInput]);

  function updateRecallPrompt(value: string) {
    promptEditRevisionRef.current += 1;
    recallPromptEditedRef.current = true;
    setRecallPrompt(value);
    setPromptStatus(null);
  }

  async function regenerateRecallPrompt() {
    if (!generationInput || regeneratingPrompt) return;
    const requestId = ++promptRegenerationRequestRef.current;
    const editRevisionAtStart = promptEditRevisionRef.current;
    const inputAtStart = generationInput;
    setRegeneratingPrompt(true);
    setPromptStatus(null);
    try {
      const result = await generateLearningItem(inputAtStart);
      if (requestId !== promptRegenerationRequestRef.current) return;
      if (inputAtStart !== latestGenerationInputRef.current) {
        setPromptStatus('捕获已更新，问题未替换。');
        return;
      }
      if (editRevisionAtStart !== promptEditRevisionRef.current) {
        setPromptStatus('你改过问题，未替换。');
        return;
      }
      setFields(result.fields);
      setPreviewWarning(result.warnings[0] ?? null);
      recallPromptEditedRef.current = false;
      setRecallPrompt(result.fields.recallPrompt);
      setPromptStatus(PROMPT_REGENERATED);
    } catch (error) {
      if (requestId === promptRegenerationRequestRef.current) {
        setPromptStatus(displayError(error, '回忆提示无法重新生成。'));
      }
    } finally {
      if (requestId === promptRegenerationRequestRef.current) setRegeneratingPrompt(false);
    }
  }

  async function saveItem() {
    if (!draft || saveInFlight.current) return;

    const keyTakeawayIssue = keyTakeawayValidationMessage(coreLesson);
    if (keyTakeawayIssue) {
      showInvalidField('answer');
      setMessage({ text: keyTakeawayIssue, tone: 'error' });
      return;
    }
    if (!videoTitle.trim()) {
      showInvalidField('title');
      setMessage({ text: '保存前请填写视频标题。', tone: 'error' });
      return;
    }
    if (!draft.screenshotDataUrl) {
      setMessage({
        text: '需要截图。请回到视频再捕获一次。',
        tone: 'error',
      });
      return;
    }
    const recallPromptIssue = recallPromptValidationMessage(recallPrompt);
    if (recallPromptIssue) {
      showInvalidField('question');
      setMessage({ text: recallPromptIssue, tone: 'error' });
      return;
    }
    if (!generationInput) return;

    const finalRecallPrompt = recallPrompt;
    const revision = captureRevisionRef.current;
    const isCurrent = () => mounted.current && revision === captureRevisionRef.current;
    saveInFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // Pin this editor's token before generation or image work can yield to a new capture.
      const token = await durable.flush();
      const generated = await generateLearningItem(generationInput);
      const nextFields = {
        ...generated.fields,
        recallPrompt: finalRecallPrompt,
        // Keep the persisted compatibility field valid for older readers without
        // asking the user to author a second answer. Key takeaway is canonical.
        referenceAnswer: coreLesson.trim(),
      };
      if (isCurrent()) {
        setFields(generated.fields);
        setPreviewWarning(generated.warnings[0] ?? null);
      }
      const validation = validateLearningItemDraft({
        ...nextFields,
        itemType,
        sourceUrl: draft.sourceUrl,
        timestampSeconds: draft.timestampSeconds,
      });
      if (!validation.valid) {
        if (isCurrent())
          setMessage({
            text: validation.issues.map((issue) => issue.message).join(' '),
            tone: 'error',
          });
        return;
      }

      const screenshot = await convertScreenshot(draft.screenshotDataUrl);
      let created = true;
      try {
        const input = buildScheduledLearningItemInput({
          draft,
          videoTitle,
          itemType,
          coreLesson,
          categoryId,
          fields: nextFields,
          fsrsCard: createInitialCard(),
        });
        let commit: LearningCommit | undefined;
        if (persistItem === persistRepositoryItem) {
          const { fsrsCard: _card, ...content } = input;
          void _card;
          commit = {
            id: draft.draftId,
            kind: 'capture',
            captureId: draft.draftId,
            fingerprint: await learningFingerprint(content, screenshot),
            ...(token ? { draft: token } : {}),
          };
        }
        if (commit) await persistItem(input, screenshot, commit);
        else await persistItem(input, screenshot);
        durable.markCommitted(token?.id ?? captureState.editId);
      } catch (error) {
        if (persistItem === persistRepositoryItem) throw error;
        if (!(error instanceof DatabaseError) || error.code !== 'CONFLICT') throw error;
        if (!(await verifySavedCapture(draft)))
          throw new DatabaseError('CONFLICT', '无法确认是否已保存，请先到资料库查看。', error);
        created = false;
      }
      void refreshReviewReminders().then((result) => {
        if (!result.ok) {
          console.warn('[ValRecall] Review reminder refresh failed.', result.error);
        }
      });
      setDueCount((count) => Math.max(1, count));
      let allowance: CaptureRewardSummary | null = null;
      let savedItemId = draft.draftId;
      let rewardFailed = false;
      if (persistItem === persistRepositoryItem) {
        const receipt = await getLearningReceipt(repository, draft.draftId);
        if (!receipt) throw new Error('无法确认是否已保存，请重试。');
        allowance = receipt.capture;
        savedItemId = receipt.itemId;
      } else if (created) {
        try {
          allowance = await recordCaptureAllowance();
        } catch {
          rewardFailed = true;
        }
      }
      if (!isCurrent()) return;
      setSavedReceipt({
        itemId: savedItemId,
        platform: draft.platform,
        timestampDisplay: draft.timestampDisplay,
        videoTitle: videoTitle.trim(),
      });
      setPending(null);
      setCaptureAllowance(allowance);
      triggerTemporarySuccess();
      setMessage(
        !created
          ? { text: '这次捕获已保存过。', tone: 'success' }
          : rewardFailed
            ? { text: '已保存，但零花钱未能确认，请查看账本。', tone: 'warning' }
            : null,
      );
      // Cleanup is also conditional inside the repository transaction.
      if (isCurrent())
        await dismissCapture(draft?.draftId).catch((error: unknown) =>
          console.warn('[ValRecall] Saved capture cleanup failed.', error),
        );
    } catch (error) {
      if (isCurrent()) {
        setMessage({
          text: '保存失败：' + displayError(error, '请重试。'),
          tone: 'error',
        });
      }
    } finally {
      saveInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function openSource() {
    if (!draft || sourceInFlight.current) return;
    const request = ++sourceRequest.current;
    const revision = captureRevisionRef.current;
    const current = () =>
      mounted.current &&
      request === sourceRequest.current &&
      revision === captureRevisionRef.current;
    sourceInFlight.current = true;
    setOpeningSource(true);
    try {
      const result = await openSourceAtTimestamp({
        platform: draft.platform,
        sourceUrl: draft.sourceUrl,
        canonicalUrl: draft.canonicalUrl,
        timestampSeconds: draft.timestampSeconds,
        pauseAfterSeek: preferences?.pauseAfterReopen ?? true,
      });
      if (current())
        setMessage({
          text: result.ok
            ? `已打开来源，定位到 ${draft.timestampDisplay}。`
            : `已打开页面，请手动跳到 ${draft.timestampDisplay}。`,
          tone: result.ok ? 'success' : 'warning',
        });
    } catch (error) {
      if (current())
        setMessage({ text: displayError(error, '来源无法打开，请重试。'), tone: 'error' });
    } finally {
      if (mounted.current && request === sourceRequest.current) {
        sourceInFlight.current = false;
        setOpeningSource(false);
      }
    }
  }

  /** The auto-filled question and the captured defaults are not the user's work. */
  function captureHasEdits(): boolean {
    if (!draft || editorDraftId !== draft.draftId) return false;
    return (
      videoTitle !== (draft.videoTitle ?? '') ||
      coreLesson !== '' ||
      recallPromptEditedRef.current ||
      categoryId !== null ||
      itemType !== preferences?.defaultItemType
    );
  }

  async function cancelCapture() {
    if (saveInFlight.current || (captureHasEdits() && !window.confirm('放弃这次捕获？'))) return;
    saveInFlight.current = true;
    setBusy(true);
    const revision = captureRevisionRef.current;
    let cleanupFailed = false;
    try {
      await dismissCapture(draft?.draftId);
      if (revision === captureRevisionRef.current && mounted.current)
        await durable.discardCurrent();
    } catch {
      cleanupFailed = true;
    }
    saveInFlight.current = false;
    setBusy(false);
    if (revision !== captureRevisionRef.current || !mounted.current) return;
    if (cleanupFailed) {
      setMessage({ text: '放弃失败，请重试。', tone: 'error' });
      return;
    }
    setSavedReceipt(null);
    setCaptureAllowance(null);
    setPending(null);
    setMessage({
      text: '已放弃这次捕获。',
      tone: 'warning',
    });
  }

  function openDashboard(target?: { view: 'library'; itemId?: string }) {
    setDashboardError(null);
    void openValRecallDashboard(target).then((result) => {
      if (!result.ok) {
        setDashboardError(result.error);
        setMessage({ text: result.error, tone: 'error' });
      }
    });
  }

  return (
    <main className="app-shell capture-workspace-shell" data-has-capture={Boolean(draft)}>
      <Header />
      <div className="panel-wrap stack">
        <nav className="capture-mode-nav" aria-label="记录方式">
          <button
            type="button"
            className="button secondary"
            aria-pressed={captureMode === 'video'}
            onClick={() => setCaptureMode('video')}
          >
            视频捕获{captureMode === 'reading' && draft ? ' · 待整理' : ''}
          </button>
          <button
            type="button"
            className="button secondary"
            aria-pressed={captureMode === 'reading'}
            onClick={() => {
              setReadingVisited(true);
              setCaptureMode('reading');
            }}
          >
            阅读摘录
          </button>
        </nav>
        {readingVisited && (
          <div className="reading-window" hidden={captureMode !== 'reading'}>
            {draft && (
              <p className="sr-only" role="status">
                有一条视频捕获待整理。
              </p>
            )}
            <ReadingCapture
              active={captureMode === 'reading'}
              {...(preferences ? { preferences } : {})}
              loadCategories={loadCategories}
              {...(saveReadingCapture ? { save: saveReadingCapture } : {})}
              onSaved={() => {
                void loadDueCount()
                  .then((count) => setDueCount(normalizeDueCount(count)))
                  .catch(() => undefined);
              }}
            />
            {dashboardError && <Notice tone="error">{dashboardError}</Notice>}
            <DashboardButton onClick={openDashboard} />
          </div>
        )}
        <div className="reading-window stack" hidden={captureMode !== 'video'}>
          <CompanionHero
            state={resolveCompanionHeroState({
              processing: busy || loadingCapture,
              reviewing: Boolean(draft),
              temporarySuccess: temporarySuccess && Boolean(savedReceipt),
              dueCount,
            })}
            status={companionStatus({
              busy,
              loadingCapture,
              draft,
              pending,
              saved: Boolean(savedReceipt),
              praise: captureAllowance?.praise ?? null,
            })}
            detail={
              !busy && !loadingCapture && !pending && !savedReceipt && dueCount > 0
                ? `今天有 ${dueCount} 条复习可以开始。`
                : null
            }
            working={busy || loadingCapture}
          />
          {message && !draft && (
            <div className="motion-state-change" key={`${message.tone}-${message.text}`}>
              <Notice tone={message.tone}>{message.text}</Notice>
            </div>
          )}

          {savedReceipt && (
            <section
              className="card capture-save-receipt motion-confirm"
              aria-labelledby="capture-save-receipt-title"
              aria-live="polite"
            >
              <h2 className="sr-only" id="capture-save-receipt-title">
                捕获已保存
              </h2>
              <p>
                <strong>{savedReceipt.videoTitle}</strong>
                <br />
                <span className="muted small">
                  {platformLabel(savedReceipt.platform)} · {savedReceipt.timestampDisplay}
                </span>
              </p>
              {captureAllowance && (
                <p className="capture-reward-confirmation">
                  零花钱 +{captureAllowance.captureReward + captureAllowance.checkInReward} 元
                </p>
              )}
              <div className="cluster capture-result-actions">
                <button
                  className="button primary-action"
                  onClick={() => {
                    setSavedReceipt(null);
                    setCaptureAllowance(null);
                    setMessage(null);
                  }}
                >
                  继续捕获
                </button>
                <button
                  className="button secondary"
                  onClick={() => openDashboard({ view: 'library', itemId: savedReceipt.itemId })}
                >
                  在资料库查看
                </button>
              </div>
            </section>
          )}

          {!pending && !savedReceipt && <DashboardButton onClick={openDashboard} />}

          {pending &&
            !pending.ok &&
            (__VALRECALL_PUBLIC_RELEASE__ ? (
              <section className="card stack motion-state-change">
                <h2>{pending.error.code === 'UNSUPPORTED_PAGE' ? '不支持的页面' : '捕获失败'}</h2>
                <Notice tone="error">{captureErrorText(pending.error.code)}</Notice>
                <div className="cluster capture-result-actions">
                  <button
                    type="button"
                    className="button primary-action"
                    disabled={loadingCapture}
                    onClick={() => {
                      setMessage(null);
                      setLoadingCapture(true);
                      void requestCaptureRetry().then((finished) => {
                        setLoadingCapture(false);
                        if (!finished) {
                          setMessage({
                            text: '重试没有成功。请回到视频页，按捕获快捷键。',
                            tone: 'error',
                          });
                        }
                      });
                    }}
                  >
                    {loadingCapture ? '正在重试…' : '重试'}
                  </button>
                </div>
              </section>
            ) : (
              <section className="card motion-state-change">
                <h2>{pending.error.code === 'UNSUPPORTED_PAGE' ? '不支持的页面' : '捕获失败'}</h2>
                <Notice tone="error">{pending.error.message}</Notice>
              </section>
            ))}

          <DraftRecovery
            draft={{
              ...durable,
              available:
                draft && capturePane === 'write' && questionMode === 'preview'
                  ? []
                  : durable.available.filter(
                      (row) => row.id !== 'capture-source:' + draft?.draftId,
                    ),
            }}
            disabled={busy}
          />
          {draft && (
            <>
              {!draft.screenshotDataUrl && (
                <Notice tone="error">截图失败。请重新捕获这一刻后再保存。</Notice>
              )}
              {draft.screenshotDataUrl && (
                <figure className="capture-cue">
                  <img
                    className="screenshot capture-screenshot motion-reveal"
                    src={draft.screenshotDataUrl}
                    alt="捕获到的可见视频画面"
                  />
                  <figcaption className="muted small">
                    {platformLabel(draft.platform)} · {draft.timestampDisplay}
                  </figcaption>
                </figure>
              )}
              <nav className="capture-pane-nav" aria-label="捕获工作区">
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={capturePane === 'write'}
                  aria-controls="capture-write-pane"
                  onClick={() => setCapturePane('write')}
                >
                  写题
                </button>
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={capturePane === 'source'}
                  aria-controls="capture-source-pane"
                  onClick={() => setCapturePane('source')}
                >
                  来源
                </button>
              </nav>
              <div id="capture-source-pane" hidden={capturePane !== 'source'} className="stack">
                <SourceContextDisclosure
                  before={draft.subtitleBefore}
                  current={draft.subtitleCurrent}
                  after={draft.subtitleAfter}
                  summary={`捕获自 ${platformLabel(draft.platform)} · ${draft.timestampDisplay}`}
                  open={sourceExpanded}
                >
                  <label className="field">
                    <span>视频标题</span>
                    <input
                      ref={sourceTitleInput}
                      value={videoTitle}
                      disabled={busy}
                      onChange={(event) => setVideoTitle(event.target.value)}
                    />
                  </label>
                  {(draft.uploader || draft.chapterTitle) && (
                    <dl className="metadata">
                      {draft.uploader && (
                        <>
                          <dt>创作者</dt>
                          <dd>{draft.uploader}</dd>
                        </>
                      )}
                      {draft.chapterTitle && (
                        <>
                          <dt>章节</dt>
                          <dd>{draft.chapterTitle}</dd>
                        </>
                      )}
                    </dl>
                  )}
                  <button
                    className="button secondary small-button"
                    disabled={openingSource}
                    onClick={() => void openSource()}
                  >
                    {openingSource ? '正在打开来源…' : '打开来源'}
                  </button>
                </SourceContextDisclosure>
                <Diagnostics
                  diagnostics={draft.extractionDiagnostics}
                  open={preferences?.showExtractionDiagnostics ?? false}
                />
              </div>

              <section
                id="capture-write-pane"
                hidden={capturePane !== 'write'}
                className="card stack capture-question-card motion-enter"
                aria-label="回忆题"
              >
                <nav className="capture-question-mode" aria-label="题目呈现方式">
                  <button
                    type="button"
                    className="button secondary small-button"
                    aria-pressed={questionMode === 'edit'}
                    onClick={() => setQuestionMode('edit')}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="button secondary small-button"
                    aria-pressed={questionMode === 'preview'}
                    onClick={() => setQuestionMode('preview')}
                  >
                    模拟复习
                  </button>
                </nav>
                <div hidden={questionMode !== 'edit'} className="stack capture-question-editor">
                  <label className="field">
                    <span>问题</span>
                    <textarea
                      ref={questionInput}
                      value={recallPrompt}
                      disabled={busy}
                      required
                      onChange={(event) => updateRecallPrompt(event.target.value)}
                      placeholder="什么问题能帮你想起这份收获？"
                    />
                  </label>
                  <div className="cluster capture-prompt-actions">
                    <button
                      type="button"
                      className="button secondary small-button"
                      disabled={busy || regeneratingPrompt}
                      onClick={() => void regenerateRecallPrompt()}
                    >
                      {regeneratingPrompt ? '重新生成中…' : '重新生成问题'}
                    </button>
                    {promptStatus && (
                      <small
                        className={promptStatus === PROMPT_REGENERATED ? 'sr-only' : 'muted'}
                        role="status"
                        aria-live="polite"
                      >
                        {promptStatus}
                      </small>
                    )}
                  </div>
                  <label className="field">
                    <span>答案要点</span>
                    <textarea
                      ref={answerInput}
                      value={coreLesson}
                      disabled={busy}
                      required
                      onChange={(event) => setCoreLesson(event.target.value)}
                      placeholder={
                        __VALRECALL_PUBLIC_RELEASE__
                          ? '例如：先写出结论，再补上理由。'
                          : '例如：现在就该用掉技能，而不是一直攒着造成压力。'
                      }
                    />
                  </label>
                  {previewWarning && <Notice tone="warning">{previewWarning}</Notice>}
                  <details className="capture-more-options">
                    <summary>更多选项 · 学习目标与分类</summary>
                    <div className="stack">
                      <fieldset className="goal-picker" disabled={busy}>
                        <legend>学习目标</legend>
                        <div className="goal-grid">
                          {LEARNING_GOALS.map((goal) => (
                            <label
                              className={`goal-option ${itemType === goal.value ? 'selected' : ''}`}
                              key={goal.value}
                            >
                              <input
                                type="radio"
                                name="learning-goal"
                                value={goal.value}
                                checked={itemType === goal.value}
                                onChange={() => setItemType(goal.value)}
                              />
                              <span>
                                <strong>{learningGoalLabel(goal.value)}</strong>
                                <span>{goal.description}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <CategoryPicker
                        categories={categories}
                        value={categoryId}
                        onChange={setCategoryId}
                        onCreate={async (name) => {
                          const category = await createCategory(name);
                          setCategories((current) => [
                            ...current.filter((entry) => entry.id !== category.id),
                            category,
                          ]);
                          setCategoryLoadError(null);
                          return category;
                        }}
                        disabled={busy}
                        compact
                      />
                      {categoryLoadError && <Notice tone="warning">{categoryLoadError}</Notice>}
                    </div>
                  </details>
                </div>
                {questionMode === 'preview' && (
                  <section className="capture-question-preview stack" aria-label="模拟复习预览">
                    <h3>{recallPrompt.trim() || '先写一个问题，再来试着回忆。'}</h3>
                    {answerRevealed ? (
                      <div className="capture-preview-answer stack-tight">
                        <p className="eyebrow">答案要点</p>
                        <p>{coreLesson.trim() || '还没有填写答案要点。'}</p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setAnswerRevealed(true)}
                      >
                        揭晓答案
                      </button>
                    )}
                  </section>
                )}
              </section>
              <footer
                ref={stickyBarClearance}
                className="capture-save-bar stack-tight"
                aria-label="保存回忆题"
              >
                {message && <Notice tone={message.tone}>{message.text}</Notice>}
                <button
                  className="button primary-action motion-press"
                  disabled={busy}
                  onClick={() => void saveItem()}
                >
                  {busy ? '保存中…' : '保存回忆题'}
                  {busy && <span className="motion-loading-indicator" aria-hidden="true" />}
                </button>
                <div className="cluster capture-secondary-actions">
                  <button
                    className="button secondary small-button"
                    disabled={busy}
                    onClick={() => void cancelCapture()}
                  >
                    放弃捕获
                  </button>
                  <DashboardButton onClick={openDashboard} />
                </div>
              </footer>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function normalizeDueCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function companionStatus({
  busy,
  loadingCapture,
  draft,
  pending,
  saved,
  praise,
}: {
  busy: boolean;
  loadingCapture: boolean;
  draft: CaptureDraft | null;
  pending: PendingState;
  saved: boolean;
  praise: string | null;
}): string {
  if (busy) return '正在保存捕获';
  if (loadingCapture) return '正在捕获时刻';
  if (draft) return '整理这个 Moment';
  if (saved) return __VALRECALL_PUBLIC_RELEASE__ ? '捕获已保存' : (praise ?? '捕获已保存');
  if (pending && !pending.ok) return '无法捕获';
  return __VALRECALL_PUBLIC_RELEASE__
    ? captureStatusText(lastReadCaptureShortcut())
    : '按 Alt+Shift+M 捕获';
}

function DashboardButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="button secondary" onClick={() => onClick()}>
      打开学习面板
    </button>
  );
}

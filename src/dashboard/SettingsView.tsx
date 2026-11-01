import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Rating, State } from 'ts-fsrs';

import { SHORT_TERM_REVIEW_MODES, type ShortTermReviewMode } from '../fsrs';
import {
  LEARNING_ITEM_TYPES,
  learningGoalLabel,
  type LearningItemType,
} from '../models/learning-item';
import { isValidReminderTime } from '../reminders/reminder-service';
import { Notice } from '../shared/components';
import {
  getReminderStatus,
  displayError,
  refreshReviewReminders,
  sendTestDailyPlan,
  sendTestReminder,
} from '../shared/extension';
import type { ReminderStatusResponse } from '../models/messages';
import { loadPreferences, savePreferences, type ValRecallPreferences } from '../shared/preferences';
import { MotionDisclosure, safeViewTransition, useReducedMotion } from '../ui/motion';
import { loadMostRecentSchedulingDiagnostic, type SchedulingDiagnostic } from './services';
import { useOperation } from '../shared/use-operation';
import { useEditProtection } from '../shared/edit-protection';
import { SyncSettings } from './SyncSettings';
import { TaskTrialSettings } from './TaskTrialSettings';
import { TypographySettings } from './TypographySettings';

export type SettingsCategory = 'general' | 'daily-plan' | 'reminders' | 'advanced';

/** The rewards switch ships in the public edition only, as its own chunk. */
const RewardsSetting = __VALRECALL_PUBLIC_RELEASE__
  ? lazy(() =>
      import('../edition/RewardsSetting').then((module) => ({ default: module.RewardsSetting })),
    )
  : null;

/** The public edition folds phone sync away. Its own chunk, and not reached by the private build. */
const OptionalSync = __VALRECALL_PUBLIC_RELEASE__
  ? lazy(() =>
      import('../edition/OptionalSync').then((module) => ({ default: module.OptionalSync })),
    )
  : null;

export function SettingsView({
  preferences,
  onSaved,
  onOpenData,
  onOpenWardrobe,
  initialCategory = 'general',
  diagnosticLoader = loadMostRecentSchedulingDiagnostic,
}: {
  preferences: ValRecallPreferences;
  onSaved: (preferences: ValRecallPreferences) => void;
  onOpenData: () => void;
  /** The companion wardrobe; the private build only. */
  onOpenWardrobe?: (() => void) | undefined;
  initialCategory?: SettingsCategory;
  diagnosticLoader?: (mode: ShortTermReviewMode) => Promise<SchedulingDiagnostic | null>;
}) {
  const [values, setValues] = useState(preferences);
  const [saved, setSaved] = useState(false);
  const [reminderNotice, setReminderNotice] = useState<{
    tone: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [sendingDailyPlanTest, setSendingDailyPlanTest] = useState(false);
  const [reminderStatus, setReminderStatus] = useState<ReminderStatusResponse | null>(null);
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState<SchedulingDiagnostic | null>(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const categoryFocusPendingRef = useRef(false);
  const advancedButtonRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();
  const operation = useOperation();
  const [baseline, setBaseline] = useState(preferences);
  useEditProtection({
    dirty: JSON.stringify(values) !== JSON.stringify(baseline),
    busy: () => operation.pending.current,
  });
  const reminderRequest = useRef(0);
  // Guidance appears only once the status says notifications are not allowed.
  const notificationsNotAllowed =
    reminderStatus?.ok === true && reminderStatus.status.notificationPermission !== 'granted';
  const version =
    typeof chrome !== 'undefined' && chrome.runtime?.id
      ? chrome.runtime.getManifest().version
      : 'dev';

  useEffect(() => {
    setValues((current) =>
      JSON.stringify(current) === JSON.stringify(baseline) ? preferences : current,
    );
    setBaseline(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!categoryFocusPendingRef.current) return;
    document.querySelector<HTMLElement>(`[data-settings-panel="${category}"] h3`)?.focus();
    categoryFocusPendingRef.current = false;
  }, [category]);

  useEffect(() => {
    if (category !== 'advanced' || !advancedOpen) return;
    let active = true;
    setDiagnosticLoading(true);
    setDiagnosticError(null);
    void diagnosticLoader(values.shortTermReviewMode)
      .then((value) => {
        if (active) setDiagnostic(value);
      })
      .catch((error: unknown) => {
        if (active) {
          setDiagnosticError(error instanceof Error ? error.message : '排程诊断无法加载。');
        }
      })
      .finally(() => {
        if (active) setDiagnosticLoading(false);
      });
    return () => {
      active = false;
    };
  }, [advancedOpen, category, diagnosticLoader, values.shortTermReviewMode]);

  useEffect(() => {
    if (category !== 'reminders') return;
    const request = ++reminderRequest.current;
    void getReminderStatus().then((status) => {
      if (request === reminderRequest.current) setReminderStatus(status);
    });
    return () => {
      reminderRequest.current += 1;
    };
  }, [category]);

  function changeCategory(nextCategory: SettingsCategory) {
    if (nextCategory === category) return;
    categoryFocusPendingRef.current = true;
    safeViewTransition(() => setCategory(nextCategory), { reducedMotion });
  }

  async function save() {
    if (operation.pending.current) return;
    if (!isValidReminderTime(values.reminderTime)) {
      setReminderNotice({ tone: 'error', text: '请选择有效的每日提醒时间。' });
      return;
    }
    if (!isValidReminderTime(values.dailyPlanReminderTime)) {
      setReminderNotice({ tone: 'error', text: '请选择有效的每日计划提醒时间。' });
      return;
    }
    if (
      !isValidReminderTime(values.reviewQuietHoursStart) ||
      !isValidReminderTime(values.reviewQuietHoursEnd)
    ) {
      setReminderNotice({ tone: 'error', text: '请选择有效的免打扰时间。' });
      return;
    }
    if (!operation.begin()) return;
    setSaved(false);
    setReminderNotice(null);
    const snapshot = values;
    try {
      await savePreferences(snapshot);
    } catch (error) {
      setReminderNotice({
        tone: 'error',
        text: displayError(error, '设置没保存，请重试。'),
      });
      operation.finish();
      return;
    }
    onSaved(snapshot);
    setBaseline(snapshot);
    setSaved(true);
    try {
      const result = await refreshReviewReminders();
      if (!result.ok)
        setReminderNotice({ tone: 'warning', text: `已保存，提醒没刷新：${result.error}` });
      const request = ++reminderRequest.current;
      const status = await getReminderStatus();
      if (request === reminderRequest.current) setReminderStatus(status);
    } catch {
      setReminderNotice({ tone: 'warning', text: '已保存，提醒没刷新，请重试。' });
    } finally {
      operation.finish();
    }
  }

  async function reset() {
    if (!operation.begin()) return;
    try {
      const current = await loadPreferences();
      setValues(current);
      setBaseline(current);
      setSaved(false);
      setReminderNotice(null);
    } catch (error) {
      setReminderNotice({
        tone: 'error',
        text: displayError(error, '没能读取已保存的设置，请重试。'),
      });
    } finally {
      operation.finish();
    }
  }

  async function testReminder() {
    setSendingTest(true);
    const result = await sendTestReminder();
    setReminderNotice(
      result.ok
        ? { tone: 'success', text: '测试通知已发送。' }
        : { tone: 'error', text: result.error },
    );
    setSendingTest(false);
  }

  async function testDailyPlan() {
    setSendingDailyPlanTest(true);
    const result = await sendTestDailyPlan();
    setReminderNotice(
      result.ok
        ? { tone: 'success', text: '测试通知已发送。' }
        : { tone: 'error', text: result.error },
    );
    setSendingDailyPlanTest(false);
  }

  return (
    <section className="stack settings-view" aria-busy={operation.busy}>
      <fieldset className="reading-fields stack" disabled={operation.busy}>
        <div>
          <p className="eyebrow">设置</p>
          <h2 className="dashboard-page-heading" tabIndex={-1}>
            捕获与复习偏好
          </h2>
        </div>
        <div className="cluster settings-subpage-links">
          <button className="button secondary" onClick={onOpenData}>
            备份与恢复
          </button>
          {__VALRECALL_PRIVATE_COMPANION_ASSETS__ && onOpenWardrobe ? (
            <button className="button secondary" onClick={onOpenWardrobe}>
              衣橱
            </button>
          ) : null}
        </div>
        <div className="settings-category-tabs" role="tablist" aria-label="设置分类">
          {SETTINGS_CATEGORIES.map((entry) => (
            <button
              className={`button secondary small-button settings-category-button motion-press${
                category === entry.id ? ' is-selected' : ''
              }`}
              aria-selected={category === entry.id}
              data-settings-category={entry.id}
              key={entry.id}
              role="tab"
              onClick={() => changeCategory(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {saved && (
          <div className="motion-state-change" key="settings-saved">
            <Notice tone="success">已保存。</Notice>
          </div>
        )}
        {reminderNotice && (
          <div className="motion-state-change" key={reminderNotice.text}>
            <Notice tone={reminderNotice.tone}>{reminderNotice.text}</Notice>
          </div>
        )}
        <div
          className="settings-category-panel motion-state-change"
          data-settings-panel="general"
          hidden={category !== 'general'}
          role="tabpanel"
        >
          {category === 'general' && <TypographySettings />}
          {__VALRECALL_PUBLIC_RELEASE__ && OptionalSync
            ? category === 'general' && (
                <Suspense fallback={null}>
                  <OptionalSync />
                </Suspense>
              )
            : category === 'general' && <SyncSettings />}
          <div className="card stack">
            <h3 tabIndex={-1}>常规</h3>
            <label className="field">
              <span>默认学习目标</span>
              <select
                value={values.defaultItemType}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    defaultItemType: event.target.value as LearningItemType,
                  }));
                }}
              >
                {LEARNING_ITEM_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {learningGoalLabel(type)}
                  </option>
                ))}
              </select>
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.pauseAfterReopen}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, pauseAfterReopen: event.target.checked }));
                }}
              />
              <span>重新打开到保存时间戳后暂停播放器</span>
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.showExtractionDiagnostics}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    showExtractionDiagnostics: event.target.checked,
                  }));
                }}
              />
              <span>默认展开提取诊断</span>
            </label>
            <label className="field">
              <span>短期复习模式</span>
              <select
                value={values.shortTermReviewMode}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    shortTermReviewMode: event.target.value as ShortTermReviewMode,
                  }));
                }}
              >
                {SHORT_TERM_REVIEW_MODES.map((mode) => (
                  <option value={mode} key={mode}>
                    {shortTermModeLabel(mode)}
                  </option>
                ))}
              </select>
              <span className="muted small">
                {shortTermModeDescription(values.shortTermReviewMode)}
              </span>
            </label>
            <div className="cluster">
              <button className="button motion-press" onClick={() => void save()}>
                {operation.busy ? '正在处理…' : '保存设置'}
              </button>
              <button className="button secondary motion-press" onClick={() => void reset()}>
                重新加载已保存设置
              </button>
            </div>
          </div>
          {__VALRECALL_PUBLIC_RELEASE__ && RewardsSetting
            ? category === 'general' && (
                <>
                  <Suspense fallback={null}>
                    <RewardsSetting />
                  </Suspense>
                  <TaskTrialSettings />
                </>
              )
            : category === 'general' && <TaskTrialSettings />}
        </div>
        <div
          className="settings-category-panel motion-state-change"
          data-settings-panel="daily-plan"
          hidden={category !== 'daily-plan'}
          role="tabpanel"
        >
          <div className="card stack">
            <div>
              <h3 tabIndex={-1}>每日计划提醒</h3>
              <p className="muted small">每天早上提醒今天的复习和待办数量。</p>
            </div>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.dailyPlanReminderEnabled}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    dailyPlanReminderEnabled: event.target.checked,
                  }));
                }}
              />
              <span>启用每日计划摘要</span>
            </label>
            <label className="field reminder-time-field">
              <span>每日计划时间（本地时间）</span>
              <input
                type="time"
                required
                disabled={!values.dailyPlanReminderEnabled}
                value={values.dailyPlanReminderTime}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    dailyPlanReminderTime: event.target.value,
                  }));
                }}
              />
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.includeReviewsInDailyPlan}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    includeReviewsInDailyPlan: event.target.checked,
                  }));
                }}
              />
              <span>包含到期复习数量</span>
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.includeTasksInDailyPlan}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    includeTasksInDailyPlan: event.target.checked,
                  }));
                }}
              />
              <span>包含剩余任务数量</span>
            </label>
            <div className="cluster">
              <button className="button motion-press" onClick={() => void save()}>
                保存每日计划设置
              </button>
              <button
                className="button secondary motion-press"
                disabled={sendingDailyPlanTest}
                onClick={() => void testDailyPlan()}
              >
                {sendingDailyPlanTest ? '正在发送每日计划测试…' : '发送每日计划测试'}
              </button>
            </div>
          </div>
        </div>
        <div
          className="settings-category-panel motion-state-change"
          data-settings-panel="reminders"
          hidden={category !== 'reminders'}
          role="tabpanel"
        >
          <div className="card stack">
            <div>
              <h3 tabIndex={-1}>下次到期提醒</h3>
              <p className="muted small">最早一条复习到期时提醒你。</p>
            </div>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.nextDueReminderEnabled}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    nextDueReminderEnabled: event.target.checked,
                  }));
                }}
              />
              <span>下次复习到期时通知</span>
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.groupReviewNotificationCount}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    groupReviewNotificationCount: event.target.checked,
                  }));
                }}
              />
              <span>通知里显示到期数量</span>
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.reviewQuietHoursEnabled}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({
                    ...current,
                    reviewQuietHoursEnabled: event.target.checked,
                  }));
                }}
              />
              <span>复习通知使用免打扰时段</span>
            </label>
            <div className="field-grid">
              <label className="field reminder-time-field">
                <span>免打扰开始</span>
                <input
                  type="time"
                  disabled={!values.reviewQuietHoursEnabled}
                  value={values.reviewQuietHoursStart}
                  onChange={(event) => {
                    setSaved(false);
                    setValues((current) => ({
                      ...current,
                      reviewQuietHoursStart: event.target.value,
                    }));
                  }}
                />
              </label>
              <label className="field reminder-time-field">
                <span>免打扰结束</span>
                <input
                  type="time"
                  disabled={!values.reviewQuietHoursEnabled}
                  value={values.reviewQuietHoursEnd}
                  onChange={(event) => {
                    setSaved(false);
                    setValues((current) => ({
                      ...current,
                      reviewQuietHoursEnd: event.target.value,
                    }));
                  }}
                />
              </label>
            </div>
            <div className="notice info reminder-status" aria-live="polite">
              {formatReminderStatus(reminderStatus)}
            </div>
            <hr />
            <div>
              <h3>Edge 每日复习提醒</h3>
              {notificationsNotAllowed && (
                <p className="muted small">需要在 Edge 和系统里允许通知。</p>
              )}
            </div>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.reminderEnabled}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, reminderEnabled: event.target.checked }));
                }}
              />
              <span>启用每日复习提醒</span>
            </label>
            <label className="field reminder-time-field">
              <span>提醒时间（本地时间）</span>
              <input
                type="time"
                required
                disabled={!values.reminderEnabled}
                value={values.reminderTime}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, reminderTime: event.target.value }));
                }}
              />
            </label>
            <label className="cluster">
              <input
                style={{ width: 'auto' }}
                type="checkbox"
                checked={values.notifyOnlyWhenDue}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, notifyOnlyWhenDue: event.target.checked }));
                }}
              />
              <span>仅在有到期学习条目时通知</span>
            </label>
            <div className="cluster">
              <button className="button motion-press" onClick={() => void save()}>
                保存提醒设置
              </button>
              <button
                className="button secondary motion-press"
                disabled={sendingTest}
                onClick={() => void testReminder()}
              >
                {sendingTest ? '正在发送测试通知…' : '发送测试通知'}
              </button>
            </div>
          </div>
        </div>
        <div
          className="settings-category-panel motion-state-change"
          data-settings-panel="advanced"
          hidden={category !== 'advanced'}
          role="tabpanel"
        >
          <button
            className="button secondary settings-advanced-toggle motion-press"
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-content"
            ref={advancedButtonRef}
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            {advancedOpen ? '隐藏高级选项' : '显示高级选项'}
          </button>
          <MotionDisclosure
            className="settings-advanced-disclosure"
            id="settings-advanced-content"
            open={advancedOpen}
            returnFocusRef={advancedButtonRef}
          >
            <div className="stack settings-advanced-content">
              <div className="card">
                <h3 tabIndex={-1}>排程诊断</h3>
                {diagnosticLoading ? (
                  <p role="status">正在加载本地排程数据…</p>
                ) : diagnosticError ? (
                  <Notice tone="error">{diagnosticError}</Notice>
                ) : diagnostic ? (
                  <SchedulingDiagnosticView diagnostic={diagnostic} />
                ) : (
                  <p className="muted">还没有已复习的卡片。</p>
                )}
              </div>
              <div className="card">
                <h3>关于</h3>
                <dl className="metadata">
                  <dt>扩展</dt>
                  <dd>ValRecall</dd>
                  <dt>版本</dt>
                  <dd>{version}</dd>
                  <dt>界面字体</dt>
                  {__VALRECALL_PUBLIC_RELEASE__ ? (
                    <dd>
                      本产品使用霞鹜文楷（LXGW WenKai），SIL Open Font License 1.1。
                      <a href="fonts/LXGW-OFL.txt" target="_blank" rel="noreferrer">
                        字体许可
                      </a>
                      <br />
                      本产品使用思源黑体（Noto Sans SC），SIL Open Font License 1.1。
                      <a href="fonts/OFL.txt" target="_blank" rel="noreferrer">
                        字体许可
                      </a>
                    </dd>
                  ) : (
                    <dd>
                      本产品使用霞鹜文楷（LXGW WenKai），SIL Open Font License 1.1。
                      <a href="fonts/LXGW-OFL.txt" target="_blank" rel="noreferrer">
                        字体许可
                      </a>
                      <br />
                      本产品使用 MiSans 字体，由小米提供。
                      <a href="fonts/MiSans-LICENSE.pdf" target="_blank" rel="noreferrer">
                        字体许可
                      </a>
                      <br />
                      本产品使用思源黑体（Noto Sans SC），SIL Open Font License 1.1。
                      <a href="fonts/OFL.txt" target="_blank" rel="noreferrer">
                        字体许可
                      </a>
                    </dd>
                  )}
                  <dt>存储</dt>
                  <dd>本地 IndexedDB</dd>
                  <dt>生成</dt>
                  <dd>本地规则</dd>
                </dl>
              </div>
            </div>
          </MotionDisclosure>
        </div>
      </fieldset>
    </section>
  );
}

const SETTINGS_CATEGORIES: ReadonlyArray<{ id: SettingsCategory; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'daily-plan', label: '每日计划' },
  { id: 'reminders', label: '提醒' },
  { id: 'advanced', label: '高级' },
];

function formatReminderStatus(status: ReminderStatusResponse | null): string {
  if (status === null) return '正在检查下次复习提醒…';
  if (!status.ok) return status.error;
  const permission =
    status.status.notificationPermission === 'granted'
      ? null
      : status.status.notificationPermission === 'denied'
        ? '通知权限：已在 Edge 或 Windows 中被阻止。'
        : '通知权限：仅在已安装的 Edge 扩展中可用。';
  const schedule =
    status.status.nextReviewReminderAt === null
      ? '没有已安排的未来复习。'
      : `下次复习提醒：${new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(status.status.nextReviewReminderAt))}。`;
  return permission ? `${permission} ${schedule}` : schedule;
}

function shortTermModeLabel(mode: ShortTermReviewMode): string {
  switch (mode) {
    case 'off':
      return '关闭';
    case 'light':
      return '轻量';
    case 'standard':
      return '标准';
  }
}

function shortTermModeDescription(mode: ShortTermReviewMode): string {
  switch (mode) {
    case 'off':
      return '新卡直接按长期间隔排；忘记的卡 10 分钟后再出现。';
    case 'light':
      return '只保留 10 分钟后的一次回顾。';
    case 'standard':
      return '1 分钟、10 分钟两步，Good 约 10 分钟后再出现。';
  }
}

function SchedulingDiagnosticView({ diagnostic }: { diagnostic: SchedulingDiagnostic }) {
  const { card, configuration, latestLog } = diagnostic;
  return (
    <dl className="metadata scheduling-diagnostic">
      <dt>卡片 ID</dt>
      <dd>{diagnostic.itemId}</dd>
      <dt>状态</dt>
      <dd>{State[card.state]}</dd>
      <dt>到期</dt>
      <dd>{formatDiagnosticDate(card.due)}</dd>
      <dt>上次复习</dt>
      <dd>{card.last_review ? formatDiagnosticDate(card.last_review) : '尚未复习'}</dd>
      <dt>已排程 / 已过天数</dt>
      <dd>
        {card.scheduled_days} / {card.elapsed_days}
      </dd>
      <dt>复习次数 / 遗忘次数</dt>
      <dd>
        {card.reps} / {card.lapses}
      </dd>
      <dt>稳定性 / 难度</dt>
      <dd>
        {card.stability} / {card.difficulty}
      </dd>
      <dt>最近评分</dt>
      <dd>{Rating[diagnostic.latestRating]}</dd>
      <dt>最近复习记录</dt>
      <dd>{formatDiagnosticDate(latestLog.review)}</dd>
      <dt>排程器</dt>
      <dd>
        ts-fsrs {configuration.packageVersion} · {configuration.algorithmVersion}
      </dd>
      <dt>模式 / 保持率 / 最大间隔</dt>
      <dd>
        {shortTermModeLabel(configuration.shortTermReviewMode)} /{' '}
        {configuration.parameters.request_retention} / {configuration.parameters.maximum_interval}{' '}
        天
      </dd>
      <dt>学习 / 重新学习</dt>
      <dd>
        {configuration.parameters.learning_steps.join(', ') || '无'} /{' '}
        {configuration.parameters.relearning_steps.join(', ') || '无'}
      </dd>
      <dt>短期 / 模糊</dt>
      <dd>
        {String(configuration.parameters.enable_short_term)} /{' '}
        {String(configuration.parameters.enable_fuzz)}
      </dd>
      <dt>FSRS 权重</dt>
      <dd>{configuration.parameters.w.join(', ')}</dd>
    </dl>
  );
}

function formatDiagnosticDate(date: Date): string {
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

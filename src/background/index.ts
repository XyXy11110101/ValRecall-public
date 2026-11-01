import { dismissCaptureById, preservePendingCapture } from '../database/pending-capture';
import type { CaptureDraft } from '../models/learning-item';
import type { ExtractionDiagnostic } from '../models/extraction';
import { isPageSubtitleSnapshot, type PageSubtitleSnapshot } from '../models/page-subtitles';
import type { VideoPlatform } from '../models/platform';
import { ValRecallRepository } from '../database';
import {
  isCapturePageResponse,
  isCaptureConsistencyResponse,
  isSeekToTimestampResponse,
  isValRecallMessage,
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type CapturePageResponse,
  type OpenSourceMessage,
  type SeekToTimestampResponse,
} from '../models/messages';
import { createDailyPlanChromePort } from '../reminders/daily-plan-chrome-port';
import { DailyPlanService } from '../reminders/daily-plan-service';
import { createChromeReminderPort } from '../reminders/chrome-reminder-port';
import { registerReminderRuntime } from '../reminders/reminder-runtime';
import { ReminderService } from '../reminders/reminder-service';
import { loadPreferences } from '../shared/preferences';
import { registerNativeSyncRuntime } from '../sync/native-bridge';
import { SyncRepository } from '../database/sync-repository';
import { desktopSyncDependencies } from '../sync/desktop-runtime';
import { SYNC_DATA_CHANGED } from '../sync/data-events';
import { createDashboardOpener } from './dashboard-opener';
import { captureScreenshotSafely } from './capture-safety';
import {
  collectMainWorldSubtitleSnapshot,
  type PageSubtitleBridgeRequest,
} from './page-subtitle-bridge';
import { createChromeBackgroundRoutePort, registerBackgroundRoutes } from './routing';
import {
  buildSourceOpenUrl,
  detectVideoPlatform,
  getSourceOpenCandidates,
  getSourceTabPatterns,
  isSupportedVideoUrl,
  matchesPreferredSourceContext,
} from './source-url';
import { openDashboardOnInstall } from '../edition/open-on-install';
import { registerCaptureRetry } from '../edition/capture-retry';

type PendingCaptureResponse = CapturePageResponse;

const PENDING_CAPTURE_META_KEY = 'runtime.pendingCapture';
const repository = new ValRecallRepository();
registerNativeSyncRuntime(
  chrome,
  desktopSyncDependencies(new SyncRepository(repository), () => {
    void chrome.runtime.sendMessage(SYNC_DATA_CHANGED).catch(() => undefined);
  }),
);
const openDashboard = createDashboardOpener(chrome);
const reminderService = new ReminderService(
  createChromeReminderPort(chrome, {
    loadPreferences,
    listItems: () => repository.listItems({ includeReviewHistory: false }),
  }),
);
const dailyPlanService = new DailyPlanService(
  createDailyPlanChromePort(chrome, {
    loadPreferences,
    countDueReviews: (now) => repository.countDueReviewItems(now),
    countRemainingTasks: (now) => repository.countRemainingTasksToday(now),
  }),
);
let pendingCapture: PendingCaptureResponse | null = null;

registerBackgroundRoutes(createChromeBackgroundRoutePort(chrome), {
  openDashboard,
  startCapture,
});
if (__VALRECALL_PUBLIC_RELEASE__) openDashboardOnInstall(chrome);
if (__VALRECALL_PUBLIC_RELEASE__) registerCaptureRetry(chrome, () => startCapture());
registerReminderRuntime(chrome, {
  service: reminderService,
  dailyPlanService,
  openReviewDashboard: () => openDashboard('review'),
  openHomeDashboard: () => openDashboard('home'),
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isValRecallMessage(message)) return false;

  if (message.type === MESSAGE_TYPES.getPendingCapture) {
    void loadPendingCapture().then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE_TYPES.dismissCapture) {
    const id = message.payload?.draftId;
    if (!id) {
      sendResponse({ ok: false, error: '缺少捕获身份，请重新打开侧栏。' });
      return false;
    }
    void dismissCaptureById(repository, id)
      .then((removed) => {
        if (removed && pendingCapture?.ok && pendingCapture.draft.draftId === id)
          pendingCapture = null;
        sendResponse({ ok: true, removed });
      })
      .catch(() => sendResponse({ ok: false, error: '捕获清理失败。' }));
    return true;
  }

  if (message.type === MESSAGE_TYPES.openSource) {
    void openSource(message).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE_TYPES.sendTestReminder) {
    void reminderService
      .sendTestNotification()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error, 'ValRecall could not create the test notification.'),
        }),
      );
    return true;
  }

  if (message.type === MESSAGE_TYPES.sendTestDailyPlan) {
    void dailyPlanService
      .sendTestNotification()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error, 'ValRecall could not create the Daily Plan test.'),
        }),
      );
    return true;
  }

  if (message.type === MESSAGE_TYPES.refreshReviewReminders) {
    void reminderService
      .reconcile()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error, 'ValRecall could not refresh the review reminder.'),
        }),
      );
    return true;
  }

  if (message.type === MESSAGE_TYPES.getReminderStatus) {
    void reminderService
      .getStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error, 'ValRecall could not read the review reminder status.'),
        }),
      );
    return true;
  }

  return false;
});

export async function startCapture(tab?: chrome.tabs.Tab): Promise<void> {
  const activeTab = tab?.id ? tab : await findActiveTab();
  if (!activeTab?.id || !activeTab.windowId) {
    await publishError('CAPTURE_FAILED', '找不到当前标签页，请重试。');
    return;
  }
  const tabId = activeTab.id;

  // Opening immediately keeps this call tied to the deliberate command/action gesture.
  await chrome.sidePanel.open({ windowId: activeTab.windowId }).catch(() => undefined);

  if (!isSupportedUrl(activeTab.url)) {
    await publishError('UNSUPPORTED_PAGE', '请打开 B 站、YouTube 或抖音的视频页面后再试。');
    return;
  }

  try {
    const response = await requestPageCapture(tabId, activeTab.url ?? '');
    if (!response.ok) {
      await setPendingCapture(response);
      return;
    }

    const draft: CaptureDraft = { ...response.draft };
    try {
      draft.screenshotDataUrl = await captureScreenshotSafely({
        expectedTabId: tabId,
        draft,
        readActiveTab: () => findActiveTabInWindow(activeTab.windowId),
        validatePage: () => requestCaptureConsistency(tabId, draft.draftId),
        captureVisibleTab: () =>
          chrome.tabs.captureVisibleTab(activeTab.windowId, {
            format: 'jpeg',
            quality: 88,
          }),
      });
      draft.extractionDiagnostics = [
        ...draft.extractionDiagnostics,
        {
          field: 'screenshot',
          strategy: 'captureVisibleTab',
          status: 'success',
          severity: 'info',
          message: 'Captured the visible tab. The original full screenshot is preserved.',
        },
      ];
    } catch (error) {
      await publishError(
        'SCREENSHOT_FAILED',
        errorMessage(error, '无法截取画面，请回到视频后重试。'),
      );
      return;
    }

    await setPendingCapture({ ok: true, draft });
  } catch (error) {
    await publishError('CAPTURE_FAILED', errorMessage(error, '无法捕获这个页面，请重试。'));
  }
}

async function requestCaptureConsistency(tabId: number, draftId: string): Promise<boolean> {
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.validateCapturePage,
      version: MESSAGE_PROTOCOL_VERSION,
      payload: { draftId },
    });
    return isCaptureConsistencyResponse(response) && response.ok;
  } catch {
    return false;
  }
}

async function requestPageCapture(
  tabId: number,
  expectedUrl: string,
): Promise<CapturePageResponse> {
  try {
    const subtitleSnapshot = await requestMainWorldSubtitleSnapshot(tabId, expectedUrl);
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.capturePage,
      version: MESSAGE_PROTOCOL_VERSION,
      payload: { subtitleSnapshot },
    });
    if (!isCapturePageResponse(response)) throw new Error('The page returned an invalid capture.');
    return response;
  } catch {
    // SPA navigation can occasionally leave a supported tab without the declared script.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const subtitleSnapshot = await requestMainWorldSubtitleSnapshot(tabId, expectedUrl);
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.capturePage,
      version: MESSAGE_PROTOCOL_VERSION,
      payload: { subtitleSnapshot },
    });
    if (!isCapturePageResponse(response)) throw new Error('The page returned an invalid capture.');
    return response;
  }
}

async function requestMainWorldSubtitleSnapshot(
  tabId: number,
  expectedUrl: string,
): Promise<PageSubtitleSnapshot | null> {
  const platform = detectVideoPlatform(expectedUrl);
  if (platform === null) return null;
  const request: PageSubtitleBridgeRequest = {
    requestId:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `subtitle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    platform,
    expectedHref: expectedUrl,
  };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectMainWorldSubtitleSnapshot,
      args: [request],
    });
    const snapshot: unknown = results[0]?.result;
    return isPageSubtitleSnapshot(snapshot) &&
      snapshot.requestId === request.requestId &&
      snapshot.platform === platform
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

async function findActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function findActiveTabInWindow(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab;
}

async function publishError(
  code: 'UNSUPPORTED_PAGE' | 'SCREENSHOT_FAILED' | 'CAPTURE_FAILED',
  message: string,
): Promise<void> {
  await setPendingCapture({ ok: false, error: { code, message } });
}

async function loadPendingCapture(): Promise<PendingCaptureResponse> {
  if (pendingCapture) return pendingCapture;
  try {
    const stored = await repository.getMeta<unknown>(PENDING_CAPTURE_META_KEY);
    if (isCapturePageResponse(stored)) {
      pendingCapture = stored;
      return stored;
    }
  } catch (error) {
    console.warn('[ValRecall] Pending capture recovery failed.', error);
  }
  return {
    ok: false,
    error: {
      code: 'CAPTURE_FAILED',
      message: '还没有待整理的捕获，请再按一次快捷键。',
    },
  };
}

async function setPendingCapture(response: PendingCaptureResponse): Promise<void> {
  pendingCapture = response;
  try {
    await preservePendingCapture(repository, response);
  } catch (error) {
    console.warn('[ValRecall] Pending capture persistence failed.', error);
  }
  notifyPanel();
}

function notifyPanel(): void {
  if (!pendingCapture) return;
  void chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPES.pendingCaptureChanged,
      version: MESSAGE_PROTOCOL_VERSION,
      payload: pendingCapture,
    })
    .catch(() => undefined);
}

async function openSource(request: OpenSourceMessage): Promise<SeekToTimestampResponse> {
  const { sourceUrl, canonicalUrl, timestampSeconds, pauseAfterSeek } = request.payload;
  const platform = request.payload.platform ?? detectVideoPlatform(sourceUrl);
  if (!platform) {
    return failedSeek(timestampSeconds ?? 0, 0, 'The saved source URL is not supported.');
  }

  const targetUrls = getSourceOpenCandidates(sourceUrl, canonicalUrl, platform);
  if (targetUrls.length === 0) {
    return failedSeek(timestampSeconds ?? 0, 0, 'The saved source URL is not supported.');
  }

  const diagnostics: ExtractionDiagnostic[] = [];
  let totalAttempts = 0;
  let lastError = 'The video player did not become ready in time.';

  for (let targetIndex = 0; targetIndex < targetUrls.length; targetIndex += 1) {
    const targetUrl = targetUrls[targetIndex]!;
    let tab = await findMatchingTab(targetUrl, platform);
    try {
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined)
          await chrome.windows.update(tab.windowId, { focused: true });
      } else {
        tab = await chrome.tabs.create({
          url: buildSourceOpenUrl(targetUrl, platform, timestampSeconds),
          active: true,
        });
      }
    } catch (error) {
      lastError = errorMessage(error, 'The source page could not be opened.');
      diagnostics.push({
        field: 'seek',
        strategy: `open-source-candidate-${targetIndex + 1}`,
        status: 'failed',
        severity: 'warning',
        message: lastError,
      });
      continue;
    }

    if (!tab.id) {
      lastError = 'The opened source tab has no tab identifier.';
      diagnostics.push({
        field: 'seek',
        strategy: `open-source-candidate-${targetIndex + 1}`,
        status: 'failed',
        severity: 'warning',
        message: lastError,
      });
      continue;
    }

    if (timestampSeconds === null) {
      diagnostics.push({
        field: 'seek',
        strategy: 'open-source-without-timestamp',
        status: 'success',
        severity: 'info',
        message: 'The source was opened without requesting a player seek.',
      });
      return { ok: true, attempts: totalAttempts, timestampSeconds: 0, error: null, diagnostics };
    }

    const response = await seekInTab(tab.id, timestampSeconds, pauseAfterSeek);
    totalAttempts += response.attempts;
    diagnostics.push(...response.diagnostics);
    if (response.ok) return { ...response, attempts: totalAttempts, diagnostics };
    lastError = response.error ?? lastError;

    if (targetIndex < targetUrls.length - 1) {
      diagnostics.push({
        field: 'seek',
        strategy: 'bilibili-watch-later-canonical-fallback',
        status: 'failed',
        severity: 'warning',
        message:
          'The original Watch Later context was unavailable; trying the stable canonical video page.',
      });
    }
  }

  return failedSeek(timestampSeconds ?? 0, totalAttempts, lastError, diagnostics);
}

async function seekInTab(
  tabId: number,
  timestampSeconds: number,
  pauseAfterSeek: boolean,
): Promise<SeekToTimestampResponse> {
  const maxAttempts = 10;
  let lastError = 'The video player did not become ready in time.';
  const diagnostics: ExtractionDiagnostic[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response: unknown = await chrome.tabs.sendMessage(tabId, {
        type: MESSAGE_TYPES.seekToTimestamp,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { timestampSeconds, pauseAfterSeek },
      });
      if (!isSeekToTimestampResponse(response)) {
        throw new Error('The content script returned an invalid seek response.');
      }
      return response;
    } catch (error) {
      lastError = errorMessage(error, lastError);
      diagnostics.push({
        field: 'seek',
        strategy: `content-script-attempt-${attempt}`,
        status: 'failed',
        severity: 'warning',
        message: lastError,
      });
      if (attempt === 1) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js'],
          });
        } catch (injectionError) {
          lastError = errorMessage(injectionError, lastError);
        }
      }
    }
    if (attempt < maxAttempts) await delay(500);
  }
  return failedSeek(timestampSeconds, maxAttempts, lastError, diagnostics);
}

async function findMatchingTab(
  targetUrl: string,
  platform: VideoPlatform,
): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: getSourceTabPatterns(platform) });
  return tabs.find((tab) => tab.url && matchesPreferredSourceContext(tab.url, targetUrl, platform));
}

function failedSeek(
  timestampSeconds: number,
  attempts: number,
  error: string,
  diagnostics: ExtractionDiagnostic[] = [],
): SeekToTimestampResponse {
  return { ok: false, attempts, timestampSeconds, error, diagnostics };
}

function isSupportedUrl(url?: string): boolean {
  return Boolean(url && isSupportedVideoUrl(url));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

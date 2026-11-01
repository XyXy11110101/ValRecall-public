import { describe, expect, it, vi } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';

import {
  LEARNING_ITEM_SCHEMA_VERSION,
  type ImageLearningItem,
  type TextLearningItem,
  type VideoLearningItem,
} from '../database/types';
import { companionIconPath, outfitForDate } from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import {
  createChromeReminderPort,
  REMINDER_STATE_STORAGE_KEY,
  type ReminderChromeApi,
} from './chrome-reminder-port';

function createApi(storedState: unknown = undefined): ReminderChromeApi {
  return {
    alarms: {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      get: vi.fn(async () => undefined),
    },
    notifications: {
      create: vi.fn(async (id) => id),
    },
    permissions: {
      contains: vi.fn(async () => true),
    },
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://valrecall/${path}`),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ [REMINDER_STATE_STORAGE_KEY]: storedState })),
        set: vi.fn(async () => undefined),
      },
    },
  };
}

describe('createChromeReminderPort', () => {
  it('normalizes and persists local reminder state', async () => {
    const api = createApi({
      lastEvaluationLocalDate: 'invalid',
      lastNotificationLocalDate: '2026-07-21',
    });
    const port = createChromeReminderPort(api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [],
    });

    await expect(port.loadState()).resolves.toEqual({
      lastEvaluationLocalDate: null,
      lastNotificationLocalDate: '2026-07-21',
      lastDueCohortDigest: null,
      lastNextNotificationAt: null,
    });
    await port.saveState({
      lastEvaluationLocalDate: '2026-07-21',
      lastNotificationLocalDate: null,
      lastDueCohortDigest: null,
      lastNextNotificationAt: null,
    });

    expect(api.storage.local.set).toHaveBeenCalledWith({
      [REMINDER_STATE_STORAGE_KEY]: {
        lastEvaluationLocalDate: '2026-07-21',
        lastNotificationLocalDate: null,
        lastDueCohortDigest: null,
        lastNextNotificationAt: null,
      },
    });
  });

  it('delegates due selection without changing the returned items', async () => {
    const now = new Date('2026-07-21T20:00:00.000Z');
    const item = learningItem(now);
    const originalDue = item.fsrsCard.due.getTime();
    const listItems = vi.fn(async () => [item]);
    const port = createChromeReminderPort(createApi(), {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems,
    });

    await expect(port.loadReviewSchedule(now)).resolves.toEqual({
      due: [{ id: item.id, due: now }],
      future: [],
    });

    expect(listItems).toHaveBeenCalledOnce();
    expect(item.suspended).toBe(false);
    expect(item.fsrsCard.due.getTime()).toBe(originalDue);
  });

  it('includes Text Moments in the same reminder schedule', async () => {
    const now = new Date('2026-07-21T20:00:00.000Z');
    const text: TextLearningItem = {
      id: 'text-due',
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      sourceType: 'text',
      title: 'Text reminder',
      categoryId: null,
      itemType: 'Understand',
      personalNote: '',
      situation: '',
      coreLesson: 'Core lesson',
      mistakeToAvoid: '',
      recommendedAction: '',
      reason: '',
      recallPrompt: 'Recall it',
      referenceAnswer: 'Core lesson',
      tags: [],
      createdAt: now,
      updatedAt: now,
      fsrsCard: createEmptyCard(now),
      reviewHistory: [],
      suspended: false,
      extractionDiagnostics: [],
    };
    const port = createChromeReminderPort(createApi(), {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [text],
    });

    await expect(port.loadReviewSchedule(now)).resolves.toEqual({
      due: [{ id: text.id, due: now }],
      future: [],
    });
  });

  it('schedules Image and manual Video Moments from FSRS only', async () => {
    const now = new Date('2026-07-21T20:00:00.000Z');
    const futureDue = new Date('2026-07-22T20:00:00.000Z');
    const image = imageItem(now);
    const manualVideo = learningItem(futureDue);
    manualVideo.id = 'manual-video-future';
    manualVideo.sourceType = 'video';
    manualVideo.videoOrigin = 'library';
    manualVideo.timestampSeconds = null;
    manualVideo.timestampDisplay = null;
    manualVideo.screenshotId = null;
    const port = createChromeReminderPort(createApi(), {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [manualVideo, image],
    });

    await expect(port.loadReviewSchedule(now)).resolves.toEqual({
      due: [{ id: image.id, due: now }],
      future: [{ id: manualVideo.id, due: futureDue }],
    });
    expect(image.imageAssetId).toBe('asset-image-due');
    expect(manualVideo.timestampSeconds).toBeNull();
  });

  it('uses one-shot alarm times and extension-local notification icons', async () => {
    const api = createApi();
    const port = createChromeReminderPort(api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [],
      now: () => new Date(2026, 9, 28, 14, 0),
    });

    await port.createAlarm('daily', 12345);
    await port.clearAlarm('daily');
    await port.createNotification('notice', {
      title: 'Title',
      message: 'Message',
      buttons: ['开始复习'],
    });

    expect(api.alarms.create).toHaveBeenCalledWith('daily', { when: 12345 });
    expect(api.alarms.clear).toHaveBeenCalledWith('daily');
    expect(api.notifications.create).toHaveBeenCalledWith('notice', {
      type: 'basic',
      iconUrl: `chrome-extension://valrecall/${companionIconPath(outfitForDate('2026-10-28'), 'reminder')}`,
      title: 'Title',
      message: 'Message',
      buttons: [{ title: '开始复习' }],
    });
  });

  it('shows the pinned outfit on review reminders and falls back to the extension icon', async () => {
    const api = createApi();
    vi.mocked(api.storage.local.get).mockImplementation(async (key: string) =>
      key === COMPANION_WARDROBE_STORAGE_KEY
        ? { [key]: { version: 1, mode: 'pinned', outfit: 'outfit9' } }
        : {},
    );
    vi.mocked(api.notifications.create)
      .mockRejectedValueOnce(new Error('Unable to download all specified images.'))
      .mockResolvedValueOnce('notice');
    const port = createChromeReminderPort(api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [],
      now: () => new Date(2026, 9, 28, 14, 0),
    });

    await port.createNotification('notice', { title: 'Title', message: 'Message' });

    expect(api.storage.local.get).toHaveBeenCalledWith(COMPANION_WARDROBE_STORAGE_KEY);
    expect(
      vi.mocked(api.notifications.create).mock.calls.map(([, options]) => options.iconUrl),
    ).toEqual([
      'chrome-extension://valrecall/assets/companion/chibi/outfit9/icon-reminder-128.png',
      'chrome-extension://valrecall/icons/icon128.png',
    ]);
  });

  it('reads the one named alarm and notification permission for Settings status', async () => {
    const api = createApi();
    vi.mocked(api.alarms.get).mockResolvedValueOnce({ scheduledTime: 12345 });
    const port = createChromeReminderPort(api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      listItems: async () => [],
    });

    await expect(port.getAlarmTime('valrecall-next-review')).resolves.toBe(12345);
    await expect(port.getNotificationPermission()).resolves.toBe('granted');
    expect(api.permissions.contains).toHaveBeenCalledWith({
      permissions: ['notifications'],
    });
  });
});

function learningItem(now: Date): VideoLearningItem {
  return {
    id: 'due-item',
    schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1example',
    canonicalUrl: null,
    videoId: 'BV1example',
    videoTitle: 'Due lesson',
    uploader: null,
    description: null,
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    videoDurationSeconds: 90,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: 'Core lesson',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'Recall it',
    referenceAnswer: 'Core lesson',
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function imageItem(now: Date): ImageLearningItem {
  return {
    id: 'image-due',
    schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
    sourceType: 'image',
    title: 'Image reminder',
    imageAssetId: 'asset-image-due',
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: 'Core lesson',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'Recall the image',
    referenceAnswer: 'Core lesson',
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

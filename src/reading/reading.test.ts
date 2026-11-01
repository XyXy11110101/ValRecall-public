// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { createEmptyCard } from 'ts-fsrs';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseError, ValRecallRepository, migratePersistedItem } from '../database';
import { applyCaptureReward, DEFAULT_ALLOWANCE } from '../shared/allowance';
import {
  clozeFromSelection,
  newReadingDraft,
  readingDraftIssue,
  type ReadingDraft,
} from './reading-draft';
import { saveReading } from './save-reading';

const now = new Date('2026-10-01T12:00:00Z');
const source = {
  schemaVersion: 1 as const,
  excerpt: '原文第一段\n\nOriginal second paragraph.',
  bookTitle: '测试书',
  location: '第二章 · 第 42 页',
};
const input = () => ({
  title: '阅读题',
  coreLesson: '答案要点',
  recallPrompt: '解释这个概念？',
  referenceAnswer: '答案要点',
  itemType: 'Understand' as const,
  fsrsCard: createEmptyCard(now),
  readingSource: source,
});
const database = () =>
  new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'reading-test',
    clock: () => now,
  });
const draft = (): ReadingDraft => ({
  ...newReadingDraft(),
  excerpt: source.excerpt,
  recallPrompt: '解释这个概念？',
  coreLesson: '答案要点',
  bookTitle: source.bookTitle,
  location: source.location,
});

describe('reading data and capture semantics', () => {
  it('preserves source through create, unrelated edit, search and export/import', async () => {
    const repo = database();
    const item = await repo.createTextItem(input());
    await repo.updateItem(item.id, { title: '更新标题' });
    for (const query of ['测试书', 'Original second', '第 42 页', '解释这个概念', '答案要点']) {
      expect((await repo.listItems({ query })).map((entry) => entry.id)).toEqual([item.id]);
    }
    const exported = await repo.exportData();
    expect(exported.schemaVersion).toBe(11);
    expect(exported.items[0]).toMatchObject({ schemaVersion: 4, readingSource: source });
    const other = database();
    await other.importData(exported, 'replace');
    expect(await other.getItem(item.id)).toMatchObject({ readingSource: source });
    await repo.close();
    await other.close();
  });

  it('keeps schema-2 text, image and manual video identities', async () => {
    const repo = database();
    await repo.createTextItem(input());
    const base = {
      ...(await repo.exportData()).items[0]!,
      schemaVersion: 2,
      readingSource: undefined,
    };
    expect(migratePersistedItem(base)).toMatchObject({ sourceType: 'text', schemaVersion: 4 });
    expect(
      migratePersistedItem({
        ...base,
        sourceType: 'image',
        imageAssetId: 'asset',
        imageMimeType: 'image/png',
        imageWidth: 10,
        imageHeight: 20,
      }),
    ).toMatchObject({ sourceType: 'image', imageAssetId: 'asset' });
    expect(
      migratePersistedItem({
        ...base,
        sourceType: 'video',
        videoOrigin: 'library',
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
        canonicalUrl: null,
        videoId: 'AbCdEf_123-',
        videoTitle: '旧视频',
        timestampSeconds: null,
        timestampDisplay: null,
      }),
    ).toMatchObject({ sourceType: 'video', videoOrigin: 'library', timestampSeconds: null });
    const old = { ...(await repo.exportData()), schemaVersion: 6, items: [base] };
    Reflect.deleteProperty(old, 'notes');
    Reflect.deleteProperty(old, 'intakeReceipts');
    const other = database();
    await other.importData(old, 'replace');
    expect((await other.listItems())[0]).toMatchObject({ sourceType: 'text' });
    await repo.close();
    await other.close();
  });

  it('rejects malformed source without writing or partially replacing retained data', async () => {
    const repo = database();
    const item = await repo.createTextItem(input());
    await expect(
      repo.updateItem(item.id, { readingSource: { ...source, excerpt: ' ' } }),
    ).rejects.toThrow();
    const exported = await repo.exportData();
    const invalid = {
      ...exported,
      items: [{ ...exported.items[0], readingSource: { ...source, schemaVersion: 999 } }],
    };
    await expect(repo.importData(invalid, 'replace')).rejects.toThrow();
    expect(await repo.getItem(item.id)).toMatchObject({ readingSource: source });
    await repo.close();
  });

  it('masks every literal repeat while preserving lines and rejecting whole-paragraph/empty selection', () => {
    expect(clozeFromSelection('A+B 是符号。\n再问 A+B。', 0, 3)).toEqual({
      recallPrompt: '回忆空缺处的内容：\n［……］ 是符号。\n再问 ［……］。',
      coreLesson: 'A+B',
    });
    expect(clozeFromSelection('一段文字', 0, 4)).toBeNull();
    expect(clozeFromSelection('😀 中文 😀', 0, 2)?.recallPrompt).not.toContain('😀');
    expect(clozeFromSelection('abc', 2, 1)).toBeNull();
    expect(readingDraftIssue(newReadingDraft())).toContain('原文');
  });

  it('rewards a new capture once; repeat/recovery never invokes manual or capture reward again', async () => {
    const repo = database();
    let state = DEFAULT_ALLOWANCE;
    const reward = vi.fn(async () => {
      const result = applyCaptureReward(state, '2026-10-01', now.toISOString());
      state = result.state;
      return result;
    });
    const deps = {
      create: repo.createTextItem.bind(repo),
      get: repo.getItem.bind(repo),
      reward,
      clock: () => now,
    };
    const value = draft();
    const saved = await saveReading(value, 'standard', deps);
    expect(saved.item.fsrsCard.due).toEqual(now);
    expect(saved.allowance).toMatchObject({ captureReward: 2, checkInReward: 5, checkIn: true });
    const again = await saveReading(value, 'standard', deps);
    expect(again.warning).toBe('这条摘录已保存过。');
    expect(reward).toHaveBeenCalledTimes(1);
    const second = await saveReading({ ...value, id: 'second' }, 'standard', deps);
    expect(second.allowance).toMatchObject({ captureReward: 2, checkIn: false });
    expect(state.balance).toBe(9);
    expect(state.ledger.filter((entry) => entry.source === 'manual')).toHaveLength(0);
    await repo.close();
  });

  it('does not reward failed writes and separates reward failure from saved content', async () => {
    const repo = database();
    const reward = vi.fn(async () => {
      throw new Error('Storage down');
    });
    const value = draft();
    const failed = {
      create: vi.fn().mockRejectedValue(new DatabaseError('TRANSACTION_FAILED', 'write failed')),
      get: repo.getItem.bind(repo),
      reward,
    };
    await expect(saveReading(value, 'standard', failed)).rejects.toThrow('write failed');
    expect(reward).not.toHaveBeenCalled();
    const deps = { ...failed, create: repo.createTextItem.bind(repo), clock: () => now };
    expect((await saveReading(value, 'standard', deps)).warning).toContain('奖励未能确认');
    expect(await repo.getItem(value.id)).toBeDefined();
    await saveReading(value, 'standard', deps);
    expect(reward).toHaveBeenCalledTimes(1);
    await repo.close();
  });
});

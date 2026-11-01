// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ValRecallRepository } from './repository';
import { DraftRepository } from './drafts';
import { WalletRepository } from './wallet';
import { FsrsService } from '../fsrs';
import { getLearningReceipt } from './learning-commits';

function repository() {
  return new ValRecallRepository({ indexedDBFactory: new IDBFactory(), databaseName: 'backup' });
}
const input = {
  id: 'one',
  title: 'Private title',
  itemType: 'Understand' as const,
  recallPrompt: 'Private question?',
  coreLesson: 'Private answer',
  referenceAnswer: 'Private answer',
  fsrsCard: new FsrsService().createInitialCard(),
};
describe('reliability backup and retained anti-duplicate evidence', () => {
  it('round-trips unfinished text, selections and image bytes in v11 without earning rewards', async () => {
    const source = repository();
    const drafts = new DraftRepository(source);
    await drafts.save(
      {
        id: 'draft',
        scope: 'manual',
        summary: 'unfinished',
        payload: {
          question: '中文？',
          selected: ['a'],
          image: new Blob(['image bytes'], { type: 'image/png' }),
        },
      },
      0,
    );
    const backup = await source.exportData();
    expect(backup.schemaVersion).toBe(11);
    const target = repository();
    await target.importData(JSON.parse(JSON.stringify(backup)), 'replace', { restoreWallet: true });
    const restored = (await new DraftRepository(target).list('manual'))[0]!;
    expect(restored.payload).toMatchObject({ question: '中文？', selected: ['a'] });
    const payload = restored.payload as { image: Blob };
    expect(await payload.image.text()).toBe('image bytes');
    expect((await new WalletRepository(target).load()).balance).toBe(0);
    expect(await target.listItems()).toEqual([]);
  });
  it('keeps minimal receipts with the retained wallet after clearing and cannot resurrect deleted content', async () => {
    const source = repository();
    const commit = { id: 'op', kind: 'manual' as const, fingerprint: 'same' };
    await source.createTextItem(input, commit);
    await source.clearAll();
    expect((await new WalletRepository(source).load()).balance).toBe(3);
    expect(await getLearningReceipt(source, 'op')).toMatchObject({
      itemId: 'one',
      manualReward: 3,
    });
    expect(JSON.stringify(await source.exportData())).not.toContain('Private question');
    await expect(source.createTextItem(input, commit)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await source.listItems()).toEqual([]);
  });
  it('keeps existing receipt evidence when replacing content but retaining wallet', async () => {
    const source = repository();
    await source.createTextItem(input, { id: 'op', kind: 'manual', fingerprint: 'same' });
    const empty = await repository().exportData();
    await source.importData(empty, 'replace');
    expect(await getLearningReceipt(source, 'op')).toBeDefined();
    expect((await new WalletRepository(source).load()).balance).toBe(3);
  });
  it('rejects incomplete v11 backups before changing any existing content', async () => {
    const source = repository();
    await source.createTextItem(input);
    const backup = await source.exportData();
    delete backup.drafts;
    await expect(source.importData(backup, 'replace')).rejects.toThrow();
    expect(await source.listItems()).toHaveLength(1);
  });
});

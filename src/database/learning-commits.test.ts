// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { ValRecallRepository } from './repository';
import { WalletRepository } from './wallet';
import { DraftRepository } from './drafts';
import { FsrsService } from '../fsrs';
import { transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';
import { getLearningReceipt } from './learning-commits';

const now = new Date('2026-10-21T12:00:00Z');
function fixture() {
  const repository = new ValRecallRepository({
    databaseName: 'atomic',
    indexedDBFactory: new IDBFactory(),
    clock: () => now,
  });
  return {
    repository,
    wallet: new WalletRepository(repository),
    drafts: new DraftRepository(repository, () => now),
  };
}
const item = {
  id: 'one',
  title: 'A useful question',
  itemType: 'Understand' as const,
  recallPrompt: 'Why?',
  coreLesson: 'Because.',
  referenceAnswer: 'Because.',
  tags: [],
  fsrsCard: new FsrsService({ clock: () => now }).createInitialCard(),
};
describe('learning content and rewards commit together', () => {
  it('returns the original receipt after response loss without awarding twice', async () => {
    const { repository, wallet } = fixture();
    const commit = { id: 'op1', kind: 'manual' as const, fingerprint: 'same' };
    const first = await repository.createTextItem(item, commit);
    const repeated = await repository.createTextItem(
      { ...item, fsrsCard: new FsrsService().createInitialCard() },
      commit,
    );
    expect(repeated).toEqual(first);
    expect((await wallet.load()).balance).toBe(3);
    expect(await repository.listItems()).toHaveLength(1);
    expect((await getLearningReceipt(repository, commit.id))?.manualReward).toBe(3);
  });
  it('aborts content and reward when the submitted draft is stale', async () => {
    const { repository, wallet, drafts } = fixture();
    const draft = await drafts.save(
      { id: 'draft', scope: 'manual', summary: 'one', payload: { text: 'old' } },
      0,
    );
    await drafts.save({ ...draft, payload: { text: 'new' } }, draft.revision);
    await expect(
      repository.createTextItem(item, { id: 'op1', kind: 'manual', fingerprint: 'same', draft }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await repository.listItems()).toEqual([]);
    expect((await wallet.load()).balance).toBe(0);
    expect((await drafts.list('manual'))[0]?.payload).toEqual({ text: 'new' });
    expect(await getLearningReceipt(repository, 'op1')).toBeUndefined();
  });
  it('retains input and saves no formal item when the wallet is corrupt', async () => {
    const { repository, drafts } = fixture();
    const draft = await drafts.save(
      { id: 'draft', scope: 'manual', summary: 'one', payload: { text: 'kept' } },
      0,
    );
    const tx = (await repository.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: { balance: 'broken' } });
    await done;
    await expect(
      repository.createTextItem(item, { id: 'op1', kind: 'manual', fingerprint: 'same', draft }),
    ).rejects.toThrow();
    expect(await repository.listItems()).toEqual([]);
    expect(await drafts.list('manual')).toHaveLength(1);
  });
  it('removes a consumed draft and preserves the capture/check-in reward rules', async () => {
    const { repository, wallet, drafts } = fixture();
    const draft = await drafts.save(
      { id: 'draft', scope: 'manual', summary: 'one', payload: { text: 'ready' } },
      0,
    );
    await repository.createTextItem(item, {
      id: 'op1',
      kind: 'capture',
      fingerprint: 'same',
      draft,
    });
    expect(await drafts.list('manual')).toEqual([]);
    expect((await wallet.load()).balance).toBe(7);
    await expect(
      repository.createTextItem(item, { id: 'op1', kind: 'capture', fingerprint: 'changed' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await wallet.load()).balance).toBe(7);
  });
});

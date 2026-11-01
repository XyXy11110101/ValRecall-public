import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningItem } from '../database';
import { ValRecallRepository } from '../database';
import { installDraftMemoryPort } from '../testing/draft-port';
import { DetailEditor } from './MomentEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('moment editor discard', () => {
  let host: HTMLDivElement;
  let root: Root;
  let item: LearningItem;
  let drafts: ReturnType<typeof installDraftMemoryPort>;
  const onClose = vi.fn();
  beforeEach(async () => {
    drafts = installDraftMemoryPort();
    onClose.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const repository = new ValRecallRepository({
      databaseName: `moment-editor-${crypto.randomUUID()}`,
    });
    item = await repository.createTextItem({
      title: 'Saved title',
      itemType: 'Understand',
      recallPrompt: 'Saved question?',
      coreLesson: 'Saved answer',
      referenceAnswer: 'Saved answer',
      fsrsCard: createEmptyCard(new Date()),
    });
    repository.close();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () =>
      root.render(
        <DetailEditor
          item={item}
          categories={[]}
          busy={false}
          error={null}
          showDiagnostics={false}
          onClose={onClose}
          onSave={vi.fn()}
        />,
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const discard = () =>
    act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === '放弃修改')!
        .click(),
    );

  it('closes an unedited form at once', async () => {
    await discard();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('asks only after an edit, and keeps the edit when the answer is no', async () => {
    const question = [...host.querySelectorAll('label')]
      .find((label) => label.querySelector('span')?.textContent === '问题')!
      .querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        question,
        'Changed question?',
      );
      question.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await discard();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('放弃这次修改？');
    expect(onClose).not.toHaveBeenCalled();
    expect(question.value).toBe('Changed question?');

    vi.mocked(window.confirm).mockReturnValue(true);
    await discard();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect([...drafts.values()]).toHaveLength(0);
  });
});

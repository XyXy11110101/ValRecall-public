import { act, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../database/connection';
import { DraftRepository, type DraftValue } from '../database/drafts';
import { useDurableDraft } from './use-durable-draft';
import { DraftRecovery } from './DraftRecovery';
import { requestEditorLeaveAsync, useEditProtection } from './edit-protection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Form({
  repository,
  startId = 'fresh',
}: {
  repository: DraftRepository;
  startId?: string;
}) {
  const [id, setId] = useState(startId);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const payload = useMemo(() => ({ id, text, selected }), [id, text, selected]);
  const draft = useDurableDraft({
    id,
    scope: 'form',
    summary: text,
    payload,
    dirty: Boolean(text || selected.length),
    repository,
    onRestore(value: DraftValue, row) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        typeof value.text !== 'string' ||
        !Array.isArray(value.selected) ||
        !value.selected.every((key) => typeof key === 'string')
      )
        throw new Error('坏草稿');
      setId(row.id);
      setText(value.text);
      setSelected(value.selected as string[]);
    },
  });
  useEditProtection({
    dirty: Boolean(text || selected.length) && !draft.retained,
    busy: false,
    prepareLeave: draft.prepareLeave,
    draftVersion: draft.version,
  });
  return (
    <>
      <DraftRecovery draft={draft} />
      <textarea aria-label="内容" value={text} onChange={(event) => setText(event.target.value)} />
      <button onClick={() => setSelected(['甲', '乙'])}>选两题</button>
      <output>{selected.join(',')}</output>
      <button onClick={() => void draft.flush().catch(() => undefined)}>落盘</button>
      <button onClick={() => void draft.discardCurrent().catch(() => undefined)}>放弃当前</button>
      <button
        onClick={() => {
          setId('next');
          setText('第二份');
          setSelected([]);
        }}
      >
        新捕获
      </button>
    </>
  );
}
describe('explicit draft recovery against real IndexedDB', () => {
  let root: Root;
  let host: HTMLDivElement;
  let database: DatabaseConnection;
  let repository: DraftRepository;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    database = new DatabaseConnection(new IDBFactory(), 'recovery');
    repository = new DraftRepository(database);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  async function render(startId?: string) {
    await act(async () =>
      root.render(<Form repository={repository} {...(startId ? { startId } : {})} />),
    );
  }
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
  async function type(value: string) {
    await act(async () => {
      const input = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function until(check: () => void | Promise<void>) {
    for (let attempt = 0; attempt < 150; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      try {
        await check();
        return;
      } catch (error) {
        if (attempt === 149) throw error;
      }
    }
  }
  async function reopen() {
    await act(async () => root.unmount());
    database.close();
    root = createRoot(host);
    await render();
    await until(() => expect(host.textContent).toContain('发现以前未完成'));
  }

  it('reports saved only after persistence and restores exact bilingual text and selected questions after reopen', async () => {
    await render();
    await type('第一段\nEnglish / 中文输入');
    await act(async () => button('选两题').click());
    // Nothing claims "saved" before the write lands, and a quick write never flashes "saving".
    expect(host.textContent).not.toContain('已存草稿');
    expect(host.textContent).not.toContain('正在存草稿');
    // The status line is there from the first change, so it never appears later and
    // pushes the field being typed in.
    const line = host.querySelector('.draft-recovery [role=status]');
    expect(line?.textContent).toBe('\u00a0');
    const savingUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savingUnload);
    expect(savingUnload.defaultPrevented).toBe(true);
    await until(() => expect(host.textContent).toContain('已存草稿'));
    expect(host.querySelector('.draft-recovery [role=status]')).toBe(line);
    const savedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
    await reopen();
    expect(host.querySelector('textarea')?.value).toBe('');
    expect(host.querySelector('output')?.textContent).toBe('');
    await act(async () => button('继续').click());
    expect(host.querySelector('textarea')?.value).toBe('第一段\nEnglish / 中文输入');
    expect(host.querySelector('output')?.textContent).toBe('甲,乙');
  });
  it('keeps the saved status steady through later edits while retained follows each write', async () => {
    await render();
    await type('第一版');
    await until(() => expect(host.textContent).toContain('已存草稿'));
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(host.textContent ?? ''));
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    await type('第二版');
    // The newer input is not retained yet, so leaving is still protected.
    const pendingUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await until(() => {
      const savedUnload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(savedUnload);
      expect(savedUnload.defaultPrevented).toBe(false);
    });
    observer.disconnect();
    expect((await repository.list('form'))[0]?.payload).toMatchObject({ text: '第二版' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes('正在存草稿'))).toBe(false);
    expect(host.textContent).toContain('已存草稿');
  });
  it('shows "saving" only when a write is still pending after the notice delay', async () => {
    await render();
    const write = repository.save.bind(repository);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repository, 'save').mockImplementation(async (...args) => {
      await gate;
      return write(...args);
    });
    await type('慢速磁盘');
    await until(() => expect(host.textContent).toContain('正在存草稿'));
    release?.();
    await until(() => expect(host.textContent).toContain('已存草稿'));
    expect(host.textContent).not.toContain('正在存草稿');
  });
  it('flushes a last keystroke before leaving and keeps the editor on disk failure', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await render();
    await type('离开前最后一行');
    let allowed = false;
    await act(async () => {
      allowed = await requestEditorLeaveAsync();
    });
    expect(allowed).toBe(true);
    expect((await repository.list('form'))[0]?.payload).toMatchObject({ text: '离开前最后一行' });
    expect(confirm).not.toHaveBeenCalled();
    vi.spyOn(repository, 'save').mockRejectedValue(new Error('磁盘暂时无法写入'));
    await type('失败也留下');
    await act(async () => {
      allowed = await requestEditorLeaveAsync();
    });
    expect(allowed).toBe(false);
    expect(host.querySelector('textarea')?.value).toBe('失败也留下');
    expect(host.textContent).toContain('磁盘暂时无法写入');
  });
  it('later leaves the stored input untouched, and discard requires confirmation', async () => {
    await repository.save(
      { id: 'old', scope: 'form', summary: '昨天', payload: { text: '旧输入', selected: [] } },
      0,
    );
    await render();
    await until(() => expect(button('稍后')).toBeDefined());
    await act(async () => button('稍后').click());
    expect(host.querySelector('textarea')?.value).toBe('');
    expect(await repository.list('form')).toHaveLength(1);
    await reopen();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => button('放弃').click());
    expect(await repository.list('form')).toHaveLength(1);
    confirm.mockReturnValue(true);
    await act(async () => button('放弃').click());
    await until(async () => expect(await repository.list('form')).toEqual([]));
  });
  it('keeps a failed write visible and retries without clearing the field', async () => {
    await render();
    const write = vi.spyOn(repository, 'save').mockRejectedValueOnce(new Error('磁盘已满'));
    await type('保留这份输入');
    await act(async () => button('落盘').click());
    await until(() => expect(host.textContent).toContain('磁盘已满'));
    expect(host.querySelector('textarea')?.value).toBe('保留这份输入');
    expect(host.textContent).not.toContain('已存草稿');
    write.mockRestore();
    await act(async () => button('重试草稿').click());
    await until(() => expect(host.textContent).toContain('已存草稿'));
  });
  it('retains a changed draft when another window wins the revision', async () => {
    const saved = await repository.save(
      { id: 'old', scope: 'form', summary: '昨天', payload: { text: '旧输入', selected: [] } },
      0,
    );
    await render();
    await until(() => expect(button('继续')).toBeDefined());
    await act(async () => button('继续').click());
    // Let the restored payload settle before simulating a concurrent writer.
    await act(async () => button('落盘').click());
    await until(() => expect(host.textContent).toContain('已存草稿'));
    const latest = (await repository.list('form'))[0]!;
    await repository.save(
      { ...saved, payload: { text: '另一窗口', selected: [] } },
      latest.revision,
    );
    await type('本窗口仍需保留');
    await act(async () => button('落盘').click());
    await until(() => expect(host.textContent).toContain('已在其他窗口修改'));
    expect(host.querySelector('textarea')?.value).toBe('本窗口仍需保留');
    expect((await repository.list('form'))[0]?.payload).toEqual({ text: '另一窗口', selected: [] });
  });
  it('keeps the last input when a new capture arrives before the debounce fires', async () => {
    await render();
    await type('第一份最后一行');
    await act(async () => button('新捕获').click());
    await act(async () => button('落盘').click());
    await until(async () => expect(await repository.list('form')).toHaveLength(2));
    const rows = await repository.list('form');
    expect(rows.find((row) => row.id === 'fresh')?.payload).toMatchObject({
      text: '第一份最后一行',
    });
    expect(rows.find((row) => row.id === 'next')?.payload).toMatchObject({ text: '第二份' });
  });
  it('a late discard completion never marks a newly arrived draft committed', async () => {
    await render();
    await type('旧捕获');
    const discard = repository.discard.bind(repository);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = vi.spyOn(repository, 'discard').mockImplementation(async (token) => {
      await gate;
      return discard(token);
    });
    await act(async () => button('放弃当前').click());
    await until(() => expect(pending).toHaveBeenCalledOnce());
    await act(async () => button('新捕获').click());
    await act(async () => {
      release?.();
      await gate;
    });
    await type('新捕获继续编辑');
    await act(async () => button('落盘').click());
    await until(async () =>
      expect(
        (await repository.list('form')).find((row) => row.id === 'next')?.payload,
      ).toMatchObject({ text: '新捕获继续编辑' }),
    );
    expect((await repository.list('form')).some((row) => row.id === 'fresh')).toBe(false);
  });
});

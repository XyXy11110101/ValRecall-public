import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKING_CARD_STORAGE_KEY } from '../models/working-card';
import { TaskTrialSettings, type TaskTrialReader } from './TaskTrialSettings';

vi.mock('./services', () => ({ repository: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubStorage(stored: unknown) {
  const values: Record<string, unknown> =
    stored === undefined ? {} : { [WORKING_CARD_STORAGE_KEY]: stored };
  const set = vi.fn(async (items: Record<string, unknown>) => void Object.assign(values, items));
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
        set,
        remove: vi.fn(async () => undefined),
      },
    },
  });
  return { values, set };
}

const reader = (): TaskTrialReader => ({
  listTasks: vi.fn().mockResolvedValue([]),
  listTaskCompletions: vi.fn().mockResolvedValue([]),
});
const trial = { startedOn: '2026-10-30', openOneOffsAtStart: 8, starts: 5 };

describe('TaskTrialSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const mount = (source: TaskTrialReader, date: Date) =>
    act(async () => root.render(<TaskTrialSettings reader={source} clock={() => date} />));
  const openDetails = () =>
    act(async () => {
      const details = container.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });

  it('reads nothing until the comparison is opened', async () => {
    stubStorage({ version: 1, trial });
    const source = reader();
    await mount(source, new Date(2026, 10, 1, 12));
    expect(source.listTasks).not.toHaveBeenCalled();
    await openDetails();
    expect(source.listTasks).toHaveBeenCalled();
    expect(container.textContent).toContain('第 3/14 天，2026-11-13 起可以看对比。');
    expect(container.querySelector('table')).toBeNull();
  });

  it('says when no trial has started', async () => {
    stubStorage(undefined);
    await mount(reader(), new Date(2026, 10, 1, 12));
    await openDetails();
    expect(container.textContent).toContain('点待办上的「开始」后开始计算。');
  });

  it('shows numbers only once the window has closed', async () => {
    stubStorage({ version: 1, trial });
    await mount(reader(), new Date(2026, 10, 13, 12));
    await openDetails();
    const table = container.querySelector('table');
    expect(table?.textContent).toContain('前 14 天');
    expect(table?.textContent).toContain('还开着的一次性任务');
    expect([...table!.querySelectorAll('tbody tr')].at(-1)?.textContent).toContain('5');
  });

  it('turns the card off at once, clearing what was written and keeping the trial', async () => {
    const { values } = stubStorage({
      version: 1,
      current: { taskId: 'a', startedOn: '2026-10-30' },
      notes: [{ taskId: 'a', text: 'note', date: '2026-10-30' }],
      trial,
    });
    await mount(reader(), new Date(2026, 10, 1, 12));
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    expect(box.checked).toBe(false);
    expect(values[WORKING_CARD_STORAGE_KEY]).toMatchObject({
      enabled: false,
      current: null,
      notes: [],
      trial,
    });
  });

  it('reports a failed switch and keeps the old value', async () => {
    const { set } = stubStorage({ version: 1 });
    set.mockRejectedValueOnce(new Error('quota'));
    await mount(reader(), new Date(2026, 10, 1, 12));
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    expect(box.checked).toBe(true);
    expect(container.textContent).toContain('开关没保存，请重试。');
  });

  it('reports a failed read of the comparison', async () => {
    stubStorage({ version: 1, trial });
    const source = reader();
    vi.mocked(source.listTasks).mockRejectedValue(new Error('db'));
    await mount(source, new Date(2026, 10, 1, 12));
    await openDetails();
    expect(container.textContent).toContain('对比没加载出来。');
  });
});

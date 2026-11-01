import { useState } from 'react';
import type { DailyTask, TaskCompletion } from '../models/daily-task';
import { localDateKey } from '../models/daily-task';
import { buildTaskTrialSummary, type TaskTrialSummary } from '../models/task-trial';
import { setWorkingEnabled } from '../models/working-card';
import { Notice } from '../shared/components';
import { repository } from './services';
import { useWorkingCard } from './use-working-card';
import './working-card.css';

export interface TaskTrialReader {
  listTasks(): Promise<DailyTask[]>;
  listTaskCompletions(): Promise<TaskCompletion[]>;
}

const systemClock = () => new Date();

/** The on/off switch for the 工作中 card, and the two-week comparison that decides its future. */
export function TaskTrialSettings({
  reader = repository,
  clock = systemClock,
}: {
  reader?: TaskTrialReader;
  clock?: () => Date;
}) {
  const card = useWorkingCard();
  const [summary, setSummary] = useState<TaskTrialSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { trial } = card.state;

  async function loadSummary() {
    if (!trial) return;
    try {
      const [tasks, completions] = await Promise.all([
        reader.listTasks(),
        reader.listTaskCompletions(),
      ]);
      setSummary(buildTaskTrialSummary(trial, tasks, completions, localDateKey(clock())));
      setError(null);
    } catch {
      setError('对比没加载出来。');
    }
  }

  return (
    <div className="card stack">
      <h3>工作中卡片</h3>
      <label className="cluster">
        <input
          style={{ width: 'auto' }}
          type="checkbox"
          checked={card.state.enabled}
          disabled={!card.ready}
          onChange={(event) => {
            const enabled = event.target.checked;
            void card
              .update((state) => setWorkingEnabled(state, enabled))
              .then(
                () => setError(null),
                () => setError('开关没保存，请重试。'),
              );
          }}
        />
        <span>在首页待办里显示</span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      {__VALRECALL_PUBLIC_RELEASE__
        ? null
        : card.ready && (
            <details
              onToggle={(event) => {
                if (event.currentTarget.open) void loadSummary();
              }}
            >
              <summary>两周对比</summary>
              {!trial && <p className="muted small">点待办上的「开始」后开始计算。</p>}
              {trial && summary?.locked && (
                <p className="muted small">
                  第 {summary.day}/14 天，{summary.unlocksOn} 起可以看对比。
                </p>
              )}
              {trial && summary && !summary.locked && (
                <table className="task-trial-table">
                  <thead>
                    <tr>
                      <th scope="col" />
                      <th scope="col">前 14 天</th>
                      <th scope="col">后 14 天</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">一次性任务完成</th>
                      <td>{summary.before.oneOff}</td>
                      <td>{summary.after.oneOff}</td>
                    </tr>
                    <tr>
                      <th scope="row">高优先任务完成</th>
                      <td>{summary.before.highPriority}</td>
                      <td>{summary.after.highPriority}</td>
                    </tr>
                    <tr>
                      <th scope="row">全部完成</th>
                      <td>{summary.before.all}</td>
                      <td>{summary.after.all}</td>
                    </tr>
                    <tr>
                      <th scope="row">还开着的一次性任务（开始时 / 现在）</th>
                      <td>{summary.openOneOffsAtStart}</td>
                      <td>{summary.openOneOffsNow}</td>
                    </tr>
                    <tr>
                      <th scope="row">点「开始」的次数</th>
                      <td>—</td>
                      <td>{summary.starts}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </details>
          )}
    </div>
  );
}

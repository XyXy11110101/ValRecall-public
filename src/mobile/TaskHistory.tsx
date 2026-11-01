import { useState, type ReactNode } from 'react';
import type { TaskHistoryGroup } from './task-progress';
import type { MobileTaskRow } from './task-presentation';

export function TaskHistory({
  groups,
  timeZone,
  renderRows,
}: {
  groups: TaskHistoryGroup[];
  timeZone: string;
  renderRows: (rows: MobileTaskRow[]) => ReactNode;
}) {
  const [limit, setLimit] = useState(30);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({});
  const date = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium' }).format(new Date(value));
  return (
    <section className="mobile-module mobile-history" aria-label="按任务查看完成历史">
      {groups.length === 0 && <p className="mobile-empty">还没有完成记录。</p>}
      {groups.slice(0, limit).map((group) => (
        <details
          key={group.taskId}
          open={expanded[group.taskId] ?? false}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setExpanded((value) =>
              value[group.taskId] === open ? value : { ...value, [group.taskId]: open },
            );
          }}
        >
          <summary id={'mobile-history-group-' + group.taskId}>
            <span>
              <strong>{group.title}</strong>
              <span className="mobile-muted">
                完成 {group.rows.length} 次 · 最近 {date(group.latestAt)}
              </span>
            </span>
          </summary>
          {expanded[group.taskId] && (
            <>
              {renderRows(group.rows.slice(0, rowLimits[group.taskId] ?? 30))}
              {group.rows.length > (rowLimits[group.taskId] ?? 30) && (
                <button
                  className="mobile-text-button"
                  onClick={() =>
                    setRowLimits((value) => ({
                      ...value,
                      [group.taskId]: (value[group.taskId] ?? 30) + 30,
                    }))
                  }
                >
                  加载更多完成记录
                </button>
              )}
            </>
          )}
        </details>
      ))}
      {groups.length > limit && (
        <button className="mobile-text-button" onClick={() => setLimit(limit + 30)}>
          加载更多任务
        </button>
      )}
    </section>
  );
}

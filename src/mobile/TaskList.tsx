import { useEffect, useRef, useState } from 'react';
import type { MobileTaskRow } from './task-presentation';

function Notes({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className={'mobile-notes' + (expanded ? ' is-expanded' : '')}
      aria-expanded={expanded}
      aria-label={expanded ? '收起备注' : '展开备注'}
      onClick={() => setExpanded(!expanded)}
    >
      {text}
    </button>
  );
}

export function TaskList({
  rows,
  disabled,
  timeZone,
  onComplete,
  onAction,
  idPrefix = 'mobile-task-',
  showNotes = true,
}: {
  rows: MobileTaskRow[];
  disabled: boolean;
  timeZone: string;
  onComplete: (row: MobileTaskRow) => void;
  onAction: (row: MobileTaskRow, action: 'undo-task' | 'cancel-task' | 'restore-task') => void;
  idPrefix?: string;
  showNotes?: boolean;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      list.current
        ?.querySelectorAll<HTMLDetailsElement>('.mobile-task-more[open]')
        .forEach((menu) => {
          if (event instanceof KeyboardEvent || !menu.contains(event.target as Node)) {
            menu.open = false;
            if (event instanceof KeyboardEvent) menu.querySelector('summary')?.focus();
          }
        });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, []);
  return (
    <ul className="mobile-task-list" ref={list}>
      {rows.map((row) => {
        const { task } = row;
        const done = row.state === 'completed';
        const skipped = row.state === 'skipped';
        const action = done ? 'undo-task' : skipped ? 'restore-task' : 'cancel-task';
        const label = done
          ? '撤销完成'
          : skipped
            ? '恢复今天'
            : task.recurrence === 'specific_date'
              ? '不做了'
              : '今天不做';
        return (
          <li
            key={task.id + ':' + row.date}
            id={idPrefix + task.id + (done || skipped ? '-' + row.date : '')}
            tabIndex={-1}
            className={
              'mobile-task' +
              (done ? ' is-done' : '') +
              (done && !row.pending ? ' is-confirmed' : '')
            }
          >
            {row.state === 'open' ? (
              <button
                type="button"
                className="mobile-complete"
                aria-label={task.title + '：标记完成'}
                disabled={disabled}
                onClick={() => onComplete(row)}
              >
                <span className="mobile-checkbox" aria-hidden="true" />
              </button>
            ) : (
              <span className="mobile-task-symbol" aria-hidden="true">
                {done ? '✓' : skipped ? '−' : '·'}
              </span>
            )}
            <div className="mobile-task-copy">
              <h3>{task.title}</h3>
              {showNotes && task.notes && <Notes text={task.notes} />}
              <p className="mobile-task-meta">
                {[
                  done
                    ? new Intl.DateTimeFormat('zh-CN', {
                        timeZone,
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(row.completedAt!))
                    : task.recurrence === 'specific_date'
                      ? row.date
                      : task.recurrence === 'daily'
                        ? '每天'
                        : '每周指定星期',
                  !done ? task.scheduledTime : null,
                  !done && task.priority !== 'normal'
                    ? task.priority === 'high'
                      ? '优先'
                      : '稍后'
                    : null,
                  row.pending ? '待同步' : null,
                  done && !row.pending
                    ? __VALRECALL_PUBLIC_RELEASE__ || row.rewardAmount == null
                      ? '已确认'
                      : '已确认 +' + row.rewardAmount + ' 元'
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <details className="mobile-task-more">
              <summary aria-label={task.title + '：更多操作'}>
                <svg
                  aria-hidden="true"
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <circle cx="5" cy="12" r="1.7" />
                  <circle cx="12" cy="12" r="1.7" />
                  <circle cx="19" cy="12" r="1.7" />
                </svg>
              </summary>
              <div className="mobile-task-menu">
                <button
                  type="button"
                  aria-label={task.title + '：' + label}
                  disabled={disabled}
                  onClick={(event) => {
                    const menu = event.currentTarget.closest('details');
                    if (menu) {
                      menu.open = false;
                      menu.querySelector('summary')?.focus();
                    }
                    onAction(row, action);
                  }}
                >
                  {label}
                </button>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

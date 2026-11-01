import type { TaskProgress as Progress } from './task-progress';
import { MobileIcon } from './MobileIcon';

export function TaskProgress({
  progress,
  onHistory,
}: {
  progress: Progress;
  onHistory: () => void;
}) {
  const max = Math.max(1, ...progress.days.map((day) => day.count));
  return (
    <section className="mobile-module mobile-progress" aria-labelledby="mobile-progress-heading">
      <h2 id="mobile-progress-heading">任务进展</h2>
      <dl className="mobile-progress-totals">
        <div>
          <dt>今天完成</dt>
          <dd>
            {progress.today.length}
            <span>次</span>
          </dd>
        </div>
        <div>
          <dt>近七天完成</dt>
          <dd>
            {progress.total}
            <span>次</span>
          </dd>
        </div>
      </dl>
      <p className="mobile-muted mobile-progress-range">
        {progress.days[0]?.date.slice(5).replace('-', '/')} —{' '}
        {progress.days[6]?.date.slice(5).replace('-', '/')}
      </p>
      <ol className="mobile-progress-chart" aria-label="近七天每日完成次数">
        {progress.days.map((day, index) => (
          <li
            key={day.date}
            className={index === 6 ? 'is-today' : ''}
            aria-label={
              `${day.date}：完成 ${day.count} 次` + (day.pending ? `，${day.pending} 次待同步` : '')
            }
          >
            <span className="mobile-progress-number">{day.count}</span>
            <span className="mobile-progress-track" aria-hidden="true">
              <span style={{ height: `${(day.count / max) * 100}%` }} />
            </span>
            <span>{index === 6 ? '今天' : `${Number(day.date.slice(8))}日`}</span>
          </li>
        ))}
      </ol>
      {progress.pending > 0 && <p className="mobile-muted">其中 {progress.pending} 次待同步</p>}
      <button id="mobile-open-history" className="mobile-settings-row" onClick={onHistory}>
        <MobileIcon name="history" />
        查看完成历史
        <MobileIcon name="chevron" />
      </button>
    </section>
  );
}

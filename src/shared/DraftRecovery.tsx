import './draft-recovery.css';
import type { DurableDraftController } from './use-durable-draft';

export function DraftRecovery({
  draft,
  disabled = false,
}: {
  draft: DurableDraftController;
  disabled?: boolean;
}) {
  if (draft.available.length === 0 && draft.status === 'idle' && !draft.error) return null;
  return (
    <section className="stack draft-recovery" aria-label="草稿恢复">
      {draft.available.length > 0 && (
        <div className="card stack">
          <p>发现以前未完成的草稿</p>
          <ul>
            {draft.available.map((row) => (
              <li key={row.id} className="stack">
                <span>
                  {row.summary || '未命名草稿'} ·{' '}
                  <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>
                </span>
                <div className="cluster">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => void draft.restore(row)}
                  >
                    继续
                  </button>
                  <button
                    type="button"
                    className="button text-button"
                    disabled={disabled}
                    onClick={() => void draft.discard(row)}
                  >
                    放弃
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button text-button"
            disabled={disabled}
            onClick={draft.later}
          >
            稍后
          </button>
        </div>
      )}
      {draft.status !== 'idle' && (
        // Until the first save lands the line keeps its height but says nothing, so the form
        // never jumps and nothing claims a save that has not happened.
        <p role="status" className="muted small" data-draft-status={draft.status}>
          {draft.status === 'pending'
            ? '\u00a0'
            : draft.status === 'saving'
              ? '正在存草稿…'
              : draft.status === 'saved'
                ? '已存草稿'
                : '存草稿失败'}
        </p>
      )}
      {draft.error && (
        <div role="alert">
          <p>{draft.error}</p>
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() => void draft.retry()}
          >
            重试草稿
          </button>
        </div>
      )}
    </section>
  );
}

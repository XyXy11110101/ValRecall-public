import { useEffect, useRef, useState } from 'react';
import { IntakeView } from '../intake/IntakeView';
import type { ValRecallPreferences } from '../shared/preferences';
import { ManualQuestionForm, type ManualQuestionSource } from './ManualQuestionForm';
import './add-workspace.css';

export interface AddEntryRequest {
  key: number;
  mode: 'receive' | 'manual';
  source?: ManualQuestionSource;
  categoryId?: string | null;
}
const pristine = { dirty: false, busy: false };

/** Both modes stay mounted: switching is organization, never implicit discard. */
export function AddWorkspace({
  active,
  request,
  preferences,
  onChanged,
  onViewItem,
}: {
  active: boolean;
  request: AddEntryRequest;
  preferences: ValRecallPreferences;
  onChanged: () => void;
  onViewItem: (id: string) => void;
}) {
  // The public edition has only the manual form, whatever route or request asked for this page.
  const [mode, setMode] = useState<AddEntryRequest['mode']>(
    __VALRECALL_PUBLIC_RELEASE__ ? 'manual' : request.mode,
  );
  const [intakeState, setIntakeState] = useState(pristine);
  const [manualState, setManualState] = useState(pristine);
  const [sourceRequest, setSourceRequest] = useState({
    key: request.key,
    ...(request.source ? { source: request.source } : {}),
    ...(request.categoryId !== undefined ? { categoryId: request.categoryId } : {}),
  });
  const applied = useRef(request.key);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = intakeState.busy || manualState.busy;
  useEffect(() => {
    if (applied.current === request.key) return;
    applied.current = request.key;
    setMode(__VALRECALL_PUBLIC_RELEASE__ ? 'manual' : request.mode);
    if (request.source || request.categoryId !== undefined) {
      setSourceRequest({
        key: request.key,
        ...(request.source ? { source: request.source } : {}),
        ...(request.categoryId !== undefined ? { categoryId: request.categoryId } : {}),
      });
    }
  }, [request]);
  useEffect(() => {
    if (active) heading.current?.focus();
  }, [active, request.key]);
  return (
    <section className="add-workspace stack" aria-busy={busy}>
      <header>
        <h2 className="dashboard-page-heading" data-editor-return-focus ref={heading} tabIndex={-1}>
          添加回忆题
        </h2>
      </header>
      {__VALRECALL_PUBLIC_RELEASE__ ? null : (
        <div className="add-mode-switch" role="group" aria-label="添加方式">
          <button
            className="button secondary"
            aria-pressed={mode === 'manual'}
            disabled={busy}
            onClick={() => setMode('manual')}
          >
            手动创建
          </button>
          <button
            className="button secondary"
            aria-pressed={mode === 'receive'}
            disabled={busy}
            onClick={() => setMode('receive')}
          >
            接收 ChatGPT 整理
          </button>
        </div>
      )}
      {__VALRECALL_PUBLIC_RELEASE__ ? null : (
        <div hidden={mode !== 'receive'}>
          <IntakeView
            protectionActive={active}
            active={active && mode === 'receive'}
            embedded
            preferences={preferences}
            onChanged={onChanged}
            onViewItem={onViewItem}
            onDraftStateChange={setIntakeState}
          />
        </div>
      )}
      <div hidden={mode !== 'manual'}>
        <ManualQuestionForm
          embedded
          protectionActive={active}
          active={active && mode === 'manual'}
          preferences={preferences}
          sourceRequest={sourceRequest}
          onSaved={onChanged}
          onViewItem={onViewItem}
          onDraftStateChange={setManualState}
        />
      </div>
    </section>
  );
}

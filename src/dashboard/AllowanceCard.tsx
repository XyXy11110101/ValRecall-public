import { useState, type FormEvent } from 'react';

import {
  addAllowance,
  formatAddConfirmation,
  formatSpendConfirmation,
  spendAllowance,
  type AllowanceState,
} from '../shared/allowance';
import { Notice } from '../shared/components';
import { useOperation } from '../shared/use-operation';
import { useEditProtection } from '../shared/edit-protection';
import { MotionCount } from '../ui/motion';

export function AllowanceCard({
  state,
  busy = false,
  showSummary = true,
  onAdd,
  onSpend,
}: {
  state: AllowanceState;
  busy?: boolean;
  showSummary?: boolean;
  onAdd?: (amount: number, note: string) => Promise<boolean> | boolean;
  onSpend: (amount: number, note: string) => Promise<boolean> | boolean;
}) {
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const operation = useOperation();
  const working = busy || operation.busy;
  useEditProtection({ dirty: false, busy: () => busy || operation.pending.current });
  const spendDisabled = working || state.balance <= 0;
  const addDisabled = working || !onAdd;

  async function submit(kind: 'add' | 'spend') {
    if (busy || !operation.begin()) return;
    try {
      setConfirmation(null);
      const amount = Number(amountText);
      if (kind === 'add') {
        if (!onAdd) return;
        const preview = addAllowance(state, amount);
        if (!preview.ok) {
          setError(preview.error.message);
          return;
        }
        const accepted = await onAdd(amount, note.trim());
        if (!accepted) {
          setError('零花钱无法更新。');
          return;
        }
        setError(null);
        setConfirmation(formatAddConfirmation(amount, note));
        setAmountText('');
        setNote('');
        return;
      }
      const preview = spendAllowance(state, amount);
      if (!preview.ok) {
        setError(preview.error.message);
        return;
      }
      const accepted = await onSpend(amount, note.trim());
      if (!accepted) {
        setError('零花钱无法更新。');
        return;
      }
      setError(null);
      setConfirmation(formatSpendConfirmation(amount, note));
      setAmountText('');
      setNote('');
    } catch {
      setError('没能更新，请重试。');
    } finally {
      operation.finish();
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit('spend');
  }

  return (
    <section className="card home-allowance-card" aria-label={onAdd ? '花掉或加入' : '零花钱'}>
      {showSummary && (
        <div className="home-allowance-stats" aria-label="零花钱摘要">
          <p className="home-allowance-stat" data-allowance-stat="balance">
            <MotionCount value={state.balance} as="strong" />
            <span>当前余额</span>
          </p>
          <p className="home-allowance-stat" data-allowance-stat="streak">
            <MotionCount value={state.currentStreak} as="strong" />
            <span>连续天数</span>
          </p>
        </div>
      )}
      {confirmation && <Notice tone="success">{confirmation}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <form
        className={`home-allowance-spend${onAdd ? ' home-allowance-adjust' : ''}`}
        onSubmit={(event) => void onSubmit(event)}
      >
        <label>
          金额
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={amountText}
            disabled={working}
            onChange={(event) => setAmountText(event.target.value)}
          />
        </label>
        <label>
          备注
          <input
            type="text"
            value={note}
            disabled={working}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="home-allowance-actions">
          <button
            className="button motion-press"
            type="submit"
            data-allowance-action="spend"
            disabled={spendDisabled}
          >
            花掉
          </button>
          {onAdd && (
            <button
              className="button secondary motion-press"
              type="button"
              data-allowance-action="add"
              disabled={addDisabled}
              onClick={() => void submit('add')}
            >
              加入
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

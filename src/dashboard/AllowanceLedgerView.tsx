import { useEffect, useRef, useState, type RefObject } from 'react';

import {
  addStoredAllowance,
  allowanceLedgerLabel,
  loadAllowance,
  spendStoredAllowance,
  type AllowanceLedgerEntry,
  type AllowanceState,
} from '../shared/allowance';
import { Notice } from '../shared/components';
import { MotionCount, MotionDisclosure } from '../ui/motion';
import { AllowanceCard } from './AllowanceCard';

export function AllowanceLedgerView({
  allowanceLoader = loadAllowance,
  allowanceAdd = addStoredAllowance,
  allowanceSpend = spendStoredAllowance,
}: {
  allowanceLoader?: () => Promise<AllowanceState>;
  allowanceAdd?: (
    amount: number,
    note?: string,
  ) => Promise<{ ok: true; value: AllowanceState } | { ok: false; error: { message: string } }>;
  allowanceSpend?: (
    amount: number,
    note?: string,
  ) => Promise<{ ok: true; value: AllowanceState } | { ok: false; error: { message: string } }>;
}) {
  const [state, setState] = useState<AllowanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const ledgerToggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setState(null);
    setError(null);
    void allowanceLoader()
      .then((loaded) => {
        if (active) setState(loaded);
      })
      .catch(() => {
        if (active) setError('零花钱记录无法加载。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [allowanceLoader, loadAttempt]);

  async function update(
    writer: (
      amount: number,
      note: string,
    ) => Promise<{ ok: true; value: AllowanceState } | { ok: false; error: { message: string } }>,
    amount: number,
    note: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const result = await writer(amount, note);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setState(result.value);
      return true;
    } catch {
      setError('零花钱无法更新。');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack allowance-ledger-view" aria-labelledby="allowance-ledger-heading">
      <h2 className="dashboard-page-heading" id="allowance-ledger-heading" tabIndex={-1}>
        零花钱记录
      </h2>
      {error && <Notice tone="error">{error}</Notice>}
      {loading ? (
        <section className="card dashboard-loading-state" role="status">
          <span className="motion-loading-indicator" aria-hidden="true" />
          <span>正在加载零花钱…</span>
        </section>
      ) : state === null ? (
        <div className="cluster">
          <button
            className="button secondary motion-press"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            重试加载
          </button>
        </div>
      ) : (
        <>
          <div className="allowance-ledger-summary" aria-label="零花钱合计">
            <p>
              <MotionCount value={state.balance} as="strong" />
              <span>当前余额</span>
            </p>
            <p>
              <MotionCount value={state.totalEarned} as="strong" />
              <span>累计进入</span>
            </p>
            <p>
              <MotionCount value={state.totalSpent} as="strong" />
              <span>累计花掉</span>
            </p>
          </div>
          <AllowanceCard
            state={state}
            showSummary={false}
            busy={busy}
            onAdd={(amount, note) => update(allowanceAdd, amount, note)}
            onSpend={(amount, note) => update(allowanceSpend, amount, note)}
          />
          <AllowanceLedgerList
            entries={state.ledger}
            open={ledgerOpen}
            toggleRef={ledgerToggleRef}
            onToggle={() => setLedgerOpen((value) => !value)}
          />
        </>
      )}
    </section>
  );
}

function AllowanceLedgerList({
  entries,
  open,
  toggleRef,
  onToggle,
}: {
  entries: readonly AllowanceLedgerEntry[];
  open: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}) {
  if (entries.length === 0) {
    return (
      <section className="card" data-allowance-ledger="empty">
        <p className="muted">还没有进出记录。</p>
      </section>
    );
  }
  return (
    <section className="card allowance-ledger-card" aria-labelledby="allowance-ledger-list-heading">
      <button
        className="button secondary motion-press allowance-ledger-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="allowance-ledger-panel"
        id="allowance-ledger-list-heading"
        ref={toggleRef}
        onClick={onToggle}
      >
        {open ? '收起流水' : `进出明细（${entries.length}）`}
      </button>
      <MotionDisclosure
        open={open}
        id="allowance-ledger-panel"
        className="allowance-ledger-disclosure"
        returnFocusRef={toggleRef}
      >
        <ol className="allowance-ledger-list">
          {entries.map((entry) => (
            <li
              className="allowance-ledger-row"
              data-allowance-kind={entry.kind}
              data-allowance-source={entry.source}
              key={entry.id}
            >
              <span className="allowance-ledger-amount">
                {entry.kind === 'earn' ? '+' : '−'}
                {entry.amount}
              </span>
              <span className="allowance-ledger-copy">
                <strong>{allowanceLedgerLabel(entry)}</strong>
                <span className="muted small">{entry.date}</span>
              </span>
            </li>
          ))}
        </ol>
      </MotionDisclosure>
    </section>
  );
}

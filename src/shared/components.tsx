import { useState, type ReactNode } from 'react';

import type { ExtractionDiagnostic } from '../models/extraction';

export function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <h1 className="brand-name">
          Val<span>Recall</span>
        </h1>
      </div>
    </header>
  );
}

export function Diagnostics({
  diagnostics,
  open = false,
}: {
  diagnostics: ExtractionDiagnostic[];
  open?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState('');

  async function copyTechnicalDetails(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(formatRedactedDiagnostics(diagnostics));
      setCopyStatus('已复制技术详情。');
    } catch {
      setCopyStatus('技术详情无法复制。');
    }
  }

  return (
    <details className="diagnostics" open={open}>
      <summary>技术提取详情（{diagnostics.length}）</summary>
      {diagnostics.length === 0 ? (
        <p className="muted small">没有记录诊断信息。</p>
      ) : (
        <ul className="diagnostic-list">
          {diagnostics.map((entry, index) => (
            <li key={`${entry.field}-${entry.strategy}-${index}`}>
              <strong>{entry.field}</strong> · {entry.strategy} · {entry.status}: {entry.message}
            </li>
          ))}
        </ul>
      )}
      {diagnostics.length > 0 ? (
        <div className="cluster diagnostics-actions">
          <button
            className="button secondary small-button"
            type="button"
            onClick={() => void copyTechnicalDetails()}
          >
            复制技术详情
          </button>
          <span className="muted small" role="status" aria-live="polite">
            {copyStatus}
          </span>
        </div>
      ) : null}
    </details>
  );
}

export function formatRedactedDiagnostics(diagnostics: readonly ExtractionDiagnostic[]): string {
  return diagnostics
    .map((entry) => {
      const message = entry.message
        .replace(/\b(?:https?:\/\/|www\.)\S+/giu, '[redacted URL]')
        .replace(/[\r\n\t]+/gu, ' ')
        .slice(0, 500);
      return `${entry.field} | ${entry.strategy} | ${entry.status} | ${entry.severity}: ${message}`;
    })
    .join('\n');
}

export function Notice({
  children,
  tone = 'info',
  leading,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'error' | 'success';
  /** Optional decorative art before the message, such as the companion's worried face. */
  leading?: ReactNode;
}) {
  const toneClass = tone === 'info' ? '' : ` ${tone}`;
  if (leading) {
    return (
      <div
        className={`notice notice-with-leading${toneClass}`}
        role={tone === 'error' ? 'alert' : 'status'}
      >
        <span className="notice-leading" aria-hidden="true">
          {leading}
        </span>
        <div className="notice-body">{children}</div>
      </div>
    );
  }
  return (
    <div className={`notice${toneClass}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * A visually hidden polite announcement. The region stays mounted, so the first result is
 * spoken; the keyed child is replaced on every new `seq`, so an identical sentence is spoken
 * again. It takes no space: use it for results that the page already shows visually.
 */
export function LiveStatus({
  text,
  seq,
  className = 'sr-only',
}: {
  text: string | null;
  seq: number;
  /** The visually-hidden class of the surface; the desktop default is `sr-only`. */
  className?: string;
}) {
  return (
    <p className={className} role="status" aria-live="polite">
      {text ? <span key={seq}>{text}</span> : null}
    </p>
  );
}

interface SourceContextDisclosureProps {
  before?: readonly string[];
  current?: readonly string[];
  after?: readonly string[];
  summary?: string;
  summaryAriaLabel?: string;
  children?: ReactNode;
  open?: boolean;
}

interface SourceContextExcerptProps {
  before?: readonly string[];
  current?: readonly string[];
  after?: readonly string[];
  label?: string;
  className?: string;
}

interface SourceContextLine {
  kind: 'before' | 'current' | 'after';
  text: string;
}

const MAX_SOURCE_CONTEXT_LINE_LENGTH = 320;

export function SourceContextDisclosure({
  before = [],
  current = [],
  after = [],
  summary,
  summaryAriaLabel,
  children,
  open = false,
}: SourceContextDisclosureProps) {
  const lines = boundedSourceContextLines(before, current, after);

  return (
    <details className="source-context-disclosure" open={open}>
      <summary aria-label={summaryAriaLabel ?? (summary ? `来源上下文：${summary}` : '来源上下文')}>
        <span>{summary || '来源上下文'}</span>
      </summary>
      <div className="source-context-content stack-tight">
        <SourceContextLines lines={lines} />
        {children}
      </div>
    </details>
  );
}

export function SourceContextExcerpt({
  before = [],
  current = [],
  after = [],
  label = '来源摘录',
  className = '',
}: SourceContextExcerptProps) {
  const lines = boundedSourceContextLines(before, current, after);
  if (lines.length === 0) return null;

  return (
    <section
      className={`source-context-excerpt stack-tight${className ? ` ${className}` : ''}`}
      aria-label={label}
    >
      <p className="eyebrow">{label}</p>
      <SourceContextLines lines={lines} />
    </section>
  );
}

function SourceContextLines({ lines }: { lines: readonly SourceContextLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="source-context-lines" aria-label="附近字幕摘录">
      {lines.map((line, index) => (
        <p
          className={line.kind === 'current' ? 'subtitle-current' : 'muted'}
          key={`${line.kind}-${index}-${line.text}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}

export function boundedSourceContextLines(
  before: readonly string[],
  current: readonly string[],
  after: readonly string[],
): SourceContextLine[] {
  const candidates: SourceContextLine[] = [
    ...before.slice(-1).map((text) => ({ kind: 'before' as const, text })),
    ...current.slice(0, 1).map((text) => ({ kind: 'current' as const, text })),
    ...after.slice(0, 1).map((text) => ({ kind: 'after' as const, text })),
  ];
  const currentIdentity = sourceContextIdentity(current[0] ?? '');
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    const text = candidate.text.trim().slice(0, MAX_SOURCE_CONTEXT_LINE_LENGTH);
    const identity = sourceContextIdentity(text);
    if (candidate.kind === 'before' && identity === currentIdentity) return [];
    if (!identity || seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...candidate, text }];
  });
}

function sourceContextIdentity(value: string): string {
  return value
    .trim()
    .slice(0, MAX_SOURCE_CONTEXT_LINE_LENGTH)
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase();
}

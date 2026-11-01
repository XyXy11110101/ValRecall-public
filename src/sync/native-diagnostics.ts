import type { NativeHostStatus, NativeSyncPort } from './native-bridge';
import {
  classifyNativeConnectionError,
  isNativeConnectionErrorCode,
  type NativeConnectionErrorCode,
} from './native-errors';

export const DIAGNOSTIC_STAGES = [
  'permission',
  'discovery',
  'launch',
  'handshake',
  'lan',
  'phone',
] as const;
export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];
export type DiagnosticCheck = 'passed' | 'failed' | 'unknown';
export interface NativeDiagnosticReport {
  version: 1;
  checkedAt: string;
  checks: Record<DiagnosticStage, DiagnosticCheck>;
  errorCode: NativeConnectionErrorCode | null;
  phoneSeenAt: string | null;
}

export function emptyNativeDiagnosticReport(): NativeDiagnosticReport {
  return {
    version: 1,
    checkedAt: new Date().toISOString(),
    checks: {
      permission: 'unknown',
      discovery: 'unknown',
      launch: 'unknown',
      handshake: 'unknown',
      lan: 'unknown',
      phone: 'unknown',
    },
    errorCode: null,
    phoneSeenAt: null,
  };
}

export function markNativeDiagnosticFailure(
  report: NativeDiagnosticReport,
  code: NativeConnectionErrorCode,
): void {
  report.errorCode = code;
  if (code === 'SYNC-PERMISSION') report.checks.permission = 'failed';
  if (code === 'SYNC-HOST-NOT-FOUND') report.checks.discovery = 'failed';
  if (code === 'SYNC-HOST-START') {
    report.checks.discovery = 'passed';
    report.checks.launch = 'failed';
  }
  if (code === 'SYNC-HOST-EXIT' || code === 'SYNC-PROTOCOL') {
    report.checks.discovery = 'passed';
    report.checks.launch = 'passed';
  }
  if (['SYNC-HOST-EXIT', 'SYNC-PROTOCOL', 'SYNC-TIMEOUT'].includes(code))
    report.checks.handshake = 'failed';
}

export function connectedNativeDiagnosticReport(
  status: NativeHostStatus,
  phoneSeenAt: string | null,
): NativeDiagnosticReport {
  const report = emptyNativeDiagnosticReport();
  report.checks = {
    permission: 'passed',
    discovery: 'passed',
    launch: 'passed',
    handshake: 'passed',
    lan: status.addresses.length > 0 ? 'passed' : 'failed',
    phone: phoneSeenAt === null ? 'unknown' : 'passed',
  };
  report.phoneSeenAt = phoneSeenAt;
  return report;
}

interface DiagnosticDependencies {
  connect(): NativeSyncPort;
  hasPermission(): Promise<boolean>;
  consumeLastError(): unknown;
  isStatus(value: unknown): value is NativeHostStatus;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A temporary status-only native port. No init, epoch, preferences, data handler,
 * pairing, or LAN-start command is sent. An uninitialized installed v1 helper
 * returns a framed refusal: that proves stdio transport, not initialized sync.
 */
export async function checkNativeConnection(
  dependencies: DiagnosticDependencies,
): Promise<NativeDiagnosticReport> {
  const report = emptyNativeDiagnosticReport();
  try {
    if (!(await dependencies.hasPermission())) {
      markNativeDiagnosticFailure(report, 'SYNC-PERMISSION');
      return report;
    }
    report.checks.permission = 'passed';
    if (dependencies.signal?.aborted) {
      markNativeDiagnosticFailure(report, 'SYNC-UNKNOWN');
      return report;
    }
    const port = dependencies.connect();
    return await new Promise<NativeDiagnosticReport>((resolve) => {
      let finished = false;
      const id = 'connection-check';
      const finish = (code?: NativeConnectionErrorCode) => {
        if (finished) return;
        finished = true;
        if (code) markNativeDiagnosticFailure(report, code);
        report.checkedAt = new Date().toISOString();
        clearTimeout(timer);
        try {
          port.onMessage.removeListener(onMessage);
        } catch {
          /* Context may be gone. */
        }
        try {
          port.onDisconnect.removeListener(onDisconnect);
        } catch {
          /* Context may be gone. */
        }
        dependencies.signal?.removeEventListener('abort', onAbort);
        try {
          port.disconnect();
        } catch {
          /* The process may already have exited. */
        }
        resolve(report);
      };
      const onMessage = (value: unknown) => {
        report.checks.discovery = 'passed';
        report.checks.launch = 'passed';
        if (!validResult(value, id)) {
          finish('SYNC-PROTOCOL');
          return;
        }
        report.checks.handshake = 'passed';
        if (value.ok) {
          if (!dependencies.isStatus(value.payload)) {
            finish('SYNC-PROTOCOL');
            return;
          }
          report.checks.lan = value.payload.addresses.length > 0 ? 'passed' : 'failed';
          finish();
        } else {
          // Exact allowlist for installed pre-diagnostic helpers, never echo arbitrary text.
          finish(
            value.error === 'Enable phone sync in ValRecall before pairing.'
              ? undefined
              : 'SYNC-HOST-REQUEST',
          );
        }
      };
      const onDisconnect = () => {
        let error: unknown;
        try {
          error = dependencies.consumeLastError();
        } catch {
          /* Still finish cleanup. */
        }
        finish(classifyNativeConnectionError(error));
      };
      const onAbort = () => finish('SYNC-UNKNOWN');
      const timer = setTimeout(() => finish('SYNC-TIMEOUT'), dependencies.timeoutMs ?? 8_000);
      try {
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        dependencies.signal?.addEventListener('abort', onAbort, { once: true });
        if (dependencies.signal?.aborted) {
          onAbort();
          return;
        }
        port.postMessage({ version: 1, id, type: 'status', payload: {} });
      } catch (error) {
        finish(classifyNativeConnectionError(error));
      }
    });
  } catch (error) {
    markNativeDiagnosticFailure(report, classifyNativeConnectionError(error));
    return report;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validResult(
  value: unknown,
  id: string,
): value is Record<string, unknown> & { ok: boolean } {
  if (!record(value)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length >= 900_000) return false;
  } catch {
    return false;
  }
  return (
    value.version === 1 &&
    value.id === id &&
    value.type === 'result' &&
    (value.ok === true ||
      (value.ok === false && typeof value.error === 'string' && value.error.length <= 2_000))
  );
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function isNativeDiagnosticReport(value: unknown): value is NativeDiagnosticReport {
  if (
    !record(value) ||
    value.version !== 1 ||
    !timestamp(value.checkedAt) ||
    !record(value.checks) ||
    (value.errorCode !== null && !isNativeConnectionErrorCode(value.errorCode)) ||
    (value.phoneSeenAt !== null && !timestamp(value.phoneSeenAt))
  )
    return false;
  if (
    Object.keys(value).sort().join(',') !== 'checkedAt,checks,errorCode,phoneSeenAt,version' ||
    Object.keys(value.checks).sort().join(',') !== [...DIAGNOSTIC_STAGES].sort().join(',')
  )
    return false;
  const checks = value.checks;
  if (
    !DIAGNOSTIC_STAGES.every(
      (stage) =>
        typeof checks[stage] === 'string' &&
        ['passed', 'failed', 'unknown'].includes(checks[stage]),
    )
  )
    return false;
  return (
    (checks.handshake !== 'passed' ||
      (checks.permission === 'passed' &&
        checks.discovery === 'passed' &&
        checks.launch === 'passed')) &&
    (checks.phone !== 'passed' || (checks.handshake === 'passed' && value.phoneSeenAt !== null))
  );
}

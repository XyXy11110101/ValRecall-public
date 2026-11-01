import { loadSyncEnabled, saveSyncEnabled, type SyncPreferenceStorage } from './settings';
import {
  NATIVE_CONNECTION_ERRORS,
  classifyNativeConnectionError,
  isNativeConnectionErrorCode,
} from './native-errors';
import {
  checkNativeConnection,
  connectedNativeDiagnosticReport,
  emptyNativeDiagnosticReport,
  isNativeDiagnosticReport,
  markNativeDiagnosticFailure,
  type NativeDiagnosticReport,
} from './native-diagnostics';

export const NATIVE_SYNC_HOST = 'com.valrecall.sync';
export const SYNC_CONTROL_TYPE = 'valrecall.sync.control';
export const NATIVE_SYNC_MAX_BYTES = 900_000;
export const SYNC_PORT = 19284;
const CONNECTION_ERROR = '无法连接 Windows 同步助手。请先安装助手，并检查 Edge 扩展权限。';
const PERMISSION_ERROR =
  'Edge 尚未允许连接电脑助手。请关闭手机同步后重新启用，并允许权限请求。[SYNC-PERMISSION]';
const DATA_ERROR = '电脑本地同步身份读取失败；请保留数据，不要重装或清空。[SYNC-DATA]';
const TIMEOUT_ERROR = '电脑助手未在限定时间内回应。[SYNC-TIMEOUT]';
const HOST_REQUEST_ERROR = '电脑助手已启动，但没有完成当前连接或配对请求。[SYNC-HOST-REQUEST]';
const PROTOCOL_ERROR = '电脑助手返回的连接信息格式不符合要求。[SYNC-PROTOCOL]';

/** Classify known browser errors; never expose arbitrary error text, paths or payloads. */
function nativeConnectionError(value: unknown): string {
  return NATIVE_CONNECTION_ERRORS[classifyNativeConnectionError(value)];
}
const SYNC_COMMANDS = ['status', 'enable', 'disable', 'pair', 'revoke', 'diagnose'] as const;
export type SyncControlCommand = (typeof SYNC_COMMANDS)[number];

export interface PairingCode {
  version: 1;
  serverId: string;
  host: string;
  port: 19284;
  fingerprint: string;
  secret: string;
  expiresAt: string;
}

export interface NativeHostStatus {
  serverId: string;
  paired: boolean;
  addresses: string[];
  port: 19284;
  pairing?: PairingCode;
}

export interface SyncControlState {
  enabled: boolean;
  connected: boolean;
  status: NativeHostStatus | null;
  diagnostics?: NativeDiagnosticReport;
}

export type SyncControlResponse =
  | { version: 1; ok: true; state: SyncControlState }
  | { version: 1; ok: false; state: SyncControlState; error: string };

export interface NativeSyncRequest {
  version: 1;
  deviceId: string;
  request: unknown;
}

interface ListenerEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface NativeSyncPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ListenerEvent<(message: unknown) => void>;
  onDisconnect: ListenerEvent<() => void>;
}

export interface NativeSyncDependencies {
  getEpoch(): Promise<string>;
  onSync(request: NativeSyncRequest): Promise<unknown>;
  connect(): NativeSyncPort;
  storage: SyncPreferenceStorage;
  hasPermission?(): Promise<boolean>;
  consumeLastError?(): unknown;
  timeoutMs?: number;
  retryDelayMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Owns one opt-in native connection. Automatic attempts share a finite retry budget. */
export class NativeSyncController {
  private enabled = false;
  private disposed = false;
  private port: NativeSyncPort | null = null;
  private status: NativeHostStatus | null = null;
  private epoch: string | null = null;
  private connection: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private retries = 0;
  private serial = 0;
  private pending = new Map<string, PendingRequest>();
  private inbound = new Set<string>();
  private detach: (() => void) | null = null;
  private connectionError = CONNECTION_ERROR;
  private diagnostics: NativeDiagnosticReport | null = null;
  private diagnosticAbort: AbortController | null = null;
  private lastPhoneContactAt: string | null = null;

  constructor(private readonly dependencies: NativeSyncDependencies) {}

  getState(): SyncControlState {
    return {
      enabled: this.enabled,
      connected: this.port !== null && this.status !== null,
      status: this.status,
      ...(this.diagnostics ? { diagnostics: structuredClone(this.diagnostics) } : {}),
    };
  }

  start(): Promise<void> {
    const work = this.queue.then(async () => {
      if (this.disposed) return;
      this.enabled = await loadSyncEnabled(this.dependencies.storage);
      if (this.enabled) {
        this.retries = 3;
        await this.ensureConnection();
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  control(command: SyncControlCommand): Promise<SyncControlResponse> {
    const work = this.queue.then(async (): Promise<SyncControlResponse> => {
      this.connectionError = CONNECTION_ERROR;
      try {
        if (this.disposed) throw new Error('同步连接已关闭。请重新打开设置。');
        if (command === 'diagnose') return await this.diagnose();
        this.diagnostics = null;
        if (command === 'disable') {
          await saveSyncEnabled(this.dependencies.storage, false);
          this.enabled = false;
          this.retries = 0;
          this.closePort();
        } else {
          if (command === 'enable') {
            await saveSyncEnabled(this.dependencies.storage, true);
            this.enabled = true;
          }
          if (!this.enabled) {
            if (command !== 'status') throw new Error('请先启用手机局域网同步。');
          } else {
            this.retries = 3;
            await this.ensureConnection();
            if (command === 'pair' && this.status?.paired) {
              throw new Error('请先解除原有手机配对，再连接新手机。');
            }
            const type =
              command === 'pair'
                ? 'pairing.start'
                : command === 'revoke'
                  ? 'pairing.revoke'
                  : 'status';
            const status = await this.request(type, {});
            if (!isNativeHostStatus(status)) {
              this.connectionError = PROTOCOL_ERROR;
              throw new Error(PROTOCOL_ERROR);
            }
            this.status = status;
          }
        }
        return { version: 1, ok: true, state: this.getState() };
      } catch {
        return { version: 1, ok: false, state: this.getState(), error: this.connectionError };
      }
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  stop(): void {
    this.disposed = true;
    this.retries = 0;
    this.diagnosticAbort?.abort();
    this.closePort();
  }

  /** Explicit diagnostic action never reads epoch or calls the business repository. */
  private async diagnose(): Promise<SyncControlResponse> {
    if (this.connection) await this.connection.catch(() => undefined);
    if (this.disposed) throw new Error(CONNECTION_ERROR);
    if (this.port && this.status) {
      const port = this.port;
      try {
        const status = await this.request('status', {});
        if (!isNativeHostStatus(status)) {
          this.connectionError = PROTOCOL_ERROR;
          throw new Error(PROTOCOL_ERROR);
        }
        if (this.port !== port) throw new Error(this.connectionError);
        this.status = status;
        this.diagnostics = connectedNativeDiagnosticReport(status, this.lastPhoneContactAt);
      } catch {
        this.diagnostics = emptyNativeDiagnosticReport();
        const code = Object.entries(NATIVE_CONNECTION_ERRORS).find(
          ([, message]) => message === this.connectionError,
        )?.[0];
        markNativeDiagnosticFailure(
          this.diagnostics,
          isNativeConnectionErrorCode(code) ? code : 'SYNC-PROTOCOL',
        );
      }
    } else {
      this.diagnosticAbort = new AbortController();
      try {
        this.diagnostics = await checkNativeConnection({
          connect: () => this.dependencies.connect(),
          hasPermission: () => this.dependencies.hasPermission?.() ?? Promise.resolve(true),
          consumeLastError: () => this.dependencies.consumeLastError?.(),
          isStatus: isNativeHostStatus,
          ...(this.dependencies.timeoutMs === undefined
            ? {}
            : { timeoutMs: this.dependencies.timeoutMs }),
          signal: this.diagnosticAbort.signal,
        });
      } finally {
        this.diagnosticAbort = null;
      }
    }
    const code = this.diagnostics.errorCode;
    return code
      ? { version: 1, ok: false, state: this.getState(), error: NATIVE_CONNECTION_ERRORS[code] }
      : { version: 1, ok: true, state: this.getState() };
  }

  private ensureConnection(): Promise<void> {
    if (this.port && this.status) return this.refreshEpoch();
    if (this.connection) return this.connection;
    const work = this.connectWithRetries();
    this.connection = work;
    void work
      .finally(() => {
        if (this.connection === work) this.connection = null;
      })
      .catch(() => undefined);
    return work;
  }

  /** A restored database revokes the old phone session even if Edge stayed open. */
  private async refreshEpoch(): Promise<void> {
    const epoch = await this.readEpoch();
    if (!isIdentifier(epoch)) throw new Error(CONNECTION_ERROR);
    if (epoch === this.epoch) return;
    const status = await this.request('init', { epoch });
    if (!isNativeHostStatus(status)) {
      this.connectionError = PROTOCOL_ERROR;
      throw new Error(PROTOCOL_ERROR);
    }
    this.epoch = epoch;
    this.status = status;
  }

  private async connectWithRetries(): Promise<void> {
    if (this.dependencies.hasPermission && !(await this.dependencies.hasPermission())) {
      this.connectionError = PERMISSION_ERROR;
      throw new Error(PERMISSION_ERROR);
    }
    while (this.enabled && !this.disposed && this.retries > 0) {
      this.retries -= 1;
      try {
        const epoch = await this.readEpoch();
        if (!isIdentifier(epoch) || !this.enabled || this.disposed)
          throw new Error(CONNECTION_ERROR);
        let port: NativeSyncPort;
        try {
          port = this.dependencies.connect();
        } catch (error) {
          this.connectionError = nativeConnectionError(error);
          throw new Error(this.connectionError);
        }
        this.port = port;
        const onMessage = (message: unknown) => {
          void this.receive(port, message).catch(() => {
            if (this.port === port) this.closePort();
          });
        };
        const onDisconnect = () => {
          const lastError = this.dependencies.consumeLastError?.();
          if (this.port !== port) return;
          this.connectionError = nativeConnectionError(lastError);
          this.closePort();
          if (this.enabled && !this.disposed && this.retries > 0) {
            void this.ensureConnection().catch(() => undefined);
          }
        };
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        this.detach = () => {
          port.onMessage.removeListener(onMessage);
          port.onDisconnect.removeListener(onDisconnect);
        };
        const status = await this.request('init', { epoch });
        if (!isNativeHostStatus(status)) {
          this.connectionError = PROTOCOL_ERROR;
          throw new Error(PROTOCOL_ERROR);
        }
        if (this.port !== port) throw new Error(this.connectionError);
        this.epoch = epoch;
        this.status = status;
        return;
      } catch {
        this.closePort();
        if (this.retries > 0 && this.enabled && !this.disposed) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.dependencies.retryDelayMs ?? 500),
          );
        }
      }
    }
    throw new Error(this.connectionError);
  }

  private async readEpoch(): Promise<string> {
    try {
      const epoch = await this.dependencies.getEpoch();
      if (!isIdentifier(epoch)) throw new Error(DATA_ERROR);
      return epoch;
    } catch {
      this.connectionError = DATA_ERROR;
      throw new Error(DATA_ERROR);
    }
  }

  private request(type: string, payload: unknown): Promise<unknown> {
    const port = this.port;
    if (!port || this.disposed || !this.enabled) return Promise.reject(new Error(CONNECTION_ERROR));
    const id = `extension-${++this.serial}`;
    const message = { version: 1, id, type, payload };
    if (!fitsNativeMessage(message)) return Promise.reject(new Error(CONNECTION_ERROR));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionError = TIMEOUT_ERROR;
        this.pending.delete(id);
        reject(new Error(TIMEOUT_ERROR));
        if (this.port === port) this.closePort();
      }, this.dependencies.timeoutMs ?? 8_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage(message);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(CONNECTION_ERROR));
      }
    });
  }

  private async receive(port: NativeSyncPort, message: unknown): Promise<void> {
    if (port !== this.port || !this.enabled || this.disposed) return;
    if (
      !fitsNativeMessage(message) ||
      !isRecord(message) ||
      message.version !== 1 ||
      !isIdentifier(message.id)
    ) {
      throw new Error(CONNECTION_ERROR);
    }
    if (message.type === 'result') {
      if (message.ok !== true && message.ok !== false) throw new Error(CONNECTION_ERROR);
      if (
        message.ok === false &&
        (typeof message.error !== 'string' || message.error.length > 2_000)
      ) {
        throw new Error(CONNECTION_ERROR);
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.payload);
      else {
        this.connectionError = HOST_REQUEST_ERROR;
        pending.reject(new Error(HOST_REQUEST_ERROR));
      }
      return;
    }
    if (message.type !== 'sync' || !isNativeSyncRequest(message.payload) || !this.status) {
      throw new Error(CONNECTION_ERROR);
    }
    if (this.inbound.has(message.id) || this.inbound.size >= 8) {
      port.postMessage({
        version: 1,
        id: message.id,
        type: 'result',
        ok: false,
        error: '同步请求正在处理中。',
      });
      return;
    }
    this.inbound.add(message.id);
    let response: unknown;
    try {
      const payload = await this.dependencies.onSync(message.payload);
      response = { version: 1, id: message.id, type: 'result', ok: true, payload };
      if (!fitsNativeMessage(response)) throw new Error(CONNECTION_ERROR);
    } catch {
      response = {
        version: 1,
        id: message.id,
        type: 'result',
        ok: false,
        error: '本机同步未完成，请保留手机待同步记录后重试。',
      };
    } finally {
      this.inbound.delete(message.id);
    }
    if (this.port === port && this.enabled && !this.disposed) {
      port.postMessage(response);
      this.lastPhoneContactAt = new Date().toISOString();
    }
  }

  private closePort(): void {
    const port = this.port;
    this.port = null;
    this.status = null;
    this.epoch = null;
    this.lastPhoneContactAt = null;
    this.detach?.();
    this.detach = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(this.connectionError));
    }
    this.pending.clear();
    this.inbound.clear();
    try {
      port?.disconnect();
    } catch {
      /* Native process may already have exited. */
    }
  }
}

type SyncRuntimeListener = (
  message: unknown,
  sender: { id?: string; url?: string; tab?: unknown },
  respond: (response: SyncControlResponse) => void,
) => boolean;

export interface NativeSyncRuntimeApi {
  runtime: {
    id?: string;
    lastError?: unknown;
    getURL(path: string): string;
    connectNative(host: string): NativeSyncPort;
    onMessage: ListenerEvent<SyncRuntimeListener>;
    onSuspend?: ListenerEvent<() => void>;
  };
  storage: { local: SyncPreferenceStorage };
  permissions?: { contains(permissions: { permissions: 'nativeMessaging'[] }): Promise<boolean> };
}

/** Only our exact dashboard document can access controls or ephemeral pairing credentials. */
export function registerNativeSyncRuntime(
  api: NativeSyncRuntimeApi,
  dependencies: Pick<NativeSyncDependencies, 'getEpoch' | 'onSync'>,
): { controller: NativeSyncController; ready: Promise<void>; dispose(): void } {
  const controller = new NativeSyncController({
    ...dependencies,
    storage: api.storage.local,
    connect: () => api.runtime.connectNative(NATIVE_SYNC_HOST),
    hasPermission: () =>
      api.permissions?.contains({ permissions: ['nativeMessaging'] }) ?? Promise.resolve(false),
    consumeLastError: () => api.runtime.lastError,
  });
  const listener: SyncRuntimeListener = (message, sender, respond) => {
    if (
      !isSyncControlMessage(message) ||
      !api.runtime.id ||
      sender.id !== api.runtime.id ||
      !isDashboardDocument(sender.url, api.runtime.getURL('dashboard.html'))
    )
      return false;
    void controller.control(message.command).then(respond);
    return true;
  };
  const stop = () => controller.stop();
  api.runtime.onMessage.addListener(listener);
  api.runtime.onSuspend?.addListener(stop);
  const ready = controller.start().catch(() => undefined);
  return {
    controller,
    ready,
    dispose() {
      stop();
      api.runtime.onMessage.removeListener(listener);
      api.runtime.onSuspend?.removeListener(stop);
    },
  };
}

export async function sendSyncControl(command: SyncControlCommand): Promise<SyncControlResponse> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id)
    throw new Error('请在 Edge 的 ValRecall 扩展设置中配置手机同步。');
  const operation: Promise<unknown> = chrome.runtime.sendMessage({
    version: 1,
    type: SYNC_CONTROL_TYPE,
    command,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response: unknown = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('同步助手响应超时，请刷新后重试。')), 30_000);
      }),
    ]);
    if (!isSyncControlResponse(response)) throw new Error('同步助手返回了无效状态，请刷新后重试。');
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Must be called directly from the enable button's user gesture. */
export function requestNativeSyncPermission(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.permissions?.request)
    return Promise.resolve(false);
  return chrome.permissions.request({ permissions: ['nativeMessaging'] });
}

function isDashboardDocument(candidate: string | undefined, trusted: string): boolean {
  if (!candidate) return false;
  try {
    const actual = new URL(candidate);
    const expected = new URL(trusted);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      !actual.username &&
      !actual.password
    );
  } catch {
    return false;
  }
}

export function isLanAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split('.').map(Number);
  if (parts.some((part, index) => part > 255 || String(part) !== value.split('.')[index]))
    return false;
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isPairingCode(value: unknown): value is PairingCode {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isIdentifier(value.serverId) &&
    isLanAddress(value.host) &&
    value.port === SYNC_PORT &&
    typeof value.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    typeof value.secret === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.secret) &&
    typeof value.expiresAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value.expiresAt) &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

export function isNativeHostStatus(value: unknown): value is NativeHostStatus {
  return (
    isRecord(value) &&
    isIdentifier(value.serverId) &&
    typeof value.paired === 'boolean' &&
    value.port === SYNC_PORT &&
    Array.isArray(value.addresses) &&
    value.addresses.length <= 32 &&
    value.addresses.every(isLanAddress) &&
    (value.pairing === undefined ||
      (isPairingCode(value.pairing) &&
        value.pairing.serverId === value.serverId &&
        value.addresses.includes(value.pairing.host)))
  );
}

export function isSyncControlResponse(value: unknown): value is SyncControlResponse {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state)) return false;
  const { state } = value;
  return (
    typeof state.enabled === 'boolean' &&
    typeof state.connected === 'boolean' &&
    (state.status === null || isNativeHostStatus(state.status)) &&
    (state.diagnostics === undefined || isNativeDiagnosticReport(state.diagnostics)) &&
    (!state.connected || (state.enabled && state.status !== null)) &&
    (value.ok === true ||
      (value.ok === false && typeof value.error === 'string' && value.error.length <= 2_000))
  );
}

function isSyncControlMessage(
  value: unknown,
): value is { version: 1; type: typeof SYNC_CONTROL_TYPE; command: SyncControlCommand } {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.type === SYNC_CONTROL_TYPE &&
    typeof value.command === 'string' &&
    SYNC_COMMANDS.some((command) => command === value.command)
  );
}

function isNativeSyncRequest(value: unknown): value is NativeSyncRequest {
  return (
    isRecord(value) && value.version === 1 && isIdentifier(value.deviceId) && 'request' in value
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fitsNativeMessage(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return (
      typeof json === 'string' && new TextEncoder().encode(json).length < NATIVE_SYNC_MAX_BYTES
    );
  } catch {
    return false;
  }
}

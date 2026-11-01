import {
  MobileRepository,
  MobileRepositoryError,
  type MobileOutboxEntry,
  type MobileState,
} from '../database/mobile-repository';
import {
  isSyncReceipt,
  readSyncSnapshot,
  type SyncOperation,
  type SyncRequest,
} from '../sync/contracts';
import {
  isRecord,
  isSyncId,
  isTimeZone,
  SYNC_BATCH_LIMIT,
  SYNC_MAX_SNAPSHOT_CHARACTERS,
  SYNC_PAGE_CHARACTERS,
} from '../sync/protocol';
import { nativeRequest, NativeBridgeError } from './bridge';

export type MobileSyncErrorCode =
  | 'EPOCH_CHANGED'
  | 'NOT_PAIRED'
  | 'INVALID_RESPONSE'
  | 'SNAPSHOT_EXPIRED'
  | 'TOO_LARGE'
  | 'UNAVAILABLE'
  | 'ACTION_REQUIRED'
  | 'UPGRADE_REQUIRED';

export class MobileSyncError extends Error {
  constructor(
    readonly code: MobileSyncErrorCode,
    message: string,
    readonly newEpoch: string | null = null,
  ) {
    super(message);
  }
}

export interface SyncClientOptions {
  request?: (request: SyncRequest) => Promise<unknown>;
  pairStatus?: () => Promise<unknown>;
  clock?: () => number;
}

/**
 * One completion or creation the computer applied during this sync. Presentation only: it
 * lets the phone say "电脑已确认" even when the same sync's pull already removed the entry.
 * It is never used for balances, which come only from the stored snapshot and receipts.
 */
export interface MobileAppliedReceipt {
  operationId: string;
  kind: 'complete-task' | 'create-task';
  taskId: string;
  reward: number;
}

export interface MobileSyncSummary {
  state: MobileState;
  pushed: number;
  remaining: number;
  conflicts: number;
  snapshotUpdated: boolean;
  changeProbe?: boolean;
  /** Receipts this sync recorded with status 'applied' and settled with a completed pull. */
  applied?: MobileAppliedReceipt[];
}

export const MOBILE_SYNC_REQUEST_BYTES = 256 * 1024;
const MAX_BATCHES = 100;
const MAX_PAGES = 170;
const SNAPSHOT_LIFETIME_MS = 120_000;

function invalid(message = '同步出错，请重试。'): never {
  throw new MobileSyncError('INVALID_RESPONSE', message);
}

function checkError(value: unknown): void {
  if (isRecord(value) && value.version === 1)
    throw new MobileSyncError('UPGRADE_REQUIRED', '请更新电脑版 ValRecall 后再同步。');
  if (!isRecord(value) || value.version !== 2) invalid();
  if (value.type !== 'error') return;
  if (typeof value.message !== 'string' || value.message.length > 2_000) invalid();
  if (value.code === 'EPOCH_CHANGED')
    throw new MobileSyncError('EPOCH_CHANGED', '电脑数据已恢复，请重新配对。');
  if (value.code === 'SNAPSHOT_EXPIRED')
    throw new MobileSyncError('SNAPSHOT_EXPIRED', '本次同步已过期，请重试。');
  if (value.code === 'TOO_LARGE')
    throw new MobileSyncError('TOO_LARGE', '待同步数据过多，请在电脑检查。');
  if (value.code === 'UNAVAILABLE')
    throw new MobileSyncError('UNAVAILABLE', '电脑忙，请稍后重试。');
  invalid();
}

function makeBatch(epoch: string, entries: readonly MobileOutboxEntry[]): SyncOperation[] {
  const operations: SyncOperation[] = [];
  for (const entry of entries.slice(0, SYNC_BATCH_LIMIT)) {
    const candidate = [...operations, entry.operation];
    const request: SyncRequest = { version: 2, type: 'push', epoch, operations: candidate };
    if (new TextEncoder().encode(JSON.stringify(request)).length > MOBILE_SYNC_REQUEST_BYTES) break;
    operations.push(entry.operation);
  }
  if (operations.length === 0 && entries.length > 0)
    throw new MobileSyncError('TOO_LARGE', '待同步内容过多，请在电脑检查。');
  return operations;
}

/** The transport exposes domain JSON only; pairing tokens and TLS never enter this class. */
export class SyncClient {
  private readonly request: (request: SyncRequest) => Promise<unknown>;
  private readonly pairStatus: () => Promise<unknown>;
  private readonly clock: () => number;
  private running: Promise<MobileSyncSummary> | null = null;
  /** Unknown until an authenticated capability response; never infer from a timer. */
  changeProbe: boolean | undefined;

  constructor(
    private readonly repository: MobileRepository,
    options: SyncClientOptions = {},
  ) {
    this.request = options.request ?? ((request) => nativeRequest('sync', request));
    this.pairStatus = options.pairStatus ?? (() => nativeRequest('pair.status'));
    this.clock = options.clock ?? Date.now;
  }

  sync(): Promise<MobileSyncSummary> {
    return this.execute(false);
  }

  checkForChanges(onSynchronizing?: () => void): Promise<MobileSyncSummary> {
    return this.execute(true, onSynchronizing);
  }

  private execute(checkOnly: boolean, onSynchronizing?: () => void): Promise<MobileSyncSummary> {
    if (this.running) return this.running;
    const run = async () => {
      try {
        return await this.synchronize(checkOnly, onSynchronizing);
      } catch (error) {
        if (error instanceof MobileSyncError) throw error;
        if (error instanceof MobileRepositoryError && error.code === 'EPOCH_CHANGED')
          throw new MobileSyncError('EPOCH_CHANGED', error.message);
        if (error instanceof MobileRepositoryError) invalid(error.message);
        if (
          error instanceof NativeBridgeError &&
          ['NOT_PAIRED', 'PAIRING_REVOKED'].includes(error.code)
        )
          throw new MobileSyncError('NOT_PAIRED', '配对未连接，请在设置中重新扫码。');
        if (error instanceof NativeBridgeError && error.code === 'PERMISSION_DENIED')
          throw new MobileSyncError(
            'ACTION_REQUIRED',
            '请在手机系统设置中允许 ValRecall 访问本地网络。',
          );
        if (error instanceof NativeBridgeError && error.code === 'CERTIFICATE_CHANGED')
          throw new MobileSyncError('ACTION_REQUIRED', '电脑已变化，请重新配对。');
        if (
          error instanceof NativeBridgeError &&
          !['UNAVAILABLE', 'UNREACHABLE', 'BUSY'].includes(error.code)
        )
          throw new MobileSyncError('ACTION_REQUIRED', error.message);
        throw new MobileSyncError('UNAVAILABLE', '连不上电脑，请确认 Edge 已打开且在同一 Wi-Fi。');
      }
    };
    const result = (async () =>
      typeof navigator !== 'undefined' && navigator.locks
        ? await navigator.locks.request(
            `valrecall-mobile-sync:${this.repository.databaseName}`,
            run,
          )
        : await run())();
    this.running = result;
    void result
      .finally(() => {
        if (this.running === result) this.running = null;
      })
      .catch(() => undefined);
    return result;
  }

  private async synchronize(
    checkOnly: boolean,
    onSynchronizing?: () => void,
  ): Promise<MobileSyncSummary> {
    const pairing = await this.pairStatus();
    if (!isRecord(pairing) || typeof pairing.paired !== 'boolean') invalid('手机配对状态无效。');
    if (!pairing.paired) throw new MobileSyncError('NOT_PAIRED', '请先扫描电脑上的配对码。');
    if (!isSyncId(pairing.deviceId) || !isSyncId(pairing.epoch))
      invalid('手机配对记录无效，请重新配对。');
    const initial = await this.repository.load();
    const epoch = pairing.epoch;
    if (initial.epoch !== null && initial.epoch !== epoch)
      throw new MobileSyncError('EPOCH_CHANGED', '电脑数据已更换，请确认接收。', epoch);
    // A foreground poll on a known legacy peer never falls back to downloading.
    if (checkOnly && this.changeProbe === false) return this.summary(initial, 0, false);
    const hasPending = initial.outbox.some(
      (entry) =>
        entry.epoch === epoch && (entry.status === 'pending' || entry.status === 'acknowledged'),
    );
    if (
      checkOnly &&
      !hasPending &&
      this.changeProbe === true &&
      initial.snapshot?.contentRevision
    ) {
      const response = await this.request({ version: 2, type: 'change-state', epoch });
      checkError(response);
      if (
        !isRecord(response) ||
        response.type !== 'change-state' ||
        response.epoch !== epoch ||
        !isSyncId(response.contentRevision) ||
        !isTimeZone(response.timeZone)
      )
        invalid();
      const current = await this.repository.load();
      if (current.epoch !== initial.epoch)
        throw new MobileSyncError('EPOCH_CHANGED', '数据已变化，请重新同步。');
      const pending = current.outbox.some(
        (entry) =>
          entry.epoch === epoch && (entry.status === 'pending' || entry.status === 'acknowledged'),
      );
      if (
        !pending &&
        current.snapshot?.contentRevision === response.contentRevision &&
        current.snapshot.timeZone === response.timeZone
      )
        return this.summary(current, 0, false);
    }
    onSynchronizing?.();
    const capabilities = await this.request({ version: 2, type: 'capabilities', epoch });
    checkError(capabilities);
    if (
      !isRecord(capabilities) ||
      capabilities.type !== 'capabilities' ||
      capabilities.epoch !== epoch ||
      capabilities.protocol !== 2 ||
      capabilities.wallet !== 2
    )
      throw new MobileSyncError('UPGRADE_REQUIRED', '请更新电脑版 ValRecall 后再同步。');
    if (capabilities.changeProbe !== undefined && capabilities.changeProbe !== 1)
      throw new MobileSyncError('UPGRADE_REQUIRED', '版本不兼容，请更新电脑和 App。');
    this.changeProbe = capabilities.changeProbe === 1;
    if (capabilities.taskCreationReward !== undefined && capabilities.taskCreationReward !== 5)
      throw new MobileSyncError('UPGRADE_REQUIRED', '版本不兼容，请更新电脑和 App。');
    let pushed = 0;
    const applied: MobileAppliedReceipt[] = [];
    // Freeze the initial queue. Work created during network IO is retained for the next finite sync.
    const queuedIds = new Set(
      initial.snapshot
        ? initial.outbox
            .filter((entry) => entry.epoch === epoch && entry.status === 'pending')
            .map((entry) => entry.id)
        : [],
    );
    for (let batchIndex = 0; batchIndex < MAX_BATCHES && queuedIds.size > 0; batchIndex++) {
      const state = await this.repository.load();
      if (state.epoch !== epoch)
        throw new MobileSyncError('EPOCH_CHANGED', '电脑数据已更换，请重新同步。');
      const pending = state.outbox.filter(
        (entry) => entry.epoch === epoch && entry.status === 'pending' && queuedIds.has(entry.id),
      );
      if (pending.length === 0) break;
      const operations = makeBatch(epoch, pending);
      const ids = operations.map((operation) => operation.id);
      await this.repository.markAttempted(epoch, ids);
      const response = await this.request({
        version: 2,
        type: 'push',
        epoch,
        operations,
        ...(capabilities.taskCreationReward === 5 ? { taskCreationReward: 5 as const } : {}),
      });
      checkError(response);
      if (
        !isRecord(response) ||
        response.type !== 'receipts' ||
        response.epoch !== epoch ||
        !Array.isArray(response.receipts) ||
        response.receipts.length !== ids.length ||
        !response.receipts.every(isSyncReceipt) ||
        response.receipts.some((receipt) => receipt.walletDelta === undefined) ||
        new Set(response.receipts.map((receipt) => receipt.operationId)).size !== ids.length ||
        response.receipts.some((receipt) => !ids.includes(receipt.operationId))
      )
        invalid('同步确认不一致，请重试。');
      await this.repository.recordReceipts(epoch, ids, response.receipts);
      for (const receipt of response.receipts) {
        const operation = operations.find((candidate) => candidate.id === receipt.operationId);
        if (receipt.status !== 'applied' || !operation) continue;
        if (operation.kind === 'complete-task' || operation.kind === 'create-task')
          applied.push({
            operationId: operation.id,
            kind: operation.kind,
            taskId: operation.kind === 'create-task' ? operation.task.id : operation.taskId,
            reward: receipt.reward,
          });
      }
      for (const id of ids) queuedIds.delete(id);
      pushed += operations.length;
    }
    const beforePull = await this.repository.load();
    if (beforePull.epoch !== null && beforePull.epoch !== epoch)
      throw new MobileSyncError('EPOCH_CHANGED', '电脑数据已更换，请重新同步。');
    const acknowledged = beforePull.outbox
      .filter((entry) => entry.epoch === epoch && entry.status === 'acknowledged')
      .map((entry) => entry.id);
    await this.pull(epoch, acknowledged);
    const state = await this.repository.load();
    return this.summary(state, pushed, true, applied);
  }

  private summary(
    state: MobileState,
    pushed: number,
    snapshotUpdated: boolean,
    applied: MobileAppliedReceipt[] = [],
  ): MobileSyncSummary {
    return {
      applied,
      state,
      pushed,
      remaining: state.outbox.filter(
        (entry) => entry.epoch === state.epoch && entry.status === 'pending',
      ).length,
      conflicts: state.outbox.filter(
        (entry) => entry.epoch === state.epoch && entry.status === 'conflict',
      ).length,
      snapshotUpdated,
      changeProbe: this.changeProbe === true,
    };
  }

  private async pull(epoch: string, acknowledged: string[]): Promise<void> {
    const start = this.clock();
    let cursor = 0;
    let token: string | null = null;
    const chunks: string[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      if (this.clock() - start >= SNAPSHOT_LIFETIME_MS)
        throw new MobileSyncError('SNAPSHOT_EXPIRED', '同步传输超时，请重试。');
      const response = await this.request({ version: 2, type: 'pull', epoch, token, cursor });
      checkError(response);
      if (
        !isRecord(response) ||
        response.type !== 'page' ||
        response.epoch !== epoch ||
        !isSyncId(response.token) ||
        (token !== null && response.token !== token) ||
        response.cursor !== cursor ||
        typeof response.chunk !== 'string' ||
        response.chunk.length === 0 ||
        response.chunk.length > SYNC_PAGE_CHARACTERS ||
        (response.nextCursor !== null &&
          (response.nextCursor !== cursor + response.chunk.length ||
            response.chunk.length !== SYNC_PAGE_CHARACTERS))
      )
        invalid('同步数据不完整，请重试。');
      if (this.clock() - start >= SNAPSHOT_LIFETIME_MS)
        throw new MobileSyncError('SNAPSHOT_EXPIRED', '本次同步已过期，请重试。');
      cursor += response.chunk.length;
      if (cursor > SYNC_MAX_SNAPSHOT_CHARACTERS)
        throw new MobileSyncError('TOO_LARGE', '待同步数据超过手机容量，请在电脑检查。');
      chunks.push(response.chunk);
      token = response.token;
      if (response.nextCursor === null) {
        let snapshot;
        try {
          snapshot = readSyncSnapshot(JSON.parse(chunks.join('')) as unknown);
        } catch {
          invalid('同步数据无法读取，请更新电脑版和 App 后重试。');
        }
        if (snapshot.epoch !== epoch) invalid('电脑数据已更换，请重新配对。');
        if (this.changeProbe && !snapshot.contentRevision) invalid('电脑快照缺少修订标记。');
        try {
          await this.repository.applySnapshot(snapshot, acknowledged);
        } catch (error) {
          if (error instanceof MobileRepositoryError && error.code === 'EPOCH_CHANGED') throw error;
          throw new MobileSyncError('ACTION_REQUIRED', '保存失败，请检查手机存储空间。');
        }
        return;
      }
    }
    throw new MobileSyncError('TOO_LARGE', '待同步数据过多，请在电脑检查。');
  }
}

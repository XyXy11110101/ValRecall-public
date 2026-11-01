import {
  readSyncRequest,
  type SyncOperation,
  type SyncReceipt,
  type SyncResponse,
  type SyncSnapshot,
  type SyncChangeState,
} from './contracts';
import { SyncDataError } from './protocol';
import {
  computerTimeZone,
  isRecord,
  isSyncId,
  SYNC_MAX_SNAPSHOT_CHARACTERS,
  SYNC_PAGE_CHARACTERS,
} from './protocol';

export interface DesktopSyncPort {
  getEpoch(): Promise<string>;
  getSnapshot(timeZone: string): Promise<SyncSnapshot>;
  getChangeState?(timeZone: string): Promise<SyncChangeState>;
  applyOperations(
    epoch: string,
    deviceId: string,
    operations: SyncOperation[],
    creationRewards?: boolean,
  ): Promise<SyncReceipt[]>;
}

/** Only one bounded immutable snapshot lives in memory; no raw data is logged or persisted here. */
export class DesktopSyncService {
  private snapshot: {
    deviceId: string;
    epoch: string;
    token: string;
    json: string;
    expires: number;
  } | null = null;
  constructor(
    private readonly port: DesktopSyncPort,
    private readonly clock = () => Date.now(),
    private readonly zone = computerTimeZone,
    private readonly id = () => crypto.randomUUID(),
  ) {}

  async handle(deviceId: string, input: unknown): Promise<SyncResponse> {
    if (isRecord(input) && input.version === 1)
      return {
        version: 1,
        type: 'error',
        code: 'INVALID_REQUEST',
        message: '请升级手机 App 后再同步。',
      };
    let request;
    try {
      if (
        !isSyncId(deviceId) ||
        new TextEncoder().encode(JSON.stringify(input)).length > 256 * 1024
      )
        throw new Error();
      request = readSyncRequest(input);
    } catch {
      return {
        version: 2,
        type: 'error',
        code: 'INVALID_REQUEST',
        message: '同步请求无效，请重试。',
      };
    }
    try {
      if (request.type === 'change-state') {
        if (!this.port.getChangeState) throw new SyncDataError('电脑不支持变化检查，请更新。');
        const state = await this.port.getChangeState(this.zone());
        if (state.epoch !== request.epoch)
          return { version: 2, type: 'error', code: 'EPOCH_CHANGED', message: '电脑数据已更换。' };
        return { version: 2, type: 'change-state', ...state };
      }
      const epoch = await this.port.getEpoch();
      if (request.epoch !== epoch) {
        this.snapshot = null;
        return {
          version: 2,
          type: 'error',
          code: 'EPOCH_CHANGED',
          message: '电脑已恢复或重建数据，请重新配对。旧待同步记录不会自动重放。',
        };
      }
      if (request.type === 'capabilities')
        return {
          version: 2,
          type: 'capabilities',
          epoch,
          protocol: 2,
          wallet: 2,
          taskCreationReward: 5,
          ...(this.port.getChangeState ? { changeProbe: 1 as const } : {}),
        };
      if (request.type === 'push') {
        const receipts = await this.port.applyOperations(
          epoch,
          deviceId,
          request.operations,
          request.taskCreationReward === 5,
        );
        return { version: 2, type: 'receipts', epoch, receipts };
      }
      if (request.token === null) {
        const snapshot = await this.port.getSnapshot(this.zone());
        // Restore may have occurred between the epoch read and atomic snapshot.
        if (snapshot.epoch !== epoch)
          return {
            version: 2,
            type: 'error',
            code: 'EPOCH_CHANGED',
            message: '电脑数据已更换，请重新配对。',
          };
        const json = JSON.stringify(snapshot);
        if (json.length > SYNC_MAX_SNAPSHOT_CHARACTERS)
          return {
            version: 2,
            type: 'error',
            code: 'TOO_LARGE',
            message: '任务快照超过手机版容量限制，请保留数据并在电脑检查。',
          };
        this.snapshot = {
          deviceId,
          epoch,
          token: this.id(),
          json,
          expires: this.clock() + 120_000,
        };
      }
      const snapshot = this.snapshot;
      if (
        !snapshot ||
        snapshot.deviceId !== deviceId ||
        snapshot.epoch !== epoch ||
        snapshot.expires <= this.clock() ||
        (request.token !== null && request.token !== snapshot.token) ||
        request.cursor >= snapshot.json.length ||
        request.cursor % SYNC_PAGE_CHARACTERS !== 0
      ) {
        return {
          version: 2,
          type: 'error',
          code: 'SNAPSHOT_EXPIRED',
          message: '这次快照已过期，请重新同步。',
        };
      }
      const end = Math.min(request.cursor + SYNC_PAGE_CHARACTERS, snapshot.json.length);
      return {
        version: 2,
        type: 'page',
        epoch,
        token: snapshot.token,
        cursor: request.cursor,
        chunk: snapshot.json.slice(request.cursor, end),
        nextCursor: end < snapshot.json.length ? end : null,
      };
    } catch (error) {
      return {
        version: 2,
        type: 'error',
        code: error instanceof SyncDataError ? 'INVALID_DATA' : 'UNAVAILABLE',
        message:
          error instanceof SyncDataError
            ? '电脑同步数据需要检查，请在电脑打开 ValRecall。'
            : '电脑还没确认，请稍后重试。',
      };
    }
  }
}

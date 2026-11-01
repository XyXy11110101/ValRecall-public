import { isLocalDateKey } from '../models/daily-task';

export const SYNC_PROTOCOL_VERSION = 2 as const;
export const SYNC_BATCH_LIMIT = 50;
export const SYNC_PAGE_CHARACTERS = 48_000;
export const SYNC_MAX_SNAPSHOT_CHARACTERS = 8_000_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSyncId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** A calendar date is captured when an operation is made, never re-dated on arrival. */
export function dateInTimeZone(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime()) || !isTimeZone(timeZone)) {
    throw new Error('电脑时区或时间无效，请重新同步。');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const result = `${part('year')}-${part('month')}-${part('day')}`;
  if (!isLocalDateKey(result)) throw new Error('无法确定任务日期。');
  return result;
}

export function computerTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isTimeZone(timeZone)) throw new Error('无法读取电脑时区。');
  return timeZone;
}

export function probeResponse(request: unknown): { version: 1; type: 'probe'; message: string } {
  if (!isRecord(request) || request.version !== 1 || request.type !== 'probe') {
    throw new Error('同步通道测试仅接受 probe，不会读取或修改任务及零花钱。');
  }
  return {
    version: 1,
    type: 'probe',
    message: '手机、同步助手和 Edge 已连接；测试未读写学习数据。',
  };
}

/** Invalid durable synchronization metadata must stop automatic attempts. */
export class SyncDataError extends Error {}

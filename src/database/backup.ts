import { DatabaseError } from './errors';
import { migratePersistedItem } from './mappers';
import { EXPORT_SCHEMA_VERSION, type PersistedLearningItem } from './types';

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }

  return btoa(binary);
}

export const MAX_IMPORTED_SCREENSHOT_BYTES = 32 * 1024 * 1024;

export function base64ToBlob(
  data: string,
  mimeType: string,
  label: string,
  maximumBytes: number,
): Blob {
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (data.length > maximumEncodedLength) {
    throw new DatabaseError('INVALID_DATA', `${label} exceeds the supported size limit.`);
  }

  try {
    const binary = atob(data);
    if (binary.length > maximumBytes) {
      throw new DatabaseError('INVALID_DATA', `${label} exceeds the supported size limit.`);
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new Blob([bytes], { type: mimeType });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError('INVALID_DATA', `${label} is not valid base64.`, error);
  }
}

export function importRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

export function importString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be text.`);
  }

  return value;
}

export function importDate(value: unknown, label: string): string {
  const source = importString(value, label);
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) {
    throw new DatabaseError('INVALID_DATA', `${label} must be a valid date.`);
  }

  return date.toISOString();
}

export function importBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DatabaseError('INVALID_DATA', `${label} must be true or false.`);
  }
  return value;
}

export function importNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return importString(value, label, true);
}

interface ImportEnvelope {
  application: 'ValRecall';
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | typeof EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  items: unknown[];
  reviews: unknown[];
  screenshots: unknown[];
  meta: unknown[];
  categories: unknown[];
  tasks: unknown[];
  taskCompletions: unknown[];
  taskSkips: unknown[];
  notes: unknown[];
  intakeReceipts: unknown[];
  wallet: unknown;
  sync: unknown;
}

export function validateExport(value: unknown): ImportEnvelope {
  const candidate = importRecord(value, 'Import data');
  if (candidate.application !== 'ValRecall') {
    throw new DatabaseError('INVALID_DATA', 'This file is not a ValRecall export.');
  }
  if (
    candidate.schemaVersion !== 1 &&
    candidate.schemaVersion !== 2 &&
    candidate.schemaVersion !== 3 &&
    candidate.schemaVersion !== 4 &&
    candidate.schemaVersion !== 5 &&
    candidate.schemaVersion !== 6 &&
    candidate.schemaVersion !== 7 &&
    candidate.schemaVersion !== 8 &&
    candidate.schemaVersion !== 9 &&
    candidate.schemaVersion !== 10 &&
    candidate.schemaVersion !== EXPORT_SCHEMA_VERSION
  ) {
    throw new DatabaseError(
      'INVALID_DATA',
      `Unsupported export schema version: ${String(candidate.schemaVersion)}.`,
    );
  }
  const coreArrays = [candidate.items, candidate.reviews, candidate.screenshots, candidate.meta];
  if (
    (candidate.schemaVersion >= 10 && !Array.isArray(candidate.taskSkips)) ||
    (candidate.taskSkips !== undefined && !Array.isArray(candidate.taskSkips))
  )
    throw new DatabaseError('INVALID_DATA', '备份缺少有效的跳过记录。');
  if (
    candidate.schemaVersion < 10 &&
    Array.isArray(candidate.taskSkips) &&
    candidate.taskSkips.length > 0
  )
    throw new DatabaseError('INVALID_DATA', '跳过记录需要版本 10 备份。');
  if (coreArrays.some((entry) => !Array.isArray(entry))) {
    throw new DatabaseError('INVALID_DATA', 'The ValRecall export is incomplete.');
  }
  if (
    candidate.schemaVersion >= 3 &&
    (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.taskCompletions))
  ) {
    throw new DatabaseError('INVALID_DATA', 'The ValRecall task export is incomplete.');
  }
  if (
    (candidate.tasks !== undefined && !Array.isArray(candidate.tasks)) ||
    (candidate.taskCompletions !== undefined && !Array.isArray(candidate.taskCompletions))
  ) {
    throw new DatabaseError('INVALID_DATA', 'Imported task collections must be arrays.');
  }
  if (candidate.schemaVersion >= 4 && !Array.isArray(candidate.categories)) {
    throw new DatabaseError('INVALID_DATA', 'The ValRecall Category export is incomplete.');
  }
  if (candidate.categories !== undefined && !Array.isArray(candidate.categories)) {
    throw new DatabaseError('INVALID_DATA', 'Imported Categories must be an array.');
  }

  if (
    candidate.schemaVersion >= 8 &&
    (!Array.isArray(candidate.notes) || !Array.isArray(candidate.intakeReceipts))
  ) {
    throw new DatabaseError('INVALID_DATA', '备份缺少笔记或整理接收记录。');
  }
  if (
    candidate.schemaVersion < 8 &&
    (candidate.notes !== undefined || candidate.intakeReceipts !== undefined)
  ) {
    throw new DatabaseError('INVALID_DATA', '笔记和整理接收记录需要版本 8 备份。');
  }
  return {
    application: 'ValRecall',
    schemaVersion: candidate.schemaVersion,
    exportedAt: importDate(candidate.exportedAt, 'exportedAt'),
    items: candidate.items as unknown[],
    reviews: candidate.reviews as unknown[],
    screenshots: candidate.screenshots as unknown[],
    meta: candidate.meta as unknown[],
    categories: (candidate.categories as unknown[] | undefined) ?? [],
    tasks: (candidate.tasks as unknown[] | undefined) ?? [],
    taskCompletions: (candidate.taskCompletions as unknown[] | undefined) ?? [],
    taskSkips: (candidate.taskSkips as unknown[] | undefined) ?? [],
    notes: (candidate.notes as unknown[] | undefined) ?? [],
    intakeReceipts: (candidate.intakeReceipts as unknown[] | undefined) ?? [],
    wallet: candidate.wallet,
    sync: candidate.sync,
  };
}

export function migrateImportedItem(
  value: unknown,
  exportSchemaVersion: number,
  index: number,
): PersistedLearningItem {
  const item = importRecord(value, `items[${index}]`);
  if (exportSchemaVersion < 8 && item.noteSource !== undefined) {
    throw new DatabaseError('INVALID_DATA', '笔记来源需要版本 8 备份。');
  }
  if (exportSchemaVersion < 6 && (item.sourceType === 'image' || item.videoOrigin === 'library')) {
    throw new DatabaseError(
      'INVALID_DATA',
      `Export schema ${exportSchemaVersion} cannot contain Library media Moments.`,
    );
  }
  if (exportSchemaVersion < 7 && item.readingSource !== undefined) {
    throw new DatabaseError('INVALID_DATA', '阅读摘录需要版本 7 的导出文件。');
  }
  if (exportSchemaVersion === 1) {
    const itemSchemaVersion = item.schemaVersion ?? 0;
    if (itemSchemaVersion !== 0 && itemSchemaVersion !== 1) {
      throw new DatabaseError(
        'INVALID_DATA',
        `Export schema 1 cannot contain learning item schema ${String(itemSchemaVersion)}.`,
      );
    }
    if (item.platform !== undefined && item.platform !== 'bilibili') {
      throw new DatabaseError('INVALID_DATA', 'Export schema 1 only supports Bilibili items.');
    }
  }

  return migratePersistedItem(value);
}

export function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new DatabaseError(
        'INVALID_DATA',
        `The import contains a duplicate ${label} ID: ${value}.`,
      );
    }
    seen.add(value);
  }
}

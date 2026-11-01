export interface IntakeReceipt {
  schemaVersion: 1;
  id: string;
  kind: 'note' | 'question';
  fingerprint: string;
  targetId: string;
  processedAt: string;
  reward: 'attempted' | 'awarded' | 'unavailable';
}

export interface IntakeEntryResult {
  recordId: string;
  questionId?: string;
  kind: 'note' | 'question';
  status: 'new' | 'duplicate' | 'conflict';
  targetId: string;
  deleted: boolean;
}

export interface IntakeResult {
  /** Present only when new content and reward were committed atomically. */
  rewardAmount?: number;
  entries: IntakeEntryResult[];
  /** Kept for callers and legacy backup support; current intake never creates notes. */
  notes: number;
  questions: number;
  /** Only receipts created with new content; duplicates never receive another attempt. */
  rewardReceiptIds: string[];
}

export function isIntakeReceipt(value: unknown): value is IntakeReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === 1 &&
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    (row.kind === 'note' || row.kind === 'question') &&
    typeof row.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(row.fingerprint) &&
    typeof row.targetId === 'string' &&
    row.targetId.length > 0 &&
    typeof row.processedAt === 'string' &&
    Number.isFinite(Date.parse(row.processedAt)) &&
    (row.reward === 'attempted' || row.reward === 'awarded' || row.reward === 'unavailable')
  );
}

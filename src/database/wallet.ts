import {
  ALLOWANCE_STORAGE_KEY,
  DEFAULT_ALLOWANCE,
  normalizeAllowance,
  type AllowanceState,
} from '../shared/allowance';
import { isLocalDateKey } from '../models/daily-task';
import { DatabaseConnection } from './connection';
import { DATABASE_NAME, STORE_NAMES } from './migrations';
import { requestResult, transactionComplete } from './idb';
import { bumpContentRevision } from './sync-revision';
import { SyncDataError } from '../sync/protocol';

export type LegacyWalletLoader = () => Promise<unknown>;
export type DatabaseOpener = { open(): Promise<IDBDatabase> };
export const WALLET_STATE_KEY = 'state';
export const SYNC_EPOCH_KEY = 'epoch';
export const SYNC_SEQUENCE_KEY = 'snapshotSequence';

export async function readLegacyWallet(): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  return (await chrome.storage.local.get(ALLOWANCE_STORAGE_KEY))[ALLOWANCE_STORAGE_KEY];
}

/** Unlike the legacy display normalizer, persistence must never turn corruption into zero. */
export function readAllowanceState(value: unknown, legacy = false): AllowanceState {
  if (value === undefined && legacy) return structuredClone(DEFAULT_ALLOWANCE);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new SyncDataError('零花钱数据无效。');
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 &&
    row.schemaVersion !== 2 &&
    !(legacy && row.schemaVersion === undefined)
  )
    throw new SyncDataError('零花钱数据版本不受支持。');
  for (const key of [
    'balance',
    'currentStreak',
    'reviewStreak',
    'totalEarned',
    'totalSpent',
    'lastCapturePraiseIndex',
    'ledgerSeq',
  ]) {
    if (legacy && key !== 'balance' && row[key] === undefined) continue;
    if (
      typeof row[key] !== 'number' ||
      !Number.isSafeInteger(row[key]) ||
      (row[key] < 0 && !(key === 'balance' && row.schemaVersion === 2))
    )
      throw new SyncDataError('零花钱金额或计数无效。');
  }
  for (const key of ['lastCheckInDate', 'lastReviewSessionDate']) {
    if (legacy && row[key] === undefined) continue;
    if (row[key] !== null && !isLocalDateKey(row[key])) throw new SyncDataError('零花钱日期无效。');
  }
  if (
    !(legacy && row.ledger === undefined) &&
    (!Array.isArray(row.ledger) || row.ledger.length > 200)
  )
    throw new SyncDataError('零花钱账本无效。');
  if (Array.isArray(row.ledger)) {
    for (const entry of row.ledger) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('amount' in entry) ||
        !('balanceAfter' in entry) ||
        !Number.isSafeInteger(entry.amount) ||
        entry.amount <= 0 ||
        !Number.isSafeInteger(entry.balanceAfter) ||
        (entry.balanceAfter < 0 && row.schemaVersion !== 2)
      )
        throw new SyncDataError('零花钱账本金额无效。');
    }
  }
  const normalized = normalizeAllowance(value);
  if (Array.isArray(row.ledger) && normalized.ledger.length !== row.ledger.length)
    throw new SyncDataError('零花钱账本有无效记录。');
  for (const entry of normalized.ledger) {
    if (
      !Number.isSafeInteger(entry.amount) ||
      !Number.isSafeInteger(entry.balanceAfter) ||
      !Number.isFinite(Date.parse(entry.at))
    )
      throw new SyncDataError('零花钱账本存在无效记录。');
  }
  return normalized;
}

export async function walletInTransaction(transaction: IDBTransaction): Promise<AllowanceState> {
  const row: unknown = await requestResult(
    transaction.objectStore(STORE_NAMES.wallet).get(WALLET_STATE_KEY),
  );
  if (typeof row !== 'object' || row === null || !('value' in row))
    throw new SyncDataError('零花钱数据未就绪，请稍后重试。');
  return readAllowanceState(row.value);
}

export function putWallet(transaction: IDBTransaction, state: AllowanceState): void {
  transaction
    .objectStore(STORE_NAMES.wallet)
    .put({ key: WALLET_STATE_KEY, value: readAllowanceState(state) });
  bumpContentRevision(transaction);
}

export class WalletRepository {
  constructor(
    private readonly database: DatabaseOpener,
    private readonly legacyLoader: LegacyWalletLoader = readLegacyWallet,
  ) {}

  async ensureWallet(): Promise<void> {
    const db = await this.database.open();
    const read = db.transaction(STORE_NAMES.wallet, 'readonly');
    const readDone = transactionComplete(read);
    const current: unknown = await requestResult(
      read.objectStore(STORE_NAMES.wallet).get(WALLET_STATE_KEY),
    );
    await readDone;
    if (current !== undefined) {
      if (typeof current !== 'object' || current === null || !('value' in current))
        throw new SyncDataError('零花钱数据无效。');
      readAllowanceState(current.value);
      if ((current.value as Record<string, unknown>).schemaVersion === 2) return;
      // Upgrade the authoritative IDB row, never reload the stale preferences wallet.
      const tx = db.transaction(STORE_NAMES.wallet, 'readwrite');
      const done = transactionComplete(tx);
      try {
        const latest: unknown = await requestResult(
          tx.objectStore(STORE_NAMES.wallet).get(WALLET_STATE_KEY),
        );
        if (typeof latest !== 'object' || latest === null || !('value' in latest))
          throw new SyncDataError('零花钱数据无效。');
        const state = readAllowanceState(latest.value);
        if ((latest.value as Record<string, unknown>).schemaVersion !== 2) putWallet(tx, state);
        await done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          /* Already closed. */
        }
        await done.catch(() => undefined);
        throw error;
      }
      return;
    }
    // Read the old store outside the IDB transaction. A failure aborts migration entirely.
    const state = readAllowanceState(await this.legacyLoader(), true);
    const tx = db.transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    const existing: unknown = await requestResult(
      tx.objectStore(STORE_NAMES.wallet).get(WALLET_STATE_KEY),
    );
    if (existing === undefined) putWallet(tx, state);
    await done;
  }

  async load(): Promise<AllowanceState> {
    await this.ensureWallet();
    const tx = (await this.database.open()).transaction(STORE_NAMES.wallet, 'readonly');
    const done = transactionComplete(tx);
    const state = await walletInTransaction(tx);
    await done;
    return state;
  }

  async update<T>(
    mutation: (state: AllowanceState) => { state: AllowanceState; result: T },
  ): Promise<T> {
    await this.ensureWallet();
    const tx = (await this.database.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const previous = await walletInTransaction(tx);
      const original = JSON.stringify(previous);
      const next = mutation(previous);
      if (JSON.stringify(next.state) !== original) putWallet(tx, next.state);
      await done;
      return next.result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

const defaultWallets = new WeakMap<IDBFactory, WalletRepository>();
export function getDefaultWallet(): WalletRepository {
  let wallet = defaultWallets.get(indexedDB);
  if (!wallet) {
    wallet = new WalletRepository(new DatabaseConnection(indexedDB, DATABASE_NAME));
    defaultWallets.set(indexedDB, wallet);
  }
  return wallet;
}

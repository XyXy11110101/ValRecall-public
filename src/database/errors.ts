export type DatabaseErrorCode =
  'OPEN_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_DATA' | 'TRANSACTION_FAILED';

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly cause?: unknown;

  constructor(code: DatabaseErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.cause = cause;
  }
}

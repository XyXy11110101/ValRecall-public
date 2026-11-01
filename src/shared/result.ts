export interface AppError {
  code: string;
  message: string;
  technicalMessage?: string;
}

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export const validationResult = (issues: ValidationIssue[]): ValidationResult => ({
  valid: issues.length === 0,
  issues,
});

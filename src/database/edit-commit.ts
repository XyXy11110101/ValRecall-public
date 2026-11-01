import { DatabaseError } from './errors';
import type { DraftToken } from './drafts';

export interface EditCommit {
  draft?: DraftToken;
  expectedState: string;
}
/** Stable synchronous comparison: no hashing/await inside an IDB transaction. */
export function editState(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => {
    if (key === 'reviewHistory') return undefined;
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    return entry;
  });
}
export function checkEditState(value: unknown, commit?: EditCommit) {
  if (commit && editState(value) !== commit.expectedState)
    throw new DatabaseError('CONFLICT', '原记录已在其他窗口修改，请重新打开后再编辑。');
}

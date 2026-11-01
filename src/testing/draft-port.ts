import { vi } from 'vitest';
import { DraftRepository, readDraft, type LocalDraft } from '../database/drafts';
import { DatabaseError } from '../database/errors';

/** Isolated storage port for UI unit tests; repository/recovery integration tests use real IDB. */
export function installDraftMemoryPort() {
  const rows = new Map<string, LocalDraft>();
  vi.spyOn(DraftRepository.prototype, 'list').mockImplementation(async (scope) =>
    [...rows.values()].filter((row) => row.scope === scope),
  );
  vi.spyOn(DraftRepository.prototype, 'save').mockImplementation(async (input, revision) => {
    if ((rows.get(input.id)?.revision ?? 0) !== revision)
      throw new DatabaseError('CONFLICT', '草稿已改变。');
    const row = readDraft({
      ...input,
      schemaVersion: 1,
      revision: revision + 1,
      updatedAt: new Date().toISOString(),
    });
    rows.set(row.id, row);
    return row;
  });
  vi.spyOn(DraftRepository.prototype, 'discard').mockImplementation(async (token) => {
    if (rows.get(token.id)?.revision !== token.revision)
      throw new DatabaseError('CONFLICT', '草稿已改变。');
    rows.delete(token.id);
  });
  return rows;
}

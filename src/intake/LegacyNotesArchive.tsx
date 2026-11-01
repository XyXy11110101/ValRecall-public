import { useEffect, useState } from 'react';
import type { NoteRecord } from '../models/note';
import { repository } from '../dashboard/services';
import { Notice } from '../shared/components';
import { displayError } from '../shared/extension';
import { NoteContentView } from './NoteContentView';

const loadNotes = () => repository.listNotes();

/** Historical material stays readable and remains part of the full backup. */
export function LegacyNotesArchive({
  revision = 0,
  load = loadNotes,
}: {
  revision?: number;
  load?: () => Promise<NoteRecord[]>;
}) {
  const [opened, setOpened] = useState(false);
  const [notes, setNotes] = useState<NoteRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    setLoading(true);
    setError(null);
    void load()
      .then(
        (rows) => {
          if (active) setNotes(rows);
        },
        (caught: unknown) => {
          if (active) setError(displayError(caught, '历史笔记无法加载，请重试。'));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [opened, revision, attempt, load]);
  return (
    <details
      className="legacy-notes-archive"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>历史笔记</summary>
      {opened && (
        <div className="stack" aria-busy={loading}>
          <p className="muted">以前保存的笔记，仅供查看。</p>
          {loading && <p role="status">正在读取历史笔记…</p>}
          {error && (
            <Notice tone="error">
              {error}
              <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>
                重试
              </button>
            </Notice>
          )}
          {!loading && !error && notes?.length === 0 && <p>没有历史笔记。</p>}
          {!error &&
            notes?.map((note) => (
              <details key={note.id} className="legacy-note">
                <summary>{note.title}</summary>
                <NoteContentView content={note} />
              </details>
            ))}
        </div>
      )}
    </details>
  );
}

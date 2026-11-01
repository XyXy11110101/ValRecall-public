import { useEffect, useRef, useState } from 'react';
import {
  DraftRepository,
  type DraftToken,
  type DraftValue,
  type LocalDraft,
} from '../database/drafts';

/** A local write that settles sooner than this never shows the "saving" status. */
export const DRAFT_SAVING_NOTICE_MS = 300;

/** 'pending': dirty input whose first local write has not landed yet. */
export type DurableDraftStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface DurableDraftOptions {
  id: string;
  scope: string;
  summary: string;
  payload: DraftValue;
  dirty: boolean;
  active?: boolean;
  repository?: DraftRepository;
  onRestore: (payload: DraftValue, row: LocalDraft) => void;
}
export function useDurableDraft(options: DurableDraftOptions) {
  const [repository] = useState(() => options.repository ?? new DraftRepository());
  const [available, setAvailable] = useState<LocalDraft[]>([]);
  const [status, setStatus] = useState<Exclude<DurableDraftStatus, 'pending'>>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [, setPersisted] = useState(0);
  const current = useRef(options);
  current.current = options;
  const revisions = useRef(new Map<string, number>());
  const savedPayloads = useRef(new Map<string, DraftValue>());
  const committed = useRef(new Set<string>());
  const queue = useRef<Promise<DraftToken | undefined>>(Promise.resolve(undefined));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const listed = useRef(new Map<string, Promise<LocalDraft[]>>());
  function list(scope: string, refresh = false) {
    let request = listed.current.get(scope);
    if (!request || refresh) {
      request = repository.list(scope);
      listed.current.set(scope, request);
    }
    return request;
  }
  useEffect(() => {
    if (options.active === false) return;
    let valid = true;
    void list(options.scope, true)
      .then((rows) => {
        if (valid) {
          setAvailable(
            rows.filter((row) => !revisions.current.has(row.id) && !committed.current.has(row.id)),
          );
          setHidden(false);
        }
      })
      .catch(() => {
        if (valid) {
          setStatus('error');
          setError('无法读取以前的草稿，请重试。');
        }
      });
    return () => {
      valid = false;
    };
  }, [repository, options.scope, options.active]);

  function flush(snapshot = current.current): Promise<DraftToken | undefined> {
    if (!snapshot.dirty || committed.current.has(snapshot.id)) return Promise.resolve(undefined);
    const next = queue.current
      .catch(() => undefined)
      .then(async () => {
        if (committed.current.has(snapshot.id)) return undefined;
        // A quick local write never shows "saving": the previous status stays until
        // the write settles, and `retained` already compares the exact payload.
        const notice = window.setTimeout(() => {
          if (mounted.current && current.current.id === snapshot.id) setStatus('saving');
        }, DRAFT_SAVING_NOTICE_MS);
        try {
          const previous = revisions.current.get(snapshot.id) ?? 0;
          const rows = await list(snapshot.scope);
          if (previous === 0 && rows.some((row) => row.id === snapshot.id))
            throw new Error('这份内容已有草稿，请先选“继续”或“放弃”。');
          if (savedPayloads.current.get(snapshot.id) === snapshot.payload && previous > 0)
            return { id: snapshot.id, revision: previous };
          const saved = await repository.save(
            {
              id: snapshot.id,
              scope: snapshot.scope,
              summary: snapshot.summary.slice(0, 120),
              payload: snapshot.payload,
            },
            previous,
          );
          revisions.current.set(saved.id, saved.revision);
          savedPayloads.current.set(saved.id, snapshot.payload);
          return { id: saved.id, revision: saved.revision };
        } finally {
          window.clearTimeout(notice);
        }
      });
    queue.current = next;
    void next.then(
      () => {
        if (
          mounted.current &&
          current.current.id === snapshot.id &&
          current.current.payload === snapshot.payload
        ) {
          setStatus(committed.current.has(snapshot.id) ? 'idle' : 'saved');
          setError(null);
          // The status may already read 'saved'; re-render so `retained` sees this write.
          setPersisted((count) => count + 1);
        }
      },
      (failure: unknown) => {
        if (mounted.current && current.current.id === snapshot.id) {
          setStatus('error');
          setError(failure instanceof Error ? failure.message : '存草稿失败，请重试。');
        }
      },
    );
    return next;
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const latestById = useRef(new Map<string, DurableDraftOptions>());
  latestById.current.set(options.id, options);
  useEffect(() => {
    const id = options.id;
    return () => {
      const previous = latestById.current.get(id);
      if (previous?.dirty) void flushRef.current(previous).catch(() => undefined);
      latestById.current.delete(id);
    };
  }, [options.id]);
  useEffect(() => {
    if (!options.dirty || committed.current.has(options.id)) return;
    // No status flip per keystroke or checkbox: DraftRecovery would flash "保存中".
    const timer = window.setTimeout(() => {
      void flushRef.current().catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [options.id, options.payload, options.dirty]);
  useEffect(() => {
    const flushHidden = () => {
      if (document.hidden) void flushRef.current().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', flushHidden);
    return () => {
      document.removeEventListener('visibilitychange', flushHidden);
      void flushRef.current().catch(() => undefined);
    };
  }, []);

  async function restore(row: LocalDraft) {
    try {
      if (row.id !== current.current.id) await flush();
      else await queue.current.catch(() => undefined);
      current.current.onRestore(row.payload, row);
      revisions.current.set(row.id, row.revision);
      savedPayloads.current.set(row.id, row.payload);
      setAvailable((rows) => rows.filter((candidate) => candidate.id !== row.id));
      setStatus('saved');
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法恢复这份草稿。');
    }
  }
  async function discard(row: LocalDraft) {
    if (!window.confirm('放弃这份草稿？此操作不能撤销。')) return;
    try {
      await queue.current.catch(() => undefined);
      await repository.discard(row);
      listed.current.delete(row.scope);
      revisions.current.delete(row.id);
      savedPayloads.current.delete(row.id);
      setAvailable((rows) => rows.filter((candidate) => candidate.id !== row.id));
      setError(null);
      setStatus('idle');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '草稿未删除，请重试。');
    }
  }
  async function discardCurrent() {
    const snapshot = current.current;
    const token = await flush(snapshot);
    if (token) await repository.discard(token);
    markCommitted(snapshot.id);
  }
  function markCommitted(id = current.current.id) {
    committed.current.add(id);
    if (id === current.current.id && mounted.current) {
      setStatus('idle');
      setError(null);
    }
  }
  async function retry() {
    try {
      const rows = await list(current.current.scope, true);
      setAvailable(
        rows.filter((row) => !revisions.current.has(row.id) && !committed.current.has(row.id)),
      );
      setHidden(false);
      setError(null);
      await flush();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '草稿读取失败。');
    }
  }
  async function prepareLeave() {
    const snapshot = current.current;
    try {
      await flush(snapshot);
      return current.current.id === snapshot.id && current.current.payload === snapshot.payload;
    } catch {
      // flush reports the concrete failure beside the form. Keep the input mounted.
      return false;
    }
  }
  // Dirty input that has not reached its first write yet shows a steady "will be kept"
  // line at once, so the status line never appears later and pushes the form down.
  const shownStatus: DurableDraftStatus =
    status === 'idle' && options.dirty && !committed.current.has(options.id) ? 'pending' : status;
  return {
    prepareLeave,
    version: options.payload,
    retained: savedPayloads.current.get(options.id) === options.payload && status === 'saved',
    available: hidden ? [] : available,
    status: shownStatus,
    error,
    flush,
    retry,
    restore,
    discard,
    discardCurrent,
    markCommitted,
    later: () => setHidden(true),
  };
}
export type DurableDraftController = ReturnType<typeof useDurableDraft>;

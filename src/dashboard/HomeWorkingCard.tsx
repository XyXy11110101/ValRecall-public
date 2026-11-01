import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import type { DailyTask, TaskOccurrence } from '../database';
import { WORKING_NOTE_MAX_LENGTH } from '../models/working-card';
import { Notice } from '../shared/components';
import './working-card.css';

/** A note saves itself this long after the last keystroke. */
const TASK_NOTES_SAVE_DELAY_MS = 2000;

type TaskNotesStatus = 'idle' | 'saved' | 'failed';

export interface TaskNotesFlush {
  /** False when text on the card is still unsaved; the caller must not end the card. */
  ok: boolean;
  /** The newest version this card has written, so a stale row never reaches an edit form. */
  task: DailyTask | null;
}

/** A note whose card moved on before it could be saved, kept until it is saved or given up. */
export interface StrandedNote {
  taskId: string;
  text: string;
  /** 重试 failed too. The line changes, so the click is seen to have done something. */
  retried: boolean;
}

export interface TaskNotes {
  text: string;
  status: TaskNotesStatus;
  stranded: readonly StrandedNote[];
  /** Changes with every keystroke, so a leave knows the text it saved is still the newest. */
  version: number;
  focus(): void;
  change(text: string): void;
  blur(): void;
  retry(): void;
  compositionStart(): void;
  compositionEnd(): void;
  flush(): Promise<TaskNotesFlush>;
  retryStranded(taskId: string): void;
  discardStranded(taskId: string): void;
  /** Read live: true while any text written here has not reached its task. */
  hasUnsaved(): boolean;
  /** Writes everything, stranded notes too. False when any of it is still unsaved. */
  saveAll(): Promise<boolean>;
}

interface NotesDraft {
  taskId: string;
  text: string;
  /** What the task holds, as far as this page knows. Text equal to it has nothing to save. */
  stored: string | null;
  /** The row this draft last read or wrote against. A clean draft gives way once the row moves on. */
  seen: string;
  /** Its card moved on and its write failed: it waits here for 重试 or 放弃. */
  strand?: { retrying: boolean; retried: boolean };
}

function taskNotesValue(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function draftIsDirty(draft: NotesDraft): boolean {
  return draft.text !== (draft.stored ?? '') && taskNotesValue(draft.text) !== draft.stored;
}

function rowVersion(row: TaskOccurrence): string {
  return `${row.task.updatedAt}|${row.task.notes ?? ''}`;
}

/** Text of cards that have moved on goes first: it must not wait on the card in front of it. */
function nextDraftToWrite(
  drafts: ReadonlyMap<string, NotesDraft>,
  cardTaskId: string | undefined,
): NotesDraft | null {
  let onCard: NotesDraft | null = null;
  for (const draft of drafts.values()) {
    if (!draftIsDirty(draft) || (draft.strand && !draft.strand.retrying)) continue;
    if (draft.taskId !== cardTaskId) return draft;
    onCard = draft;
  }
  return onCard;
}

/**
 * Runs `run` now, or once the mouse press in progress has produced its click. A control that
 * changes height between mousedown and mouseup moves the target out from under the pointer, and
 * the browser then sends no click at all.
 */
export function useAfterPress(): (run: () => void) => void {
  const pressed = useRef(false);
  const waiting = useRef<Array<() => void>>([]);
  useEffect(() => {
    const press = (event: MouseEvent) => {
      if (event.button === 0) pressed.current = true;
    };
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      // The click follows mouseup in the same task, so this runs after it.
      window.setTimeout(() => {
        for (const run of waiting.current.splice(0)) run();
      }, 0);
    };
    window.addEventListener('mousedown', press, true);
    window.addEventListener('mouseup', release, true);
    window.addEventListener('pointercancel', release, true);
    // A release the page never hears, on a scrollbar say, must not hold back the next Enter.
    window.addEventListener('keydown', release, true);
    // Not captured: a field's own blur must not count as the window losing the press.
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('mousedown', press, true);
      window.removeEventListener('mouseup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('keydown', release, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  return useCallback((run: () => void) => {
    if (pressed.current) waiting.current.push(run);
    else run();
  }, []);
}

const runNow = (run: () => void) => run();

/**
 * The card's note: local drafts keyed by task, each written to its task's own 备注. The list
 * refreshes underneath them, so a draft only adopts the row while nothing is being typed or saved.
 * Writes run one at a time, always of the newest text, and a failed write waits for the next
 * keystroke, blur or retry instead of retrying on its own. Once a card has moved on, its text no
 * longer holds up the next card: a failed write sets it aside as a stranded note.
 */
export function useTaskNotes(
  row: TaskOccurrence | null,
  save: ((taskId: string, notes: string | null) => Promise<DailyTask>) | undefined,
  afterPress: (run: () => void) => void = runNow,
): TaskNotes {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, NotesDraft>>(() => new Map());
  const [outcome, setOutcome] = useState<{ taskId: string; status: TaskNotesStatus } | null>(null);
  const draftsRef = useRef(drafts);
  const rowRef = useRef(row);
  const saveRef = useRef(save);
  const focused = useRef(false);
  const composing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const writing = useRef<Promise<void> | null>(null);
  const lastSaved = useRef<DailyTask | null>(null);
  const keystrokes = useRef(0);
  rowRef.current = row;
  // The card can be switched off with text still on its way.
  if (save) saveRef.current = save;
  // React sends no blur when a focused field is removed, and no row means no field.
  if (!row) {
    focused.current = false;
    composing.current = false;
  }

  const putDraft = useCallback((next: NotesDraft) => {
    const map = new Map(draftsRef.current);
    map.set(next.taskId, next);
    draftsRef.current = map;
    setDrafts(map);
  }, []);
  const dropDraft = useCallback((taskId: string) => {
    const map = new Map(draftsRef.current);
    map.delete(taskId);
    draftsRef.current = map;
    setDrafts(map);
  }, []);

  const settle = useCallback(() => {
    if (writing.current) return;
    const shown = rowRef.current;
    for (const current of draftsRef.current.values()) {
      if (draftIsDirty(current)) continue;
      const onCard = shown?.task.id === current.taskId;
      if (onCard && (focused.current || rowVersion(shown) === current.seen)) continue;
      // Tidying the text can change the field's height.
      afterPress(() => {
        if (draftsRef.current.get(current.taskId) !== current) return;
        if (focused.current && rowRef.current?.task.id === current.taskId) return;
        dropDraft(current.taskId);
      });
    }
  }, [afterPress, dropDraft]);

  const flush = useCallback(async (): Promise<TaskNotesFlush> => {
    window.clearTimeout(timer.current);
    // Bounded by the typing: each pass writes newer text than the last, and a failure ends it.
    for (;;) {
      if (writing.current) {
        await writing.current;
        continue;
      }
      const shown = rowRef.current;
      const current = nextDraftToWrite(draftsRef.current, shown?.task.id);
      const write = saveRef.current;
      if (!current || !write) break;
      const seen = shown?.task.id === current.taskId ? rowVersion(shown) : current.seen;
      const attempt = write(current.taskId, taskNotesValue(current.text)).then(
        (saved) => {
          lastSaved.current = saved;
          const latest = draftsRef.current.get(current.taskId);
          if (latest) {
            const next: NotesDraft = {
              taskId: latest.taskId,
              text: latest.text,
              stored: saved.notes,
              seen,
            };
            putDraft(next);
            if (rowRef.current?.task.id === current.taskId)
              setOutcome(draftIsDirty(next) ? null : { taskId: current.taskId, status: 'saved' });
          }
          return saved;
        },
        () => {
          const latest = draftsRef.current.get(current.taskId);
          if (rowRef.current?.task.id === current.taskId)
            setOutcome({ taskId: current.taskId, status: 'failed' });
          else if (latest)
            putDraft({
              ...latest,
              strand: { retrying: false, retried: latest.strand !== undefined },
            });
          return null;
        },
      );
      writing.current = attempt.then(() => {
        writing.current = null;
      });
      if (!(await attempt) && rowRef.current?.task.id === current.taskId)
        return { ok: false, task: lastSaved.current };
    }
    // Nothing is waiting any more, so an earlier failure no longer holds.
    setOutcome((value) => (value?.status === 'failed' ? null : value));
    settle();
    return { ok: true, task: lastSaved.current };
  }, [putDraft, settle]);

  const armTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), TASK_NOTES_SAVE_DELAY_MS);
  }, [flush]);

  const shownVersion = row ? rowVersion(row) : null;
  useEffect(settle, [settle, shownVersion]);

  // The card moved on while text was waiting: it still goes to its own task. Text that could not
  // get there comes back to its field if its card does. And a new card does not open on a 已保存
  // from the last time.
  const taskId = row?.task.id ?? null;
  useEffect(() => {
    const own = taskId === null ? undefined : draftsRef.current.get(taskId);
    if (own?.strand && taskId !== null) {
      putDraft({ taskId, text: own.text, stored: own.stored, seen: own.seen });
      setOutcome({ taskId, status: 'failed' });
    } else {
      setOutcome((value) => (value?.status === 'saved' && value.taskId !== taskId ? null : value));
    }
    if ([...draftsRef.current.keys()].some((id) => id !== taskId)) void flush();
  }, [flush, putDraft, taskId]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    // beforeunload is the last moment the document still gets IndexedDB's callbacks: a write that
    // starts at pagehide usually cannot finish. pagehide stays for a close that skips beforeunload.
    const onLeaving = () => void flush();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onLeaving);
    window.addEventListener('pagehide', onLeaving);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('beforeunload', onLeaving);
      window.removeEventListener('pagehide', onLeaving);
      void flush();
    };
  }, [flush]);

  const hasUnsaved = useCallback(() => [...draftsRef.current.values()].some(draftIsDirty), []);
  const saveAll = useCallback(async () => {
    for (const draft of draftsRef.current.values())
      if (draft.strand) putDraft({ ...draft, strand: { ...draft.strand, retrying: true } });
    return (await flush()).ok && !hasUnsaved();
  }, [flush, hasUnsaved, putDraft]);

  const own = taskId === null ? undefined : drafts.get(taskId);
  return {
    text: own ? own.text : (row?.task.notes ?? ''),
    status: outcome && outcome.taskId === taskId ? outcome.status : 'idle',
    stranded: [...drafts.values()].flatMap((draft) =>
      draft.strand && draft.taskId !== taskId
        ? [{ taskId: draft.taskId, text: draft.text, retried: draft.strand.retried }]
        : [],
    ),
    version: keystrokes.current,
    // A focused field keeps its own text: a refresh must not move what is being read or typed.
    focus() {
      focused.current = true;
      const shown = rowRef.current;
      if (shown && !draftsRef.current.has(shown.task.id)) {
        putDraft({
          taskId: shown.task.id,
          text: shown.task.notes ?? '',
          stored: shown.task.notes,
          seen: rowVersion(shown),
        });
      }
    },
    change(text) {
      const shown = rowRef.current;
      if (!shown) return;
      const current = draftsRef.current.get(shown.task.id);
      const next = current
        ? { ...current, text }
        : {
            taskId: shown.task.id,
            text,
            stored: shown.task.notes,
            seen: rowVersion(shown),
          };
      keystrokes.current += 1;
      putDraft(next);
      // A trailing newline has nothing to save, so 已保存 is still true.
      if (draftIsDirty(next))
        setOutcome((value) =>
          value?.status === 'saved' && value.taskId === shown.task.id ? null : value,
        );
      window.clearTimeout(timer.current);
      if (!composing.current) armTimer();
    },
    blur() {
      focused.current = false;
      composing.current = false;
      void flush();
    },
    retry() {
      void flush();
    },
    // Pinyin on its way to a candidate is not text yet, so the pause over the list saves nothing.
    compositionStart() {
      composing.current = true;
      window.clearTimeout(timer.current);
    },
    // Chromium's last input event comes before this one, still marked as composing.
    compositionEnd() {
      composing.current = false;
      armTimer();
    },
    flush,
    retryStranded(id) {
      const note = draftsRef.current.get(id);
      if (!note?.strand || note.strand.retrying) return;
      putDraft({ ...note, strand: { ...note.strand, retrying: true } });
      void flush();
    },
    discardStranded(id) {
      if (draftsRef.current.get(id)?.strand) dropDraft(id);
    },
    hasUnsaved,
    saveAll,
  };
}

interface NextStepField {
  text: string;
  editing: boolean;
  onOpen(): void;
  onChange(text: string): void;
  /** Settles to false when the text could not be saved; the field then stays open. */
  onCommit(): Promise<boolean>;
  onCancel(): void;
}

/**
 * The one task being worked on. The row itself comes from the list's own renderer, so completing,
 * the stamp and the coin behave exactly as on any other row. Without `fields` the card holds only
 * an undo line, on its way out. `finished` freezes everything while the stamp shows.
 */
export function HomeWorkingCard({
  children,
  cardRef,
  fields,
}: {
  children: ReactNode;
  cardRef?: Ref<HTMLElement>;
  fields?: { finished: boolean; next: NextStepField; notes: TaskNotes };
}) {
  return (
    <section ref={cardRef} className="home-working-card" aria-labelledby="home-working-heading">
      <h4 id="home-working-heading">工作中</h4>
      {children}
      {fields && (
        <div className="home-working-fields" inert={fields.finished}>
          <NextStepLine {...fields.next} />
          <TaskNotesArea {...fields.notes} />
        </div>
      )}
    </section>
  );
}

function NextStepLine({ text, editing, onOpen, onChange, onCommit, onCancel }: NextStepField) {
  const input = useRef<HTMLInputElement>(null);
  const line = useRef<HTMLButtonElement>(null);
  // Enter or Esc already decided: the blur that follows must not save a second time.
  const decided = useRef(false);
  const focusLine = useRef(false);

  useEffect(() => {
    if (editing) {
      decided.current = false;
      const field = input.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    } else if (focusLine.current) {
      focusLine.current = false;
      line.current?.focus();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        ref={line}
        type="button"
        className={`home-working-next${text ? ' has-text' : ''}`}
        onClick={onOpen}
      >
        {text ? (
          `下一步：${text}`
        ) : (
          <>
            <span aria-hidden="true">+</span> 下一步
          </>
        )}
      </button>
    );
  }
  return (
    <input
      ref={input}
      className="home-working-next-input"
      aria-label="下一步"
      placeholder="下一步"
      value={text}
      maxLength={WORKING_NOTE_MAX_LENGTH}
      autoComplete="off"
      onChange={(event) => {
        // Typed after Enter: Enter no longer settles the field, so leaving it saves the newest text.
        decided.current = false;
        focusLine.current = false;
        onChange(event.target.value);
      }}
      onBlur={() => {
        if (!decided.current) void onCommit();
      }}
      onKeyDown={(event) => {
        // Enter ends a Chinese composition first; it must not also submit.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          decided.current = true;
          focusLine.current = true;
          void onCommit().then((saved) => {
            if (saved) return;
            decided.current = false;
            focusLine.current = false;
          });
        } else if (event.key === 'Escape') {
          decided.current = true;
          focusLine.current = true;
          onCancel();
        }
      }}
    />
  );
}

function TaskNotesArea({
  text,
  status,
  focus,
  change,
  blur,
  retry,
  compositionStart,
  compositionEnd,
}: TaskNotes) {
  const field = useRef<HTMLTextAreaElement>(null);
  const retryButton = useRef<HTMLButtonElement | null>(null);
  const retryHadFocus = useRef(false);
  // Leaving the field saves it, so a save can succeed with focus already on the button, or on its
  // way there under a press that never becomes a click. React detaches a ref before it removes the
  // node, which is the last moment to see that.
  const attachRetry = useCallback((element: HTMLButtonElement | null) => {
    if (!element) retryHadFocus.current = document.activeElement === retryButton.current;
    retryButton.current = element;
  }, []);
  useLayoutEffect(() => {
    if (!retryHadFocus.current) return;
    retryHadFocus.current = false;
    field.current?.focus();
  }, [status]);
  return (
    <div className="home-working-notes">
      <div className="home-working-notes-head">
        <label htmlFor="home-working-notes-input">笔记</label>
        <span className="home-working-notes-status" role="status">
          {status === 'saved' && '已保存'}
          {status === 'failed' && (
            <button
              ref={attachRetry}
              type="button"
              className="home-working-notes-retry"
              onClick={() => {
                // The button goes away on success: focus must not go with it.
                field.current?.focus();
                retry();
              }}
            >
              没保存，请重试
            </button>
          )}
        </span>
      </div>
      <textarea
        ref={field}
        id="home-working-notes-input"
        value={text}
        rows={3}
        placeholder="想到什么记在这里"
        onFocus={focus}
        onBlur={blur}
        onChange={(event) => change(event.target.value)}
        onCompositionStart={compositionStart}
        onCompositionEnd={compositionEnd}
      />
    </div>
  );
}

/**
 * Text that could not reach a task no longer on the card. It stays readable here, so it can still
 * be copied when its task is gone, until it is saved or given up.
 */
export function StrandedNotes({
  notes,
  focusAfter,
}: {
  notes: Pick<TaskNotes, 'stranded' | 'retryStranded' | 'discardStranded'>;
  /** Where focus goes when the notice holding it leaves. */
  focusAfter: () => void;
}) {
  return notes.stranded.map((note) => (
    <StrandedNotice
      key={note.taskId}
      note={note}
      onRetry={() => notes.retryStranded(note.taskId)}
      onDiscard={() => notes.discardStranded(note.taskId)}
      focusAfter={focusAfter}
    />
  ));
}

function StrandedNotice({
  note,
  onRetry,
  onDiscard,
  focusAfter,
}: {
  note: StrandedNote;
  onRetry: () => void;
  onDiscard: () => void;
  focusAfter: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(focusAfter);
  moveFocus.current = focusAfter;
  useLayoutEffect(() => {
    const element = box.current;
    // Runs before the notice leaves the page: focus must not go with it.
    return () => {
      if (element?.contains(document.activeElement)) moveFocus.current();
    };
  }, []);
  return (
    <Notice tone="error">
      <div ref={box} className="home-working-stranded">
        <p>上一项的笔记{note.retried ? '还是' : ''}没保存</p>
        <button className="button text-button" aria-label="重试 上一项的笔记" onClick={onRetry}>
          重试
        </button>
        <button className="button text-button" aria-label="放弃 上一项的笔记" onClick={onDiscard}>
          放弃
        </button>
        <p className="home-working-stranded-text">{note.text}</p>
      </div>
    </Notice>
  );
}

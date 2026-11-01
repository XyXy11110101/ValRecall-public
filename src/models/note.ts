/** Notes never carry a schedule. Source snapshots remain readable after note deletion. */
export interface NoteContent {
  title: string;
  excerpt: string;
  thought: string;
  summary: string;
  aiAdditions: string;
  bookTitle: string;
  location: string;
}

export interface NoteRecord extends NoteContent {
  schemaVersion: 1;
  id: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSource extends NoteContent {
  schemaVersion: 1;
  noteId: string;
}

export const NOTE_FIELDS = [
  'title',
  'excerpt',
  'thought',
  'summary',
  'aiAdditions',
  'bookTitle',
  'location',
] as const;

export function isNoteContent(value: unknown): value is NoteContent {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    NOTE_FIELDS.every((key) => typeof row[key] === 'string') &&
    typeof row.title === 'string' &&
    row.title.trim().length > 0 &&
    ((typeof row.excerpt === 'string' && row.excerpt.trim().length > 0) ||
      (typeof row.thought === 'string' && row.thought.trim().length > 0))
  );
}

export function noteContent(value: NoteContent): NoteContent {
  return {
    title: value.title,
    excerpt: value.excerpt,
    thought: value.thought,
    summary: value.summary,
    aiAdditions: value.aiAdditions,
    bookTitle: value.bookTitle,
    location: value.location,
  };
}

export function isNoteSource(value: unknown): value is NoteSource {
  if (!isNoteContent(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return row.schemaVersion === 1 && typeof row.noteId === 'string' && row.noteId.length > 0;
}

export function isNoteRecord(value: unknown): value is NoteRecord {
  if (!isNoteContent(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    row.schemaVersion === 1 &&
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    (row.categoryId === null ||
      (typeof row.categoryId === 'string' && row.categoryId.length > 0)) &&
    ['createdAt', 'updatedAt'].every(
      (key) => typeof row[key] === 'string' && Number.isFinite(Date.parse(row[key])),
    )
  );
}

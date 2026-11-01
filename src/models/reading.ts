/** Authored source evidence, never an answer shown before Reveal. */
export interface ReadingSource {
  schemaVersion: 1;
  excerpt: string;
  bookTitle: string;
  location: string;
}

export function isReadingSource(value: unknown): value is ReadingSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    source.schemaVersion === 1 &&
    typeof source.excerpt === 'string' &&
    source.excerpt.trim().length > 0 &&
    typeof source.bookTitle === 'string' &&
    typeof source.location === 'string'
  );
}

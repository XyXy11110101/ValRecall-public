import type { ReadingSource } from '../models/reading';

export function ReadingSourceDetails({ source }: { source: ReadingSource }) {
  return (
    <details className="reading-source-details">
      <summary>原文与出处</summary>
      {(source.bookTitle || source.location) && (
        <p className="muted small">
          {[source.bookTitle, source.location].filter(Boolean).join(' · ')}
        </p>
      )}
      <blockquote className="reading-excerpt">{source.excerpt}</blockquote>
    </details>
  );
}

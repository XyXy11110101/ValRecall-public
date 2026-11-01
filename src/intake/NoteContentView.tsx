import type { NoteContent } from '../models/note';

/** Render untrusted material as text, with provenance visible in every context. */
export function NoteContentView({ content }: { content: NoteContent }) {
  return (
    <div className="note-content stack">
      {content.excerpt && (
        <section>
          <h4>原文</h4>
          <blockquote className="reading-excerpt">{content.excerpt}</blockquote>
        </section>
      )}
      {content.thought && (
        <section>
          <h4>自己的感想</h4>
          <p>{content.thought}</p>
        </section>
      )}
      {content.summary && (
        <section>
          <h4>整理摘要 · AI</h4>
          <p>{content.summary}</p>
        </section>
      )}
      {content.aiAdditions && (
        <section>
          <h4>补充与待核实 · AI</h4>
          <p className="muted">{content.aiAdditions}</p>
        </section>
      )}
      {(content.bookTitle || content.location) && (
        <p className="muted small">
          {[content.bookTitle, content.location].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}

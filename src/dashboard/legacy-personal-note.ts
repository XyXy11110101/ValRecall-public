export type LegacyPersonalNoteKind = 'none' | 'duplicate' | 'distinct';

export interface LegacyPersonalNote {
  kind: LegacyPersonalNoteKind;
  value: string;
}

export interface LegacyNoteEditorInitialState {
  coreLesson: string;
  personalNote: string;
  legacy: LegacyPersonalNote;
  resolution: 'none' | 'keep' | 'merge' | 'discard';
}

/** Comparison-only normalization. Stored user text is never rewritten by this helper. */
export function normalizeLegacyNoteWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function classifyLegacyPersonalNote(
  coreLesson: string,
  personalNote: string,
): LegacyPersonalNote {
  const normalizedNote = normalizeLegacyNoteWhitespace(personalNote);
  if (normalizedNote.length === 0) return { kind: 'none', value: personalNote };

  const normalizedCore = normalizeLegacyNoteWhitespace(coreLesson);
  if (normalizedCore.length > 0 && normalizedCore === normalizedNote) {
    return { kind: 'duplicate', value: personalNote };
  }
  return { kind: 'distinct', value: personalNote };
}

export function createLegacyNoteEditorInitialState(
  coreLesson: string,
  personalNote: string,
): LegacyNoteEditorInitialState {
  const legacy = classifyLegacyPersonalNote(coreLesson, personalNote);
  if (legacy.kind === 'none') {
    return { coreLesson, personalNote: '', legacy, resolution: 'none' };
  }
  if (legacy.kind === 'duplicate') {
    return { coreLesson, personalNote: '', legacy, resolution: 'none' };
  }
  if (normalizeLegacyNoteWhitespace(coreLesson).length === 0) {
    return {
      coreLesson: personalNote,
      personalNote: '',
      legacy,
      resolution: 'merge',
    };
  }
  return { coreLesson, personalNote, legacy, resolution: 'keep' };
}

export function mergeLegacyPersonalNote(coreLesson: string, personalNote: string): string {
  const core = coreLesson.trim();
  const note = personalNote.trim();
  if (note.length === 0) return core;
  if (core.length === 0) return note;
  if (normalizeLegacyNoteWhitespace(core) === normalizeLegacyNoteWhitespace(note)) return core;
  return `${core}\n\n${note}`;
}

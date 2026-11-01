import { describe, expect, it } from 'vitest';

import { DATABASE_VERSION, STORE_NAMES } from '../database';
import {
  classifyLegacyPersonalNote,
  createLegacyNoteEditorInitialState,
  mergeLegacyPersonalNote,
  normalizeLegacyNoteWhitespace,
} from './legacy-personal-note';

describe('legacy personal-note compatibility', () => {
  it('keeps legacy personal notes on items after the authorized standalone-note migration', () => {
    expect(DATABASE_VERSION).toBe(6);
    expect(Object.values(STORE_NAMES)).toEqual([
      'items',
      'screenshots',
      'reviews',
      'meta',
      'dailyTasks',
      'taskCompletions',
      'notes',
      'intakeReceipts',
      'wallet',
      'syncReceipts',
      'taskRevisions',
      'occurrenceRevisions',
      'taskSkips',
      'drafts',
      'learningReceipts',
      'reviewSessions',
    ]);
  });

  it('uses conservative whitespace normalization only for duplicate comparison', () => {
    expect(normalizeLegacyNoteWhitespace('  Hold\u00a0 the\nangle.  ')).toBe('Hold the angle.');
    expect(classifyLegacyPersonalNote('Hold the angle.', ' Hold\n the angle. ')).toMatchObject({
      kind: 'duplicate',
    });
  });

  it('hides empty and duplicate notes while staging duplicate clearing only on save', () => {
    expect(createLegacyNoteEditorInitialState('Take space.', '')).toMatchObject({
      coreLesson: 'Take space.',
      personalNote: '',
      legacy: { kind: 'none' },
    });
    expect(createLegacyNoteEditorInitialState('Take space.', '  Take   space. ')).toMatchObject({
      coreLesson: 'Take space.',
      personalNote: '',
      legacy: { kind: 'duplicate' },
    });
  });

  it('preserves a distinct legacy note by default', () => {
    expect(createLegacyNoteEditorInitialState('Hold the angle.', 'Use utility first.')).toEqual({
      coreLesson: 'Hold the angle.',
      personalNote: 'Use utility first.',
      legacy: { kind: 'distinct', value: 'Use utility first.' },
      resolution: 'keep',
    });
  });

  it('prefills an empty Key takeaway from legacy text and stages the move for save', () => {
    expect(createLegacyNoteEditorInitialState('  ', 'Keep this old note.')).toEqual({
      coreLesson: 'Keep this old note.',
      personalNote: '',
      legacy: { kind: 'distinct', value: 'Keep this old note.' },
      resolution: 'merge',
    });
  });

  it('merges distinct text without dropping or duplicating either value', () => {
    expect(mergeLegacyPersonalNote('Hold the angle.', 'Use utility first.')).toBe(
      'Hold the angle.\n\nUse utility first.',
    );
    expect(mergeLegacyPersonalNote('Hold the angle.', ' Hold\n the angle. ')).toBe(
      'Hold the angle.',
    );
  });
});

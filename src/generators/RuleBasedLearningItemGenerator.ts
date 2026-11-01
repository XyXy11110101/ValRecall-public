import {
  validateLearningItemDraft,
  type LearningItemDraftFields,
  type LearningItemType,
} from '../models/learning-item';
import {
  type GenerationSource,
  type LearningItemGenerationInput,
  type LearningItemGenerationResult,
  type LearningItemGenerator,
} from './LearningItemGenerator';
import { PUBLIC_RECALL_PROMPTS, publicBaseTags } from '../edition/capture-defaults';

const RECALL_PROMPTS: Record<LearningItemType, string> = {
  Avoid: 'What should you avoid in this situation?',
  Do: 'What action should you take in this situation?',
  Notice: 'What cue should you notice here?',
  Understand: 'What principle or explanation should you remember from this moment?',
};

export class RuleBasedLearningItemGenerator implements LearningItemGenerator {
  async generate(input: LearningItemGenerationInput): Promise<LearningItemGenerationResult> {
    const authoredCoreLesson = clean(input.coreLesson);
    const coreLesson = authoredCoreLesson;
    const sourceUsed: GenerationSource = coreLesson ? 'key-takeaway' : 'none';

    const fields: LearningItemDraftFields = {
      situation: '',
      coreLesson,
      mistakeToAvoid: '',
      recommendedAction: '',
      reason: '',
      recallPrompt: __VALRECALL_PUBLIC_RELEASE__
        ? PUBLIC_RECALL_PROMPTS[input.itemType]
        : RECALL_PROMPTS[input.itemType],
      referenceAnswer: coreLesson,
      tags: buildTags(input.platform, input.itemType, input.chapterTitle),
    };
    const validation = validateLearningItemDraft({
      ...fields,
      itemType: input.itemType,
    });

    // An empty answer is normal while writing. The save check reports it and focuses the field.
    return { fields, validation, sourceUsed, warnings: [] };
  }
}

function buildTags(
  platform: LearningItemGenerationInput['platform'],
  itemType: LearningItemType,
  chapterTitle: string | null,
): string[] {
  const tags = __VALRECALL_PUBLIC_RELEASE__
    ? publicBaseTags(platform, itemType)
    : [platform, itemType.toLowerCase()];
  const chapter = clean(chapterTitle ?? '');
  if (chapter.length > 0 && chapter.length <= 60) {
    tags.push(chapter);
  }
  return uniqueLines(tags);
}

/**
 * Defence in depth for persisted or externally supplied drafts. The adapter is the
 * primary trust boundary; this only rejects the combined signature of a settings
 * document and never rejects a cue merely for containing one ordinary UI word.
 */
export function looksLikeSubtitleSettingsText(value: string): boolean {
  const text = clean(value);
  const strongMarkers = [
    '字幕大小',
    '字幕颜色',
    '恢复默认设置',
    'B站自研的AI原声翻译功能',
    String.fromCodePoint(0x701b, 0x6940, 0x7bb7, 0x6fb6, 0x0443, 0x76ac),
    String.fromCodePoint(0x701b, 0x6940, 0x7bb7, 0x68f0, 0x6ec6, 0x58ca),
    String.fromCodePoint(0x93ad, 0x3220, 0xe632, 0x699b, 0x6a3f, 0xe17b, 0x7481, 0x5267, 0x7586),
    String.fromCodePoint(
      0x0042,
      0x7ed4,
      0x6b12,
      0x569c,
      0x942e,
      0x65c2,
      0x6b91,
      0x0041,
      0x0049,
      0x9358,
      0x71b7,
      0xff10,
      0x7f08,
      0x660f,
      0x7627,
      0x9354,
      0x71bb,
      0x5158,
    ),
  ];
  const interfaceMarkers = [
    '字幕设置',
    String.fromCodePoint(0x701b, 0x6940, 0x7bb7, 0x7481, 0x5267, 0x7586),
    String.fromCodePoint(0x93bb, 0x5fda, 0x7adf, 0x93c2, 0x7470, 0x7d21),
    String.fromCodePoint(0x699b, 0x6a3f, 0xe17b, 0x6d63, 0x5d87, 0x7586),
    String.fromCodePoint(0x9473, 0x5c7e, 0x6ad9, 0x6d93, 0x5d89, 0x20ac, 0x5fd4, 0x69d1, 0x6434),
    String.fromCodePoint(0x7edb, 0x590b, 0x762e, 0x7f02, 0x2542, 0x6581),
  ];
  const strongMatches = strongMarkers.filter((marker) => text.includes(marker)).length;
  const interfaceMatches = interfaceMarkers.filter((marker) => text.includes(marker)).length;
  return strongMatches >= 2 || (text.length > 240 && strongMatches + interfaceMatches >= 3);
}

function uniqueLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const value = clean(line);
    if (value.length > 0 && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function clean(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

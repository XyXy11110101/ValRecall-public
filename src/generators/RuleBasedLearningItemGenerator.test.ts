import { describe, expect, it } from 'vitest';

import { LEARNING_ITEM_TYPES, type LearningItemType } from '../models/learning-item';
import { RuleBasedLearningItemGenerator } from './RuleBasedLearningItemGenerator';

const prompts: Record<LearningItemType, string> = {
  Avoid: 'What should you avoid in this situation?',
  Do: 'What action should you take in this situation?',
  Notice: 'What cue should you notice here?',
  Understand: 'What principle or explanation should you remember from this moment?',
};

describe('RuleBasedLearningItemGenerator', () => {
  const generator = new RuleBasedLearningItemGenerator();

  it.each(LEARNING_ITEM_TYPES)(
    'generates the required %s prompt without changing the note',
    async (itemType) => {
      const result = await generator.generate({
        platform: 'bilibili',
        itemType,
        coreLesson: 'Move only after the smoke lands.',
        subtitleBefore: ['Wait for the utility cue.'],
        subtitleCurrent: ['The smoke has landed.'],
        subtitleAfter: ['Clear the next angle.'],
        videoTitle: 'A-site lesson',
        chapterTitle: 'Entry timing',
      });

      expect(result.fields.recallPrompt).toBe(prompts[itemType]);
      expect(result.fields.coreLesson).toBe('Move only after the smoke lands.');
      expect(result.fields.referenceAnswer).toBe('Move only after the smoke lands.');
      expect(result.fields.reason).toBe('');
      expect(JSON.stringify(result.fields)).not.toContain('The smoke has landed.');
      expect(result.sourceUsed).toBe('key-takeaway');
      expect(result.validation.valid).toBe(true);
    },
  );

  it('does not populate legacy structured fields for new Captures', async () => {
    const avoid = await generator.generate({
      platform: 'bilibili',
      itemType: 'Avoid',
      coreLesson: 'Do not re-peek immediately.',
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      videoTitle: null,
      chapterTitle: null,
    });
    const action = await generator.generate({
      platform: 'bilibili',
      itemType: 'Do',
      coreLesson: 'Reposition after contact.',
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      videoTitle: null,
      chapterTitle: null,
    });

    expect(avoid.fields.situation).toBe('');
    expect(avoid.fields.mistakeToAvoid).toBe('');
    expect(avoid.fields.recommendedAction).toBe('');
    expect(avoid.fields.reason).toBe('');
    expect(action.fields.situation).toBe('');
    expect(action.fields.recommendedAction).toBe('');
    expect(action.fields.mistakeToAvoid).toBe('');
    expect(action.fields.reason).toBe('');
  });

  it('keeps nearby subtitles as source context when no Key takeaway exists', async () => {
    const result = await generator.generate({
      platform: 'bilibili',
      itemType: 'Notice',
      coreLesson: '',
      subtitleBefore: ['Before line'],
      subtitleCurrent: ['Visible cue'],
      subtitleAfter: ['After line'],
      videoTitle: null,
      chapterTitle: null,
    });

    expect(result.fields.coreLesson).toBe('');
    expect(result.fields.referenceAnswer).toBe('');
    expect(result.fields.reason).toBe('');
    expect(JSON.stringify(result.fields)).not.toContain('Visible cue');
    expect(result.sourceUsed).toBe('none');
    // An unwritten answer is not a warning: the check happens at save, not when the panel opens.
    expect(result.warnings).toEqual([]);
  });

  it('does not invent a lesson when note and subtitle context are empty', async () => {
    const result = await generator.generate({
      platform: 'bilibili',
      itemType: 'Understand',
      coreLesson: '',
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      videoTitle: 'Aim theory',
      chapterTitle: null,
    });

    expect(result.fields.coreLesson).toBe('');
    expect(result.fields.referenceAnswer).toBe('');
    expect(result.sourceUsed).toBe('none');
    expect(result.validation.valid).toBe(false);
    expect(result.validation.issues.some((issue) => issue.code === 'CORE_LESSON_REQUIRED')).toBe(
      true,
    );
  });

  it('refuses genuine Chinese subtitle settings documents as an automatic lesson', async () => {
    const result = await generator.generate({
      platform: 'bilibili',
      itemType: 'Understand',
      coreLesson: '',
      subtitleReliable: true,
      subtitleBefore: [],
      subtitleCurrent: [
        '字幕设置 字幕大小 适中 字幕颜色 白色 恢复默认设置 B站自研的AI原声翻译功能',
      ],
      subtitleAfter: [],
      videoTitle: 'Fixture',
      chapterTitle: null,
    });

    expect(result.fields.coreLesson).toBe('');
    expect(result.fields.referenceAnswer).toBe('');
    expect(result.sourceUsed).toBe('none');
  });

  it('continues to refuse legacy mojibake subtitle settings documents', async () => {
    const result = await generator.generate({
      platform: 'bilibili',
      itemType: 'Understand',
      coreLesson: '',
      subtitleReliable: true,
      subtitleBefore: [],
      subtitleCurrent: [
        '\u701b\u6940\u7bb7\u7481\u5267\u7586\u0020\u701b\u6940\u7bb7\u6fb6\u0443\u76ac\u0020\u95ab\u5099\u8151\u0020\u701b\u6940\u7bb7\u68f0\u6ec6\u58ca\u0020\u9427\u501f\u58ca\u0020\u93bb\u5fda\u7adf\u93c2\u7470\u7d21\u0020\u699b\u6a3f\ue17b\u6d63\u5d87\u7586\u0020\u9473\u5c7e\u6ad9\u6d93\u5d89\u20ac\u5fd4\u69d1\u6434\u003f\u93ad\u3220\ue632\u699b\u6a3f\ue17b\u7481\u5267\u7586',
      ],
      subtitleAfter: [],
      videoTitle: 'Fixture',
      chapterTitle: null,
    });

    expect(result.fields.coreLesson).toBe('');
    expect(result.fields.referenceAnswer).toBe('');
    expect(result.sourceUsed).toBe('none');
  });

  it('does not consume subtitles when the extraction result is unavailable', async () => {
    const result = await generator.generate({
      platform: 'bilibili',
      itemType: 'Notice',
      coreLesson: '',
      subtitleReliable: false,
      subtitleBefore: [],
      subtitleCurrent: ['An untrusted fallback value'],
      subtitleAfter: [],
      videoTitle: null,
      chapterTitle: null,
    });

    expect(result.sourceUsed).toBe('none');
    expect(result.fields.referenceAnswer).toBe('');
  });

  it('tags generated fields with the capture platform', async () => {
    const result = await generator.generate({
      platform: 'youtube',
      itemType: 'Do',
      coreLesson: 'Hold the angle before moving.',
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      videoTitle: 'YouTube lesson',
      chapterTitle: null,
    });

    expect(result.fields.tags).toEqual(['youtube', 'do']);
  });
});

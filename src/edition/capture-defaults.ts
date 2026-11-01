import { learningGoalLabel, type LearningItemType } from '../models/learning-item';
import type { VideoPlatform } from '../models/platform';

export const PUBLIC_RECALL_PROMPTS: Record<LearningItemType, string> = {
  Avoid: '遇到这种情况，应该避免什么？',
  Do: '遇到这种情况，应该怎么做？',
  Notice: '这里应该留意什么？',
  Understand: '这里要记住的道理是什么？',
};

const PLATFORM_TAGS: Record<VideoPlatform, string> = {
  bilibili: 'B站',
  youtube: 'YouTube',
  douyin: '抖音',
};

export function publicBaseTags(platform: VideoPlatform, itemType: LearningItemType): string[] {
  return [PLATFORM_TAGS[platform], learningGoalLabel(itemType)];
}

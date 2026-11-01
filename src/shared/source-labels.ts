import type { LearningItemSource } from '../database';

export function sourceLabel(source: LearningItemSource): string {
  if (source === 'text') return '文字';
  if (source === 'image') return '图片';
  return platformLabel(source);
}

export function platformLabel(platform: Exclude<LearningItemSource, 'text' | 'image'>): string {
  switch (platform) {
    case 'bilibili':
      return 'Bilibili';
    case 'youtube':
      return 'YouTube';
    case 'douyin':
      return 'Douyin';
  }
}

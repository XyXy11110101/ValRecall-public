export const VIDEO_PLATFORMS = ['bilibili', 'youtube', 'douyin'] as const;

export type VideoPlatform = (typeof VIDEO_PLATFORMS)[number];

export function isVideoPlatform(value: unknown): value is VideoPlatform {
  return typeof value === 'string' && VIDEO_PLATFORMS.some((platform) => platform === value);
}

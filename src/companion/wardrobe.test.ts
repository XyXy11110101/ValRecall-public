import { describe, expect, it } from 'vitest';

import manifest from './wardrobe-manifest.json';
import {
  COMPANION_FIGURE_POSES,
  COMPANION_HEAD_POSES,
  COMPANION_ICON_KINDS,
  COMPANION_OUTFIT_LABELS,
  COMPANION_OUTFITS,
  COMPANION_PHONE_POSES,
  COMPANION_STATIC_ONLY_POSES,
  COMPANION_WIDGET_POSES,
  companionArtPath,
  companionAssetNames,
  companionIconPath,
  epochDayFromDateKey,
  isCompanionOutfit,
  outfitForDate,
} from './wardrobe';

describe('companion wardrobe contract', () => {
  it('matches the manifest the scripts, Gradle and Kotlin read', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.artRoot).toBe('assets/companion/chibi');
    expect(manifest.rotation).toEqual([...COMPANION_OUTFITS]);
    expect(manifest.labels).toEqual(COMPANION_OUTFIT_LABELS);
    expect(manifest.figurePoses).toEqual([...COMPANION_FIGURE_POSES]);
    expect(manifest.headPoses).toEqual([...COMPANION_HEAD_POSES]);
    expect(manifest.staticOnlyPoses).toEqual([...COMPANION_STATIC_ONLY_POSES]);
    expect(manifest.iconKinds).toEqual([...COMPANION_ICON_KINDS]);
    expect(manifest.phonePoses).toEqual([...COMPANION_PHONE_POSES]);
    expect(manifest.widgetPoses).toEqual([...COMPANION_WIDGET_POSES]);
  });

  it('uses names that also work as Android resource names', () => {
    expect(new Set(COMPANION_OUTFITS).size).toBe(12);
    for (const outfit of COMPANION_OUTFITS) expect(outfit).toMatch(/^[a-z][a-z0-9]*$/);
    const poses = [...COMPANION_FIGURE_POSES, ...COMPANION_HEAD_POSES];
    expect(new Set(poses).size).toBe(poses.length);
    for (const pose of poses) expect(pose).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    const known = new Set<string>(poses);
    for (const pose of [...COMPANION_PHONE_POSES, ...COMPANION_WIDGET_POSES]) {
      expect(known.has(pose)).toBe(true);
    }
  });

  it('computes the shared date fixture exactly', () => {
    for (const example of manifest.dateCases) {
      expect(epochDayFromDateKey(example.date)).toBe(example.epochDay);
      expect(outfitForDate(example.date)).toBe(example.outfit);
    }
  });

  it('agrees with UTC calendar days across centuries', () => {
    for (let day = -40_000; day <= 60_000; day += 37) {
      const key = new Date(day * 86_400_000).toISOString().slice(0, 10);
      expect(epochDayFromDateKey(key)).toBe(day);
    }
  });

  it('rejects keys that are not real dates', () => {
    for (const key of ['', '2026-02-30', '2026-13-01', '2026-00-10', '26-10-28', '2026-1-01']) {
      expect(epochDayFromDateKey(key)).toBeNull();
      expect(outfitForDate(key)).toBe('outfit1');
    }
    expect(epochDayFromDateKey('2024-02-29')).not.toBeNull();
    expect(epochDayFromDateKey('2100-02-29')).toBeNull();
  });

  it('never repeats on consecutive days and wears all twelve in every 12-day window', () => {
    const keys = Array.from({ length: 400 }, (_, index) =>
      new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10),
    );
    const outfits = keys.map(outfitForDate);
    for (let index = 1; index < outfits.length; index += 1) {
      expect(outfits[index]).not.toBe(outfits[index - 1]);
    }
    for (let start = 0; start + 12 <= outfits.length; start += 5) {
      expect(new Set(outfits.slice(start, start + 12)).size).toBe(12);
    }
  });

  it('builds animated and static paths, keeping the worried face still', () => {
    expect(companionArtPath('outfit7', 'calm', 'animated')).toBe(
      'assets/companion/chibi/outfit7/calm.anim.svg',
    );
    expect(companionArtPath('outfit7', 'calm', 'static')).toBe(
      'assets/companion/chibi/outfit7/calm.svg',
    );
    expect(companionArtPath('outfit8', 'head-worried', 'animated')).toBe(
      'assets/companion/chibi/outfit8/head-worried.svg',
    );
    expect(companionIconPath('outfit12', 'reminder')).toBe(
      'assets/companion/chibi/outfit12/icon-reminder-128.png',
    );
    expect(isCompanionOutfit('outfit10')).toBe(true);
    expect(isCompanionOutfit('idle')).toBe(false);
    expect(isCompanionOutfit(3)).toBe(false);
  });

  it('lists every file the wardrobe expects', () => {
    const names = companionAssetNames();
    expect(names).toHaveLength(540);
    expect(new Set(names).size).toBe(540);
    expect([...names].sort()).toEqual(names);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9]*\/[a-z0-9-]+(\.anim)?\.(svg|png)$/);
    }
    expect(names).toContain('outfit1/calm.anim.svg');
    expect(names).toContain('outfit12/head-worried.svg');
    expect(names).not.toContain('outfit12/head-worried.anim.svg');
    expect(names).toContain('outfit8/icon-default-128.png');
  });
});

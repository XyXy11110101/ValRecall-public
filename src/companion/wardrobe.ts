/**
 * The companion wardrobe contract (2026-10-28). The outfit no longer follows the state: every
 * local date wears one outfit from a fixed 12-day rotation, and the state only picks the pose.
 * `wardrobe-manifest.json` holds the same data for the build scripts, Gradle and the Android
 * tests; wardrobe.test.ts keeps the two identical. Nothing here runs at module load, so public
 * builds drop every art path once the private-art flag folds the callers away.
 */

export const COMPANION_OUTFITS = [
  'outfit1',
  'outfit2',
  'outfit3',
  'outfit4',
  'outfit5',
  'outfit6',
  'outfit7',
  'outfit8',
  'outfit9',
  'outfit10',
  'outfit11',
  'outfit12',
] as const;

export type CompanionOutfit = (typeof COMPANION_OUTFITS)[number];

export const COMPANION_OUTFIT_LABELS: Readonly<Record<CompanionOutfit, string>> = {
  outfit1: '服装 1',
  outfit2: '服装 2',
  outfit3: '服装 3',
  outfit4: '服装 4',
  outfit5: '服装 5',
  outfit6: '服装 6',
  outfit7: '服装 7',
  outfit8: '服装 8',
  outfit9: '服装 9',
  outfit10: '服装 10',
  outfit11: '服装 11',
  outfit12: '服装 12',
};

export const COMPANION_FIGURE_POSES = [
  'calm',
  'wave',
  'read',
  'tea',
  'point',
  'card',
  'fist',
  'think',
  'aha',
  'note',
  'cheer',
  'clap',
  'thumbs',
  'peace',
  'jump',
  'sleepy',
  'worried',
] as const;

export const COMPANION_HEAD_POSES = [
  'head-smile',
  'head-talk',
  'head-joy',
  'head-sleepy',
  'head-worried',
] as const;

export type CompanionFigurePose = (typeof COMPANION_FIGURE_POSES)[number];
export type CompanionHeadPose = (typeof COMPANION_HEAD_POSES)[number];
export type CompanionPose = CompanionFigurePose | CompanionHeadPose;

/** The worried face only decorates error notices, so it never moves. */
export const COMPANION_STATIC_ONLY_POSES = ['head-worried'] as const;

/** The phone app's subset (private APK only). */
export const COMPANION_PHONE_POSES = [
  'head-smile',
  'head-joy',
  'head-sleepy',
  'head-worried',
  'cheer',
  'clap',
  'thumbs',
] as const;

/** Rendered to PNG for the Android home-screen widget (private APK only). */
export const COMPANION_WIDGET_POSES = [
  'head-smile',
  'head-talk',
  'head-joy',
  'head-worried',
  'calm',
  'sleepy',
  'peace',
] as const;

export const COMPANION_ICON_KINDS = ['reminder', 'default'] as const;

export type CompanionIconKind = (typeof COMPANION_ICON_KINDS)[number];
export type CompanionArtVariant = 'animated' | 'static';
export type CompanionArtPath =
  `assets/companion/chibi/${CompanionOutfit}/${CompanionPose}${'' | '.anim'}.svg`;
export type CompanionIconPath =
  `assets/companion/chibi/${CompanionOutfit}/icon-${CompanionIconKind}-128.png`;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Days since 1970-01-01 for a `YYYY-MM-DD` key, or null when the key is not a real date.
 * Integer arithmetic only (Howard Hinnant's days_from_civil), so no time zone can shift it;
 * Kotlin's LocalDate.toEpochDay() gives the same number.
 */
export function epochDayFromDateKey(dateKey: string): number | null {
  const match = DATE_KEY.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Today's outfit: a 12-day cycle, so two days in a row never repeat. Invalid keys get the first. */
export function outfitForDate(dateKey: string): CompanionOutfit {
  const epochDay = epochDayFromDateKey(dateKey);
  if (epochDay === null) return COMPANION_OUTFITS[0];
  const size = COMPANION_OUTFITS.length;
  return COMPANION_OUTFITS[((epochDay % size) + size) % size] ?? COMPANION_OUTFITS[0];
}

export function isCompanionOutfit(value: unknown): value is CompanionOutfit {
  return typeof value === 'string' && (COMPANION_OUTFITS as readonly string[]).includes(value);
}

export function isStaticOnlyPose(pose: CompanionPose): boolean {
  return (COMPANION_STATIC_ONLY_POSES as readonly string[]).includes(pose);
}

/** The animated file asks for `.anim`; a still pose always resolves to its static twin. */
export function companionArtPath(
  outfit: CompanionOutfit,
  pose: CompanionPose,
  variant: CompanionArtVariant,
): CompanionArtPath {
  const motion = variant === 'animated' && !isStaticOnlyPose(pose) ? '.anim' : '';
  return `assets/companion/chibi/${outfit}/${pose}${motion}.svg`;
}

export function companionIconPath(
  outfit: CompanionOutfit,
  kind: CompanionIconKind,
): CompanionIconPath {
  return `assets/companion/chibi/${outfit}/icon-${kind}-128.png`;
}

/** Every file of the private build, relative to `assets/companion/chibi/`, sorted. */
export function companionAssetNames(): string[] {
  const names: string[] = [];
  for (const outfit of COMPANION_OUTFITS) {
    for (const pose of [...COMPANION_FIGURE_POSES, ...COMPANION_HEAD_POSES]) {
      names.push(`${outfit}/${pose}.svg`);
      if (!isStaticOnlyPose(pose)) names.push(`${outfit}/${pose}.anim.svg`);
    }
    for (const kind of COMPANION_ICON_KINDS) names.push(`${outfit}/icon-${kind}-128.png`);
  }
  return names.sort();
}

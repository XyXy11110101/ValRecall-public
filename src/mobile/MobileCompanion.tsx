import { useEffect, useState } from 'react';
import { phoneHeadPose, reactionPose } from '../companion/companion-scenes';
import {
  companionArtPath,
  outfitForDate,
  type CompanionOutfit,
  type CompanionPose,
} from '../companion/wardrobe';
import { localDateKey } from '../models/daily-task';
import { useReducedMotion } from '../ui/motion/useReducedMotion';

/**
 * The phone app's companion (private APK only): a small head on the 待办 header and a cheer
 * figure that pops up after a saved completion. Every caller sits behind
 * __VALRECALL_PRIVATE_COMPANION_ASSETS__, so the public phone build drops this module and
 * every art path in it. The art is decoration only; nothing here is announced or focusable.
 */

/** How long the cheer figure stays; the same hold as the floating completion line. */
export const MOBILE_COMPANION_REACTION_MS = 2400;

/** A completion saved on the phone. The ordinal is today's completed count before it. */
export interface MobileCompanionCompletion {
  ordinal: number;
  seq: number;
}

export interface MobileCompanionProps {
  /** The 待办 page is showing; elsewhere nothing renders, though a running hold keeps time. */
  active: boolean;
  /** The snapshot's today in its time zone, or null before the first sync. */
  today: string | null;
  now: Date;
  loadError: boolean;
  /** Open todos, or null while nothing is known (loading, unpaired, read error). */
  openTasks: number | null;
  completedToday: number;
  /** The latest saved completion; a new `seq` starts a new reaction. */
  completion: MobileCompanionCompletion | null;
}

/** The phone always rotates by date: the snapshot's day, else this device's local day. */
export function mobileCompanionOutfit(today: string | null, now: Date): CompanionOutfit {
  return outfitForDate(today ?? localDateKey(now));
}

export function MobileCompanion({
  active,
  today,
  now,
  loadError,
  openTasks,
  completedToday,
  completion,
}: MobileCompanionProps) {
  const reducedMotion = useReducedMotion();
  // The seq whose reaction is over (timed out, or the app left the screen).
  const [clearedSeq, setClearedSeq] = useState<number | null>(null);
  const reacting = completion !== null && completion.seq !== clearedSeq;

  const seq = completion?.seq ?? null;

  useEffect(() => {
    if (seq === null) return;
    const clear = () => setClearedSeq(seq);
    const visibility = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    visibility();
    const timer = window.setTimeout(clear, MOBILE_COMPANION_REACTION_MS);
    window.addEventListener('valrecall-app-background', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('valrecall-app-background', clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [seq]);

  if (!active) return null;
  const outfit = mobileCompanionOutfit(today, now);
  const headPose = phoneHeadPose({ loadError, reacting, openTasks, completedToday });
  // While hidden the figure keeps its last pose (or the next one) as a still, so the pop-up
  // fades in an image that is already decoded and nothing animates off screen.
  const cheerPose = reactionPose(completion ? completion.ordinal : completedToday);
  return (
    <>
      <CompanionArt
        className="mobile-companion-head"
        outfit={outfit}
        pose={headPose}
        animated={!reducedMotion}
      />
      <span
        className={'mobile-companion-cheer' + (reacting ? ' is-visible' : '')}
        aria-hidden="true"
        data-companion-visible={reacting ? 'true' : 'false'}
      >
        <CompanionArt
          className="mobile-companion-cheer-art"
          outfit={outfit}
          pose={cheerPose}
          animated={reacting && !reducedMotion}
        />
      </span>
    </>
  );
}

function CompanionArt({
  className,
  outfit,
  pose,
  animated,
}: {
  className: string;
  outfit: CompanionOutfit;
  pose: CompanionPose;
  animated: boolean;
}) {
  const src = companionArtPath(outfit, pose, animated ? 'animated' : 'static');
  return (
    <CompanionImage
      key={src}
      className={className}
      src={src}
      outfit={outfit}
      pose={pose}
      motion={src.endsWith('.anim.svg') ? 'animated' : 'static'}
    />
  );
}

/** Keyed by its source, so a new pose never shows the previous frame or a stale error. */
function CompanionImage({
  className,
  src,
  outfit,
  pose,
  motion,
}: {
  className: string;
  src: string;
  outfit: CompanionOutfit;
  pose: CompanionPose;
  motion: 'animated' | 'static';
}) {
  const [failed, setFailed] = useState(false);
  return (
    <img
      className={className}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      hidden={failed}
      data-companion-outfit={outfit}
      data-companion-pose={pose}
      data-companion-motion={motion}
      onError={() => setFailed(true)}
    />
  );
}

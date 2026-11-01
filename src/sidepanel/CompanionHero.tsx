import { useCallback, useEffect, useState } from 'react';

import { useCompanionWardrobe } from '../companion/CompanionWardrobe';
import { headPoseForMood } from '../companion/companion-scenes';
import {
  companionArtPath,
  type CompanionArtPath,
  type CompanionOutfit,
  type CompanionPose,
} from '../companion/wardrobe';
import { localDateKey } from '../models/daily-task';
import { useReducedMotion } from '../ui/motion/useReducedMotion';

export type CompanionHeroState = 'idle' | 'due' | 'reviewing' | 'success';

export interface CompanionHeroSignals {
  processing?: boolean;
  reviewing?: boolean;
  temporarySuccess?: boolean;
  dueCount?: number;
}

export function resolveCompanionHeroState({
  processing = false,
  reviewing = false,
  temporarySuccess = false,
  dueCount = 0,
}: CompanionHeroSignals): CompanionHeroState {
  if (processing || reviewing) return 'reviewing';
  if (temporarySuccess) return 'success';
  if (Number.isFinite(dueCount) && dueCount > 0) return 'due';
  return 'idle';
}

export function useTemporaryCompanionSuccess(durationMs = 2400) {
  const [successSequence, setSuccessSequence] = useState(0);
  const triggerTemporarySuccess = useCallback(() => {
    setSuccessSequence((sequence) => sequence + 1);
  }, []);

  useEffect(() => {
    if (successSequence === 0) return;
    const timeout = window.setTimeout(() => setSuccessSequence(0), Math.max(0, durationMs));
    return () => window.clearTimeout(timeout);
  }, [durationMs, successSequence]);

  return [successSequence > 0, triggerTemporarySuccess] as const;
}

export function CompanionHero({
  state,
  status,
  detail = null,
  working = false,
}: {
  state: CompanionHeroState;
  status: string;
  detail?: string | null;
  working?: boolean;
}) {
  return (
    <section
      className={`companion-hero companion-hero-${state} motion-enter`}
      data-companion-hero-state={state}
      aria-labelledby="companion-hero-status"
      aria-live="polite"
    >
      <div className="companion-hero-copy">
        <h2 id="companion-hero-status">{status}</h2>
        {detail && <p>{detail}</p>}
        {working && (
          <div className="companion-hero-meta">
            <span className="motion-loading-indicator" aria-hidden="true" />
            <span className="sr-only">处理中</span>
          </div>
        )}
      </div>
      {__VALRECALL_PRIVATE_COMPANION_ASSETS__ ? (
        <PrivateCompanionFigure state={state} />
      ) : (
        <span className="companion-hero-abstract companion-hero-no-art" aria-hidden="true" />
      )}
    </section>
  );
}

/**
 * The narrow side panel shows the companion's head in today's (or the pinned) outfit; the
 * state picks the expression. It waits for the wardrobe, so a pin never flashes the rotation.
 */
function PrivateCompanionFigure({ state }: { state: CompanionHeroState }) {
  const wardrobe = useCompanionWardrobe();
  const reducedMotion = useReducedMotion();
  const dateKey = useVisibleDateKey();
  if (!wardrobe.ready) return <span className="companion-hero-abstract" aria-hidden="true" />;
  const outfit = wardrobe.outfitFor(dateKey);
  const pose = headPoseForMood(state);
  const path = companionArtPath(outfit, pose, reducedMotion ? 'static' : 'animated');
  return <CompanionHeroImage key={path} path={path} outfit={outfit} pose={pose} />;
}

function CompanionHeroImage({
  path,
  outfit,
  pose,
}: {
  path: CompanionArtPath;
  outfit: CompanionOutfit;
  pose: CompanionPose;
}) {
  const [assetStatus, setAssetStatus] = useState<'loading' | 'ready' | 'missing'>('loading');

  if (assetStatus === 'missing') {
    return <span className="companion-hero-abstract" aria-hidden="true" />;
  }

  return (
    <div className="companion-hero-figure" aria-hidden="true">
      <img
        className="companion-hero-image"
        src={path}
        alt=""
        aria-hidden="true"
        data-asset-status={assetStatus}
        data-companion-outfit={outfit}
        data-companion-pose={pose}
        data-companion-motion={path.endsWith('.anim.svg') ? 'animated' : 'static'}
        draggable={false}
        onLoad={() => setAssetStatus('ready')}
        onError={() => setAssetStatus('missing')}
      />
    </div>
  );
}

/**
 * The side panel has no clock: the date is read when it opens and again whenever it becomes
 * visible, so a panel left open overnight changes outfit the next time it is looked at.
 */
function useVisibleDateKey(): string {
  const [dateKey, setDateKey] = useState(() => localDateKey(new Date()));
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      setDateKey(localDateKey(new Date()));
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);
  return dateKey;
}

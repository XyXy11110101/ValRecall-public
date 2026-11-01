import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useCompanionWardrobe } from '../companion/CompanionWardrobe';
import {
  headPoseForMood,
  homePose,
  REVIEW_ART_SLOTS,
  reviewSlotIsStill,
  reviewSlotPose,
  type CompanionMood,
  type ReviewArtSlot,
  type ReviewSlotPoseInput,
} from '../companion/companion-scenes';
import {
  companionArtPath,
  isStaticOnlyPose,
  type CompanionArtPath,
  type CompanionArtVariant,
  type CompanionOutfit,
  type CompanionPose,
} from '../companion/wardrobe';
import { localDateKey } from '../models/daily-task';
import { MOTION_DURATION_MS } from '../ui/motion/contracts';
import { useReducedMotion } from '../ui/motion/useReducedMotion';

export const COMPANION_ASSETS_ENABLED = __VALRECALL_PRIVATE_COMPANION_ASSETS__;

export type CompanionState = CompanionMood;
export type CompanionPlacement = 'empty' | 'home' | 'review' | 'tasks' | 'reaction';
export type { CompanionArtPath };

const COMPANION_MESSAGE_BY_STATE: Readonly<
  Record<CompanionState, (reviewCount: number, taskCount: number) => string>
> = {
  idle: (reviewCount, taskCount) => buildCompanionHomeMessage(reviewCount, taskCount),
  due: (reviewCount, taskCount) => buildCompanionHomeMessage(reviewCount, taskCount),
  reviewing: () => '先试着回忆，再揭晓答案。',
  success: () => '已保存，到时间再见。',
};

export function companionMessage(
  state: CompanionState,
  reviewCount: number,
  taskCount: number,
): string {
  return COMPANION_MESSAGE_BY_STATE[state](reviewCount, taskCount);
}

/**
 * Reduced motion, a still moment (the Review question) and the worried face use the static
 * twin; everything else may move. The outfit comes from the date or the pin, never the state.
 */
export function companionArtVariant(
  pose: CompanionPose,
  options: { reducedMotion: boolean; still?: boolean },
): CompanionArtVariant {
  return options.reducedMotion || options.still === true || isStaticOnlyPose(pose)
    ? 'static'
    : 'animated';
}

/**
 * Both twins of each pose, so a switch to any of them never waits on the network. Under
 * reduced motion only the static twins are ever shown, so only they are fetched.
 */
export function companionArtVariants(
  outfit: CompanionOutfit,
  poses: readonly CompanionPose[],
  options: { reducedMotion?: boolean } = {},
): CompanionArtPath[] {
  const paths = poses.flatMap((pose) =>
    options.reducedMotion === true
      ? [companionArtPath(outfit, pose, 'static')]
      : [companionArtPath(outfit, pose, 'animated'), companionArtPath(outfit, pose, 'static')],
  );
  return [...new Set(paths)];
}

/** The pose a placement takes when the caller does not choose one. */
export function defaultCompanionPose(
  state: CompanionState,
  placement: CompanionPlacement,
  context: { dateKey: string; hour: number; reviewsDue: boolean; allDone: boolean },
): CompanionPose {
  switch (placement) {
    case 'empty':
      return 'sleepy';
    case 'tasks':
      return headPoseForMood(state);
    case 'review':
    case 'reaction':
      return reviewSlotPose(reviewSlotForState(state), { ...context, cardIndex: 0 });
    case 'home':
      return homePose({
        mood: state,
        hour: context.hour,
        dateKey: context.dateKey,
        reviewsDue: context.reviewsDue,
        allDone: context.allDone,
        reactionOrdinal: null,
      });
  }
}

/** One keyed layer of the Review stack. `still` keeps the layer on its static twin. */
export interface CompanionStackLayer {
  key: string;
  pose: CompanionPose;
  still?: boolean;
}

/** The five Review slots for one card, in the order the stack renders them. */
export function reviewCompanionLayers(input: ReviewSlotPoseInput): CompanionStackLayer[] {
  return REVIEW_ART_SLOTS.map((slot) => ({
    key: slot,
    pose: reviewSlotPose(slot, input),
    still: reviewSlotIsStill(slot),
  }));
}

/** Used only when a caller passes no slot: the macro state's nearest Review slot. */
function reviewSlotForState(state: CompanionState): ReviewArtSlot {
  switch (state) {
    case 'idle':
      return 'rest';
    case 'due':
      return 'invite';
    case 'reviewing':
      return 'reveal';
    case 'success':
      return 'complete';
  }
}

const decodedCompanionPaths = new Set<string>();

function decodeCompanionPath(path: CompanionArtPath): Promise<boolean> {
  if (decodedCompanionPaths.has(path)) return Promise.resolve(true);
  const image = new Image();
  if (typeof image.decode !== 'function') return Promise.resolve(false);
  image.src = path;
  return image.decode().then(
    () => {
      decodedCompanionPaths.add(path);
      return true;
    },
    () => false,
  );
}

/** Decodes the exact files ahead of a switch; true once every one of them is decoded. */
export function preloadCompanionArt(paths: readonly CompanionArtPath[]): Promise<boolean> {
  if (!COMPANION_ASSETS_ENABLED || typeof Image === 'undefined' || paths.length === 0) {
    return Promise.resolve(false);
  }
  return Promise.all(paths.map(decodeCompanionPath)).then((results) => results.every(Boolean));
}

export function isCompanionArtDecoded(paths: readonly CompanionArtPath[]): boolean {
  // Checked first so ordinary builds compile every private art path away.
  if (!COMPANION_ASSETS_ENABLED) return false;
  return paths.length > 0 && paths.every((path) => decodedCompanionPaths.has(path));
}

/**
 * Decodes both twins of the poses a view may switch to, in the outfit for `dateKey`. True
 * once they are all decoded; always false in ordinary builds and before the wardrobe is read.
 */
export function useCompanionArtPreload(poses: readonly CompanionPose[], dateKey: string): boolean {
  const wardrobe = useCompanionWardrobe();
  const reducedMotion = useReducedMotion();
  const outfit = wardrobe.ready ? wardrobe.outfitFor(dateKey) : null;
  const key =
    COMPANION_ASSETS_ENABLED && outfit !== null
      ? companionArtVariants(outfit, poses, { reducedMotion }).join('\n')
      : '';
  const [decodedKey, setDecodedKey] = useState<string | null>(() =>
    key !== '' && isCompanionArtDecoded(key.split('\n') as CompanionArtPath[]) ? key : null,
  );

  useEffect(() => {
    if (key === '') return;
    let active = true;
    void preloadCompanionArt(key.split('\n') as CompanionArtPath[]).then((ready) => {
      if (active && ready) setDecodedKey(key);
    });
    return () => {
      active = false;
    };
  }, [key]);

  return key !== '' && decodedKey === key;
}

/**
 * The worried face for save and sync failures: today's outfit (or the pinned one), always
 * still. It is decorative; ordinary builds get nothing, so the notice stays text-only.
 */
export function worriedCompanionLeading(dateKey?: string) {
  if (!COMPANION_ASSETS_ENABLED) return undefined;
  return <WorriedCompanionFace dateKey={dateKey} />;
}

function WorriedCompanionFace({ dateKey }: { dateKey?: string | undefined }) {
  const wardrobe = useCompanionWardrobe();
  const [missingPath, setMissingPath] = useState<string | null>(null);
  if (!wardrobe.ready) return null;
  const outfit = wardrobe.outfitFor(dateKey ?? localDateKey(new Date()));
  const path = companionArtPath(outfit, 'head-worried', 'static');
  if (missingPath === path) return null;
  return (
    <img
      className="companion-worried-face"
      src={path}
      alt=""
      aria-hidden="true"
      width={48}
      height={48}
      draggable={false}
      data-companion-outfit={outfit}
      data-companion-pose="head-worried"
      data-companion-motion="static"
      onError={() => setMissingPath(path)}
    />
  );
}

export interface CompanionProps {
  state: CompanionState;
  count?: number;
  taskCount?: number;
  compact?: boolean;
  placement?: CompanionPlacement;
  message?: string | null;
  /** Everything for today is finished: a resting success shows the all-done pose. */
  allDone?: boolean;
  /** The pose for Home, Tasks and the empty state; derived from the state when absent. */
  pose?: CompanionPose | undefined;
  /** The local date that picks today's outfit; today when absent. */
  dateKey?: string | undefined;
  /** A fixed outfit (a Review session keeps the one it started with). */
  outfit?: CompanionOutfit | undefined;
  /** Keep the static twin even when motion is allowed. */
  still?: boolean;
  /** Review and reaction placements: the keyed layers of the crossfade stack. */
  layers?: readonly CompanionStackLayer[] | undefined;
  /** The layer to show; it becomes visible once its file has loaded. */
  activeLayer?: string | undefined;
}

export function Companion({
  state,
  count = 0,
  taskCount = 0,
  compact = false,
  placement = compact ? 'review' : 'home',
  message,
  allDone = false,
  pose,
  dateKey,
  outfit,
  still = false,
  layers,
  activeLayer,
}: CompanionProps) {
  const visibleMessage =
    message === undefined ? companionMessage(state, count, taskCount) : message;
  if (!COMPANION_ASSETS_ENABLED) {
    const Shell = placement === 'empty' ? 'div' : 'aside';
    return (
      <Shell
        className={`companion companion-${state} companion-${placement} companion-public-fallback${
          compact ? ' companion-compact' : ''
        } motion-state-change`}
        data-companion-state={state}
        data-companion-placement={placement}
        role={placement === 'empty' ? 'presentation' : undefined}
        aria-hidden="true"
      >
        {visibleMessage && (
          <div className="companion-copy">
            {__VALRECALL_PUBLIC_RELEASE__ ? null : <p className="eyebrow">复习伙伴</p>}
            <p>{visibleMessage}</p>
          </div>
        )}
        <div className="companion-figure">
          <div className="companion-abstract" aria-hidden="true" />
        </div>
      </Shell>
    );
  }
  if (placement === 'review' || placement === 'reaction') {
    return (
      <ReviewCompanionAssetStack
        state={state}
        message={visibleMessage}
        compact={compact}
        placement={placement}
        layers={layers}
        activeLayer={activeLayer}
        dateKey={dateKey}
        outfit={outfit}
      />
    );
  }
  return (
    <CompanionFigure
      state={state}
      message={visibleMessage}
      compact={compact}
      placement={placement}
      pose={pose}
      dateKey={dateKey}
      outfit={outfit}
      still={still}
      reviewsDue={count > 0}
      allDone={allDone}
    />
  );
}

function CompanionFigure({
  state,
  message,
  compact,
  placement,
  pose,
  dateKey,
  outfit,
  still,
  reviewsDue,
  allDone,
}: {
  state: CompanionState;
  message: string | null;
  compact: boolean;
  placement: CompanionPlacement;
  pose: CompanionPose | undefined;
  dateKey: string | undefined;
  outfit: CompanionOutfit | undefined;
  still: boolean;
  reviewsDue: boolean;
  allDone: boolean;
}) {
  const wardrobe = useCompanionWardrobe();
  const reducedMotion = useReducedMotion();
  const now = new Date();
  const date = dateKey ?? localDateKey(now);
  const resolvedOutfit = outfit ?? (wardrobe.ready ? wardrobe.outfitFor(date) : null);
  const resolvedPose =
    pose ??
    defaultCompanionPose(state, placement, {
      dateKey: date,
      hour: now.getHours(),
      reviewsDue,
      allDone,
    });
  const variant = companionArtVariant(resolvedPose, { reducedMotion, still });
  const path = resolvedOutfit ? companionArtPath(resolvedOutfit, resolvedPose, variant) : null;
  return (
    <CompanionAsset
      key={path ?? 'pending'}
      state={state}
      path={path}
      outfit={resolvedOutfit}
      pose={resolvedPose}
      variant={variant}
      compact={compact}
      placement={placement}
      message={message}
    />
  );
}

type CompanionAssetStatus = 'loading' | 'ready' | 'missing';

function CompanionAsset({
  state,
  path,
  outfit,
  pose,
  variant,
  compact,
  placement,
  message,
}: {
  state: CompanionState;
  /** Null until the wardrobe is read: the placeholder holds the slot. */
  path: CompanionArtPath | null;
  outfit: CompanionOutfit | null;
  pose: CompanionPose;
  variant: CompanionArtVariant;
  compact: boolean;
  placement: CompanionPlacement;
  message: string | null;
}) {
  const [assetStatus, setAssetStatus] = useState<CompanionAssetStatus>(() =>
    path !== null && decodedCompanionPaths.has(path) ? 'ready' : 'loading',
  );
  const Shell = placement === 'empty' ? 'div' : 'aside';

  return (
    <Shell
      className={`companion companion-${state} companion-${placement}${
        compact ? ' companion-compact' : ''
      } motion-state-change`}
      data-companion-state={state}
      data-companion-placement={placement}
      data-companion-asset-status={assetStatus}
      data-companion-outfit={outfit ?? undefined}
      data-companion-pose={pose}
      data-companion-motion={variant}
      role={placement === 'empty' ? 'presentation' : undefined}
      aria-hidden="true"
    >
      {message && (
        <div className="companion-copy">
          <p className="eyebrow">复习伙伴</p>
          <p>{message}</p>
        </div>
      )}
      <div className="companion-figure">
        {assetStatus !== 'ready' && <div className="companion-abstract" aria-hidden="true" />}
        {path !== null && assetStatus !== 'missing' && (
          <img
            className="companion-image"
            src={path}
            alt=""
            hidden={assetStatus !== 'ready'}
            aria-hidden="true"
            draggable={false}
            onLoad={() => setAssetStatus('ready')}
            onError={() => setAssetStatus('missing')}
          />
        )}
      </div>
    </Shell>
  );
}

interface ShownLayer {
  key: string;
  path: CompanionArtPath;
}

/**
 * The Review crossfade: one layer per slot. Only the shown layer (and the outgoing one for
 * the 220 ms crossfade) may load an animated file; every other layer holds its static twin.
 * A new slot becomes visible once its own file has loaded, so nothing flashes.
 */
function ReviewCompanionAssetStack({
  state,
  message,
  compact,
  placement,
  layers,
  activeLayer,
  dateKey,
  outfit,
}: {
  state: CompanionState;
  message: string | null;
  compact: boolean;
  placement: 'review' | 'reaction';
  layers: readonly CompanionStackLayer[] | undefined;
  activeLayer: string | undefined;
  dateKey: string | undefined;
  outfit: CompanionOutfit | undefined;
}) {
  const wardrobe = useCompanionWardrobe();
  const reducedMotion = useReducedMotion();
  const now = new Date();
  const date = dateKey ?? localDateKey(now);
  const resolvedOutfit = outfit ?? (wardrobe.ready ? wardrobe.outfitFor(date) : null);
  const stackLayers =
    layers ?? reviewCompanionLayers({ hour: now.getHours(), dateKey: date, cardIndex: 0 });
  const targetKey = activeLayer ?? reviewSlotForState(state);
  const target = stackLayers.find((layer) => layer.key === targetKey) ?? stackLayers[0];
  const targetVariant = target
    ? companionArtVariant(target.pose, { reducedMotion, still: target.still === true })
    : 'static';
  const targetPath =
    resolvedOutfit && target ? companionArtPath(resolvedOutfit, target.pose, targetVariant) : null;

  const [assetStatus, setAssetStatus] = useState<Record<string, CompanionAssetStatus>>({});
  const [visible, setVisible] = useState<ShownLayer | null>(null);
  const [outgoing, setOutgoing] = useState<ShownLayer | null>(null);
  const transitionSequenceRef = useRef(0);
  const transitionTimerRef = useRef<number | null>(null);
  const statusOf = (path: CompanionArtPath | null): CompanionAssetStatus =>
    path === null
      ? 'loading'
      : (assetStatus[path] ?? (decodedCompanionPaths.has(path) ? 'ready' : 'loading'));
  const targetStatus = statusOf(targetPath);
  const visibleStatus = statusOf(visible?.path ?? null);

  useLayoutEffect(() => {
    if (targetStatus !== 'ready' || targetPath === null || !target) return;
    if (visible?.key === target.key && visible.path === targetPath) return;
    const transitionSequence = transitionSequenceRef.current + 1;
    transitionSequenceRef.current = transitionSequence;
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
    setOutgoing(!reducedMotion && visible && visibleStatus === 'ready' ? visible : null);
    setVisible({ key: target.key, path: targetPath });
    transitionTimerRef.current = window.setTimeout(
      () => {
        if (transitionSequence !== transitionSequenceRef.current) return;
        transitionTimerRef.current = null;
        setOutgoing(null);
      },
      reducedMotion ? 0 : MOTION_DURATION_MS.standard,
    );
  }, [reducedMotion, target, targetPath, targetStatus, visible, visibleStatus]);

  useEffect(
    () => () => {
      transitionSequenceRef.current += 1;
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
    },
    [],
  );

  // Decodes both twins of every slot, so the next slot is ready when the scene moves on.
  const preloadKey = resolvedOutfit
    ? companionArtVariants(
        resolvedOutfit,
        stackLayers.map((layer) => layer.pose),
        { reducedMotion },
      ).join('\n')
    : '';
  useEffect(() => {
    if (preloadKey !== '') void preloadCompanionArt(preloadKey.split('\n') as CompanionArtPath[]);
  }, [preloadKey]);

  function recordAssetStatus(path: CompanionArtPath, status: CompanionAssetStatus) {
    setAssetStatus((current) =>
      current[path] === status ? current : { ...current, [path]: status },
    );
  }

  const rendered: Array<{ layer: CompanionStackLayer; path: CompanionArtPath }> = [];
  if (resolvedOutfit) {
    for (const layer of stackLayers) {
      const paths = new Set<CompanionArtPath>();
      if (visible?.key === layer.key) paths.add(visible.path);
      if (outgoing?.key === layer.key) paths.add(outgoing.path);
      if (target?.key === layer.key && targetPath !== null) paths.add(targetPath);
      if (paths.size === 0) paths.add(companionArtPath(resolvedOutfit, layer.pose, 'static'));
      for (const path of paths) rendered.push({ layer, path });
    }
  }

  return (
    <aside
      className={`companion companion-${state} companion-${placement}${
        compact ? ' companion-compact' : ''
      }${placement === 'reaction' ? ' companion-reaction' : ''}`}
      data-companion-state={state}
      data-companion-placement={placement}
      data-companion-outfit={resolvedOutfit ?? undefined}
      data-companion-slot={target?.key}
      data-companion-pose={target?.pose}
      data-companion-motion={targetVariant}
      data-companion-transition-from={outgoing?.key ?? undefined}
      hidden={targetPath === null || (targetStatus === 'loading' && visibleStatus !== 'ready')}
      aria-hidden="true"
    >
      {message && (
        <div className="companion-copy">
          <p className="eyebrow">复习伙伴</p>
          <p>{message}</p>
        </div>
      )}
      <div className="companion-figure companion-asset-stack">
        {rendered.map(({ layer, path }) => {
          const isActive =
            targetStatus !== 'missing' && visible?.key === layer.key && visible.path === path;
          const isOutgoing = !isActive && outgoing?.key === layer.key && outgoing.path === path;
          const presentationClass = `${isActive ? ' is-active' : ''}${
            isOutgoing ? ' is-transition-out' : ''
          }`;
          return (
            <span
              className={`companion-stack-layer${presentationClass}`}
              key={`${layer.key}\n${path}`}
              data-companion-layer={layer.key}
              aria-hidden="true"
            >
              <img
                className={`companion-image companion-stack-image${presentationClass}`}
                src={path}
                alt=""
                aria-hidden="true"
                draggable={false}
                data-companion-layer={layer.key}
                data-companion-pose={layer.pose}
                data-companion-motion={path.endsWith('.anim.svg') ? 'animated' : 'static'}
                data-asset-status={statusOf(path)}
                onLoad={() => recordAssetStatus(path, 'ready')}
                onError={() => recordAssetStatus(path, 'missing')}
              />
            </span>
          );
        })}
        {targetStatus === 'missing' && <div className="companion-abstract" aria-hidden="true" />}
      </div>
    </aside>
  );
}

export function buildCompanionHomeMessage(reviewCount: number, taskCount: number): string {
  const reviews = normalizeCount(reviewCount);
  const tasks = normalizeCount(taskCount);
  if (reviews > 0 && tasks > 0) {
    return `今天有 ${reviews} 条复习和 ${tasks} 项任务等你。`;
  }
  if (reviews > 0) {
    return `今天有 ${reviews} 条复习等你。`;
  }
  if (tasks > 0) {
    return `复习已经完成。还剩 ${tasks} 项任务。`;
  }
  return '今天都跟上进度了。';
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

import { useEffect, useRef, useState } from 'react';

import { useCompanionWardrobe } from '../companion/CompanionWardrobe';
import {
  COMPANION_FIGURE_POSES,
  COMPANION_HEAD_POSES,
  COMPANION_OUTFIT_LABELS,
  COMPANION_OUTFITS,
  companionArtPath,
  outfitForDate,
  type CompanionOutfit,
  type CompanionPose,
} from '../companion/wardrobe';
import type { CompanionWardrobePreference } from '../companion/wardrobe-preference';
import { localDateKey } from '../models/daily-task';
import { LiveStatus, Notice } from '../shared/components';
import { useReducedMotion } from '../ui/motion/useReducedMotion';
import { companionArtVariant, worriedCompanionLeading } from './Companion';
import { useMinuteClock, type MinuteClockSource } from './useMinuteClock';
import './wardrobe.css';

const POSE_LABELS: Readonly<Record<CompanionPose, string>> = {
  calm: '站着',
  wave: '挥手',
  read: '看书',
  tea: '喝茶',
  point: '指一指',
  card: '举卡片',
  fist: '加油',
  think: '想一想',
  aha: '想到了',
  note: '记笔记',
  cheer: '欢呼',
  clap: '鼓掌',
  thumbs: '点赞',
  peace: '比耶',
  jump: '跳起来',
  sleepy: '犯困',
  worried: '担心',
  'head-smile': '微笑',
  'head-talk': '说话',
  'head-joy': '开心',
  'head-sleepy': '困了',
  'head-worried': '担心',
};

/** Pose images in the first rows load at once; the rest wait until they are scrolled near. */
const EAGER_POSE_COUNT = 6;

export interface WardrobeViewProps {
  onBackToSettings: () => void;
  /** Called once the page has mounted, so the dashboard can move focus to its heading. */
  onMounted?: (() => void) | undefined;
  clock?: MinuteClockSource | undefined;
}

/** The companion wardrobe: wear today's outfit or pin one. Private build only. */
export function WardrobeView(props: WardrobeViewProps) {
  if (!__VALRECALL_PRIVATE_COMPANION_ASSETS__) return null;
  return <WardrobeContent {...props} />;
}

function WardrobeContent({ onBackToSettings, onMounted, clock }: WardrobeViewProps) {
  const wardrobe = useCompanionWardrobe();
  const reducedMotion = useReducedMotion();
  const now = useMinuteClock(clock);
  const today = localDateKey(now);
  const todayOutfit = outfitForDate(today);
  const { preference, ready } = wardrobe;
  const pinned = preference.mode === 'pinned' ? preference.outfit : null;
  const [selected, setSelected] = useState<CompanionOutfit | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<{ text: string; seq: number } | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(onMounted);

  useEffect(() => {
    mountedRef.current?.();
  }, []);

  const shown = selected ?? (ready ? wardrobe.outfitFor(today) : null);

  async function save(next: CompanionWardrobePreference) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await wardrobe.save(next);
      setStatus((current) => ({
        text:
          next.mode === 'pinned'
            ? `已固定：${COMPANION_OUTFIT_LABELS[next.outfit]}。`
            : '已改回每天换一套。',
        seq: (current?.seq ?? 0) + 1,
      }));
    } catch {
      setFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const pin = (outfit: CompanionOutfit) => void save({ version: 1, mode: 'pinned', outfit });
  const rotate = () => void save({ version: 1, mode: 'daily' });

  return (
    <section className="stack wardrobe-view" aria-busy={saving || !ready}>
      <div className="split wardrobe-view-header">
        <div>
          <p className="eyebrow">设置</p>
          <h2 className="dashboard-page-heading" tabIndex={-1}>
            衣橱
          </h2>
          <p className="muted">手机和小组件仍每天换一套。</p>
        </div>
        <button className="button secondary small-button motion-press" onClick={onBackToSettings}>
          返回设置
        </button>
      </div>
      {failed && (
        <div className="motion-state-change">
          <Notice tone="error" leading={worriedCompanionLeading(today)}>
            保存失败，请重试。
          </Notice>
        </div>
      )}
      <LiveStatus text={status?.text ?? null} seq={status?.seq ?? 0} />
      {!ready || shown === null ? (
        <p className="muted" role="status">
          正在加载衣橱…
        </p>
      ) : (
        <>
          <fieldset className="wardrobe-mode" disabled={saving}>
            <legend>穿搭</legend>
            <div className="cluster">
              <label className="wardrobe-mode-option">
                <input
                  type="radio"
                  name="wardrobe-mode"
                  value="daily"
                  checked={pinned === null}
                  onChange={rotate}
                />
                <span>每天换一套</span>
              </label>
              <label className="wardrobe-mode-option">
                <input
                  type="radio"
                  name="wardrobe-mode"
                  value="pinned"
                  checked={pinned !== null}
                  onChange={() => pin(shown)}
                />
                <span>固定一套</span>
              </label>
            </div>
          </fieldset>
          <div className="wardrobe-layout">
            <fieldset className="wardrobe-outfits">
              <legend>全部穿搭</legend>
              <ul className="wardrobe-card-grid">
                {COMPANION_OUTFITS.map((outfit) => (
                  <li key={outfit}>
                    <OutfitCard
                      outfit={outfit}
                      selected={outfit === shown}
                      today={outfit === todayOutfit}
                      pinned={outfit === pinned}
                      onSelect={() => setSelected(outfit)}
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
            <OutfitDetail
              outfit={shown}
              today={shown === todayOutfit}
              pinned={pinned}
              saving={saving}
              reducedMotion={reducedMotion}
              onPin={() => pin(shown)}
              onRotate={rotate}
            />
          </div>
        </>
      )}
    </section>
  );
}

function OutfitCard({
  outfit,
  selected,
  today,
  pinned,
  onSelect,
}: {
  outfit: CompanionOutfit;
  selected: boolean;
  today: boolean;
  pinned: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`wardrobe-card${selected ? ' is-selected' : ''}`}
      data-wardrobe-outfit={outfit}
    >
      <input
        className="wardrobe-card-input"
        type="radio"
        name="wardrobe-outfit"
        value={outfit}
        checked={selected}
        onChange={onSelect}
      />
      <span className="wardrobe-card-art">
        <WardrobeArt path={companionArtPath(outfit, 'calm', 'static')} pose="calm" eager />
      </span>
      <span className="wardrobe-card-label">{COMPANION_OUTFIT_LABELS[outfit]}</span>
      {(today || pinned) && (
        <span className="wardrobe-badges">
          {today && <span className="wardrobe-badge">今天</span>}
          {pinned && <span className="wardrobe-badge is-pinned">已固定</span>}
        </span>
      )}
    </label>
  );
}

function OutfitDetail({
  outfit,
  today,
  pinned,
  saving,
  reducedMotion,
  onPin,
  onRotate,
}: {
  outfit: CompanionOutfit;
  today: boolean;
  pinned: CompanionOutfit | null;
  saving: boolean;
  reducedMotion: boolean;
  onPin: () => void;
  onRotate: () => void;
}) {
  const poseGroups: ReadonlyArray<{ label: string; poses: readonly CompanionPose[] }> = [
    { label: '全身', poses: COMPANION_FIGURE_POSES },
    { label: '头像', poses: COMPANION_HEAD_POSES },
  ];
  let index = 0;
  return (
    <section
      className="wardrobe-detail"
      aria-labelledby="wardrobe-detail-heading"
      data-wardrobe-detail={outfit}
    >
      <div className="split wardrobe-detail-header">
        <div className="cluster">
          <h3 id="wardrobe-detail-heading">{COMPANION_OUTFIT_LABELS[outfit]}</h3>
          {today && <span className="wardrobe-badge">今天</span>}
          {pinned === outfit && <span className="wardrobe-badge is-pinned">已固定</span>}
        </div>
        <div className="cluster">
          {pinned !== outfit && (
            <button className="button motion-press" disabled={saving} onClick={onPin}>
              固定这套
            </button>
          )}
          {pinned !== null && (
            <button className="button secondary motion-press" disabled={saving} onClick={onRotate}>
              改回每天换
            </button>
          )}
        </div>
      </div>
      {poseGroups.map((group) => (
        <div className="wardrobe-pose-group" key={group.label}>
          <h4>{group.label}</h4>
          <ul className={`wardrobe-pose-grid${group.label === '头像' ? ' is-heads' : ''}`}>
            {group.poses.map((pose) => {
              const eager = index++ < EAGER_POSE_COUNT;
              const variant = companionArtVariant(pose, { reducedMotion });
              return (
                <li key={pose} className="wardrobe-pose" data-wardrobe-pose={pose}>
                  <span className="wardrobe-pose-art">
                    <WardrobeArt
                      path={companionArtPath(outfit, pose, variant)}
                      pose={pose}
                      eager={eager}
                    />
                  </span>
                  <span className="wardrobe-pose-label">{POSE_LABELS[pose]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** One decorative picture; the visible label beside it names it. A missing file leaves a blank tile. */
function WardrobeArt({ path, pose, eager }: { path: string; pose: CompanionPose; eager: boolean }) {
  const [missingPath, setMissingPath] = useState<string | null>(null);
  if (missingPath === path) return <span className="wardrobe-art-missing" aria-hidden="true" />;
  const head = pose.startsWith('head-');
  return (
    <img
      key={path}
      className="wardrobe-art"
      src={path}
      alt=""
      width={head ? 160 : 240}
      height={head ? 160 : 330}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      data-companion-pose={pose}
      data-companion-motion={path.endsWith('.anim.svg') ? 'animated' : 'static'}
      onError={() => setMissingPath(path)}
    />
  );
}

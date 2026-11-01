import { useState } from 'react';

import { useCompanionWardrobe } from '../companion/CompanionWardrobe';
import { WORKING_HEAD_POSE } from '../companion/companion-scenes';
import { companionArtPath } from '../companion/wardrobe';
import { ActionIcon } from '../shared/ActionIcon';
import { MotionCount } from '../ui/motion';
import { COMPANION_ASSETS_ENABLED } from './Companion';

const ACTION_LABEL = {
  review: '开始复习',
  add: '添加回忆题',
  retry: '重试首页摘要',
} as const;

/**
 * Review, shrunk to one line while a 工作中 card takes the page. The numbers and the way in stay,
 * including the wallet a finished task's coin flies to.
 */
export function HomeReviewStrip({
  dueCount,
  available,
  action,
  showHead,
  dateKey,
  streak,
  balance,
  onStartReview,
  onAddQuestion,
  onRetry,
  onOpenAllowance,
}: {
  dueCount: number;
  /** False until a summary has loaded: the count would be a guess. */
  available: boolean;
  action: keyof typeof ACTION_LABEL;
  showHead: boolean;
  dateKey: string;
  streak: number;
  balance: number;
  onStartReview: () => void;
  onAddQuestion: () => void;
  onRetry: () => void;
  onOpenAllowance: () => void;
}) {
  return (
    <section className="home-review-strip" aria-label="今日摘要">
      {showHead && workingHead(dateKey)}
      <p className="home-review-strip-due">
        <span>今日复习</span>
        {available ? (
          <>
            <MotionCount value={dueCount} as="strong" />
            <span>条到期</span>
          </>
        ) : (
          <span>没加载出来</span>
        )}
      </p>
      <button
        className="button home-review-strip-action"
        onClick={action === 'review' ? onStartReview : action === 'add' ? onAddQuestion : onRetry}
      >
        <ActionIcon kind={action === 'review' ? 'play' : 'plus'} />
        {ACTION_LABEL[action]}
      </button>
      <div className="home-review-strip-stats">
        <p data-allowance-stat="streak">
          连续 <MotionCount value={streak} as="strong" /> 天
        </p>
        <button type="button" data-allowance-stat="balance" onClick={onOpenAllowance}>
          零花钱{' '}
          <span className="home-wallet-target" data-wallet-target="home">
            <MotionCount value={balance} as="strong" />
          </span>
        </button>
      </div>
    </section>
  );
}

/** Ordinary builds get nothing, so no art path reaches them and no placeholder holds a slot. */
function workingHead(dateKey: string) {
  if (!COMPANION_ASSETS_ENABLED) return null;
  return <WorkingHead dateKey={dateKey} />;
}

function WorkingHead({ dateKey }: { dateKey: string }) {
  const wardrobe = useCompanionWardrobe();
  const [missingPath, setMissingPath] = useState<string | null>(null);
  if (!wardrobe.ready) return null;
  const outfit = wardrobe.outfitFor(dateKey);
  const path = companionArtPath(outfit, WORKING_HEAD_POSE, 'static');
  if (missingPath === path) return null;
  return (
    <img
      className="home-review-strip-head"
      src={path}
      alt=""
      aria-hidden="true"
      width={44}
      height={44}
      draggable={false}
      data-companion-outfit={outfit}
      data-companion-pose={WORKING_HEAD_POSE}
      data-companion-motion="static"
      onError={() => setMissingPath(path)}
    />
  );
}

import { useEffect, useState, type CSSProperties } from 'react';

export interface ReviewStepReceipt {
  id: string;
  rewardAmount?: number;
}

const SPARK_COUNT = 8;

/** Presentation only: never gates the next question or changes a review receipt. */
export function ReviewStepFeedback({ receipt }: { receipt: ReviewStepReceipt | null }) {
  const [visibleId, setVisibleId] = useState<string | null>(null);
  useEffect(() => {
    if (!receipt || document.hidden) {
      setVisibleId(null);
      return;
    }
    setVisibleId(receipt.id);
    const timer = window.setTimeout(() => setVisibleId(null), 1400);
    const hide = () => {
      if (document.hidden) setVisibleId(null);
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [receipt]);

  const reward = receipt?.rewardAmount ?? 0;
  return (
    <div
      className="review-step-feedback-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {receipt && visibleId === receipt.id && (
        <div
          className="review-step-feedback"
          key={receipt.id}
          data-receipt-id={receipt.id}
          data-rewarded={reward > 0}
        >
          <span className="review-step-seal" aria-hidden="true">
            <span className="review-step-ring" />
            {Array.from({ length: SPARK_COUNT }, (_, index) => (
              <i
                className="review-step-spark"
                key={index}
                style={{ '--spark-angle': `${index * (360 / SPARK_COUNT)}deg` } as CSSProperties}
              />
            ))}
            <svg viewBox="0 0 32 32" fill="none">
              <path d="m8 16 5 5 11-11" />
            </svg>
          </span>
          {/* The check is decorative, so screen readers still hear that the rating saved. */}
          <span className="sr-only">已保存</span>
          {reward > 0 && (
            <span className="review-step-earned">
              <span className="review-step-earned-source">零花钱 </span>
              <strong className="review-step-amount">+{reward} 元</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

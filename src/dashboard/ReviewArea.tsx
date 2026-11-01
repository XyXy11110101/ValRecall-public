import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { requestEditorLeave, requestEditorLeaveAsync } from '../shared/edit-protection';

import type { LearningItem } from '../database';
import type { ValRecallPreferences } from '../shared/preferences';
import { safeViewTransition, useReducedMotion } from '../ui/motion';
import { TodayView, type ReviewStartRequest } from './TodayView';
import { UpcomingReviewsView } from './UpcomingReviewsView';

export type ReviewSection = 'due' | 'upcoming';

export function ReviewArea({
  section,
  onSectionChange,
  revision,
  preferences,
  preferredItemId,
  startRequest,
  onStartRequestConsumed,
  onChanged,
  onGoHome,
  onGoLibrary,
  onViewItem,
  onOpenReminderSettings,
}: {
  section: ReviewSection;
  onSectionChange: (section: ReviewSection) => void;
  revision: number;
  preferences: ValRecallPreferences;
  preferredItemId: string | null;
  startRequest?: ReviewStartRequest | null;
  onStartRequestConsumed?: () => void;
  onChanged: () => void;
  onGoHome: () => void;
  onGoLibrary: () => void;
  onViewItem: (item: LearningItem) => void;
  onOpenReminderSettings: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const focusPendingRef = useRef(false);

  useEffect(() => {
    if (!focusPendingRef.current) return;
    document.querySelector<HTMLElement>('.review-section-content .dashboard-page-heading')?.focus();
    focusPendingRef.current = false;
  }, [section]);

  function changeSection(next: ReviewSection) {
    if (next === section) return;
    if (__VALRECALL_PUBLIC_RELEASE__) {
      // A tab pressed just after a rating waits for that rating's write.
      void requestEditorLeaveAsync().then((allowed) => {
        if (!allowed) return;
        focusPendingRef.current = true;
        safeViewTransition(
          () => {
            flushSync(() => onSectionChange(next));
          },
          { reducedMotion },
        );
      });
      return;
    }
    if (!requestEditorLeave()) return;
    focusPendingRef.current = true;
    safeViewTransition(
      () => {
        flushSync(() => onSectionChange(next));
      },
      { reducedMotion },
    );
  }

  return (
    <section className="stack review-area">
      <div className="review-section-tabs" role="tablist" aria-label="复习分区">
        <button
          className={`button small-button motion-press ${section === 'due' ? '' : 'secondary'}`}
          aria-selected={section === 'due'}
          role="tab"
          onClick={() => changeSection('due')}
        >
          现在到期
        </button>
        <button
          className={`button small-button motion-press ${
            section === 'upcoming' ? '' : 'secondary'
          }`}
          aria-selected={section === 'upcoming'}
          role="tab"
          onClick={() => changeSection('upcoming')}
        >
          即将到期
        </button>
      </div>
      <div className="review-section-content motion-view-swap" key={section}>
        {section === 'due' ? (
          <TodayView
            revision={revision}
            preferences={preferences}
            preferredItemId={preferredItemId}
            startRequest={startRequest ?? null}
            {...(onStartRequestConsumed ? { onStartRequestConsumed } : {})}
            onChanged={onChanged}
            onGoHome={onGoHome}
            onGoLibrary={onGoLibrary}
            onViewUpcoming={() => changeSection('upcoming')}
          />
        ) : (
          <UpcomingReviewsView
            revision={revision}
            preferences={preferences}
            onViewItem={onViewItem}
            onOpenReminderSettings={onOpenReminderSettings}
          />
        )}
      </div>
    </section>
  );
}

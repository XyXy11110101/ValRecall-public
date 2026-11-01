import { State, type Card } from 'ts-fsrs';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export function formatFsrsInterval(reviewedAt: Date, due: Date): string {
  const milliseconds = Math.max(0, due.getTime() - reviewedAt.getTime());
  if (milliseconds < hour) return `${Math.max(1, Math.round(milliseconds / minute))}m`;
  if (milliseconds < day) return `${Math.max(1, Math.round(milliseconds / hour))}h`;
  const days = Math.max(1, Math.round(milliseconds / day));
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))}mo`;
  return `${Math.max(1, Math.round(days / 365))}y`;
}

export function formatNextReview(reviewedAt: Date, due: Date): string {
  const milliseconds = Math.max(0, due.getTime() - reviewedAt.getTime());
  if (milliseconds < hour) {
    const minutes = Math.max(1, Math.round(milliseconds / minute));
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (milliseconds < day) {
    const hours = Math.max(1, Math.round(milliseconds / hour));
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }

  const reviewedDay = new Date(
    reviewedAt.getFullYear(),
    reviewedAt.getMonth(),
    reviewedAt.getDate(),
  );
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  if (dueDay.getTime() - reviewedDay.getTime() === day) return 'tomorrow';

  return `on ${new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
  }).format(due)}`;
}

export function formatFsrsState(card: Card): string {
  return State[card.state];
}

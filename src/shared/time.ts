const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;

export function isValidTimeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Formats a non-negative duration without rounding into a future second. */
export function formatTimestamp(seconds: number): string {
  if (!isValidTimeSeconds(seconds)) {
    throw new RangeError('Timestamp seconds must be a finite, non-negative number.');
  }

  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((wholeSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = wholeSeconds % SECONDS_PER_MINUTE;
  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = String(remainder).padStart(2, '0');

  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  const seconds = numbers.at(-1) ?? 0;
  const minutes = numbers.at(-2) ?? 0;
  const hours = numbers.length === 3 ? (numbers[0] ?? 0) : 0;

  if (seconds >= 60 || minutes >= 60) {
    return null;
  }

  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds;
}

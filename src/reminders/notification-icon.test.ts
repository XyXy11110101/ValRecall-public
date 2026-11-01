import { describe, expect, it, vi } from 'vitest';

import { companionIconPath, outfitForDate } from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import {
  APP_NOTIFICATION_ICON,
  companionNotificationIcon,
  createWithIconFallback,
} from './notification-icon';

const now = new Date(2026, 9, 28, 14, 0);
const reminderIcon = companionIconPath(outfitForDate('2026-10-28'), 'reminder');

describe('notification icons', () => {
  it('uses today’s outfit head in the private build and the test build', async () => {
    const read = vi.fn(async () => ({}));
    await expect(companionNotificationIcon('reminder', read, now)).resolves.toBe(reminderIcon);
    await expect(companionNotificationIcon('default', read, now)).resolves.toBe(
      companionIconPath(outfitForDate('2026-10-28'), 'default'),
    );
    expect(read).toHaveBeenCalledWith(COMPANION_WARDROBE_STORAGE_KEY);
  });

  it('follows the local date, so the icon changes outfit at midnight', async () => {
    const read = async () => ({});
    await expect(
      companionNotificationIcon('reminder', read, new Date(2026, 9, 29, 0, 5)),
    ).resolves.toBe(companionIconPath(outfitForDate('2026-10-29'), 'reminder'));
  });

  it('uses the pinned outfit when one is pinned', async () => {
    const read = async () => ({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit10' },
    });
    await expect(companionNotificationIcon('reminder', read, now)).resolves.toBe(
      'assets/companion/chibi/outfit10/icon-reminder-128.png',
    );
  });

  it('falls back to today’s outfit when the choice is corrupt or unreadable', async () => {
    await expect(
      companionNotificationIcon(
        'reminder',
        async () => ({ [COMPANION_WARDROBE_STORAGE_KEY]: { mode: 'pinned', outfit: 'nope' } }),
        now,
      ),
    ).resolves.toBe(reminderIcon);
    await expect(
      companionNotificationIcon(
        'reminder',
        async () => {
          throw new Error('storage unavailable');
        },
        now,
      ),
    ).resolves.toBe(reminderIcon);
  });

  it('creates the notification once when the companion icon loads', async () => {
    const create = vi.fn(async () => 'id');
    await createWithIconFallback(create, reminderIcon);
    expect(create.mock.calls).toEqual([[reminderIcon]]);
  });

  it('never loses a reminder to artwork: it retries with the extension icon', async () => {
    const create = vi
      .fn<(iconPath: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('Unable to download all specified images.'))
      .mockResolvedValueOnce('id');
    await createWithIconFallback(create, reminderIcon);
    expect(create.mock.calls).toEqual([[reminderIcon], [APP_NOTIFICATION_ICON]]);
  });

  it('reports a failure that also happens with the extension icon', async () => {
    const create = vi.fn(async () => {
      throw new Error('notifications unavailable');
    });
    await expect(createWithIconFallback(create, reminderIcon)).rejects.toThrow(
      'notifications unavailable',
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the extension icon itself was requested', async () => {
    const create = vi.fn(async () => {
      throw new Error('notifications unavailable');
    });
    await expect(createWithIconFallback(create, APP_NOTIFICATION_ICON)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

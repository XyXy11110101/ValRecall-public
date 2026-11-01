// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { MobileRepository } from '../database/mobile-repository';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import { SyncClient } from '../mobile/sync-client';
import { localDateKey } from '../models/daily-task';
import { computerTimeZone, dateInTimeZone } from './protocol';
import { DesktopSyncService } from './service';
import { seedHistoricalTask } from '../testing/historical-task';

/**
 * The desktop picks "today" from local time and the phone from the zone the computer reports.
 * These two must name the same day, or a reward goes to the wrong occurrence. Only a run under
 * a zone far from UTC can catch a difference, so run this file under several values of TZ.
 */
const connections: { close(): void }[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

async function fixture(start: Date) {
  let time = start;
  const desktop = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'zone-desktop',
    clock: () => time,
  });
  const mobile = new MobileRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'zone-phone',
    clock: () => time,
  });
  connections.push(desktop, mobile);
  const domain = new SyncRepository(desktop, {
    clock: () => time,
    legacyLoader: async () => undefined,
  });
  const epoch = await domain.getEpoch();
  // The real zone reader, not an injected one: this is what the product sends to the phone.
  const service = new DesktopSyncService(domain, () => time.getTime(), computerTimeZone);
  const client = new SyncClient(mobile, {
    pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch }),
    request: (request) => service.handle('phone', request),
  });
  const task = await seedHistoricalTask(desktop, start);
  await client.sync();
  return {
    desktop,
    domain,
    mobile,
    client,
    task,
    setTime: (at: Date) => {
      time = at;
    },
  };
}

// The first and last minutes of a day are where a difference between the two shows.
const EDGES: [string, Date, string][] = [
  ['just after midnight', new Date(2026, 9, 13, 0, 1), '2026-10-13'],
  ['at noon', new Date(2026, 9, 13, 12), '2026-10-13'],
  ['just before midnight', new Date(2026, 9, 13, 23, 59), '2026-10-13'],
  ['on the last day of the year', new Date(2026, 11, 31, 23, 59), '2026-12-31'],
];

describe('the computer and the phone name the same day, in the zone this test runs under', () => {
  it.each(EDGES)('agree %s', (_name, at, date) => {
    expect(localDateKey(at)).toBe(date);
    expect(dateInTimeZone(at, computerTimeZone())).toBe(date);
  });

  it.each(EDGES)(
    'pays a computer completion, and treats the phone doing the same as a repeat, %s',
    async (_name, at, date) => {
      const f = await fixture(at);
      const queued = await f.mobile.enqueueCompletion(f.task.id);
      expect(queued.operation).toMatchObject({ date, timeZone: computerTimeZone() });
      const paid = await f.domain.changeTaskCompletionAtomic(f.task.id, date, true, at);
      expect(paid.reward?.reward).toBe(5);
      await f.client.sync();
      expect((await f.mobile.load()).outbox).toEqual([]);
      expect((await f.domain.wallet.load()).balance).toBe(5);
      expect((await f.desktop.listTaskCompletions()).map((row) => row.localDate)).toEqual([date]);
    },
  );

  it.each(EDGES)(
    'dates a phone reward on the day the computer shows, %s',
    async (_name, at, date) => {
      const f = await fixture(at);
      await f.mobile.enqueueCompletion(f.task.id);
      await f.client.sync();
      expect((await f.domain.wallet.load()).ledger[0]).toMatchObject({ amount: 5, date });
      expect((await f.desktop.getTaskDaySummary(date)).remaining).toBe(0);
      expect((await f.desktop.getHomeTaskOverview(date)).completed).toHaveLength(1);
    },
  );

  it('pays again only once the local day has really changed', async () => {
    const f = await fixture(new Date(2026, 9, 13, 23, 59));
    await f.mobile.enqueueCompletion(f.task.id);
    f.setTime(new Date(2026, 9, 14, 0, 1));
    await f.mobile.enqueueCompletion(f.task.id);
    await f.client.sync();
    expect((await f.domain.wallet.load()).balance).toBe(10);
    expect((await f.desktop.listTaskCompletions()).map((row) => row.localDate).sort()).toEqual([
      '2026-10-13',
      '2026-10-14',
    ]);
  });
});

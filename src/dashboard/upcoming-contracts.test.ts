// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DATABASE_VERSION } from '../database';
import { NEXT_REVIEW_ALARM_NAME } from '../reminders/reminder-service';

const repositorySource = `${read('src/database/repository.ts')}\n${read('src/database/queries.ts')}`;
const homeSource = `${read('src/dashboard/HomeView.tsx')}\n${read('src/dashboard/home-data.ts')}`;
const upcomingSource = `${read('src/dashboard/UpcomingReviewsCard.tsx')}\n${read(
  'src/dashboard/UpcomingReviewsView.tsx',
)}\n${read('src/dashboard/upcoming-reviews.ts')}`;
const taskSource = read('src/dashboard/TasksView.tsx');
const reminderSource = read('src/reminders/reminder-service.ts');
const css = read('src/styles/global.css');
const packageJson = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const manifest = JSON.parse(read('public/manifest.json')) as {
  permissions: string[];
  host_permissions: string[];
};

describe('A21 bounded/read-only architecture contracts', () => {
  it('uses the existing due index with a readonly strict page and no Home list-all call', () => {
    expect(repositorySource).toContain('.index(INDEX_NAMES.itemDue)');
    expect(repositorySource).toContain('MAX_UPCOMING_REVIEW_PAGE_SIZE = 100');
    expect(repositorySource).toMatch(
      /listUpcomingReviewItems[\s\S]*?transaction\(STORE_NAMES\.items, 'readonly'\)/,
    );
    expect(homeSource).not.toContain('repository.listItems(');
    expect(homeSource).toContain('HOME_UPCOMING_QUERY_LIMIT');
  });

  it('has no screenshot component, scheduler, rating action, per-item timer, or unbounded scroll', () => {
    expect(upcomingSource).not.toContain('ItemThumbnail');
    expect(upcomingSource).not.toContain('FsrsService');
    expect(upcomingSource).not.toContain('reviewItem(');
    expect(upcomingSource).not.toContain('setInterval');
    expect(upcomingSource).not.toContain('IntersectionObserver');
    expect(upcomingSource).toContain('加载更多');
    expect(upcomingSource).toContain('COHORT_INITIAL_ITEM_LIMIT');
  });

  it('keeps task Upcoming separate from FSRS forecast code', () => {
    expect(taskSource).toContain("type TasksSection = 'today' | 'upcoming'");
    expect(taskSource).toContain('DailyTask');
    expect(taskSource).not.toContain('UpcomingReviewsView');
    expect(taskSource).not.toContain('listUpcomingReviewItems');
  });

  it('preserves database/alarm/manifest/dependency boundaries', () => {
    expect(DATABASE_VERSION).toBe(6);
    expect(NEXT_REVIEW_ALARM_NAME).toBe('valrecall-next-review');
    expect(reminderSource.match(/valrecall-next-review/g)).toHaveLength(1);
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'notifications',
      'scripting',
      'storage',
      'sidePanel',
    ]);
    expect(manifest.host_permissions).toEqual([
      'https://www.bilibili.com/video/*',
      'https://bilibili.com/video/*',
      'https://www.bilibili.com/list/watchlater*',
      'https://www.youtube.com/watch*',
      'https://www.douyin.com/video/*',
    ]);
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const name of [
      'chart.js',
      'recharts',
      'fullcalendar',
      '@fullcalendar/react',
      'react-window',
      'react-virtualized',
      'framer-motion',
    ]) {
      expect(dependencies).not.toHaveProperty(name);
    }
  });

  it('keeps Home disclosure height bounded and responsive without horizontal scrolling', () => {
    expect(css).toMatch(/\.home-upcoming-disclosure[\s\S]*?max-height:/);
    expect(css).toMatch(/\.home-upcoming-disclosure[\s\S]*?overflow-y: auto/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.home-upcoming-card/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.upcoming-item-row/);
    expect(css).not.toMatch(/\.upcoming-(?:item|cohort)[^{]*\{[^}]*overflow-x:\s*scroll/s);
  });
});

function read(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

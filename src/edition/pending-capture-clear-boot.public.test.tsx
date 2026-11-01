import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import { MESSAGE_PROTOCOL_VERSION } from '../models/messages';

vi.mock('../dashboard/DashboardApp', () => ({ DashboardApp: () => null }));
vi.mock('../sidepanel/SidePanelApp', () => ({ SidePanelApp: () => null }));
vi.mock('../companion/CompanionWardrobe', () => ({
  CompanionWardrobeProvider: () => null,
}));
vi.mock('../ui/typography', () => ({ startTypography: async () => undefined }));
vi.mock('./rewards-boot', () => ({}));
vi.mock('../styles/global.css', () => ({}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXTENSION_ID = 'test-extension';
const CLEAR_MESSAGE = {
  type: 'VALRECALL_CLEAR_PENDING_CAPTURE',
  version: MESSAGE_PROTOCOL_VERSION,
};
const DASHBOARD = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/dashboard.html` };

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string },
  answer: () => void,
) => boolean;

function stubChrome() {
  const listeners: Listener[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXTENSION_ID,
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return {
    listeners,
    dispatch: (message: unknown) =>
      listeners.forEach((listener) => listener(message, DASHBOARD, () => undefined)),
  };
}

describe('the entry pages after a delete-all', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe.each([
    ['side panel', () => import('../sidepanel/main')],
    ['dashboard', () => import('../dashboard/main')],
  ])('the %s page', (_name, load) => {
    async function boot(publicEdition: boolean) {
      vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', publicEdition);
      vi.resetModules();
      const { dispatch } = stubChrome();
      const appRoot = document.createElement('div');
      appRoot.id = 'root';
      document.body.append(appRoot);
      await act(async () => {
        await load();
      });
      appRoot.remove();
      return { dispatch };
    }

    it('stops draft writes when the data page deletes, in the public edition', async () => {
      const { dispatch } = await boot(true);
      // The drafts module main.tsx loaded, not the one this file imported before the reset.
      const fresh = await import('../database/drafts');
      dispatch(CLEAR_MESSAGE);
      await expect(
        new fresh.DraftRepository().save({ id: 'a', scope: 'task', summary: '', payload: null }, 0),
      ).rejects.toThrow('学习内容已删除');
    });

    it('does not listen in the personal edition', async () => {
      const { dispatch } = await boot(false);
      const fresh = await import('../database/drafts');
      dispatch(CLEAR_MESSAGE);
      await expect(
        new fresh.DraftRepository().save({ id: 'a', scope: 'task', summary: '', payload: null }, 0),
      ).resolves.toMatchObject({ id: 'a' });
    });
  });
});

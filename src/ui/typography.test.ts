// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyTypography,
  chromeTypographyStorage,
  createTypographyStore,
  DEFAULT_TYPOGRAPHY,
  normalizeTypography,
  TYPOGRAPHY_BOOT_TIMEOUT_MS,
  TYPOGRAPHY_STORAGE_KEY,
  type FontChoice,
  type Typography,
  type TypographyStorage,
} from './typography';

function fakeStorage(stored?: unknown) {
  let listener: Parameters<TypographyStorage['onChanged']>[0] = () => undefined;
  const storage = {
    get: vi.fn((): Promise<Record<string, unknown>> =>
      Promise.resolve({ [TYPOGRAPHY_STORAGE_KEY]: stored }),
    ),
    set: vi.fn(() => Promise.resolve()),
    onChanged: vi.fn((next: typeof listener) => {
      listener = next;
    }),
  } satisfies TypographyStorage;
  return {
    storage,
    change(newValue: unknown) {
      listener({ [TYPOGRAPHY_STORAGE_KEY]: { newValue } });
    },
    changeOther() {
      listener({ 'valrecall.preferences': { newValue: { size: 'xlarge' } } });
    },
  };
}

function attributes(root: HTMLElement) {
  return { size: root.getAttribute('data-text-size'), font: root.getAttribute('data-font') };
}

describe('normalizeTypography', () => {
  it('keeps known values', () => {
    expect(normalizeTypography({ size: 'xlarge', font: 'yahei' })).toEqual({
      size: 'xlarge',
      font: 'yahei',
    });
  });

  it.each([
    [undefined],
    [null],
    ['large'],
    [7],
    [['large']],
    [{}],
    [{ size: 'huge', font: 'comic' }],
    [{ size: 1.4, font: null }],
    [{ size: 'constructor', font: '__proto__' }],
  ])('falls back to the defaults for %j', (value) => {
    expect(normalizeTypography(value)).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it('keeps the good half of a half-good value', () => {
    expect(normalizeTypography({ size: 'large', font: 'comic' })).toEqual({
      size: 'large',
      font: 'wenkai',
    });
    expect(normalizeTypography({ size: 'huge', font: 'noto' })).toEqual({
      size: 'standard',
      font: 'noto',
    });
  });

  it('defaults to 标准 and 霞鹜文楷', () => {
    expect(DEFAULT_TYPOGRAPHY).toEqual({ size: 'standard', font: 'wenkai' });
  });
});

describe('applyTypography', () => {
  it('writes the two attributes the stylesheet reads', () => {
    const root = document.createElement('html');
    applyTypography({ size: 'small', font: 'misans' }, root);
    expect(attributes(root)).toEqual({ size: 'small', font: 'misans' });
  });
});

describe('typography store', () => {
  let root: HTMLElement;
  const options = (storage: TypographyStorage | null, faces = vi.fn(() => Promise.resolve())) => ({
    storage: () => storage,
    root: () => root,
    faces,
  });

  beforeEach(() => {
    root = document.createElement('html');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('boot', () => {
    it('has the stored choice on the page when it resolves', async () => {
      const { storage } = fakeStorage({ size: 'xlarge', font: 'noto' });
      const store = createTypographyStore(options(storage));
      await store.start();
      expect(attributes(root)).toEqual({ size: 'xlarge', font: 'noto' });
      expect(store.get()).toEqual({ size: 'xlarge', font: 'noto' });
    });

    it('writes the defaults at once, before anything has been read', () => {
      const { storage } = fakeStorage({ size: 'xlarge', font: 'noto' });
      void createTypographyStore(options(storage)).start();
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
    });

    it('uses the defaults for unknown stored values', async () => {
      const { storage } = fakeStorage({ size: 'gigantic', font: 7 });
      await createTypographyStore(options(storage)).start();
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
    });

    it('resolves with the defaults when there is no extension storage', async () => {
      await createTypographyStore(options(null)).start();
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
    });

    it('resolves with the defaults when the read rejects', async () => {
      const { storage } = fakeStorage();
      storage.get.mockRejectedValueOnce(new Error('read failed'));
      await expect(createTypographyStore(options(storage)).start()).resolves.toBeUndefined();
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
    });

    it('resolves with the defaults when the read throws', async () => {
      const { storage } = fakeStorage();
      storage.get.mockImplementationOnce(() => {
        throw new Error('context invalidated');
      });
      await expect(createTypographyStore(options(storage)).start()).resolves.toBeUndefined();
    });

    it('resolves when reaching storage or its event throws', async () => {
      await expect(
        createTypographyStore({
          ...options(null),
          storage: () => {
            throw new Error('no storage');
          },
        }).start(),
      ).resolves.toBeUndefined();
      const { storage } = fakeStorage({ size: 'large', font: 'wenkai' });
      storage.onChanged.mockImplementationOnce(() => {
        throw new Error('no event');
      });
      await createTypographyStore(options(storage)).start();
      expect(attributes(root).size).toBe('large');
    });

    it('stops waiting for a read that hangs, and never blanks the page', async () => {
      vi.useFakeTimers();
      const { storage } = fakeStorage();
      storage.get.mockReturnValueOnce(new Promise(() => undefined));
      const started = vi.fn();
      void createTypographyStore(options(storage)).start().then(started);
      await vi.advanceTimersByTimeAsync(TYPOGRAPHY_BOOT_TIMEOUT_MS - 1);
      expect(started).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toHaveBeenCalledOnce();
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind after a normal read', async () => {
      vi.useFakeTimers();
      const { storage } = fakeStorage({ size: 'large', font: 'wenkai' });
      await createTypographyStore(options(storage)).start();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still applies a slow read that arrives after the page rendered', async () => {
      vi.useFakeTimers();
      const { storage } = fakeStorage();
      let finish!: (values: Record<string, unknown>) => void;
      storage.get.mockReturnValueOnce(new Promise((done) => (finish = done)));
      const store = createTypographyStore(options(storage));
      const started = store.start();
      await vi.advanceTimersByTimeAsync(TYPOGRAPHY_BOOT_TIMEOUT_MS);
      await started;
      finish({ [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'yahei' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(attributes(root)).toEqual({ size: 'large', font: 'yahei' });
    });

    it('does not let a slow read undo a newer change from another page', async () => {
      const { storage, change } = fakeStorage();
      let finish!: (values: Record<string, unknown>) => void;
      storage.get.mockReturnValueOnce(new Promise((done) => (finish = done)));
      const store = createTypographyStore(options(storage));
      const started = store.start();
      change({ size: 'xlarge', font: 'misans' });
      finish({ [TYPOGRAPHY_STORAGE_KEY]: { size: 'small', font: 'noto' } });
      await started;
      expect(attributes(root)).toEqual({ size: 'xlarge', font: 'misans' });
    });

    it('reads once, however many times it is started', async () => {
      const { storage } = fakeStorage();
      const store = createTypographyStore(options(storage));
      await Promise.all([store.start(), store.start()]);
      expect(storage.get).toHaveBeenCalledOnce();
      expect(storage.onChanged).toHaveBeenCalledOnce();
    });
  });

  describe('font files', () => {
    it.each<FontChoice>(['wenkai', 'noto', 'yahei', 'misans'])(
      'asks for the files of %s only',
      async (font) => {
        const { storage } = fakeStorage({ size: 'standard', font });
        const faces = vi.fn(() => Promise.resolve());
        await createTypographyStore(options(storage, faces)).start();
        expect(faces).toHaveBeenCalledExactlyOnceWith(font);
      },
    );

    it('reads the first text of the chosen font and no MiSans file for any other', async () => {
      const load = vi.fn((_font: string, _text?: string) => Promise.resolve([]));
      Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
      const boot = async (stored: unknown) => {
        load.mockClear();
        const { storage } = fakeStorage(stored);
        await createTypographyStore({ storage: () => storage, root: () => root }).start();
        return load.mock.calls;
      };
      try {
        for (const stored of [undefined, { size: 'large', font: 'wenkai' }]) {
          const calls = await boot(stored);
          expect(calls.map(([font]) => font)).toEqual(['400 16px "LXGW WenKai Screen"']);
          // The page shell and digits, or the subsets holding them are not what gets read.
          for (const text of ['首页', '添加回忆题', '零花钱', '0123456789']) {
            expect(calls[0]?.[1]).toContain(text);
          }
        }
        expect((await boot({ font: 'noto' })).map(([font]) => font)).toEqual([
          '400 16px "ValRecall Reading"',
          '500 16px "ValRecall Reading"',
          '600 16px "ValRecall Reading"',
        ]);
        // On the machine already.
        expect(await boot({ font: 'yahei' })).toEqual([]);

        load.mockClear();
        const { storage } = fakeStorage({ size: 'large', font: 'misans' });
        await createTypographyStore({ storage: () => storage, root: () => root }).start();
        expect(load.mock.calls).toEqual([
          ['400 16px MiSans'],
          ['500 16px MiSans'],
          ['600 16px MiSans'],
        ]);
      } finally {
        Reflect.deleteProperty(document, 'fonts');
      }
    });

    it('stops waiting for font files that never finish', async () => {
      vi.useFakeTimers();
      const { storage } = fakeStorage({ size: 'large', font: 'misans' });
      const started = vi.fn();
      void createTypographyStore(
        options(
          storage,
          vi.fn(() => new Promise<void>(() => undefined)),
        ),
      )
        .start()
        .then(started);
      await vi.advanceTimersByTimeAsync(TYPOGRAPHY_BOOT_TIMEOUT_MS);
      expect(started).toHaveBeenCalledOnce();
      expect(attributes(root).font).toBe('misans');
    });

    it('renders anyway when the font files fail', async () => {
      const { storage } = fakeStorage({ size: 'large', font: 'misans' });
      const faces = vi.fn(() => Promise.reject(new Error('no file')));
      await expect(createTypographyStore(options(storage, faces)).start()).resolves.toBeUndefined();
      expect(attributes(root).font).toBe('misans');
    });
  });

  describe('following other pages', () => {
    it('applies a change from another page and tells its subscribers', async () => {
      const { storage, change } = fakeStorage();
      const store = createTypographyStore(options(storage));
      await store.start();
      const listener = vi.fn();
      store.subscribe(listener);
      change({ size: 'large', font: 'yahei' });
      expect(attributes(root)).toEqual({ size: 'large', font: 'yahei' });
      expect(store.get()).toEqual({ size: 'large', font: 'yahei' });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('goes back to the defaults when the key is removed or turns invalid', async () => {
      const { storage, change } = fakeStorage({ size: 'large', font: 'yahei' });
      const store = createTypographyStore(options(storage));
      await store.start();
      change(undefined);
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
      change({ size: 'large', font: 'yahei' });
      change('rubbish');
      expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
    });

    it('ignores other keys', async () => {
      const { storage, changeOther } = fakeStorage({ size: 'large', font: 'yahei' });
      const store = createTypographyStore(options(storage));
      await store.start();
      const listener = vi.fn();
      store.subscribe(listener);
      changeOther();
      expect(listener).not.toHaveBeenCalled();
      expect(attributes(root)).toEqual({ size: 'large', font: 'yahei' });
    });

    it('stops telling a subscriber that has left', async () => {
      const { storage, change } = fakeStorage();
      const store = createTypographyStore(options(storage));
      await store.start();
      const listener = vi.fn();
      store.subscribe(listener)();
      change({ size: 'large', font: 'yahei' });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('choosing', () => {
    async function started(stored?: Typography) {
      const fake = fakeStorage(stored);
      const store = createTypographyStore(options(fake.storage));
      await store.start();
      return { ...fake, store };
    }

    it('applies before the write finishes, then stores the whole choice', async () => {
      const { storage, store } = await started({ size: 'large', font: 'wenkai' });
      let finish!: () => void;
      storage.set.mockReturnValueOnce(new Promise<void>((done) => (finish = done)));
      const saved = store.choose({ font: 'misans' });
      expect(attributes(root)).toEqual({ size: 'large', font: 'misans' });
      expect(storage.set).toHaveBeenCalledExactlyOnceWith({
        [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'misans' },
      });
      finish();
      await expect(saved).resolves.toBe(true);
      expect(attributes(root)).toEqual({ size: 'large', font: 'misans' });
    });

    it('goes back and says so when the write fails', async () => {
      const { storage, store } = await started({ size: 'large', font: 'wenkai' });
      storage.set.mockRejectedValueOnce(new Error('quota'));
      await expect(store.choose({ size: 'xlarge' })).resolves.toBe(false);
      expect(attributes(root)).toEqual({ size: 'large', font: 'wenkai' });
      expect(store.get()).toEqual({ size: 'large', font: 'wenkai' });
    });

    it('does not step backwards through its own quick writes', async () => {
      const { storage, store, change } = await started();
      const finishes: Array<() => void> = [];
      storage.set.mockImplementation(() => new Promise<void>((done) => finishes.push(done)));
      const first = store.choose({ size: 'large' });
      const second = store.choose({ size: 'xlarge' });
      change({ size: 'large', font: 'wenkai' });
      expect(attributes(root).size).toBe('xlarge');
      finishes[0]!();
      await first;
      expect(attributes(root).size).toBe('xlarge');
      change({ size: 'xlarge', font: 'wenkai' });
      finishes[1]!();
      await second;
      expect(attributes(root).size).toBe('xlarge');
    });

    it('applies when there is nowhere to store it', async () => {
      const store = createTypographyStore(options(null));
      await store.start();
      await expect(store.choose({ font: 'noto' })).resolves.toBe(true);
      expect(attributes(root).font).toBe('noto');
    });

    describe('before the page has heard what is stored', () => {
      const STORED = { size: 'xlarge', font: 'noto' };

      it('keeps the other stored field while a first read is still on its way', async () => {
        const fake = fakeStorage(STORED);
        let finish!: (values: Record<string, unknown>) => void;
        fake.storage.get.mockReturnValueOnce(new Promise((done) => (finish = done)));
        const store = createTypographyStore(options(fake.storage));
        const boot = store.start();
        await expect(store.choose({ size: 'large' })).resolves.toBe(true);
        expect(fake.storage.set).toHaveBeenCalledWith({
          [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'noto' },
        });
        finish({ [TYPOGRAPHY_STORAGE_KEY]: STORED });
        await boot;
        expect(attributes(root)).toEqual({ size: 'large', font: 'noto' });
      });

      it('keeps it after a first read that failed', async () => {
        const fake = fakeStorage(STORED);
        fake.storage.get.mockRejectedValueOnce(new Error('no'));
        const store = createTypographyStore(options(fake.storage));
        await store.start();
        expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
        await expect(store.choose({ size: 'large' })).resolves.toBe(true);
        expect(fake.storage.set).toHaveBeenCalledWith({
          [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'noto' },
        });
        expect(attributes(root)).toEqual({ size: 'large', font: 'noto' });
      });

      it('writes nothing while storage cannot say what it holds, and can try again', async () => {
        const fake = fakeStorage(STORED);
        fake.storage.get.mockRejectedValueOnce(new Error('no'));
        fake.storage.get.mockRejectedValueOnce(new Error('still no'));
        const store = createTypographyStore(options(fake.storage));
        await store.start();
        await expect(store.choose({ size: 'large' })).resolves.toBe(false);
        expect(fake.storage.set).not.toHaveBeenCalled();
        expect(attributes(root)).toEqual({ size: 'standard', font: 'wenkai' });
        await expect(store.choose({ font: 'yahei' })).resolves.toBe(true);
        expect(fake.storage.set).toHaveBeenCalledExactlyOnceWith({
          [TYPOGRAPHY_STORAGE_KEY]: { size: 'xlarge', font: 'yahei' },
        });
      });

      it('gives up on a read that hangs, and leaves no timer behind', async () => {
        vi.useFakeTimers();
        try {
          const fake = fakeStorage(STORED);
          fake.storage.get.mockReturnValue(new Promise(() => undefined));
          const store = createTypographyStore(options(fake.storage));
          const boot = store.start();
          await vi.advanceTimersByTimeAsync(TYPOGRAPHY_BOOT_TIMEOUT_MS);
          await boot;
          const choice = store.choose({ size: 'large' });
          expect(attributes(root).size).toBe('large');
          await vi.advanceTimersByTimeAsync(TYPOGRAPHY_BOOT_TIMEOUT_MS);
          await expect(choice).resolves.toBe(false);
          expect(fake.storage.set).not.toHaveBeenCalled();
          expect(attributes(root).size).toBe('standard');
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps every field of a quick burst', async () => {
        const fake = fakeStorage(STORED);
        fake.storage.get.mockRejectedValueOnce(new Error('no'));
        const store = createTypographyStore(options(fake.storage));
        await store.start();
        await Promise.all([store.choose({ size: 'large' }), store.choose({ font: 'yahei' })]);
        expect(fake.storage.set).toHaveBeenLastCalledWith({
          [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'yahei' },
        });
        expect(attributes(root)).toEqual({ size: 'large', font: 'yahei' });
      });

      it('keeps a field another page changed while the choice was asking', async () => {
        const fake = fakeStorage(STORED);
        let finish!: (values: Record<string, unknown>) => void;
        fake.storage.get.mockRejectedValueOnce(new Error('no'));
        fake.storage.get.mockReturnValueOnce(new Promise((done) => (finish = done)));
        const store = createTypographyStore(options(fake.storage));
        await store.start();
        const choice = store.choose({ size: 'large' });
        fake.change({ size: 'small', font: 'misans' });
        finish({ [TYPOGRAPHY_STORAGE_KEY]: STORED });
        await choice;
        expect(fake.storage.set).toHaveBeenCalledWith({
          [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'misans' },
        });
      });

      it('still shows a late first read after a choice that could not be saved', async () => {
        const fake = fakeStorage(STORED);
        let finish!: (values: Record<string, unknown>) => void;
        fake.storage.get.mockReturnValueOnce(new Promise((done) => (finish = done)));
        fake.storage.get.mockRejectedValueOnce(new Error('no'));
        const store = createTypographyStore(options(fake.storage));
        const boot = store.start();
        await expect(store.choose({ size: 'large' })).resolves.toBe(false);
        finish({ [TYPOGRAPHY_STORAGE_KEY]: STORED });
        await boot;
        expect(attributes(root)).toEqual({ size: 'xlarge', font: 'noto' });
      });
    });
  });
});

describe('chromeTypographyStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null outside the extension', () => {
    expect(chromeTypographyStorage()).toBeNull();
    vi.stubGlobal('chrome', {});
    expect(chromeTypographyStorage()).toBeNull();
  });

  it('follows only the local area', () => {
    const listeners: Array<(changes: object, area: string) => void> = [];
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(), set: vi.fn() },
        onChanged: { addListener: (next: (typeof listeners)[number]) => listeners.push(next) },
      },
    });
    const seen = vi.fn();
    chromeTypographyStorage()?.onChanged(seen);
    const changes = { [TYPOGRAPHY_STORAGE_KEY]: { newValue: {} } };
    listeners[0]?.(changes, 'sync');
    expect(seen).not.toHaveBeenCalled();
    listeners[0]?.(changes, 'local');
    expect(seen).toHaveBeenCalledExactlyOnceWith(changes);
  });
});

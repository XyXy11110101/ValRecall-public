/**
 * The desktop's text size and font. Its own storage key, because any change to
 * `valrecall.preferences` re-runs the reminders. It is a display choice for this device: not synced,
 * not in backups, and clearing the learning data leaves it alone. The phone does not read it.
 *
 * The values reach the page as two attributes on <html>, and global.css does the rest. Both pages
 * call `startTypography()` before their first render, so no page paints at the wrong size.
 */
export const TYPOGRAPHY_STORAGE_KEY = 'valrecall.typography';

export const TEXT_SIZES = [
  { id: 'small', label: '小' },
  { id: 'standard', label: '标准' },
  { id: 'large', label: '大' },
  { id: 'xlarge', label: '特大' },
] as const;

export const FONT_CHOICES = [
  { id: 'wenkai', label: '霞鹜文楷' },
  { id: 'misans', label: 'MiSans' },
  { id: 'noto', label: '思源黑体' },
  { id: 'yahei', label: '微软雅黑' },
] as const;

/** The public edition carries no MiSans, so it offers the others. Written out so it stays a constant. */
export const VISIBLE_FONT_CHOICES: ReadonlyArray<(typeof FONT_CHOICES)[number]> = [
  { id: 'wenkai', label: '霞鹜文楷' },
  { id: 'noto', label: '思源黑体' },
  { id: 'yahei', label: '微软雅黑' },
];

export type TextSize = (typeof TEXT_SIZES)[number]['id'];
export type FontChoice = (typeof FONT_CHOICES)[number]['id'];

export interface Typography {
  size: TextSize;
  font: FontChoice;
}

export const DEFAULT_TYPOGRAPHY: Readonly<Typography> = Object.freeze({
  size: 'standard',
  font: 'wenkai',
});

/** A page waits this long at most for the stored choice before it renders with what it has. */
export const TYPOGRAPHY_BOOT_TIMEOUT_MS = 800;

/**
 * What a page reads before its first render, so it does not paint in a fallback font and then swap.
 * MiSans has no subsets, so its three files are read whole. WenKai and Noto are split by character,
 * so they read the subsets holding the text every page opens with; rarer characters that arrive
 * later can still swap in. Microsoft YaHei is on the machine and has nothing to read.
 */
const FIRST_TEXT =
  'ValRecall 0123456789 Alt+Shift+M 首页资料库复习学习统计待办零花钱设置添加回忆题更多视频捕获' +
  '阅读摘录写题来源打开面板按今天有条和项任务等你日到期开始已连续数最近保存全部之后逾正在加载';

const FIRST_FACES: Readonly<Record<FontChoice, ReadonlyArray<readonly [string, string?]>>> = {
  wenkai: [['400 16px "LXGW WenKai Screen"', FIRST_TEXT]],
  misans: [['400 16px MiSans'], ['500 16px MiSans'], ['600 16px MiSans']],
  noto: [
    ['400 16px "ValRecall Reading"', FIRST_TEXT],
    ['500 16px "ValRecall Reading"', FIRST_TEXT],
    ['600 16px "ValRecall Reading"', FIRST_TEXT],
  ],
  yahei: [],
};

/** Each field stands alone: one unknown value keeps its default and leaves the other choice. */
export function normalizeTypography(value: unknown): Typography {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    size: TEXT_SIZES.find(({ id }) => id === record.size)?.id ?? DEFAULT_TYPOGRAPHY.size,
    font:
      (__VALRECALL_PUBLIC_RELEASE__ ? VISIBLE_FONT_CHOICES : FONT_CHOICES).find(
        ({ id }) => id === record.font,
      )?.id ?? DEFAULT_TYPOGRAPHY.font,
  };
}

export function applyTypography(
  typography: Typography,
  root: HTMLElement = document.documentElement,
): void {
  root.setAttribute('data-text-size', typography.size);
  root.setAttribute('data-font', typography.font);
}

type StorageChanges = Record<string, { newValue?: unknown }>;

/** The small slice of `chrome.storage` this needs. */
export interface TypographyStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  onChanged(listener: (changes: StorageChanges) => void): void;
}

export function chromeTypographyStorage(): TypographyStorage | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    onChanged: (listener) =>
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') listener(changes);
      }),
  };
}

function loadFaces(font: FontChoice): Promise<unknown> {
  if (!document.fonts) return Promise.resolve();
  return Promise.all(FIRST_FACES[font].map((args) => document.fonts.load(...args)));
}

export interface TypographyStoreOptions {
  storage?: () => TypographyStorage | null;
  root?: () => HTMLElement;
  /** Reads the font files a page needs before it paints. */
  faces?: (font: FontChoice) => Promise<unknown>;
  timeoutMs?: number;
}

export interface TypographyStore {
  /** Resolves when the page may render. Never rejects, and never takes longer than the timeout. */
  start(): Promise<void>;
  get(): Typography;
  subscribe(listener: () => void): () => void;
  /**
   * Applies at once, then stores, leaving the field it does not change as storage has it.
   * False means it could not be stored, and the page went back.
   */
  choose(change: Partial<Typography>): Promise<boolean>;
}

export function createTypographyStore({
  storage: getStorage = chromeTypographyStorage,
  root = () => document.documentElement,
  faces = loadFaces,
  timeoutMs = TYPOGRAPHY_BOOT_TIMEOUT_MS,
}: TypographyStoreOptions = {}): TypographyStore {
  const listeners = new Set<() => void>();
  let current: Typography = { ...DEFAULT_TYPOGRAPHY };
  /** What storage holds, as far as this page knows: where a failed write goes back to. */
  let stored: Typography = current;
  /** Whether `stored` has really been heard from storage. Until then it is only the defaults. */
  let known = false;
  /** Fields chosen before that. A choice changes one field, so the other has to come from storage. */
  let chosen: Partial<Typography> = {};
  let writes = 0;
  let starting: Promise<void> | null = null;

  function show(next: Typography): void {
    if (next.size === current.size && next.font === current.font) return;
    current = next;
    applyTypography(next, root());
    for (const listener of listeners) listener();
  }

  function learn(value: Typography): void {
    known = true;
    stored = value;
    show(normalizeTypography({ ...value, ...chosen }));
  }

  async function firstRead(storage: TypographyStorage): Promise<void> {
    const values = await storage.get(TYPOGRAPHY_STORAGE_KEY);
    if (known) return;
    learn(normalizeTypography(values[TYPOGRAPHY_STORAGE_KEY]));
    await faces(current.font);
  }

  /** The first read may have failed or still be hanging, so a choice asks again, for a limited time. */
  async function readForChoice(storage: TypographyStorage): Promise<Typography> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error('Storage did not answer')), timeoutMs);
    });
    try {
      const values = await Promise.race([storage.get(TYPOGRAPHY_STORAGE_KEY), deadline]);
      return normalizeTypography(values[TYPOGRAPHY_STORAGE_KEY]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function boot(): Promise<void> {
    applyTypography(current, root());
    let storage: TypographyStorage | null;
    try {
      storage = getStorage();
    } catch {
      return;
    }
    if (!storage) return;
    try {
      storage.onChanged((changes) => {
        const change = changes[TYPOGRAPHY_STORAGE_KEY];
        if (!change) return;
        const value = normalizeTypography(change.newValue);
        if (!known) {
          learn(value);
          return;
        }
        stored = value;
        // This page's own writes come back here too. Showing one mid-burst would step backwards.
        if (writes === 0) show(stored);
      });
    } catch {
      // Without the event this page still has its first read and its own choices.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((done) => {
      timer = setTimeout(done, timeoutMs);
    });
    await Promise.race([firstRead(storage).catch(() => undefined), deadline]);
    clearTimeout(timer);
  }

  return {
    start() {
      starting ??= boot();
      return starting;
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async choose(change) {
      const storage = getStorage();
      show(normalizeTypography({ ...current, ...change }));
      if (!storage) return true;
      writes += 1;
      let saved = true;
      try {
        if (!known) {
          chosen = { ...chosen, ...change };
          const held = await readForChoice(storage);
          if (!known) learn(held);
        }
        const next = current;
        await storage.set({ [TYPOGRAPHY_STORAGE_KEY]: next });
        stored = next;
      } catch {
        // Not knowing what is stored counts as a failure: a blind write would lose the other field.
        saved = false;
      }
      writes -= 1;
      if (writes === 0) {
        chosen = {};
        show(stored);
      }
      return saved;
    },
  };
}

export const typography = createTypographyStore();

export function startTypography(): Promise<void> {
  return typography.start();
}

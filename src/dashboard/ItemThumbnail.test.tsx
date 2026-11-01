import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ItemThumbnail } from './ItemThumbnail';

const mocks = vi.hoisted(() => ({
  getScreenshot: vi.fn(),
}));

vi.mock('./services', () => ({
  repository: {
    getScreenshot: mocks.getScreenshot,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ItemThumbnail', () => {
  let container: HTMLDivElement;
  let root: Root;
  let createObjectUrl: ReturnType<typeof vi.fn>;
  let revokeObjectUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    createObjectUrl = vi.fn(() => 'blob:valrecall-thumbnail');
    revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    mocks.getScreenshot.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('preserves the 16:9 fallback when a screenshot is unavailable', async () => {
    mocks.getScreenshot.mockRejectedValue(new Error('Screenshot unavailable'));
    await act(async () => {
      root.render(<ItemThumbnail screenshotId="missing" alt="Learning moment" />);
      await Promise.resolve();
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain(
      'no screenshot available',
    );
  });

  it('leaves an editorial text layout when an optional image is missing or fails', async () => {
    mocks.getScreenshot.mockResolvedValue(null);
    await act(async () => {
      root.render(<ItemThumbnail screenshotId="missing" alt="Moment" hideWhenMissing />);
    });
    expect(container.childElementCount).toBe(0);
    mocks.getScreenshot.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    await act(async () => {
      root.render(<ItemThumbnail screenshotId="available" alt="Moment" hideWhenMissing />);
    });
    expect(container.querySelector('img')).not.toBeNull();
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.childElementCount).toBe(0);
    act(() => root.render(<ItemThumbnail screenshotId={null} alt="Moment" hideWhenMissing />));
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:valrecall-thumbnail');
  });

  it('fades a resolved image in after load and revokes its object URL on replacement', async () => {
    mocks.getScreenshot.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    await act(async () => {
      root.render(<ItemThumbnail screenshotId="available" alt="Learning moment" />);
      await Promise.resolve();
    });
    const image = container.querySelector('img');
    expect(image?.classList.contains('motion-thumbnail')).toBe(true);
    expect(image?.getAttribute('data-loaded')).toBe('false');

    act(() => image?.dispatchEvent(new Event('load')));
    expect(image?.getAttribute('data-loaded')).toBe('true');

    act(() => root.render(<ItemThumbnail screenshotId={null} alt="Learning moment" />));
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:valrecall-thumbnail');
    expect(container.querySelector('[role="img"]')).not.toBeNull();
  });
});

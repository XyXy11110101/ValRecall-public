import { describe, expect, it } from 'vitest';

import {
  AGAIN_POOL,
  COMPLETE_POOL,
  EASY_POOL,
  ENTRY_POOL,
  GOOD_POOL,
  HARD_POOL,
  PROMPT_POOL,
  REVEAL_POOL,
  nextLine,
} from './review-companion-copy';

const POOLS = {
  entry: ENTRY_POOL,
  prompt: PROMPT_POOL,
  reveal: REVEAL_POOL,
  again: AGAIN_POOL,
  hard: HARD_POOL,
  good: GOOD_POOL,
  easy: EASY_POOL,
  complete: COMPLETE_POOL,
} as const;

describe('review companion copy pools', () => {
  it.each(Object.entries(POOLS))('keeps 你 in every %s line', (_name, pool) => {
    expect(pool.length).toBeGreaterThan(0);
    for (const line of pool) {
      expect(line).toBeTruthy();
    }
  });

  it('rotates deterministically and wraps without Math.random', () => {
    const first = nextLine(ENTRY_POOL, -1);
    expect(first).toEqual({ line: ENTRY_POOL[0], nextIndex: 0 });
    const second = nextLine(ENTRY_POOL, first.nextIndex);
    expect(second).toEqual({ line: ENTRY_POOL[1], nextIndex: 1 });
    const wrapped = nextLine(ENTRY_POOL, ENTRY_POOL.length - 1);
    expect(wrapped).toEqual({ line: ENTRY_POOL[0], nextIndex: 0 });
  });
});

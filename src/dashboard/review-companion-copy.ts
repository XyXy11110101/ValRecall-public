export const ENTRY_POOL = [
  '准备好了就开始这一轮。',
  '按自己的节奏来。',
  '先想一遍，再核对答案。',
  '这一轮不赶时间。',
] as const;

export const PROMPT_POOL = [
  '先想想这题。',
  '试着用自己的话说一遍。',
  '哪些线索能帮你想起来？',
  '慢慢想，不着急。',
  '先在心里给出一个答案。',
  '这一题让你想到了什么？',
] as const;

export const REVEAL_POOL = [
  '看看刚才抓住了哪些要点。',
  '和刚才想到的对照一下。',
  '有哪些地方需要再想一想？',
  '按刚才的回忆选择评分。',
  '记下这次遗漏的一点就好。',
  '看看答案怎样回应这个问题。',
] as const;

export const AGAIN_POOL = ['这次没想起的，留给下次练习。', '如实记录就好。'] as const;

export const HARD_POOL = ['这次想得有些费力，记录下来就好。', '按实际感受来。'] as const;

export const GOOD_POOL = ['想起来了，真好。', '记住刚才独立想起的感觉。'] as const;

export const EASY_POOL = ['这次轻松想起了。', '想起来了，真好。'] as const;

export const COMPLETE_POOL = [
  '本轮结束。可以歇一会儿。',
  '这一轮到这里。下次再来。',
  '本轮处理完了，看看这次的记录。',
  '今天的学习已经记下了。',
] as const;

export type ReviewCompanionCopyPool = readonly string[];

export function nextLine(
  pool: ReviewCompanionCopyPool,
  lastIndex: number,
): { line: string; nextIndex: number } {
  if (pool.length === 0) {
    throw new Error('Review companion copy pool must not be empty.');
  }
  const bounded = Number.isInteger(lastIndex) ? lastIndex : -1;
  const nextIndex = (((bounded + 1) % pool.length) + pool.length) % pool.length;
  return { line: pool[nextIndex]!, nextIndex };
}
